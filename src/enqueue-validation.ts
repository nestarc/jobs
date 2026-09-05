import { JobsError, JobsErrorCode } from './errors';
import type { EnqueueOptions } from './types';
import type { JobDefinitions } from './contracts';

export const MAX_TIMER_MS = 2_147_483_647;
export const MAX_ID_LENGTH = 1024;

export function invalidInput(reason: string): never {
  throw new JobsError(JobsErrorCode.InvalidInput, reason);
}

export function assertIdentifier(
  value: unknown,
  label: string,
  max = MAX_ID_LENGTH,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    invalidInput(`${label} must be a non-blank string of at most ${max} UTF-16 code units`);
  }
}

export function assertValidJobId(jobId: unknown): void {
  if (jobId !== undefined) assertIdentifier(jobId, 'jobId');
}

export function assertJobType(jobType: unknown): asserts jobType is string {
  assertIdentifier(jobType, 'jobType', 256);
  if (jobType.includes(':')) invalidInput('jobType must not contain ":"');
}

export function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    invalidInput(`${label} must be a positive safe integer`);
}

function duration(value: unknown, label: string, positive = false): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < (positive ? 1 : 0) ||
    value > MAX_TIMER_MS
  ) {
    invalidInput(
      `${label} must be finite and within [${positive ? 1 : 0}, ${MAX_TIMER_MS}] milliseconds`,
    );
  }
}

export function assertEnqueueOptions(opts: EnqueueOptions<object, object>): void {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts))
    invalidInput('options must be an object');
  assertValidJobId(opts.jobId);
  if (opts.attempts !== undefined) assertPositiveInteger(opts.attempts, 'attempts');
  for (const field of ['delay', 'delayMs', 'timeoutMs'] as const) {
    if (opts[field] !== undefined) duration(opts[field], field, field === 'timeoutMs');
  }
  if (
    opts.scheduledFor !== undefined &&
    (!(opts.scheduledFor instanceof Date) || !Number.isFinite(opts.scheduledFor.getTime()))
  ) {
    invalidInput('scheduledFor must be a valid Date');
  }
  if (opts.scheduledFor && opts.scheduledFor.getTime() - Date.now() > MAX_TIMER_MS)
    invalidInput('scheduledFor exceeds the maximum scheduling horizon');
  if (opts.idempotencyKey !== undefined) assertIdentifier(opts.idempotencyKey, 'idempotencyKey');
  if (opts.dedupe !== undefined) {
    const d = opts.dedupe;
    if (typeof d !== 'object' || d === null || Array.isArray(d))
      invalidInput('dedupe must be an object');
    assertIdentifier(d.key, 'dedupe.key');
    if (d.scope !== undefined && d.scope !== 'tenant' && d.scope !== 'global')
      invalidInput('dedupe.scope must be tenant or global');
    if (d.mode !== undefined && d.mode !== 'while_active' && d.mode !== 'until_completed')
      invalidInput('dedupe.mode must be while_active or until_completed');
    if (d.ttlMs !== undefined) duration(d.ttlMs, 'dedupe.ttlMs');
  }
  if (opts.backoff !== undefined) {
    const b = opts.backoff;
    if (typeof b !== 'object' || b === null || (b.type !== 'fixed' && b.type !== 'exponential'))
      invalidInput('backoff.type must be fixed or exponential');
    duration(b.delayMs, 'backoff.delayMs');
    if ('maxDelayMs' in b && b.maxDelayMs !== undefined)
      duration(b.maxDelayMs, 'backoff.maxDelayMs');
    if (
      b.jitter !== undefined &&
      (typeof b.jitter !== 'number' || !Number.isFinite(b.jitter) || b.jitter < 0 || b.jitter > 1)
    )
      invalidInput('backoff.jitter must be within [0,1]');
  }
}

export function assertJobConfiguration(
  jobTypes: Iterable<string>,
  jobs?: JobDefinitions,
): string[] {
  if (typeof jobTypes === 'string' || !jobTypes || typeof jobTypes[Symbol.iterator] !== 'function')
    invalidInput('jobTypes must be an iterable of job types');
  const types = [...jobTypes];
  const seen = new Set<string>();
  for (const type of types) {
    assertJobType(type);
    if (seen.has(type)) invalidInput(`duplicate jobType: ${type}`);
    seen.add(type);
  }
  if (jobs !== undefined && (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)))
    invalidInput('jobs must be an object');
  if (jobs)
    for (const [type, definition] of Object.entries(jobs)) {
      assertJobType(type);
      if (typeof definition !== 'object' || definition === null)
        invalidInput(`job definition for ${type} must be an object`);
      if (definition.defaults !== undefined && typeof definition.defaults !== 'function')
        assertEnqueueOptions(definition.defaults);
    }
  return types;
}
