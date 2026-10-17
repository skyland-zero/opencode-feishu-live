import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { FeishuBot } from './bot/feishu-bot.js';
import { config } from './config.js';
import { AcpConnection } from './agent/acp-connection.js';
import { LiveSession } from './agent/live-session.js';
import { classifyIntent } from './agent/intent-router.js';
import { LiveCard, formatDuration, formatUsage, type StatusSink } from './status/live-card.js';
import { StatusBubble } from './status/status-bubble.js';
import type { StatusReporter } from './status/reporter.js';
import { MessageHandler } from './relay/message-handler.js';
import type {
  ActivityEvent,
  BotResponse,
  FeishuMessageEvent,
  NotificationMode,
  TaskInfo,
  TaskResponseMode,
  TokenUsage,
} from './types.js';
import { logger } from './utils/logger.js';

interface QueuedTurn {
  taskId: string;
  command: string;
  blocks: acp.ContentBlock[];
  mode: TaskResponseMode;
  /** Feishu message id of the user's triggering message (reply anchor). */
  replyTo?: string;
}

interface ManagedSession {
  bridgeId: string;
  chatId: string;
  live: LiveSession;
  running: boolean;
  currentTaskId?: string;
  currentReporter?: StatusReporter;
  queue: QueuedTurn[];
  creating?: Promise<ManagedSession>;
}

export class OpenCodeFeishuLive {
  private readonly bot: FeishuBot;
  private readonly handler: MessageHandler;
  private readonly connection: AcpConnection;

  private sessions = new Map<string, ManagedSession>();
  private tasks = new Map<string, TaskInfo>();
  private acpSessionIndex = new Map<string, string>(); // acp sessionId -> bridgeId
  private sessionNotifyMode = new Map<string, NotificationMode>();
  private desiredModel = new Map<string, string>();
  private pendingFiles = new Map<string, string[]>();
  private lastConfigCatalog: Array<{ id: string; name?: string; currentValue?: unknown; options?: unknown }> = [];

  private readonly uploadStagingDir = join(config.opencode.workingDir, '.feishu_uploads');
  private readonly MAX_PENDING_FILES = 5;
  private readonly MAX_TEXT_CHUNK = 2800;
  private readonly MAX_QUEUE = 3;
  private isStopping = false;

  constructor() {
    this.bot = new FeishuBot(config.feishu);
    this.handler = new MessageHandler();
    this.connection = new AcpConnection();
  }

  async start(): Promise<void> {
    logger.info('Starting OpenCode Feishu Live bridge...');

    this.bot.on('message', (event: FeishuMessageEvent) => {
      void this.handleIncomingMessage(event).catch((error: unknown) => {
        logger.error('Unhandled message processing error:', error);
      });
    });

    this.connection.on('permission', (info: { sessionId: string; title: string; decision: string }) => {
      const bridgeId = this.acpSessionIndex.get(info.sessionId);
      if (!bridgeId) {
        return;
      }
      const managed = this.sessions.get(bridgeId);
      managed?.currentReporter?.handleActivity({
        type: 'permission',
        at: Date.now(),
        title: info.title,
        decision: info.decision === 'allowed' ? 'allowed' : 'rejected',
      });
    });

    this.connection.on('disconnected', (reason: string) => {
      logger.warn(`ACP agent disconnected (${reason}); failing active turns`);
      void this.failAllActiveTurns('OpenCode 进程连接中断，任务已中断，请重发');
    });

    await this.connection.start().catch((error: unknown) => {
      logger.error(`Initial ACP start failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.bot.start();

    logger.info(`Bridge started successfully (v${config.version})`);
    logger.info(`Work dir: ${config.opencode.workingDir}`);
    logger.info('Waiting for Feishu messages...');
  }

  async stop(): Promise<void> {
    if (this.isStopping) {
      return;
    }
    this.isStopping = true;
    logger.info('Shutting down...');
    for (const managed of this.sessions.values()) {
      managed.live.dispose();
    }
    await this.bot.stop();
    await this.connection.stop();
    logger.info('Bridge stopped');
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Message intake
  // ------------------------------------------------------------------

  private async handleIncomingMessage(event: FeishuMessageEvent): Promise<void> {
    const message = event.event?.message;
    const senderType = event.event?.sender?.sender_type || '';
    if (senderType !== 'user') {
      return;
    }

    const chatId = message?.chat_id || '';
    if (!chatId) {
      return;
    }

    const senderId = this.extractSenderId(event);
    const bridgeId = `${senderId}:${chatId}`;

    if (config.security.allowedUsers.length > 0 && !config.security.allowedUsers.includes(senderId)) {
      logger.warn(`Ignoring message from unauthorized user ${senderId}`);
      return;
    }

    try {
      if (message?.message_type === 'file') {
        await this.handleIncomingFileMessage(event, bridgeId, chatId);
        return;
      }

      const response = await this.handler.handleMessage(event);
      if (!response) {
        return;
      }

      await this.dispatchResponse(bridgeId, chatId, senderId, response, message?.message_id || '');
    } catch (error) {
      logger.error('Error handling message:', error);
      await this.bot.sendMessage(chatId, '❌ 处理消息失败，请稍后重试。', 'text', message?.message_id || undefined);
    }
  }

  private async dispatchResponse(
    bridgeId: string,
    chatId: string,
    senderId: string,
    response: BotResponse,
    messageId: string,
  ): Promise<void> {
    if (response.text && !response.executeCommand) {
      await this.sendText(chatId, response.text, messageId);
    }

    if (response.resetSession) {
      this.dropSession(bridgeId);
    }

    if (response.modelCommand) {
      await this.handleModelCommand(bridgeId, chatId, response.modelCommand.action, response.modelCommand.model, messageId);
      return;
    }

    if (response.notifyCommand) {
      await this.handleNotifyCommand(bridgeId, chatId, response.notifyCommand.action, response.notifyCommand.mode, messageId);
      return;
    }

    if (response.sendFilePath) {
      await this.handleSendFileCommand(chatId, response.sendFilePath, messageId);
      return;
    }

    if (response.cancelTask) {
      await this.handleCancel(bridgeId, chatId, messageId);
      return;
    }

    if (response.executeCommand) {
      await this.startTurn(bridgeId, chatId, senderId, messageId, response);
    }
  }

  private async startTurn(
    bridgeId: string,
    chatId: string,
    senderId: string,
    messageId: string,
    response: BotResponse,
  ): Promise<void> {
    const command = response.executeCommand || '';
    const files = this.consumePendingFiles(bridgeId);
    const mode = await this.resolveResponseMode(bridgeId, response.intentHint || 'task', command);
    const replyTo = messageId || undefined;

    if (files.length > 0 && mode !== 'silent') {
      const names = files.map(file => basename(file)).join(', ');
      await this.sendText(chatId, `📎 已附带文件：${names}`, replyTo);
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task: TaskInfo = {
      id: taskId,
      status: 'queued',
      responseMode: mode,
      command,
      userId: senderId,
      chatId,
      messageId,
      createdAt: new Date(),
      output: [],
    };
    this.tasks.set(taskId, task);
    this.handler.addTaskToSession(bridgeId, task);

    const blocks = await this.buildPromptBlocks(command, files, response.intentHint || 'task');

    let managed: ManagedSession;
    try {
      managed = await this.ensureSession(bridgeId, chatId);
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      this.handler.updateTask(task);
      await this.sendText(chatId, `❌ 无法连接 OpenCode：${task.error}`, replyTo);
      return;
    }

    if (managed.running) {
      if (managed.queue.length >= this.MAX_QUEUE) {
        await this.sendText(chatId, '⚠️ 当前还有任务在排队，请等前面的任务完成或发送 `!stop` 中断。', replyTo);
        return;
      }
      managed.queue.push({ taskId, command, blocks, mode, replyTo });
      if (mode !== 'silent') {
        await this.sendText(chatId, `⏳ 已排队（前面还有 ${managed.queue.length} 条任务）`, replyTo);
      }
      return;
    }

    await this.runTurn(managed, { taskId, command, blocks, mode, replyTo });
  }

  // ------------------------------------------------------------------
  // Turn execution
  // ------------------------------------------------------------------

  private async runTurn(managed: ManagedSession, turn: QueuedTurn): Promise<void> {
    const task = this.tasks.get(turn.taskId);
    if (!task) {
      return;
    }

    const chatId = managed.chatId;
    const mode = turn.mode;
    managed.running = true;
    managed.currentTaskId = turn.taskId;
    task.status = 'running';
    task.startedAt = new Date();
    task.opencodeSessionId = managed.live.sessionId;
    this.handler.updateTask(task);

    const reporter = this.buildStatusReporter(mode, chatId, turn.command, managed.bridgeId);
    managed.currentReporter = reporter;
    if (reporter) {
      await reporter.start();
    }

    const collectedBlocks: string[] = [];
    let heldText = '';
    let finalized = false;
    let turnError: Error | undefined;
    let stopReason: string | undefined;
    let usage: TokenUsage | undefined;
    let turnDurationMs = 0;
    let interimChain: Promise<void> = Promise.resolve();
    const replyTo = turn.replyTo;

    const flushHeld = async (): Promise<void> => {
      const pending = heldText.trim();
      heldText = '';
      if (pending.length === 0) {
        return;
      }
      await this.sendText(chatId, pending, replyTo);
    };

    const onActivity = (event: ActivityEvent): void => {
      reporter?.handleActivity(event);
      if (event.type === 'text_end') {
        collectedBlocks.push(event.text);
        task.output.push(event.text);
        interimChain = interimChain
          .then(async () => {
            if (mode === 'silent' || !config.opencode.interimTextEnabled) {
              return;
            }
            const trimmed = event.text.trim();
            if (!trimmed) {
              return;
            }
            if (trimmed.length < config.opencode.interimTextMinChars) {
              heldText += `${trimmed}\n\n`;
              return;
            }
            await flushHeld();
            await this.sendText(chatId, trimmed, replyTo);
            reporter?.noteContentSent();
          })
          .catch((error: unknown) => {
            logger.warn(`Failed to forward interim text: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
    };

    const turnEnd = new Promise<void>((resolveEnd) => {
      const onTurnEnd = (event: ActivityEvent): void => {
        if (event.type === 'turn_end') {
          finalized = true;
          stopReason = event.stopReason;
          usage = event.usage;
          turnDurationMs = event.durationMs;
          managed.live.removeListener('activity', onTurnEnd);
          resolveEnd();
          return;
        }
      };
      managed.live.on('activity', onTurnEnd);
    });

    const onPromptError = (error: Error): void => {
      turnError = error;
    };
    managed.live.on('prompt_error', onPromptError);
    managed.live.on('activity', onActivity);

    try {
      managed.live.prompt(turn.blocks);
      await turnEnd;
    } catch (error) {
      turnError = error instanceof Error ? error : new Error(String(error));
    } finally {
      managed.live.removeListener('activity', onActivity);
      managed.live.removeListener('prompt_error', onPromptError);
    }

    if (!finalized && !turnError) {
      turnError = new Error('任务未正常结束（连接可能已中断）');
    }

    // Flush any queued interim sends, then held small text blocks
    await interimChain;
    if (mode !== 'silent') {
      await flushHeld().catch((error: unknown) => {
        logger.warn(`Failed to flush held text: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const cancelled = stopReason === 'cancelled';
    const status: 'completed' | 'failed' | 'cancelled' = turnError
      ? 'failed'
      : cancelled
        ? 'cancelled'
        : 'completed';

    task.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    task.completedAt = new Date();
    task.duration = turnDurationMs;
    task.stopReason = stopReason;
    task.usage = usage;
    if (turnError) {
      task.error = turnError.message;
    }
    this.handler.updateTask(task);

    if (reporter) {
      await reporter.finalize({
        status,
        durationMs: turnDurationMs,
        usage,
        error: turnError?.message,
        stopReason,
      });
    }

    await this.sendCompletionMessage(chatId, mode, {
      status,
      durationMs: turnDurationMs,
      usage,
      error: turnError?.message,
      interimEnabled: config.opencode.interimTextEnabled && mode !== 'silent',
      hasBlocks: collectedBlocks.length > 0,
      blocks: collectedBlocks,
      suppressFooter: Boolean(reporter),
      replyTo,
    });

    managed.running = false;
    managed.currentTaskId = undefined;
    managed.currentReporter = undefined;

    const next = managed.queue.shift();
    if (next) {
      await this.runTurn(managed, next);
    }
  }

  // ------------------------------------------------------------------
  // Turn helpers
  // ------------------------------------------------------------------

  private async sendCompletionMessage(
    chatId: string,
    mode: TaskResponseMode,
    info: {
      status: 'completed' | 'failed' | 'cancelled';
      durationMs: number;
      usage?: TokenUsage;
      error?: string;
      interimEnabled: boolean;
      hasBlocks: boolean;
      blocks: string[];
      /** True when a status reporter (bubble/card) already carries the completion line. */
      suppressFooter: boolean;
      /** Feishu message id to reply-link these messages to. */
      replyTo?: string;
    },
  ): Promise<void> {
    const footerBits: string[] = [];
    if (info.status === 'completed') {
      footerBits.push('✅ 完成');
    } else if (info.status === 'cancelled') {
      footerBits.push('⏹️ 已取消');
    } else {
      footerBits.push('❌ 失败');
    }
    footerBits.push(`用时 ${formatDuration(info.durationMs)}`);
    const usageText = formatUsage(info.usage);
    if (usageText) {
      footerBits.push(usageText);
    }
    const footer = footerBits.join(' · ');

    if (info.status === 'failed' && info.error) {
      await this.sendText(chatId, `${footer}\n原因：${info.error}`, info.replyTo);
      return;
    }

    if (mode === 'silent' || !info.interimEnabled) {
      const joined = info.blocks.map(block => block.trim()).filter(Boolean).join('\n\n');
      const keepFooter = config.opencode.completionFooterEnabled && mode !== 'silent' && !info.suppressFooter;
      if (joined) {
        const suffix = keepFooter ? `\n\n———\n${footer}` : '';
        await this.sendText(chatId, `${joined}${suffix}`, info.replyTo);
      } else if (keepFooter || info.status !== 'completed') {
        await this.sendText(chatId, footer, info.replyTo);
      }
      return;
    }

    const keepFooter = config.opencode.completionFooterEnabled && !info.suppressFooter;
    if (keepFooter || info.status !== 'completed') {
      await this.sendText(chatId, footer, info.replyTo);
    }
  }

  // ------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------

  private async ensureSession(bridgeId: string, chatId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(bridgeId);
    if (existing) {
      return existing;
    }

    const ready = await this.connection.waitReady(20000);
    if (!ready) {
      await this.connection.start().catch(() => undefined);
      if (!(await this.connection.waitReady(10000))) {
        throw new Error('OpenCode ACP 连接尚未就绪');
      }
    }

    const session = await this.connection.ctx.buildSession({
      cwd: config.opencode.workingDir,
      mcpServers: [],
    }).start();

    const live = new LiveSession(this.connection, session);
    const managed: ManagedSession = {
      bridgeId,
      chatId,
      live,
      running: false,
      queue: [],
    };
    this.sessions.set(bridgeId, managed);
    this.acpSessionIndex.set(live.sessionId, bridgeId);
    this.lastConfigCatalog = live.configOptions;

    logger.info(`Created ACP session ${live.sessionId} for ${bridgeId} (cwd=${config.opencode.workingDir})`);

    const desired = this.desiredModel.get(bridgeId);
    if (desired) {
      try {
        await live.setConfigOption('model', desired);
        logger.info(`Applied session model override: ${desired}`);
      } catch (error) {
        logger.warn(`Failed to apply model ${desired}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return managed;
  }

  private dropSession(bridgeId: string): void {
    const managed = this.sessions.get(bridgeId);
    if (!managed) {
      return;
    }
    this.acpSessionIndex.delete(managed.live.sessionId);
    managed.live.dispose();
    this.sessions.delete(bridgeId);
    logger.info(`Dropped ACP session for ${bridgeId}`);
  }

  private async failAllActiveTurns(message: string): Promise<void> {
    for (const managed of this.sessions.values()) {
      const reporter = managed.currentReporter;
      const taskId = managed.currentTaskId;
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (task) {
        task.status = 'failed';
        task.error = message;
        task.completedAt = new Date();
        this.handler.updateTask(task);
      }
      if (reporter && !reporter.isFinalized) {
        await reporter.finalize({ status: 'failed', durationMs: 0, error: message });
      }
      managed.live.dispose();
      this.acpSessionIndex.delete(managed.live.sessionId);
      managed.running = false;
      managed.currentReporter = undefined;
      managed.currentTaskId = undefined;
      managed.queue = [];
    }
    this.sessions.clear();
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  private async handleModelCommand(
    bridgeId: string,
    chatId: string,
    action: 'list' | 'current' | 'set' | 'reset',
    model?: string,
    replyTo?: string,
  ): Promise<void> {
    if (action === 'list') {
      let catalog = this.lastConfigCatalog;
      const managed = this.sessions.get(bridgeId);
      if (managed) {
        catalog = managed.live.configOptions;
      }
      const modelOption = catalog.find(option => option.id === 'model');
      const options = Array.isArray(modelOption?.options) ? (modelOption?.options as Array<{ value: string; name?: string }>) : [];
      if (options.length === 0) {
        await this.sendText(chatId, '⚠️ 暂未获取到模型列表，请先发送一条消息建立会话后重试。', replyTo);
        return;
      }
      const lines = options.map((item, index) => `${index + 1}. ${item.value}`);
      await this.sendText(chatId, `📚 可用模型（${options.length}）\n${lines.join('\n')}`, replyTo);
      return;
    }

    if (action === 'current') {
      const managed = this.sessions.get(bridgeId);
      let current: string | undefined;
      if (managed) {
        const modelOption = managed.live.configOptions.find(option => option.id === 'model');
        if (typeof modelOption?.currentValue === 'string') {
          current = modelOption.currentValue;
        }
      }
      current = current || this.desiredModel.get(bridgeId) || config.opencode.model;
      await this.sendText(chatId, current ? `🎯 当前会话模型：\`${current}\`` : '🎯 当前会话模型：默认（自动检测）', replyTo);
      return;
    }

    if (action === 'reset') {
      this.desiredModel.delete(bridgeId);
      const managed = this.sessions.get(bridgeId);
      if (managed) {
        try {
          const modelOption = managed.live.configOptions.find(option => option.id === 'model');
          const options = Array.isArray(modelOption?.options) ? (modelOption?.options as Array<{ value: string }>) : [];
          const fallback = config.opencode.model || options[0]?.value;
          if (fallback) {
            await managed.live.setConfigOption('model', fallback);
          }
        } catch (error) {
          logger.warn(`Model reset failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await this.sendText(chatId, `♻️ 已恢复默认模型${config.opencode.model ? `：\`${config.opencode.model}\`` : ''}`, replyTo);
      return;
    }

    const target = (model || '').trim();
    if (!target) {
      await this.sendText(chatId, '用法：`/model <model_id>`，或 `/model list` 查看可用模型。', replyTo);
      return;
    }

    const managed = this.sessions.get(bridgeId);
    if (!managed) {
      // Apply at next session creation
      this.desiredModel.set(bridgeId, target);
      await this.sendText(chatId, `✅ 已记录模型偏好：\`${target}\`（下条消息生效）`, replyTo);
      return;
    }

    const modelOption = managed.live.configOptions.find(option => option.id === 'model');
    const options = Array.isArray(modelOption?.options) ? (modelOption?.options as Array<{ value: string }>) : [];
    if (options.length > 0 && !options.some(item => item.value === target)) {
      const suggestions = options.filter(item => item.value.toLowerCase().includes(target.toLowerCase())).slice(0, 5);
      const suggestText = suggestions.length > 0
        ? `\n你可能想用：\n${suggestions.map(item => `- ${item.value}`).join('\n')}`
        : '';
      await this.sendText(chatId, `❌ 模型不存在：\`${target}\`\n请先用 \`/model list\` 查看可用模型。${suggestText}`, replyTo);
      return;
    }

    try {
      await managed.live.setConfigOption('model', target);
      this.desiredModel.set(bridgeId, target);
      await this.sendText(chatId, `✅ 已切换会话模型为：\`${target}\``, replyTo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendText(chatId, `❌ 切换模型失败：${message}`, replyTo);
    }
  }

  private async handleNotifyCommand(
    bridgeId: string,
    chatId: string,
    action: 'current' | 'set',
    mode?: NotificationMode,
    replyTo?: string,
  ): Promise<void> {
    if (action === 'current') {
      const current = this.sessionNotifyMode.get(bridgeId) || config.opencode.notifyDefaultMode;
      await this.sendText(
        chatId,
        `🔔 当前推送模式：\`${current}\`\n${this.describeNotifyMode(current)}\n默认模式：\`${config.opencode.notifyDefaultMode}\``,
        replyTo,
      );
      return;
    }

    if (!mode) {
      await this.sendText(chatId, '用法：`/notify quiet|normal|debug` 或 `/notify current`', replyTo);
      return;
    }

    this.sessionNotifyMode.set(bridgeId, mode);
    await this.sendText(chatId, `✅ 已切换推送模式为：\`${mode}\`\n${this.describeNotifyMode(mode)}`, replyTo);
  }

  private describeNotifyMode(mode: NotificationMode): string {
    if (mode === 'quiet') {
      return '只发消息（过程文本 + 结果），不显示进度气泡。';
    }
    if (mode === 'normal') {
      return 'Hermes 风格进度气泡（思考/工具行原地刷新）+ 过程文本 + 结果。';
    }
    return '进度气泡 + 过程文本 + 推理预览 + 更详细的工具输出。';
  }

  private async handleCancel(bridgeId: string, chatId: string, replyTo?: string): Promise<void> {
    const managed = this.sessions.get(bridgeId);
    if (!managed || !managed.running) {
      await this.sendText(chatId, '当前没有正在执行的任务。', replyTo);
      return;
    }
    await managed.live.cancel();
    await this.sendText(chatId, '⏹️ 正在中断当前任务…', replyTo);
  }

  private async handleSendFileCommand(chatId: string, filePathInput: string, replyTo?: string): Promise<void> {
    const resolvedPath = this.resolveFilePath(filePathInput);
    await access(resolvedPath, fsConstants.R_OK);
    await this.bot.sendFile(chatId, resolvedPath);
    await this.sendText(chatId, `✅ 文件已发送：\`${basename(resolvedPath)}\``, replyTo);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private buildSink(): StatusSink {
    return {
      sendCard: async (chatId, card) => this.bot.sendMessage(chatId, JSON.stringify(card), 'interactive'),
      patchCard: async (_chatId, messageId, card) => this.bot.patchCard(messageId, card),
      sendText: async (chatId, text) => this.bot.sendMessage(chatId, text),
      editText: async (_chatId, messageId, text) => this.bot.editTextMessage(messageId, text),
    };
  }

  private buildStatusReporter(
    mode: TaskResponseMode,
    chatId: string,
    command: string,
    bridgeId: string,
  ): StatusReporter | undefined {
    if (mode !== 'normal' && mode !== 'debug') {
      return undefined;
    }
    if (!config.opencode.statusEnabled || config.opencode.statusMode === 'off') {
      return undefined;
    }
    const sink = this.buildSink();
    if (config.opencode.statusMode === 'card') {
      return new LiveCard({
        sink,
        chatId,
        command,
        model: this.desiredModel.get(bridgeId) || config.opencode.model,
        mode,
      });
    }
    return new StatusBubble({ sink, chatId, mode });
  }

  private async resolveResponseMode(
    bridgeId: string,
    intentHint: string,
    command: string,
  ): Promise<TaskResponseMode> {
    const defaultMode = this.sessionNotifyMode.get(bridgeId) || config.opencode.notifyDefaultMode;
    if (intentHint === 'task') {
      return defaultMode;
    }
    if (intentHint === 'chat') {
      return 'silent';
    }
    if (!config.opencode.intentRoutingEnabled) {
      return defaultMode;
    }
    const routing = await classifyIntent(command);
    logger.info(`Intent routing: label=${routing.label} confidence=${routing.confidence.toFixed(2)}`);
    if (routing.label === 'chat' && routing.confidence >= config.opencode.intentRoutingConfidence) {
      return 'silent';
    }
    return defaultMode;
  }

  private async buildPromptBlocks(
    command: string,
    files: string[],
    intentHint: string,
  ): Promise<acp.ContentBlock[]> {
    const blocks: acp.ContentBlock[] = [];
    let text = command;

    if (config.opencode.executePolicyPrompt) {
      text = `${config.opencode.executePolicyPrompt}\n\n用户请求：\n${text}`;
    }

    if (intentHint === 'task' && containsDetailedRequest(command)) {
      text = `${text}\n\n（请针对上面的请求给出详细说明，不要压缩成简短结论。）`;
    }

    blocks.push({ type: 'text', text });

    for (const filePath of files) {
      const mime = guessMime(filePath);
      blocks.push({
        type: 'resource_link',
        uri: `file://${filePath}`,
        name: basename(filePath),
        mimeType: mime,
      });
    }

    return blocks;
  }

  private async sendText(chatId: string, text: string, replyTo?: string): Promise<void> {
    const chunks = splitText(text, this.MAX_TEXT_CHUNK);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      const body = chunks.length > 1 ? `（${index + 1}/${chunks.length}）\n${chunk}` : chunk;
      await this.bot.sendMessage(chatId, body, 'text', replyTo);
    }
  }

  private async handleIncomingFileMessage(
    event: FeishuMessageEvent,
    bridgeId: string,
    chatId: string,
  ): Promise<void> {
    const message = event.event?.message;
    if (!message?.message_id) {
      return;
    }

    const { fileKey, fileName } = this.parseFileContent(message.content);
    if (!fileKey) {
      await this.bot.sendMessage(chatId, '❌ 收到文件消息，但未解析到 file_key。', 'text', message.message_id);
      return;
    }

    await mkdir(this.uploadStagingDir, { recursive: true });
    const sessionDir = join(this.uploadStagingDir, bridgeId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await mkdir(sessionDir, { recursive: true });

    const safeName = (fileName || `file_${Date.now()}`).replace(/[^\w.\-]/g, '_');
    const localPath = join(sessionDir, `${Date.now()}_${safeName}`);

    await this.bot.downloadMessageFile({
      messageId: message.message_id,
      fileKey,
      targetPath: localPath,
      resourceType: 'file',
    });

    const files = this.pendingFiles.get(bridgeId) || [];
    files.push(localPath);
    while (files.length > this.MAX_PENDING_FILES) {
      const removed = files.shift();
      if (removed) {
        void rm(removed, { force: true });
      }
    }
    this.pendingFiles.set(bridgeId, files);
    await this.bot.sendMessage(
      chatId,
      `📎 已接收文件：\`${safeName}\`\n请继续发送任务指令，我会将该文件传给 OpenCode。`,
      'text',
      message.message_id,
    );
  }

  private parseFileContent(rawContent: string): { fileKey?: string; fileName?: string } {
    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : typeof parsed.fileKey === 'string' ? parsed.fileKey : undefined;
      const fileName = typeof parsed.file_name === 'string' ? parsed.file_name : typeof parsed.fileName === 'string' ? parsed.fileName : undefined;
      return { fileKey, fileName };
    } catch {
      return {};
    }
  }

  private consumePendingFiles(bridgeId: string): string[] {
    const files = this.pendingFiles.get(bridgeId) || [];
    this.pendingFiles.delete(bridgeId);
    return files;
  }

  private resolveFilePath(inputPath: string): string {
    if (isAbsolute(inputPath)) {
      return inputPath;
    }
    return resolve(config.opencode.workingDir, inputPath);
  }

  private extractSenderId(event: FeishuMessageEvent): string {
    const sender = event.event?.sender?.sender_id;
    return sender?.user_id || sender?.open_id || sender?.union_id || 'unknown';
  }
}

// ----------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------

function splitText(text: string, maxLength: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = '';
  for (const line of normalized.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (line.length <= maxLength) {
      current = line;
      continue;
    }
    for (let start = 0; start < line.length; start += maxLength) {
      chunks.push(line.slice(start, start + maxLength));
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function containsDetailedRequest(text: string): boolean {
  const negativePattern = /(不要|不用|无需|别|不需要)\s*(详细|解释|过程|步骤|报告|分析)/i;
  if (negativePattern.test(text)) {
    return false;
  }
  return /([/!]detail\b|详细|展开|完整报告|详细报告|详细解释|原因分析|过程说明|步骤拆解|原理说明|why|how|explain|analysis|report|breakdown|walkthrough)/i.test(text);
}

function guessMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

const bridge = new OpenCodeFeishuLive();

process.on('SIGINT', () => {
  void bridge.stop();
});
process.on('SIGTERM', () => {
  void bridge.stop();
});

bridge.start().catch((error: unknown) => {
  logger.error('Failed to start bridge:', error);
  process.exit(1);
});
