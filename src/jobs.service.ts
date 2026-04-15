import { attachContext } from './context-serializer';
import { JobsError, JobsErrorCode } from './errors';
import type { JobsBackend } from './backend/jobs-backend.interface';
import type { HandlerRegistry } from './handler-registry';
import type { Scheduler } from './scheduler';
import type { EnqueueOptions, JobContext } from './types';

export interface JobsServiceDeps {
  backend: JobsBackend;
  registry: HandlerRegistry;
  schedulers?: Map<string, Scheduler>;
  jobTypes?: Iterable<string>;
  contextExtractor?: () => JobContext;
  contextRunner?: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
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
    this.assertKnownJobType(jobType);

    const context = opts.context ?? this.deps.contextExtractor?.() ?? {};
    const envelope = attachContext(payload, context);
    const jobId = await this.deps.backend.enqueue(jobType, envelope, opts);
    const tenantId = (context.tenantId as string | undefined) ?? '__default__';
    this.schedulers.get(jobType)?.onEnqueue(jobId, tenantId);
    return jobId;
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
