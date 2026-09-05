import { JobsError, JobsErrorCode } from './errors';
import { assertPositiveInteger } from './enqueue-validation';
import { HandlerRegistry } from './handler-registry';
import { Scheduler, SchedulerOptions } from './scheduler';
import { InMemoryBackend } from './backend/in-memory-backend';
import { FairWorker } from './fair-worker';
import { JobsService } from './jobs.service';
import type { JobContext } from './types';
import { FakeClock } from './fake-clock';
import type { JobDefinitions } from './contracts';

export interface FakeJobsOptions extends Omit<Partial<SchedulerOptions>, 'clock'> {
  jobTypes: string[];
  jobs?: JobDefinitions;
  now?: Date | string | number;
  contextExtractor?: () => JobContext;
  contextRunner?: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
}

export class FakeJobsService {
  readonly service: JobsService;
  readonly registry = new HandlerRegistry();
  readonly clock: FakeClock;
  readonly backend: InMemoryBackend;
  readonly schedulers = new Map<string, Scheduler>();
  private readonly workers: FairWorker[] = [];

  constructor(opts: FakeJobsOptions) {
    this.clock = new FakeClock(opts.now);
    this.backend = new InMemoryBackend({ now: () => this.clock.now() });
    const schedOpts: SchedulerOptions = {
      defaultWeight: opts.defaultWeight ?? 1,
      minSharePct: opts.minSharePct ?? 0.1,
      tenantCap: opts.tenantCap ?? 10,
      clock: () => this.clock.now(),
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
      jobTypes: opts.jobTypes,
      contextExtractor: opts.contextExtractor,
      contextRunner: opts.contextRunner,
      jobs: opts.jobs,
    });
  }

  async drain(maxIterations = 1000): Promise<void> {
    await this.drainUntilIdle(maxIterations);
  }

  async drainUntilIdle(maxIterations = 1000): Promise<void> {
    assertPositiveInteger(maxIterations, 'maxIterations');
    for (let i = 0; i < maxIterations; i++) {
      let anyPicked = false;
      for (const worker of this.workers) {
        if (await worker.tick()) anyPicked = true;
      }
      if (!anyPicked) return;
    }
    if ([...this.schedulers.values()].some((scheduler) => scheduler.hasReadyJobs())) {
      throw new JobsError(
        JobsErrorCode.DrainLimitExceeded,
        `${maxIterations} iterations; ready jobs remain`,
      );
    }
  }
}

export function createFakeJobs(opts: FakeJobsOptions): FakeJobsService {
  return new FakeJobsService(opts);
}
