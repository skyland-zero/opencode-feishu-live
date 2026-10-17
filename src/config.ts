import type { LogLevel, NotificationMode } from './types.js';

export interface Config {
  version: string;
  logging: {
    level: LogLevel;
  };
  feishu: {
    appId: string;
    appSecret: string;
    connectionMode: 'websocket' | 'webhook';
    receiveMessage: boolean;
  };
  opencode: {
    path: string;
    workingDir: string;
    model?: string;
    /** Live status card settings */
    statusEnabled: boolean;
    statusInterval: number;
    statusLines: number;
    showThinking: boolean;
    showReasoningText: boolean;
    reasoningPreviewMax: number;
    showToolOutput: boolean;
    toolOutputMax: number;
    /** Interim assistant text blocks forwarded as chat messages */
    interimTextEnabled: boolean;
    interimTextMinChars: number;
    /** Completion footer message after each turn */
    completionFooterEnabled: boolean;
    /** Auto permission replies for ACP permission requests */
    permissionMode: 'allow' | 'reject';
    /** Intent routing for ambiguous messages (one-shot classifier) */
    intentRoutingEnabled: boolean;
    intentRoutingTimeout: number;
    intentRoutingConfidence: number;
    notifyDefaultMode: NotificationMode;
    /** Optional per-message prepended execution policy (AGENTS.md is preferred) */
    executePolicyPrompt?: string;
  };
  session: {
    timeout: number;
    maxHistory: number;
  };
  security: {
    allowedUsers: string[];
    requireMention: boolean;
  };
}

const parseNotificationMode = (value: string | undefined): NotificationMode => {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'quiet' || normalized === 'normal' || normalized === 'debug') {
    return normalized;
  }
  return 'normal';
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt((value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const unescapeNewlines = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\n/g, '\n');
};

export const config: Config = {
  version: '0.1.0',
  logging: {
    level: (process.env.LOG_LEVEL as LogLevel) || 'info',
  },
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    connectionMode: 'websocket',
    receiveMessage: true,
  },
  opencode: {
    path: process.env.OPENCODE_PATH || 'opencode',
    workingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
    model: process.env.OPENCODE_MODEL || undefined,
    statusEnabled: process.env.OPENCODE_STATUS_ENABLED !== 'false',
    statusInterval: parsePositiveInt(process.env.OPENCODE_STATUS_INTERVAL, 1200),
    statusLines: parsePositiveInt(process.env.OPENCODE_STATUS_LINES, 12),
    showThinking: process.env.OPENCODE_STATUS_SHOW_THINKING !== 'false',
    showReasoningText: process.env.OPENCODE_STATUS_SHOW_REASONING === 'true',
    reasoningPreviewMax: parsePositiveInt(process.env.OPENCODE_STATUS_REASONING_MAX, 320),
    showToolOutput: process.env.OPENCODE_STATUS_SHOW_TOOL_OUTPUT !== 'false',
    toolOutputMax: parsePositiveInt(process.env.OPENCODE_STATUS_TOOL_OUTPUT_MAX, 200),
    interimTextEnabled: process.env.OPENCODE_INTERIM_TEXT !== 'false',
    interimTextMinChars: parsePositiveInt(process.env.OPENCODE_INTERIM_TEXT_MIN, 24),
    completionFooterEnabled: process.env.OPENCODE_COMPLETION_FOOTER !== 'false',
    permissionMode: process.env.OPENCODE_PERMISSION_MODE === 'reject' ? 'reject' : 'allow',
    intentRoutingEnabled: process.env.OPENCODE_INTENT_ROUTING_ENABLED !== 'false',
    intentRoutingTimeout: parsePositiveInt(process.env.OPENCODE_INTENT_ROUTING_TIMEOUT, 12000),
    intentRoutingConfidence: (() => {
      const parsed = Number.parseFloat(process.env.OPENCODE_INTENT_CONFIDENCE || '0.75');
      return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.75;
    })(),
    notifyDefaultMode: parseNotificationMode(process.env.OPENCODE_NOTIFY_DEFAULT),
    executePolicyPrompt: unescapeNewlines(process.env.OPENCODE_EXECUTE_POLICY_PROMPT),
  },
  session: {
    timeout: parsePositiveInt(process.env.SESSION_TIMEOUT, 3600000),
    maxHistory: parsePositiveInt(process.env.SESSION_MAX_HISTORY, 20),
  },
  security: {
    allowedUsers: (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(user => user.trim())
      .filter(Boolean),
    requireMention: process.env.REQUIRE_MENTION !== 'false',
  },
};
