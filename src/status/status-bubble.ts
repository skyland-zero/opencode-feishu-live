import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ActivityEvent } from '../types.js';
import type { StatusFinalizeOutcome, StatusReporter } from './reporter.js';

export interface StatusSink {
  sendText(chatId: string, text: string): Promise<string | undefined>;
  editText(chatId: string, messageId: string, text: string): Promise<void>;
}

interface BubbleLine {
  id: string;
  text: string;
}

/**
 * Hermes-style text progress bubble.
 *
 * One plain text message per "progress segment" that is edited in place as
 * activities arrive (throttled), Hermes-style:
 *  - tool lines: `{emoji} {tool}` + fenced command block, collapsed to
 *    `✅ {tool} · 5.4s` when finished (static while running — no ticking)
 *  - thinking lines: `💭 思考中…` replaced by `💭 思考完成 · 2.7s` when done
 *  - when interim content is delivered to the chat, the bubble is sealed and the
 *    next activity opens a fresh one (chat feed: [bubble][content][bubble]…)
 *  - edits are capped (Feishu allows 20 per message): after 18 edits the bubble
 *    rolls over into a new message; edit failures degrade to rate-limited
 *    standalone messages.
 */
export class StatusBubble implements StatusReporter {
  private readonly sink: StatusSink;
  private readonly chatId: string;
  private readonly debug: boolean;

  private lines: BubbleLine[] = [];
  private done = false;

  private messageId?: string;
  private editCount = 0;
  private contentSent = false;

  private dirty = false;
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private lastFlushAt = 0;

  private degraded = false;
  private burstLastAt = 0;
  private burstLastText = '';

  private toolLines = new Map<string, string>();
  private seq = 0;
  private turnModel?: string;

  private static readonly EDIT_ROLLOVER = 18;
  private static readonly MAX_RENDER_CHARS = 3600;

  constructor(options: { sink: StatusSink; chatId: string; mode: 'normal' | 'debug'; model?: string }) {
    this.sink = options.sink;
    this.chatId = options.chatId;
    this.debug = options.mode === 'debug';
    this.turnModel = options.model;
  }

  get isFinalized(): boolean {
    return this.done;
  }

  get messageRef(): string | undefined {
    return this.messageId;
  }

  async start(): Promise<void> {
    this.lines.push({ id: 'start', text: '🚀 开始处理…' });
    await this.flush(true);
  }

  noteContentSent(): void {
    this.contentSent = true;
  }

  handleActivity(event: ActivityEvent): void {
    if (this.done) {
      return;
    }

    switch (event.type) {
      case 'turn_start':
        return;
      case 'thinking_start':
        this.pushLine({ id: `think-${++this.seq}`, text: '💭 思考中…' });
        return;
      case 'thinking_end': {
        const line = this.findPrefix('think-');
        const bits: string[] = [];
        if (event.durationMs >= 1000) {
          bits.push(formatDuration(event.durationMs));
        }
        if (event.chars > 0) {
          bits.push(`${event.chars} 字`);
        }
        const text = `💭 思考完成${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
        if (line) {
          line.text = text;
        } else {
          this.pushLine({ id: `think-${++this.seq}`, text });
        }
        return;
      }
      case 'text_start':
        return;
      case 'text_delta':
        return;
      case 'text_end':
        return;
      case 'tool': {
        const toolName = event.name || 'tool';
        const emoji = toolEmoji(toolName);
        const existingId = this.toolLines.get(event.toolCallId);

        if (event.phase === 'pending') {
          if (!existingId) {
            const id = `tool-${++this.seq}`;
            this.toolLines.set(event.toolCallId, id);
            this.pushLine({ id, text: `${emoji} ${toolName}` });
          }
          return;
        }

        if (event.phase === 'running') {
          const title = (event.title || '').replace(/\s+/g, ' ').trim();
          const text = isShellLike(toolName) && title
            ? `${emoji} ${toolName}\n\`\`\`\n${clamp(title, 600)}\n\`\`\``
            : title
              ? `${emoji} ${toolName}: ${clamp(title, 100)}`
              : `${emoji} ${toolName}`;
          this.replaceOrPushToolLine(event.toolCallId, text);
          return;
        }

        if (event.phase === 'completed') {
          const seconds = event.durationMs !== undefined ? ` · ${formatDuration(event.durationMs)}` : '';
          let text = `✅ ${toolName}${seconds}`;
          if (config.opencode.showToolOutput && event.output) {
            const preview = previewText(event.output, this.debug ? config.opencode.toolOutputMax : 100);
            if (preview) {
              text += `\n  ↳ ${preview}`;
            }
          }
          this.replaceOrPushToolLine(event.toolCallId, text);
          return;
        }

        if (event.phase === 'failed') {
          const reason = event.error ? previewText(event.error, this.debug ? config.opencode.toolOutputMax : 100) : '';
          const text = reason ? `⚠️ ${toolName} · 失败\n  ↳ ${reason}` : `⚠️ ${toolName} · 失败`;
          this.replaceOrPushToolLine(event.toolCallId, text);
          return;
        }
        return;
      }
      case 'permission': {
        this.pushLine({
          id: `perm-${++this.seq}`,
          text: event.decision === 'allowed'
            ? `🔐 已允许：${clamp(event.title, 60)}`
            : `🔐 已拒绝：${clamp(event.title, 60)}`,
        });
        return;
      }
      case 'usage':
        return;
      case 'turn_end':
        return;
      default:
        return;
    }
  }

  async finalize(outcome: StatusFinalizeOutcome): Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const duration = formatDuration(outcome.durationMs);
    const model = outcome.model || this.turnModel;
    const modelSuffix = model ? ` · 模型 ${model}` : '';
    if (outcome.status === 'completed') {
      const usage = formatUsage(outcome.usage);
      this.lines.push({
        id: 'final',
        text: `🏁 完成 · 用时 ${duration}${usage ? ` · ${usage}` : ''}${modelSuffix}`,
      });
    } else if (outcome.status === 'cancelled') {
      this.lines.push({ id: 'final', text: `⏹️ 已取消 · 用时 ${duration}${modelSuffix}` });
    } else {
      this.lines.push({
        id: 'final',
        text: `❌ 失败 · 用时 ${duration}${modelSuffix}${outcome.error ? `\n  ↳ ${previewText(outcome.error, 160)}` : ''}`,
      });
    }

    await this.flush(true);
  }

  // ------------------------------------------------------------------
  // Line management
  // ------------------------------------------------------------------

  private pushLine(line: BubbleLine): void {
    // Content landed in the chat: seal this bubble and open a fresh one for
    // activities that arrived after (Hermes-style stream splitting).
    if (this.contentSent && this.lines.length > 0 && this.messageId) {
      this.contentSent = false;
      this.openNewBubble();
    }
    this.lines.push(line);
    this.markDirty();
  }

  private replaceOrPushToolLine(toolCallId: string, text: string): void {
    const id = this.toolLines.get(toolCallId);
    if (id) {
      const line = this.lines.find(item => item.id === id);
      if (line) {
        line.text = text;
        this.markDirty();
        return;
      }
    }
    const newId = `tool-${++this.seq}`;
    this.toolLines.set(toolCallId, newId);
    this.pushLine({ id: newId, text });
  }

  private findPrefix(prefix: string): BubbleLine | undefined {
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      const line = this.lines[i];
      if (line && line.id.startsWith(prefix)) {
        return line;
      }
    }
    return undefined;
  }

  private openNewBubble(): void {
    this.messageId = undefined;
    this.editCount = 0;
    this.lines = [];
    this.toolLines.clear();
  }

  // ------------------------------------------------------------------
  // Delivery
  // ------------------------------------------------------------------

  private markDirty(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.done) {
      return;
    }
    const wait = Math.max(0, this.lastFlushAt + config.opencode.statusInterval - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush(false).then(() => {
        if (!this.done && (this.dirty || this.contentSent)) {
          this.schedule();
        }
      });
    }, Math.max(wait, 50));
  }

  private render(): string {
    let text = this.lines.map(line => line.text).join('\n');
    if (text.length > StatusBubble.MAX_RENDER_CHARS) {
      // Keep the newest content, drop the oldest whole lines.
      const kept: string[] = [];
      let total = 0;
      for (let i = this.lines.length - 1; i >= 0; i -= 1) {
        const lineText = this.lines[i]?.text || '';
        if (total + lineText.length > StatusBubble.MAX_RENDER_CHARS - 20) {
          break;
        }
        kept.unshift(lineText);
        total += lineText.length + 1;
      }
      text = `…\n${kept.join('\n')}`;
    }
    return text;
  }

  private async flush(force: boolean): Promise<void> {
    if (this.flushing) {
      this.dirty = true;
      return;
    }
    if (!force && !this.dirty) {
      return;
    }
    this.flushing = true;
    this.dirty = false;

    try {
      const text = this.render();
      if (!text.trim()) {
        return;
      }

      if (this.degraded) {
        const now = Date.now();
        if (force || (now - this.burstLastAt >= 2500 && text !== this.burstLastText)) {
          await this.sink.sendText(this.chatId, text);
          this.burstLastAt = now;
          this.burstLastText = text;
        }
        return;
      }

      if (!this.messageId) {
        const messageId = await this.sink.sendText(this.chatId, text);
        this.messageId = messageId;
        this.editCount = 0;
      } else if (this.editCount < StatusBubble.EDIT_ROLLOVER) {
        await this.sink.editText(this.chatId, this.messageId, text);
        this.editCount += 1;
      } else {
        // Rollover: start a fresh message with the current full window.
        const messageId = await this.sink.sendText(this.chatId, text);
        this.messageId = messageId;
        this.editCount = 0;
      }
      this.lastFlushAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Status bubble delivery failed (${message}); switching to rate-limited messages`);
      this.degraded = true;
      this.messageId = undefined;
      this.dirty = true;
      if (!this.done) {
        this.schedule();
      }
    } finally {
      this.flushing = false;
    }
  }
}

// ----------------------------------------------------------------------
// Formatting helpers
// ----------------------------------------------------------------------

function isShellLike(toolName: string): boolean {
  return /^(shell|bash|sh|terminal|exec|command)$/i.test(toolName);
}

export function toolEmoji(toolName: string): string {
  const name = toolName.toLowerCase();
  if (/(shell|bash|terminal|exec|command)/.test(name)) return '⚙️';
  if (/(read|cat|view)/.test(name)) return '📄';
  if (/(write|edit|patch|apply)/.test(name)) return '✏️';
  if (/(grep|glob|search|find|ls|list)/.test(name)) return '🔍';
  if (/(webfetch|fetch|web|http)/.test(name)) return '🌐';
  if (/(task|agent|subagent|delegate)/.test(name)) return '🤖';
  if (/(todo|plan)/.test(name)) return '📋';
  return '⚙️';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0s';
  }
  if (ms < 10000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  if (minutes < 60) {
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatUsage(usage?: { totalTokens?: number; thoughtTokens?: number }): string {
  if (!usage) {
    return '';
  }
  const bits: string[] = [];
  const total = usage.totalTokens ?? 0;
  if (total > 0) {
    bits.push(`tokens ${formatTokens(total)}`);
  }
  if (usage.thoughtTokens && usage.thoughtTokens > 0) {
    bits.push(`推理 ${formatTokens(usage.thoughtTokens)}`);
  }
  return bits.join(' · ');
}

function formatTokens(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function previewText(text: string, max: number): string {
  const compact = text.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
