export type BackoffPolicy =
  | { type: 'fixed'; delayMs: number; jitter?: number }
  | { type: 'exponential'; delayMs: number; maxDelayMs?: number; jitter?: number };

export interface RetryPolicy {
  attempts?: number;
  backoff?: BackoffPolicy;
}

export function computeBackoffDelayMs(policy: BackoffPolicy | undefined, attempt: number): number {
  if (!policy) return 0;
  const baseDelay = Math.max(0, policy.delayMs);
  if (policy.type === 'fixed') return withJitter(baseDelay, policy.jitter);
  const exponent = Math.max(0, attempt - 1);
  const uncapped = baseDelay * 2 ** exponent;
  const capped = policy.maxDelayMs === undefined ? uncapped : Math.min(uncapped, policy.maxDelayMs);
  return withJitter(capped, policy.jitter);
}

function withJitter(delayMs: number, jitter: number | undefined): number {
  if (!jitter) return delayMs;
  const boundedJitter = Math.max(0, Math.min(1, jitter));
  const min = delayMs * (1 - boundedJitter);
  const max = delayMs * (1 + boundedJitter);
  return Math.round(min + Math.random() * (max - min));
}
