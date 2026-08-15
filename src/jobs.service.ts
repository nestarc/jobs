import { attachContext } from './context-serializer';
import { JobsError, JobsErrorCode } from './errors';
import type { JobsBackend } from './backend/jobs-backend.interface';
import type { HandlerRegistry } from './handler-registry';
import type { Scheduler } from './scheduler';
import type { EnqueueOptions, JobContext } from './types';
import type { JobDefinitions, JobDefaults } from './contracts';
import { notifyLifecycleObserver } from './lifecycle-observer';
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
    this.jobTypes = new Set(deps.jobTypes ?? this.schedulers.keys());
  }

  async enqueue(
    jobType: string,
    payload: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<string> {
    return (await this.enqueueDetailed(jobType, payload, opts)).jobId;
  }

  async enqueueDetailed(
    jobType: string,
    payload: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    this.assertKnownJobType(jobType);
    const defaults = this.jobDefaults(jobType);
    const effectiveOpts: EnqueueOptions = {
      ...opts,
      attempts: opts.attempts ?? defaults.attempts,
      backoff: opts.backoff ?? defaults.backoff,
      timeoutMs: opts.timeoutMs ?? defaults.timeoutMs,
    };
    this.assertEnqueueCapabilities(effectiveOpts);

    const context = effectiveOpts.context ?? this.deps.contextExtractor?.() ?? {};
    const envelope = attachContext(payload, context);
    const result = this.deps.backend.enqueueDetailed
      ? await this.deps.backend.enqueueDetailed(jobType, envelope, { ...effectiveOpts, context })
      : {
          status: 'created' as const,
          jobId: await this.deps.backend.enqueue(jobType, envelope, { ...effectiveOpts, context }),
        };
    if (result.status === 'created') {
      const tenantId = (context.tenantId as string | undefined) ?? '__default__';
      this.schedulers.get(jobType)?.onEnqueue(result.jobId, tenantId);
      notifyLifecycleObserver(() =>
        this.deps.events?.onEvent?.({
          type: 'job.enqueued',
          jobId: result.jobId,
          jobType,
          tenantId: context.tenantId as string | undefined,
          attempt: 0,
          at: new Date(),
          metadata: effectiveOpts.metadata,
        }),
      );
    }
    return result;
  }

  capabilities(): BackendCapabilities {
    return this.deps.backend.capabilities();
  }

  getJob(jobId: string): Promise<JobRecord | null> {
    return this.deps.backend.getJob(jobId);
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
    const replayedJobId = await this.deps.backend.replayDeadLetter(jobId, options);
    const record = await this.deps.backend.getJob(replayedJobId);
    if (record) {
      const tenantId = (record.context as JobContext | undefined)?.tenantId ?? '__default__';
      this.schedulers.get(record.type)?.onEnqueue(replayedJobId, tenantId);
      notifyLifecycleObserver(() =>
        this.deps.events?.onEvent?.({
          type: 'job.replayed',
          jobId: replayedJobId,
          jobType: record.type,
          tenantId: tenantId === '__default__' ? undefined : tenantId,
          attempt: record.attempt,
          at: new Date(),
          metadata: record.metadata,
        }),
      );
    }
    return replayedJobId;
  }

  async discardDeadLetter(jobId: string, reason?: string): Promise<void> {
    this.requireCapability('deadLetter');
    if (!this.deps.backend.discardDeadLetter) {
      throw this.unsupported('deadLetter');
    }
    await this.deps.backend.discardDeadLetter(jobId, reason);
  }

  setTenantWeight(jobType: string, tenantId: string, weight: number): void {
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

  private assertEnqueueCapabilities(opts: EnqueueOptions): void {
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
