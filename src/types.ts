export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ConnectionMode = 'websocket' | 'webhook';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type IntentHint = 'chat' | 'task' | 'ambiguous';
export type NotificationMode = 'quiet' | 'normal' | 'debug';
export type TaskResponseMode = 'silent' | NotificationMode;
export type ModelCommandAction = 'list' | 'current' | 'set' | 'reset';
export type NotifyCommandAction = 'current' | 'set';

export interface ModelCommandRequest {
  action: ModelCommandAction;
  model?: string;
}

export interface NotifyCommandRequest {
  action: NotifyCommandAction;
  mode?: NotificationMode;
}

export interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  connectionMode: 'webhook' | 'websocket';
  webhookPort?: number;
}

export interface FeishuSender {
  sender_id?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
  sender_type: string;
  tenant_key?: string;
}

export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  chat_id: string;
  chat_type: 'p2p' | 'group' | string;
  message_type: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'sticker' | 'interactive' | string;
  content: string;
  mentions?: Array<{
    key: string;
    id: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    name: string;
    tenant_key?: string;
  }>;
}

export interface FeishuMessageEvent {
  schema: string;
  header: {
    event_id: string;
    token: string;
    create_time: string;
    event_type: string;
    tenant_key: string;
    app_id: string;
  };
  event: {
    sender: FeishuSender;
    message: FeishuMessage;
  };
}

export interface BotResponse {
  text?: string;
  card?: Record<string, unknown>;
  followupText?: string;
  executeCommand?: string;
  intentHint?: IntentHint;
  modelCommand?: ModelCommandRequest;
  notifyCommand?: NotifyCommandRequest;
  sendFilePath?: string;
  resetSession?: boolean;
  cancelTask?: boolean;
}

export interface SessionInfo {
  id: string;
  userId: string;
  chatId: string;
  createdAt: Date;
  lastActivityAt: Date;
  taskHistory: TaskInfo[];
  context: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
}

export interface TaskInfo {
  id: string;
  status: TaskStatus;
  responseMode?: TaskResponseMode;
  model?: string;
  command: string;
  userId: string;
  chatId: string;
  messageId: string;
  opencodeSessionId?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  duration?: number;
  stopReason?: string;
  usage?: TokenUsage;
  output: string[];
  error?: string;
}

/** High-level activity events translated from the ACP session update stream. */
export type ActivityEvent =
  | { type: 'turn_start'; at: number }
  | { type: 'thinking_start'; at: number }
  | { type: 'thinking_delta'; at: number; text: string }
  | { type: 'thinking_end'; at: number; durationMs: number; chars: number }
  | { type: 'text_start'; at: number; messageId?: string }
  | { type: 'text_delta'; at: number; text: string }
  | { type: 'text_end'; at: number; text: string; durationMs: number; messageId?: string }
  | {
      type: 'tool';
      at: number;
      toolCallId: string;
      name: string;
      phase: 'pending' | 'running' | 'completed' | 'failed';
      title?: string;
      kind?: string;
      output?: string;
      error?: string;
      durationMs?: number;
    }
  | { type: 'permission'; at: number; title: string; decision: 'allowed' | 'rejected' }
  | { type: 'usage'; at: number; usage: TokenUsage }
  | { type: 'turn_end'; at: number; stopReason?: string; usage?: TokenUsage; durationMs: number };

export interface TurnOutcome {
  stopReason?: string;
  usage?: TokenUsage;
  error?: string;
  durationMs: number;
  textBlocks: string[];
}

export interface SendMessageOptions {
  chatId?: string;
  userId?: string;
  messageId?: string;
  content: {
    text: string;
    card?: Record<string, unknown>;
  };
}

export interface WebhookPayload {
  challenge?: string;
  token?: string;
  type?: string;
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    token: string;
    create_time: string;
  };
  event?: unknown;
}
