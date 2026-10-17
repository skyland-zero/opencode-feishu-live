import { spawn, type ChildProcess } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Manages the long-lived `opencode acp` child process and the ACP client
 * connection on top of it. Re-spawns the child with backoff if it dies.
 *
 * Events:
 *  - 'ready'        (ctx: acp.ClientContext)
 *  - 'disconnected' (reason: string)
 */
export class AcpConnection extends EventEmitter {
  private child: ChildProcess | null = null;
  private context: acp.ClientContext | null = null;
  private ready = false;
  private stopping = false;
  private starting: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelayMs = 2000;
  private shutdownResolve: (() => void) | null = null;
  private generation = 0;

  get isReady(): boolean {
    return this.ready;
  }

  get ctx(): acp.ClientContext {
    if (!this.context || !this.ready) {
      throw new Error('ACP connection is not ready');
    }
    return this.context;
  }

  /** Idempotent: resolves once the connection is initialized (or throws). */
  async start(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.stopping = false;
    this.starting = this.connect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Wait until the connection is ready, or until timeoutMs elapses. */
  async waitReady(timeoutMs = 15000): Promise<boolean> {
    if (this.ready) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('ready', onReady);
        resolve(false);
      }, timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once('ready', onReady);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.shutdownResolve?.();
    this.shutdownResolve = null;

    const child = this.child;
    this.child = null;
    this.context = null;
    this.ready = false;

    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 3000);

      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
    logger.info('AcpConnection stopped');
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;

    logger.info(`Spawning ACP agent: ${config.opencode.path} acp (cwd=${config.opencode.workingDir})`);
    const child = spawn(config.opencode.path, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: config.opencode.workingDir,
    });
    this.child = child;

    child.stderr?.on('data', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString();
      const trimmed = text.trim();
      if (trimmed) {
        logger.debug(`[acp stderr] ${trimmed.slice(0, 500)}`);
      }
    });

    if (!child.stdout || !child.stdin) {
      throw new Error('ACP child process stdio is unavailable');
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const app = acp
      .client({ name: 'opencode-feishu-live' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.handlePermission(ctx))
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        const content = await readFile(ctx.params.path, 'utf8');
        return { content };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        await writeFile(ctx.params.path, ctx.params.content, 'utf8');
        return {};
      });

    const initialized = new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        reject(new Error(`ACP agent exited during startup (code=${code}, signal=${signal})`));
      };
      child.once('exit', onExit);
      this.once('ready', () => {
        child.removeListener('exit', onExit);
        resolve();
      });
    });

    const shutdown = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
      child.once('exit', () => resolve());
    });

    app
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        logger.info(`ACP initialized (protocol v${init.protocolVersion})`);
        this.context = ctx;
        this.ready = true;
        this.emit('ready', ctx);
        await shutdown;
        this.ready = false;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`ACP connection closed: ${message}`);
      })
      .finally(() => {
        if (this.generation === generation) {
          this.ready = false;
          this.context = null;
        }
      });

    child.on('exit', (code, signal) => {
      const wasReady = this.ready;
      this.ready = false;
      this.context = null;
      if (this.generation !== generation) {
        return;
      }
      const reason = `code=${code} signal=${signal}`;
      logger.warn(`ACP agent process exited (${reason})`);
      if (wasReady) {
        this.emit('disconnected', reason);
      }
      if (!this.stopping) {
        this.scheduleRestart(reason);
      }
    });

    child.on('error', (error) => {
      logger.error(`ACP agent process error: ${error.message}`);
    });

    await initialized;
    this.restartDelayMs = 2000;
  }

  private scheduleRestart(reason: string): void {
    if (this.restartTimer || this.stopping) {
      return;
    }
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30000);
    logger.info(`Restarting ACP agent in ${delay}ms (last exit: ${reason})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`ACP restart failed: ${message}`);
        this.scheduleRestart(message);
      });
    }, delay);
  }

  private async handlePermission(
    ctx: {
      params: {
        sessionId: string;
        toolCall?: { title?: string | null; name?: string | null };
        options: Array<{ optionId: string; kind: string; name?: string }>;
      };
    },
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    const params = ctx.params;
    const allow = config.opencode.permissionMode === 'allow';
    const kinds = params.options.map(option => option.kind);
    const pick = allow
      ? params.options.find(option => option.kind === 'allow_always') ||
        params.options.find(option => option.kind === 'allow_once')
      : params.options.find(option => option.kind === 'reject_once') ||
        params.options.find(option => option.kind === 'reject_always');

    const title = params.toolCall?.title || params.toolCall?.name || '敏感操作';
    logger.info(`ACP permission request (${kinds.join(',')}) → ${allow ? 'allowed' : 'rejected'}: ${title}`);
    this.emit('permission', {
      sessionId: params.sessionId,
      title,
      decision: allow ? 'allowed' : 'rejected',
    });

    return pick
      ? { outcome: { outcome: 'selected' as const, optionId: pick.optionId } }
      : { outcome: { outcome: 'cancelled' as const } };
  }
}
