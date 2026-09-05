import { assertPositiveInteger, invalidInput } from './enqueue-validation';

/** Opt-in, operator-driven cleanup. The age is a safety floor even under count pressure. */
export interface RetentionOptions {
  terminalAgeMs: number;
  /** Maximum records removed per queue and call (default 1000). */
  batchSize?: number;
  /** Longest Outbox retry + manual recovery horizon for this deployment. */
  recoveryHorizonMs: number;
}

export interface RetentionCleanupOptions {
  /** All producers and administrative retry/replay writers must be stopped first. */
  producersStopped: true;
}

export function validateRetention(options: RetentionOptions | undefined): void {
  if (options === undefined) return;
  if (!options || typeof options !== 'object') invalidInput('retention must be an object');
  if (options.batchSize !== undefined)
    assertPositiveInteger(options.batchSize, 'retention.batchSize');
  for (const field of ['terminalAgeMs', 'recoveryHorizonMs'] as const) {
    if (!Number.isSafeInteger(options[field]) || options[field] < 0)
      invalidInput(`retention.${field} must be a non-negative safe integer`);
  }
  if (options.terminalAgeMs < options.recoveryHorizonMs)
    invalidInput('retention must cover the Outbox retry and operator recovery horizon');
}

export function assertRetentionMaintenance(options: RetentionCleanupOptions): void {
  if (options?.producersStopped !== true)
    invalidInput('retention cleanup requires stopped producers and administrative writers');
}
