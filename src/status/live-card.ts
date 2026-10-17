import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ActivityEvent, TokenUsage } from '../types.js';
import type { StatusFinalizeOutcome, StatusReporter } from './reporter.js';

export type { StatusFinalizeOutcome as LiveCardFinalizeOutcome } from './reporter.js';

export interface StatusSink {
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined>;
  patchCard(chatId: string, messageId: string, card: Record<string, unknown>): Promise<void>;
  sendText(chatId: string, text: string): Promise<string | undefined>;
  editText(chatId: string, messageId: string, text: string): Promise<void>;
}

interface LogLine {
  id: string;
  text: string;
  sub?: string;
}

interface ActiveActivity {
  kind: 'thinking' | 'text' | 'tool';
  startedAt: number;
  chars: number;
  preview: string;
  toolCallId?: string;
  label?: string;
}

/** Card carrier for the live status message (kept as an alternative to the default text bubble). */
export class LiveCard implements StatusReporter {
  private readonly sink: StatusSink;
  private readonly chatId: string;
  private readonly command: string;
  private readonly model?: string;
  private readonly debug: boolean;

  private lines: LogLine[] = [];
  private activity: ActiveActivity | null = null;
  private startedAt = Date.now();
  private done = false;
  private outcome: StatusFinalizeOutcome | null = null;

  private carrier: 'card' | 'text' | 'burst' = 'card';
  private messageId?: string;
  private editCount = 0;
  private burstLastAt = 0;
  private burstLastText = '';

  private dirty = false;
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private lastFlushAt = 0;

  private toolLineIds = new Map<string, string>();
  private extraLineSeq = 0;

  constructor(options: {
    sink: StatusSink;
    chatId: string;
    command: string;
    model?: string;
    mode: 'normal' | 'debug';
  }) {
    this.sink = options.sink;
    this.chatId = options.chatId;
    this.command = options.command;
    this.model = options.model;
    this.debug = options.mode === 'debug';
  }

  get isFinalized(): boolean {
    return this.done;
  }

  get messageRef(): string | undefined {
    return this.messageId;
  }

  async start(): Promise<void> {
    this.pushLine({ id: 'start', text: '🚀 任务开始' });
    await this.flush(true);
  }

  /** Card carrier shows interim content inline via the chat feed; nothing to split. */
  noteContentSent(): void {
    // no-op for the card carrier
  }

  /** Feed one activity event from the agent session. */
  handleActivity(event: ActivityEvent): void {
    if (this.done) {
      return;
    }
    switch (event.type) {
      case 'turn_start':
        this.markDirty();
        return;
      case 'thinking_start':
        this.activity = { kind: 'thinking', startedAt: event.at, chars: 0, preview: '' };
        this.markDirty();
        return;
      case 'thinking_delta': {
        if (!this.activity || this.activity.kind !== 'thinking') {
          this.activity = { kind: 'thinking', startedAt: event.at, chars: 0, preview: '' };
        }
        this.activity.chars += event.text.length;
        if (config.opencode.showReasoningText) {
          const joined = this.activity.preview + event.text;
          this.activity.preview = joined.length > config.opencode.reasoningPreviewMax
            ? joined.slice(-config.opencode.reasoningPreviewMax)
            : joined;
        }
        this.markDirty();
        return;
      }
      case 'thinking_end': {
        this.activity = null;
        const bits: string[] = [];
        if (event.durationMs >= 1000) {
          bits.push(formatDuration(event.durationMs));
        }
        if (event.chars > 0) {
          bits.push(`${event.chars} 字`);
        }
        this.pushLine({ id: `think-${event.at}`, text: `💭 思考完成${bits.length ? ` · ${bits.join(' · ')}` : ''}` });
        this.markDirty();
        return;
      }
      case 'text_start':
        this.activity = { kind: 'text', startedAt: event.at, chars: 0, preview: '' };
        this.markDirty();
        return;
      case 'text_delta': {
        if (!this.activity || this.activity.kind !== 'text') {
          this.activity = { kind: 'text', startedAt: event.at, chars: 0, preview: '' };
        }
        this.activity.chars += event.text.length;
        this.markDirty();
        return;
      }
      case 'text_end': {
        this.activity = null;
        const bits = [`${event.text.length} 字`];
        if (event.durationMs >= 1000) {
          bits.push(formatDuration(event.durationMs));
        }
        this.pushLine({ id: `text-${event.at}`, text: `✍️ 消息完成 · ${bits.join(' · ')}` });
        this.markDirty();
        return;
      }
      case 'tool': {
        const existing = this.toolLineIds.get(event.toolCallId);
        const toolName = toolDisplayName(event.name, event.title);
        if (event.phase === 'pending') {
          if (!existing) {
            const id = `tool-${event.toolCallId}`;
            this.toolLineIds.set(event.toolCallId, id);
            this.pushLine({ id, text: `🔧 准备调用 · ${toolName}` });
          }
          this.activity = { kind: 'tool', startedAt: event.at, chars: 0, preview: '', toolCallId: event.toolCallId, label: toolName };
        } else if (event.phase === 'running') {
          const id = existing ?? `tool-${event.toolCallId}`;
          this.toolLineIds.set(event.toolCallId, id);
          this.updateLine(id, `🔧 执行中 · ${toolName}`);
          const sameTool = this.activity?.kind === 'tool' && this.activity.toolCallId === event.toolCallId;
          this.activity = {
            kind: 'tool',
            startedAt: sameTool ? (this.activity as ActiveActivity).startedAt : event.at,
            chars: 0,
            preview: '',
            toolCallId: event.toolCallId,
            label: toolName,
          };
        } else if (event.phase === 'completed') {
          const id = existing ?? `tool-${event.toolCallId}`;
          const seconds = event.durationMs !== undefined ? ` · ${formatDuration(event.durationMs)}` : '';
          const sub = config.opencode.showToolOutput && event.output
            ? previewText(event.output, this.debug ? config.opencode.toolOutputMax : Math.min(config.opencode.toolOutputMax, 90))
            : undefined;
          this.updateLine(id, `✅ ${toolName}${seconds}`, sub);
          if (this.activity?.kind === 'tool' && this.activity.toolCallId === event.toolCallId) {
            this.activity = null;
          }
        } else if (event.phase === 'failed') {
          const id = existing ?? `tool-${event.toolCallId}`;
          const sub = event.error
            ? previewText(event.error, this.debug ? config.opencode.toolOutputMax : Math.min(config.opencode.toolOutputMax, 90))
            : undefined;
          this.updateLine(id, `⚠️ ${toolName} · 失败`, sub);
          if (this.activity?.kind === 'tool' && this.activity.toolCallId === event.toolCallId) {
            this.activity = null;
          }
        }
        this.markDirty();
        return;
      }
      case 'permission': {
        this.pushLine({
          id: `perm-${event.at}`,
          text: event.decision === 'allowed' ? `🔐 已允许：${previewText(event.title, 60)}` : `🔐 已拒绝：${previewText(event.title, 60)}`,
        });
        this.markDirty();
        return;
      }
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
    this.outcome = outcome;
    this.activity = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const duration = formatDuration(outcome.durationMs);
    if (outcome.status === 'completed') {
      const usage = formatUsage(outcome.usage);
      this.pushLine({
        id: 'done',
        text: `🏁 完成 · 用时 ${duration}${usage ? ` · ${usage}` : ''}`,
      });
    } else if (outcome.status === 'cancelled') {
      this.pushLine({ id: 'done', text: `⏹️ 已取消 · 用时 ${duration}` });
    } else {
      this.pushLine({
        id: 'done',
        text: `❌ 失败 · 用时 ${duration}`,
        sub: outcome.error ? previewText(outcome.error, 160) : undefined,
      });
    }

    await this.flush(true);
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private headerTitle(): string {
    if (!this.done) {
      return '🤖 OpenCode · 执行中';
    }
    if (this.outcome?.status === 'completed') {
      return '✅ OpenCode · 已完成';
    }
    if (this.outcome?.status === 'cancelled') {
      return '⏹️ OpenCode · 已取消';
    }
    return '❌ OpenCode · 执行失败';
  }

  private headerTemplate(): string {
    if (!this.done) {
      return 'blue';
    }
    if (this.outcome?.status === 'completed') {
      return 'green';
    }
    if (this.outcome?.status === 'cancelled') {
      return 'grey';
    }
    return 'red';
  }

  private renderStatusLine(): string {
    if (this.done && this.outcome) {
      const duration = formatDuration(this.outcome.durationMs);
      const label = this.outcome.status === 'completed' ? '已完成' : this.outcome.status === 'cancelled' ? '已取消' : '执行失败';
      return `**状态：${label}** · 用时 ${duration}`;
    }
    const elapsed = formatClock(Date.now() - this.startedAt);
    if (this.activity) {
      if (this.activity.kind === 'thinking') {
        return `**💭 思考中…** · 已用 ${elapsed}${config.opencode.showThinking ? ` · 推理 ${this.activity.chars} 字` : ''}`;
      }
      if (this.activity.kind === 'tool') {
        const toolElapsed = formatDuration(Date.now() - this.activity.startedAt);
        return `**🛠️ 执行中：${escapeLarkMd(this.activity.label || '工具')}** · ${toolElapsed}`;
      }
      return `**✍️ 输出中…** · 已用 ${elapsed} · ${this.activity.chars} 字`;
    }
    return `**🔄 执行中** · 已用 ${elapsed}`;
  }

  private windowLines(): { lines: LogLine[]; hiddenCount: number } {
    const max = Math.max(4, config.opencode.statusLines);
    if (this.lines.length <= max) {
      return { lines: this.lines, hiddenCount: 0 };
    }
    return {
      lines: this.lines.slice(-max),
      hiddenCount: this.lines.length - max,
    };
  }

  private renderLogMarkdown(): string {
    const { lines, hiddenCount } = this.windowLines();
    const parts: string[] = [];
    if (hiddenCount > 0) {
      parts.push(`*…以及 ${hiddenCount} 条更早记录*`);
    }
    for (const line of lines) {
      parts.push(escapeLarkMd(line.text));
      if (line.sub) {
        parts.push(`> ${escapeLarkMd(line.sub)}`);
      }
    }
    return parts.join('\n') || '（等待活动…）';
  }

  private renderCard(): Record<string, unknown> {
    const footerBits = [`模型：${this.model || '默认'}`];
    const cmd = previewText(this.command.replace(/\s+/g, ' ').trim(), 60);
    if (cmd) {
      footerBits.push(`任务：${cmd}`);
    }

    return {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: this.headerTitle() },
        template: this.headerTemplate(),
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: this.renderStatusLine() },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: this.renderLogMarkdown() },
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: footerBits.join(' · ') }],
        },
      ],
    };
  }

  private renderText(): string {
    const { lines, hiddenCount } = this.windowLines();
    const parts: string[] = [];
    parts.push(this.renderStatusLine().replace(/\*\*/g, ''));
    if (hiddenCount > 0) {
      parts.push(`…以及 ${hiddenCount} 条更早记录`);
    }
    for (const line of lines) {
      parts.push(line.text);
      if (line.sub) {
        parts.push(`  ↳ ${line.sub}`);
      }
    }
    return parts.join('\n');
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
        if (!this.done && (this.dirty || this.activity)) {
          this.schedule();
        }
      });
    }, Math.max(wait, 50));
  }

  private async flush(force: boolean): Promise<void> {
    if (this.flushing) {
      this.dirty = true;
      return;
    }
    if (!force && !this.dirty) {
      // Live timer refresh while an activity is running
      if (!(this.activity && Date.now() - this.lastFlushAt >= config.opencode.statusInterval)) {
        return;
      }
    }

    this.flushing = true;
    this.dirty = false;
    try {
      if (this.carrier === 'card') {
        const card = this.renderCard();
        if (!this.messageId) {
          const messageId = await this.sink.sendCard(this.chatId, card);
          if (!messageId) {
            throw new Error('card send did not return a message id');
          }
          this.messageId = messageId;
        } else {
          await this.sink.patchCard(this.chatId, this.messageId, card);
        }
      } else if (this.carrier === 'text') {
        const text = this.renderText();
        if (!this.messageId) {
          const messageId = await this.sink.sendText(this.chatId, text);
          this.messageId = messageId;
        } else if (this.editCount < 18) {
          await this.sink.editText(this.chatId, this.messageId, text);
          this.editCount += 1;
        } else {
          const messageId = await this.sink.sendText(this.chatId, text);
          this.messageId = messageId;
          this.editCount = 0;
        }
      } else {
        const text = this.renderText();
        const now = Date.now();
        if (now - this.burstLastAt >= 3000 && text !== this.burstLastText) {
          await this.sink.sendText(this.chatId, text);
          this.burstLastAt = now;
          this.burstLastText = text;
        }
      }
      this.lastFlushAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.degrade(message);
    } finally {
      this.flushing = false;
    }
  }

  private degrade(reason: string): void {
    if (this.carrier === 'card') {
      logger.warn(`Live card update failed (${reason}); falling back to text message editing`);
      this.carrier = 'text';
      this.messageId = undefined;
      this.editCount = 0;
      this.dirty = true;
      this.schedule();
      return;
    }
    if (this.carrier === 'text') {
      logger.warn(`Status text edit failed (${reason}); falling back to rate-limited messages`);
      this.carrier = 'burst';
      this.messageId = undefined;
      this.burstLastAt = 0;
      this.dirty = true;
      this.schedule();
      return;
    }
    logger.warn(`Status message delivery failed: ${reason}`);
  }

  private pushLine(line: LogLine): void {
    this.lines.push(line);
  }

  private updateLine(id: string, text: string, sub?: string): void {
    const line = this.lines.find(item => item.id === id);
    if (line) {
      line.text = text;
      if (sub !== undefined) {
        line.sub = sub;
      }
      return;
    }
    this.extraLineSeq += 1;
    this.lines.push({ id: id || `line-${this.extraLineSeq}`, text, sub });
  }
}

// ----------------------------------------------------------------------
// Formatting helpers
// ----------------------------------------------------------------------

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

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatUsage(usage?: TokenUsage): string {
  if (!usage) {
    return '';
  }
  const bits: string[] = [];
  const total = usage.totalTokens ?? (usage.inputTokens || 0) + (usage.outputTokens || 0);
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
  const compact = text.replace(/\r/g, '').trim();
  if (!compact) {
    return '';
  }
  const firstLines = compact.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' / ');
  const single = firstLines || compact;
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function toolDisplayName(name: string, title?: string): string {
  const cleanTitle = title ? title.replace(/\s+/g, ' ').trim() : '';
  if (cleanTitle && cleanTitle.toLowerCase() !== name.toLowerCase()) {
    return cleanTitle.length > 80 ? `${cleanTitle.slice(0, 80)}…` : cleanTitle;
  }
  return name;
}

function escapeLarkMd(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
