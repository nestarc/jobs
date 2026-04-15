import { HandlerRegistry } from './handler-registry';
import { Scheduler, SchedulerOptions } from './scheduler';
import { InMemoryBackend } from './backend/in-memory-backend';
import { FairWorker } from './fair-worker';
import { JobsService } from './jobs.service';
import type { JobContext } from './types';

export interface FakeJobsOptions extends Partial<SchedulerOptions> {
  jobTypes: string[];
  contextExtractor?: () => JobContext;
  contextRunner?: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
}

export class FakeJobsService {
  readonly service: JobsService;
  readonly registry = new HandlerRegistry();
  readonly backend = new InMemoryBackend();
  readonly schedulers = new Map<string, Scheduler>();
  private readonly workers: FairWorker[] = [];

  constructor(opts: FakeJobsOptions) {
    const schedOpts: SchedulerOptions = {
      defaultWeight: opts.defaultWeight ?? 1,
      minSharePct: opts.minSharePct ?? 0.1,
      tenantCap: opts.tenantCap ?? 10,
    };
    for (const jobType of opts.jobTypes) {
      const scheduler = new Scheduler(schedOpts);
      this.schedulers.set(jobType, scheduler);
      this.workers.push(
        new FairWorker({
          jobType,
          backend: this.backend,
          scheduler,
          registry: this.registry,
          contextRunner: opts.contextRunner ?? (async (_c, f) => f()),
        }),
      );
    }
    this.service = new JobsService({
      backend: this.backend,
      registry: this.registry,
      schedulers: this.schedulers,
      contextExtractor: opts.contextExtractor,
      contextRunner: opts.contextRunner,
    });
  }

  async drain(maxIterations = 1000): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      let anyPicked = false;
      for (const worker of this.workers) {
        if (await worker.tick()) anyPicked = true;
      }
      if (!anyPicked) return;
    }
  }
}
