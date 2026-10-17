import type { ActivityEvent, TokenUsage } from '../types.js';

export interface StatusFinalizeOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  durationMs: number;
  usage?: TokenUsage;
  error?: string;
  stopReason?: string;
}

/**
 * A per-task status reporter (text progress bubble or interactive card).
 * index.ts drives it with agent activity events; implementations own rendering
 * and delivery.
 */
export interface StatusReporter {
  readonly isFinalized: boolean;
  /** Send the initial status message. */
  start(): Promise<void>;
  /** Feed one activity event from the agent session. */
  handleActivity(event: ActivityEvent): void;
  /**
   * Called when interim content (a text block) has been delivered to the chat.
   * Bubble carriers use this to split the progress stream (Hermes-style: content
   * interrupts the progress bubble; the next activity opens a fresh one).
   */
  noteContentSent(): void;
  /** Finish the status message with the final state. */
  finalize(outcome: StatusFinalizeOutcome): Promise<void>;
}
