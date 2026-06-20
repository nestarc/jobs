import { attachContext } from './context-serializer';
import { JobsError, JobsErrorCode } from './errors';
import type { JobsBackend } from './backend/jobs-backend.interface';
import type { HandlerRegistry } from './handler-registry';
import type { Scheduler } from './scheduler';
import type { EnqueueOptions, JobContext } from './types';
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

    const context = opts.context ?? this.deps.contextExtractor?.() ?? {};
    const envelope = attachContext(payload, context);
    const result = this.deps.backend.enqueueDetailed
      ? await this.deps.backend.enqueueDetailed(jobType, envelope, { ...opts, context })
      : { status: 'created' as const, jobId: await this.deps.backend.enqueue(jobType, envelope, { ...opts, context }) };
    const tenantId = (context.tenantId as string | undefined) ?? '__default__';
    this.schedulers.get(jobType)?.onEnqueue(result.jobId, tenantId);
    this.deps.events?.onEvent?.({
      type: 'job.enqueued',
      jobId: result.jobId,
      jobType,
      tenantId: context.tenantId as string | undefined,
      attempt: 0,
      at: new Date(),
      metadata: opts.metadata,
    });
    return result;
  }

  capabilities(): BackendCapabilities {
    return this.deps.backend.capabilities();
  }

  getJob(jobId: string): Promise<JobRecord | null> {
    return this.deps.backend.getJob(jobId);
  }

  getJobHistory(jobId: string): Promise<JobHistoryEntry[]> {
    return this.deps.backend.getJobHistory(jobId);
  }

  listDeadLetters(filter?: DeadLetterFilter): Promise<JobRecord[]> {
    if (!this.deps.backend.listDeadLetters) return Promise.resolve([]);
    return this.deps.backend.listDeadLetters(filter);
  }

  replayDeadLetter(jobId: string, options?: ReplayOptions): Promise<string> {
    if (!this.deps.backend.replayDeadLetter) {
      return Promise.reject(new JobsError(JobsErrorCode.FairnessMisconfig, 'DLQ replay is unavailable for this backend'));
    }
    return this.deps.backend.replayDeadLetter(jobId, options);
  }

  discardDeadLetter(jobId: string, reason?: string): Promise<void> {
    if (!this.deps.backend.discardDeadLetter) {
      return Promise.reject(new JobsError(JobsErrorCode.FairnessMisconfig, 'DLQ discard is unavailable for this backend'));
    }
    return this.deps.backend.discardDeadLetter(jobId, reason);
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
}
