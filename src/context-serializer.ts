import { JobsError, JobsErrorCode } from './errors';
import { portableRecord } from './portable-value';
import { assertIdentifier, invalidInput } from './enqueue-validation';
import type { EnqueueOptions, JobContext } from './types';

export const CONTEXT_KEY = '__nestarcCtx';
export const INTERNAL_JOB_KEY = '__nestarcJob';

export function attachContext<T extends Record<string, unknown>>(
  payload: T,
  context: JobContext | undefined,
): T & { [CONTEXT_KEY]: JobContext } {
  const normalizedPayload = portableRecord(payload, 'job payload');
  const resolvedContext = portableRecord(context === undefined ? {} : context, 'job context');
  if (resolvedContext.tenantId !== undefined)
    assertIdentifier(resolvedContext.tenantId, 'tenantId');
  const reservedKey = [CONTEXT_KEY, INTERNAL_JOB_KEY].find((key) => key in payload);
  if (reservedKey) {
    throw new JobsError(
      JobsErrorCode.ReservedPayloadKey,
      `payload must not contain "${reservedKey}"`,
    );
  }
  return { ...normalizedPayload, [CONTEXT_KEY]: resolvedContext } as T & {
    [CONTEXT_KEY]: JobContext;
  };
}

export function detachContext<T extends Record<string, unknown>>(
  envelope: T,
): { payload: Omit<T, typeof CONTEXT_KEY>; context: JobContext } {
  const { [CONTEXT_KEY]: context, ...payload } = envelope as T & {
    [CONTEXT_KEY]?: JobContext;
  };
  return {
    payload: payload as Omit<T, typeof CONTEXT_KEY>,
    context: context === undefined ? {} : context,
  };
}

/** Direct backend callers supply the same envelope as JobsService. */
export function preparePortableEnqueue(
  envelope: Record<string, unknown>,
  opts: EnqueueOptions,
): { envelope: Record<string, unknown>; opts: EnqueueOptions } {
  if (typeof envelope === 'object' && envelope !== null && INTERNAL_JOB_KEY in envelope) {
    throw new JobsError(JobsErrorCode.ReservedPayloadKey, INTERNAL_JOB_KEY);
  }
  const normalized = portableRecord(envelope, 'job envelope');
  const { payload, context } = detachContext(normalized);
  const attached = attachContext(payload, context);
  if (opts.context !== undefined) portableRecord(opts.context, 'options.context');
  if (opts.dedupe?.scope === 'tenant' && !context.tenantId)
    invalidInput('tenant-scoped dedupe requires tenantId');
  return {
    envelope: attached,
    opts: {
      ...opts,
      context,
      metadata: portableRecord(opts.metadata === undefined ? {} : opts.metadata, 'job metadata'),
      backoff: opts.backoff ? { ...opts.backoff } : undefined,
      dedupe: opts.dedupe ? { ...opts.dedupe } : undefined,
      scheduledFor: opts.scheduledFor ? new Date(opts.scheduledFor.getTime()) : undefined,
    },
  };
}
