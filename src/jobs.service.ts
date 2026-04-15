import { attachContext } from './context-serializer';
import { JobsError, JobsErrorCode } from './errors';
import type { JobsBackend } from './backend/jobs-backend.interface';
import type { HandlerRegistry } from './handler-registry';
import type { Scheduler } from './scheduler';
import type { EnqueueOptions, JobContext } from './types';

export interface JobsServiceDeps {
  backend: JobsBackend;
  registry: HandlerRegistry;
  schedulers: Map<string, Scheduler>;
  contextExtractor?: () => JobContext;
  contextRunner?: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
}

export class JobsService {
  constructor(private readonly deps: JobsServiceDeps) {}

  async enqueue(
    jobType: string,
    payload: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<string> {
    const scheduler = this.deps.schedulers.get(jobType);
    if (!scheduler) throw new JobsError(JobsErrorCode.QueueNotFound, jobType);

    const context = opts.context ?? this.deps.contextExtractor?.() ?? {};
    const envelope = attachContext(payload, context);
    const jobId = await this.deps.backend.enqueue(jobType, envelope, opts);
    const tenantId = (context.tenantId as string | undefined) ?? '__default__';
    scheduler.onEnqueue(jobId, tenantId);
    return jobId;
  }

  setTenantWeight(jobType: string, tenantId: string, weight: number): void {
    const scheduler = this.deps.schedulers.get(jobType);
    if (!scheduler) throw new JobsError(JobsErrorCode.QueueNotFound, jobType);
    scheduler.setWeight(tenantId, weight);
  }

  scheduler(jobType: string): Scheduler {
    const s = this.deps.schedulers.get(jobType);
    if (!s) throw new JobsError(JobsErrorCode.QueueNotFound, jobType);
    return s;
  }
}
