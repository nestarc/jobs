import { attachContext, preparePortableEnqueue, detachContext } from './context-serializer';
import { JobsError, JobsErrorCode } from './errors';
import type { JobsBackend } from './backend/jobs-backend.interface';
import type { HandlerRegistry } from './handler-registry';
import type { Scheduler, SchedulerEnqueueTiming } from './scheduler';
import type { EnqueueOptions, JobContext } from './types';
import type { JobDefinitions, JobDefaults } from './contracts';
import { notifyLifecycleObserver, snapshotLifecycleValue } from './lifecycle-observer';
import {
  assertIdentifier,
  assertEnqueueOptions,
  assertJobType,
  assertJobConfiguration,
} from './enqueue-validation';
import type {
  BackendCapabilities,
  DeadLetterFilter,
  EnqueueResult,
  JobHistoryEntry,
  JobEventsOptions,
  JobRecord,
  ReplayOptions,
} from './lifecycle';

export interface JobsServiceDeps {
  producerEnabled?: boolean;
  backend: JobsBackend;
  registry: HandlerRegistry;
  schedulers?: Map<string, Scheduler>;
  jobTypes?: Iterable<string>;
  contextExtractor?: () => JobContext;
  contextRunner?: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
  events?: JobEventsOptions;
  jobs?: JobDefinitions;
}

export class JobsService {
  private readonly schedulers: Map<string, Scheduler>;
  private readonly jobTypes: Set<string>;

  constructor(private readonly deps: JobsServiceDeps) {
    this.schedulers = deps.schedulers ?? new Map();
    this.jobTypes = new Set(
      assertJobConfiguration(deps.jobTypes ?? this.schedulers.keys(), deps.jobs),
    );
  }

  async enqueue(
    jobType: string,
    payload: object,
    opts: EnqueueOptions<object, object> = {},
  ): Promise<string> {
    return (await this.enqueueDetailed(jobType, payload, opts)).jobId;
  }

  async enqueueDetailed(
    jobType: string,
    payload: object,
    opts: EnqueueOptions<object, object> = {},
  ): Promise<EnqueueResult> {
    if (this.deps.producerEnabled === false)
      throw new JobsError(
        JobsErrorCode.CapabilityUnsupported,
        'worker role cannot enqueue; use both',
      );
    assertJobType(jobType);
    this.assertKnownJobType(jobType);
    assertEnqueueOptions(opts);
    const defaults = this.jobDefaults(jobType);
    const effectiveOpts: EnqueueOptions<object, object> = {
      ...opts,
      attempts: opts.attempts ?? defaults.attempts,
      backoff: opts.backoff ?? defaults.backoff,
      timeoutMs: opts.timeoutMs ?? defaults.timeoutMs,
    };
    assertEnqueueOptions(effectiveOpts);

    const inputContext = (
      effectiveOpts.context === undefined
        ? (this.deps.contextExtractor?.() ?? {})
        : effectiveOpts.context
    ) as JobContext;
    const prepared = preparePortableEnqueue(
      attachContext(payload as Record<string, unknown>, inputContext),
      {
        ...effectiveOpts,
        context: inputContext,
        metadata: effectiveOpts.metadata as Record<string, unknown> | undefined,
      },
    );
    this.assertEnqueueCapabilities(effectiveOpts);
    const { envelope, opts: backendOpts } = prepared;
    const { context } = detachContext(envelope);
    let enqueueNotified = false;
    const notifyEnqueued = (result: EnqueueResult): void => {
      if (enqueueNotified || result.status !== 'created') return;
      enqueueNotified = true;
      const tenantId = context.tenantId as string | undefined;
      this.schedulers
        .get(jobType)
        ?.onEnqueue(result.jobId, tenantId, this.schedulerTiming(backendOpts));
      notifyLifecycleObserver(() =>
        this.deps.events?.onEvent?.({
          type: 'job.enqueued',
          jobId: result.jobId,
          jobType,
          tenantId: context.tenantId as string | undefined,
          attempt: 0,
          at: new Date(),
          metadata: snapshotLifecycleValue(backendOpts.metadata),
        }),
      );
    };
    const result = this.deps.backend.enqueueDetailed
      ? await this.deps.backend.enqueueDetailed(jobType, envelope, backendOpts, notifyEnqueued)
      : {
          status: 'created' as const,
          jobId: await this.deps.backend.enqueue(jobType, envelope, backendOpts),
        };
    notifyEnqueued(result);
    return result;
  }

  capabilities(): BackendCapabilities {
    return this.deps.backend.capabilities();
  }

  /** Authorization remains the caller's responsibility; mismatches look like missing IDs. */
  async getJobForTenant(jobId: string, expectedTenantId: string): Promise<JobRecord | null> {
    assertIdentifier(expectedTenantId, 'expectedTenantId');
    const record = await this.getJob(jobId);
    return (record?.context as JobContext | undefined)?.tenantId === expectedTenantId
      ? record
      : null;
  }

  getJob<TPayload = unknown, TContext = unknown>(
    jobId: string,
  ): Promise<JobRecord<TPayload, TContext> | null> {
    return this.deps.backend.getJob(jobId) as Promise<JobRecord<TPayload, TContext> | null>;
  }

  async getJobHistory(jobId: string): Promise<JobHistoryEntry[]> {
    this.requireCapability('history');
    return await this.deps.backend.getJobHistory(jobId);
  }

  async listDeadLetters(filter?: DeadLetterFilter): Promise<JobRecord[]> {
    this.requireCapability('deadLetter');
    if (!this.deps.backend.listDeadLetters) {
      throw this.unsupported('deadLetter');
    }
    return await this.deps.backend.listDeadLetters(filter);
  }

  async replayDeadLetter(jobId: string, options?: ReplayOptions): Promise<string> {
    this.requireCapability('deadLetter');
    if (!this.deps.backend.replayDeadLetter) {
      throw this.unsupported('deadLetter');
    }
    const capabilities = this.deps.backend.capabilities();
    const needsSourceRecord =
      this.schedulers.size > 0 ||
      this.deps.events?.onEvent !== undefined ||
      !capabilities.statusQuery;
    const sourceRecord = needsSourceRecord
      ? await this.findReplaySourceRecord(jobId, capabilities.statusQuery)
      : null;
    if (!capabilities.statusQuery && this.schedulers.size > 0 && !sourceRecord) {
      throw new JobsError(
        JobsErrorCode.CapabilityUnsupported,
        'dead-letter replay on a local scheduler requires the source job record',
      );
    }

    const replayedJobId = await this.deps.backend.replayDeadLetter(jobId, options);
    let record: JobRecord | null = null;
    if (capabilities.statusQuery) {
      try {
        record = await this.deps.backend.getJob(replayedJobId);
      } catch {
        // Replay is already committed. Status enrichment must not turn that
        // successful side effect into an apparent failure that callers retry.
      }
    }
    record ??= sourceRecord
      ? {
          ...sourceRecord,
          id: replayedJobId,
          status: 'queued',
          attempt: options?.resetAttempts === false ? sourceRecord.attempt : 0,
          metadata: {
            ...sourceRecord.metadata,
            ...options?.metadata,
            replayOf: jobId,
          },
        }
      : null;
    if (record && !this.isTerminal(record.status)) {
      const tenantId = (record.context as JobContext | undefined)?.tenantId;
      const schedulerTenantId = tenantId;
      if (
        record.status === 'queued' ||
        record.status === 'delayed' ||
        record.status === 'retrying'
      ) {
        this.schedulers.get(record.type)?.onEnqueue(replayedJobId, schedulerTenantId, {
          scheduledFor: record.nextAttemptAt ?? record.scheduledFor,
        });
      }
      notifyLifecycleObserver(() =>
        this.deps.events?.onEvent?.({
          type: 'job.replayed',
          jobId: replayedJobId,
          jobType: record.type,
          tenantId,
          attempt: record.attempt,
          at: new Date(),
          metadata: snapshotLifecycleValue(record.metadata),
        }),
      );
    }
    return replayedJobId;
  }

  private async findReplaySourceRecord(
    jobId: string,
    statusQuery: boolean,
  ): Promise<JobRecord | null> {
    if (statusQuery) {
      try {
        const record = await this.deps.backend.getJob(jobId);
        if (record) return record;
      } catch {
        // Fall through to the DLQ listing when the backend can still provide it.
      }
    }
    if (!this.deps.backend.listDeadLetters) return null;
    try {
      return (
        (await this.deps.backend.listDeadLetters()).find((record) => record.id === jobId) ?? null
      );
    } catch {
      return null;
    }
  }

  async discardDeadLetter(jobId: string, reason?: string): Promise<void> {
    this.requireCapability('deadLetter');
    if (!this.deps.backend.discardDeadLetter) {
      throw this.unsupported('deadLetter');
    }
    const record = await this.deps.backend.discardDeadLetter(jobId, reason);
    if (!record) return;
    const tenantId = (record.context as JobContext | undefined)?.tenantId;
    notifyLifecycleObserver(() =>
      this.deps.events?.onEvent?.({
        type: 'job.discarded',
        jobId: record.id,
        jobType: record.type,
        tenantId,
        attempt: record.attempt,
        at: new Date(),
        metadata: snapshotLifecycleValue(record.metadata),
      }),
    );
  }

  setTenantWeight(jobType: string, tenantId: string | undefined, weight: number): void {
    this.requireScheduler(jobType).setWeight(tenantId, weight);
  }

  scheduler(jobType: string): Scheduler {
    return this.requireScheduler(jobType);
  }

  private assertKnownJobType(jobType: string): void {
    if (!this.jobTypes.has(jobType)) {
      throw new JobsError(JobsErrorCode.QueueNotFound, jobType);
    }
  }

  private isTerminal(status: JobRecord['status']): boolean {
    return (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'dead_letter' ||
      status === 'cancelled'
    );
  }

  private requireScheduler(jobType: string): Scheduler {
    this.assertKnownJobType(jobType);
    const scheduler = this.schedulers.get(jobType);
    if (!scheduler) {
      throw new JobsError(
        JobsErrorCode.FairnessMisconfig,
        `scheduler controls are unavailable for ${jobType} on this backend`,
      );
    }
    return scheduler;
  }

  private assertEnqueueCapabilities(opts: EnqueueOptions<object, object>): void {
    const capabilities = this.deps.backend.capabilities();
    if (
      (opts.delay !== undefined || opts.delayMs !== undefined || opts.scheduledFor) &&
      !capabilities.delayed
    ) {
      throw this.unsupported('delayed');
    }
    if ((opts.attempts ?? 1) > 1 && !capabilities.retries) {
      throw this.unsupported('retries');
    }
    if (opts.backoff && !capabilities.backoff) {
      throw this.unsupported('backoff');
    }
    if (opts.timeoutMs !== undefined && !capabilities.timeout) {
      throw this.unsupported('timeout');
    }
    if ((opts.idempotencyKey || opts.dedupe) && !capabilities.idempotency) {
      throw this.unsupported('idempotency');
    }
  }

  private schedulerTiming(
    opts: EnqueueOptions<object, object>,
  ): SchedulerEnqueueTiming | undefined {
    if (opts.scheduledFor !== undefined) return { scheduledFor: opts.scheduledFor };
    const delayMs = opts.delayMs ?? opts.delay;
    return delayMs === undefined ? undefined : { delayMs };
  }

  private jobDefaults(jobType: string): JobDefaults {
    const definition = this.deps.jobs?.[jobType];
    if (!definition || typeof definition.defaults !== 'object' || definition.defaults === null) {
      return {};
    }
    return definition.defaults;
  }

  private requireCapability(capability: 'history' | 'deadLetter'): void {
    if (!this.deps.backend.capabilities()[capability]) {
      throw this.unsupported(capability);
    }
  }

  private unsupported(capability: string): JobsError {
    return new JobsError(
      JobsErrorCode.CapabilityUnsupported,
      `${capability} is unavailable for this backend`,
    );
  }
}
