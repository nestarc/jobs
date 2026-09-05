import { assertEnqueueOptions, MAX_TIMER_MS } from './enqueue-validation';
export type BackoffPolicy =
  | { type: 'fixed'; delayMs: number; jitter?: number }
  | { type: 'exponential'; delayMs: number; maxDelayMs?: number; jitter?: number };

export interface RetryPolicy {
  attempts?: number;
  backoff?: BackoffPolicy;
}

export function computeBackoffDelayMs(policy: BackoffPolicy | undefined, attempt: number): number {
  if (!policy) return 0;
  assertEnqueueOptions({ backoff: policy });
  const baseDelay = nonNegativeFinite(policy.delayMs);
  if (policy.type === 'fixed') return nonNegativeFinite(withJitter(baseDelay, policy.jitter));
  const exponent = Math.max(0, attempt - 1);
  const uncapped = baseDelay === 0 ? 0 : baseDelay * 2 ** Math.min(1023, exponent);
  const capped =
    policy.maxDelayMs === undefined
      ? nonNegativeFinite(uncapped)
      : Math.min(uncapped, nonNegativeFinite(policy.maxDelayMs));
  return nonNegativeFinite(withJitter(capped, policy.jitter));
}

function nonNegativeFinite(value: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, value));
}

function withJitter(delayMs: number, jitter: number | undefined): number {
  if (!jitter) return delayMs;
  const boundedJitter = Math.max(0, Math.min(1, jitter));
  const min = delayMs * (1 - boundedJitter);
  const max = delayMs * (1 + boundedJitter);
  return Math.round(min + Math.random() * (max - min));
}
