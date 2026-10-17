/**
 * Dev harness: drives the live pipeline (ACP -> activities -> status reporter)
 * without Feishu. Prints what would be sent to the chat.
 *
 * Usage:
 *   node dist/dev-drive.js "your prompt here" [--mode normal|debug] [--status bubble|card|off]
 */
import { config } from './config.js';
import { AcpConnection } from './agent/acp-connection.js';
import { LiveSession } from './agent/live-session.js';
import { LiveCard, type StatusSink } from './status/live-card.js';
import { StatusBubble } from './status/status-bubble.js';
import type { StatusReporter } from './status/reporter.js';
import type { ActivityEvent } from './types.js';
import { logger } from './utils/logger.js';

let cardSeq = 0;

function summarizeCard(card: Record<string, unknown>): string {
  const elements = Array.isArray(card.elements) ? card.elements as Array<Record<string, unknown>> : [];
  const header = card.header as { title?: { content?: string } } | undefined;
  const title = header?.title?.content || '';
  const status = (elements[0]?.text as { content?: string } | undefined)?.content || '';
  const body = (elements[2]?.text as { content?: string } | undefined)?.content || '';
  return `【${title}】\n${status}\n${body.split('\n').map(line => `  ${line}`).join('\n')}`;
}

const sink: StatusSink = {
  sendCard: async (_chatId, card) => {
    cardSeq += 1;
    console.log(`\n========== [CARD SEND] ==========\n${summarizeCard(card)}\n`);
    return `card_msg_${cardSeq}`;
  },
  patchCard: async (_chatId, messageId, card) => {
    console.log(`\n----- [CARD PATCH ${messageId}] -----\n${summarizeCard(card)}\n`);
  },
  sendText: async (_chatId, text) => {
    console.log(`\n########## [CHAT MESSAGE] ##########\n${text}\n`);
    return `text_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  },
  editText: async (_chatId, messageId, text) => {
    console.log(`\n##### [CHAT EDIT ${messageId}] #####\n${text}\n`);
  },
};

function describeEvent(event: ActivityEvent): string {
  switch (event.type) {
    case 'turn_start':
      return '▶ turn_start';
    case 'thinking_start':
      return '💭 thinking_start';
    case 'thinking_delta':
      return `💭 thinking_delta +${event.text.length}ch`;
    case 'thinking_end':
      return `💭 thinking_end (${(event.durationMs / 1000).toFixed(1)}s, ${event.chars}ch)`;
    case 'text_start':
      return '✍️ text_start';
    case 'text_delta':
      return `✍️ text_delta +${event.text.length}ch`;
    case 'text_end':
      return `✍️ text_end (${event.text.length}ch)`;
    case 'tool':
      return `🔧 tool[${event.phase}] ${event.title || event.name}${event.durationMs ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : ''}`;
    case 'permission':
      return `🔐 permission ${event.decision}: ${event.title}`;
    case 'usage':
      return '📊 usage';
    case 'turn_end':
      return `⏹ turn_end reason=${event.stopReason}`;
    default:
      return String((event as { type?: string }).type);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeFlagIndex = args.indexOf('--mode');
  const mode = (modeFlagIndex >= 0 ? args[modeFlagIndex + 1] : 'debug') as 'normal' | 'debug';
  const statusFlagIndex = args.indexOf('--status');
  const statusCarrier = (statusFlagIndex >= 0 ? args[statusFlagIndex + 1] : config.opencode.statusMode) as
    | 'bubble'
    | 'card'
    | 'off';
  const prompt = args
    .filter((item, index) =>
      !(
        item === '--mode' ||
        (modeFlagIndex >= 0 && index === modeFlagIndex + 1) ||
        item === '--status' ||
        (statusFlagIndex >= 0 && index === statusFlagIndex + 1)
      ),
    )
    .join(' ')
    .trim() || '运行命令 sleep 2 && echo READY，然后用两三句话说明 READY 是什么。';

  console.log(`workdir: ${config.opencode.workingDir}`);
  console.log(`opencode: ${config.opencode.path}`);
  console.log(`status carrier: ${statusCarrier}`);
  console.log(`prompt: ${prompt}\n`);

  const connection = new AcpConnection();
  await connection.start();
  const ready = await connection.waitReady(15000);
  if (!ready) {
    console.error('ACP connection not ready');
    process.exit(1);
  }

  const acpSession = await connection.ctx.buildSession({ cwd: config.opencode.workingDir, mcpServers: [] }).start();
  const live = new LiveSession(connection, acpSession);

  const reporter: StatusReporter | undefined = statusCarrier === 'off'
    ? undefined
    : statusCarrier === 'card'
      ? new LiveCard({ sink, chatId: 'dev-chat', command: prompt, model: config.opencode.model, mode })
      : new StatusBubble({ sink, chatId: 'dev-chat', mode });
  if (reporter) {
    await reporter.start();
  }

  let done = false;
  let stopReason: string | undefined;

  live.on('activity', (event: ActivityEvent) => {
    console.log(`[event] ${describeEvent(event)}`);
    reporter?.handleActivity(event);
    if (event.type === 'text_end' && config.opencode.interimTextEnabled) {
      console.log(`[interim candidate] ${event.text.trim().slice(0, 120).replace(/\n/g, ' ⏎ ')}…`);
      reporter?.noteContentSent();
    }
    if (event.type === 'turn_end') {
      stopReason = event.stopReason;
      done = true;
    }
  });

  const startedAt = Date.now();
  live.prompt(prompt);

  const timeout = setTimeout(() => {
    console.error('Timeout waiting for turn end (120s)');
    process.exit(2);
  }, 120000);

  while (!done) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  clearTimeout(timeout);

  const durationMs = Date.now() - startedAt;
  console.log(`\n▶ turn finished: stopReason=${stopReason} duration=${(durationMs / 1000).toFixed(1)}s`);

  await reporter?.finalize({
    status: stopReason === 'cancelled' ? 'cancelled' : 'completed',
    durationMs,
    usage: live.usage,
    stopReason,
  });

  live.dispose();
  await connection.stop();
  console.log('\n▶ done');
}

main().catch((error: unknown) => {
  logger.error('dev-drive failed:', error);
  process.exit(1);
});
