import { EventEmitter } from 'node:events';
import * as acp from '@agentclientprotocol/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ActivityEvent, TokenUsage } from '../types.js';
import type { AcpConnection } from './acp-connection.js';

interface ToolState {
  startedAt: number;
  name: string;
  title?: string;
}

/**
 * Wraps one ACP session (one bridge conversation) and translates the raw
 * ACP session/update stream into high-level ActivityEvents.
 *
 * Events: 'activity' (ActivityEvent), 'prompt_error' (Error)
 */
export class LiveSession extends EventEmitter {
  readonly acpSession: acp.ActiveSession;
  private readonly connection: AcpConnection;
  private busy = false;
  private disposed = false;

  // Streaming state
  private inThinking = false;
  private thinkingStartedAt = 0;
  private thinkingChars = 0;
  private latestReasoning = '';

  private inText = false;
  private textStartedAt = 0;
  private textBuffer = '';
  private textMessageId?: string;

  private tools = new Map<string, ToolState>();
  private lastUsage?: TokenUsage;
  private availableCommands: Array<{ name: string; description?: string }> = [];

  constructor(connection: AcpConnection, acpSession: acp.ActiveSession) {
    super();
    this.connection = connection;
    this.acpSession = acpSession;
    void this.drain();
  }

  get sessionId(): string {
    return this.acpSession.sessionId;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get usage(): TokenUsage | undefined {
    return this.lastUsage;
  }

  get commands(): Array<{ name: string; description?: string }> {
    return this.availableCommands;
  }

  get configOptions(): Array<{ id: string; name?: string; currentValue?: unknown; options?: unknown }> {
    const raw = this.acpSession.newSessionResponse as { configOptions?: unknown };
    const options = Array.isArray(raw.configOptions) ? raw.configOptions : [];
    return options as Array<{ id: string; name?: string; currentValue?: unknown; options?: unknown }>;
  }

  /** Send a prompt. Bridge side must serialize: call only while not busy. */
  prompt(blocks: string | acp.ContentBlock | acp.ContentBlock[]): void {
    if (this.disposed) {
      throw new Error('session disposed');
    }
    if (this.busy) {
      throw new Error('session busy');
    }
    this.busy = true;
    this.turnStartedAt = Date.now();
    this.emitActivity({ type: 'turn_start', at: this.turnStartedAt });

    this.acpSession.prompt(blocks).then(
      () => {
        // Final response is delivered through the update stream ('stop' message).
      },
      (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(`ACP prompt failed for session ${this.sessionId}: ${err.message}`);
        this.emit('prompt_error', err);
      },
    );
  }

  private turnStartedAt = 0;

  async cancel(): Promise<void> {
    try {
      await this.connection.ctx.notify(acp.methods.agent.session.cancel, {
        sessionId: this.acpSession.sessionId,
      });
      logger.info(`Cancelled ACP session ${this.sessionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to cancel ACP session ${this.sessionId}: ${message}`);
    }
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    await this.connection.ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.acpSession.sessionId,
      configId,
      value,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.acpSession.dispose();
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------------
  // Update stream handling
  // ------------------------------------------------------------------

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const message = await this.acpSession.nextUpdate();
        if (this.disposed) {
          return;
        }
        if (message.kind === 'stop') {
          this.handleStop(message.stopReason, (message.response as { usage?: TokenUsage }).usage);
        } else {
          this.handleUpdate(message.update as acp.SessionUpdate);
        }
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`ACP update stream ended for session ${this.sessionId}: ${message}`);
      this.emit('stream_end', message);
    }
  }

  private handleStop(stopReason: string | undefined, responseUsage?: TokenUsage): void {
    this.closeThinking();
    this.closeTextBlock();
    const durationMs = this.turnStartedAt > 0 ? Date.now() - this.turnStartedAt : 0;
    const usage = responseUsage || this.lastUsage;
    this.busy = false;
    this.emitActivity({
      type: 'turn_end',
      at: Date.now(),
      stopReason,
      usage,
      durationMs,
    });
  }

  private handleUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        const text = textOf(update.content);
        if (!config.opencode.showThinking || text === undefined) {
          return;
        }
        if (!this.inThinking) {
          this.inThinking = true;
          this.thinkingStartedAt = Date.now();
          this.thinkingChars = 0;
          this.latestReasoning = '';
          this.emitActivity({ type: 'thinking_start', at: this.thinkingStartedAt });
        }
        this.thinkingChars += text.length;
        this.latestReasoning += text;
        this.emitActivity({ type: 'thinking_delta', at: Date.now(), text });
        return;
      }
      case 'agent_message_chunk': {
        const text = textOf(update.content);
        if (text === undefined) {
          return;
        }
        this.closeThinking();
        const messageId = (update as { messageId?: string }).messageId;
        if (this.inText && messageId !== undefined && this.textMessageId !== undefined && messageId !== this.textMessageId) {
          this.closeTextBlock();
        }
        if (!this.inText) {
          this.inText = true;
          this.textStartedAt = Date.now();
          this.textBuffer = '';
          this.textMessageId = messageId;
          this.emitActivity({ type: 'text_start', at: this.textStartedAt, messageId });
        }
        this.textBuffer += text;
        this.emitActivity({ type: 'text_delta', at: Date.now(), text });
        return;
      }
      case 'tool_call': {
        this.closeThinking();
        this.closeTextBlock();
        const toolCallId = update.toolCallId;
        this.tools.set(toolCallId, {
          startedAt: Date.now(),
          name: update.name ?? 'tool',
          title: update.title ?? undefined,
        });
        this.emitActivity({
          type: 'tool',
          at: Date.now(),
          toolCallId,
          name: update.name ?? 'tool',
          phase: 'pending',
          title: update.title ?? undefined,
          kind: update.kind ?? undefined,
        });
        return;
      }
      case 'tool_call_update': {
        this.closeThinking();
        const toolCallId = update.toolCallId;
        const state = this.tools.get(toolCallId);
        const name = (update as { name?: string }).name || state?.name || 'tool';
        const title = update.title ?? state?.title;
        const phase = normalizeToolPhase(update.status);

        if (phase === 'running') {
          if (state && !state.title && title) {
            state.title = title;
          }
          this.emitActivity({
            type: 'tool',
            at: Date.now(),
            toolCallId,
            name,
            phase: 'running',
            title,
            kind: update.kind ?? undefined,
          });
          return;
        }
        if (phase === 'completed' || phase === 'failed') {
          const durationMs = state ? Date.now() - state.startedAt : undefined;
          this.tools.delete(toolCallId);
          const output = extractToolText(update);
          const rawError = (update.rawOutput as { error?: unknown } | undefined)?.error;
          this.emitActivity({
            type: 'tool',
            at: Date.now(),
            toolCallId,
            name,
            phase,
            title,
            durationMs,
            output,
            error: phase === 'failed' ? (typeof rawError === 'string' ? rawError : output) : undefined,
          });
          return;
        }
        return;
      }
      case 'config_option_update': {
        this.emit('config_options', (update as { configOptions?: unknown }).configOptions);
        return;
      }
      case 'available_commands_update': {
        const commands = (update as { availableCommands?: Array<{ name: string; description?: string }> })
          .availableCommands;
        if (Array.isArray(commands)) {
          this.availableCommands = commands;
        }
        return;
      }
      case 'usage_update': {
        const usage = (update as { usage?: unknown }).usage;
        if (usage && typeof usage === 'object') {
          this.emitActivity({ type: 'usage', at: Date.now(), usage: usage as TokenUsage });
        }
        return;
      }
      default:
        return;
    }
  }

  private closeThinking(): void {
    if (!this.inThinking) {
      return;
    }
    this.inThinking = false;
    const durationMs = Date.now() - this.thinkingStartedAt;
    this.emitActivity({
      type: 'thinking_end',
      at: Date.now(),
      durationMs,
      chars: this.thinkingChars,
    });
  }

  private closeTextBlock(): void {
    if (!this.inText) {
      return;
    }
    this.inText = false;
    const text = this.textBuffer;
    const durationMs = Date.now() - this.textStartedAt;
    this.textBuffer = '';
    if (text.trim()) {
      this.emitActivity({
        type: 'text_end',
        at: Date.now(),
        text,
        durationMs,
        messageId: this.textMessageId,
      });
    }
    this.textMessageId = undefined;
  }

  private emitActivity(event: ActivityEvent): void {
    if (event.type === 'usage') {
      this.lastUsage = event.usage;
    }
    this.emit('activity', event);
  }
}

function textOf(content: { type?: string; text?: unknown } | undefined): string | undefined {
  if (!content || content.type !== 'text') {
    return undefined;
  }
  return typeof content.text === 'string' ? content.text : undefined;
}

function normalizeToolPhase(status: unknown): 'pending' | 'running' | 'completed' | 'failed' | 'other' {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'in_progress') {
    return 'running';
  }
  if (status === 'pending') {
    return 'pending';
  }
  return 'other';
}

function extractToolText(update: acp.SessionUpdate): string | undefined {
  const content = (update as { content?: Array<{ type?: string; content?: { type?: string; text?: string } }> })
    .content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item?.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string') {
      parts.push(item.content.text);
    }
  }
  const merged = parts.join('\n').trim();
  return merged || undefined;
}
