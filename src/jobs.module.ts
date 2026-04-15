import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { JobsService } from './jobs.service';
import { HandlerRegistry } from './handler-registry';
import { Scheduler, SchedulerOptions } from './scheduler';
import { FairWorker } from './fair-worker';
import { JOB_HANDLER_METADATA } from './decorators/job-handler.decorator';
import { defaultContextExtractor, defaultContextRunner } from './tenancy-defaults';
import { InMemoryBackend } from './backend/in-memory-backend';
import { BullMQBackend } from './backend/bullmq-backend';
import type { JobContext, JobEvent } from './types';

export const JOBS_BACKEND = Symbol('JOBS_BACKEND');
export const JOBS_WORKERS = Symbol('JOBS_WORKERS');

const IN_MEMORY_WORKER_IDLE_MS = 10;

@Injectable()
class InMemoryWorkersHost implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(@Inject(JOBS_WORKERS) private readonly workers: FairWorker[]) {}

  onModuleInit(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let anyPicked = false;
      for (const worker of this.workers) {
        if (!this.running) break;
        if (await worker.tick()) anyPicked = true;
      }
      if (!anyPicked) {
        await sleep(IN_MEMORY_WORKER_IDLE_MS);
      }
    }
  }
}

export interface InMemoryOptions {
  jobTypes: string[];
  concurrency?: { tenantCap?: number };
  fairness?: { minSharePct?: number; defaultWeight?: number };
  contextExtractor?: () => JobContext;
  contextRunner?: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
  onJobStart?: (e: JobEvent) => void;
  onJobFinish?: (e: JobEvent) => void;
  onJobFail?: (e: JobEvent, err: Error) => void;
}

export interface BullMQOptions {
  backend: BullMQBackend;
  jobTypes: string[];
  contextExtractor?: () => JobContext;
  contextRunner?: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
  onJobStart?: (e: JobEvent) => void;
  onJobFinish?: (e: JobEvent) => void;
  onJobFail?: (e: JobEvent, err: Error) => void;
}

function registerHandlers(
  registry: HandlerRegistry,
  discovery: DiscoveryService,
  scanner: MetadataScanner,
): void {
  for (const provider of discovery.getProviders()) {
    const instance = provider.instance;
    if (!instance || typeof instance !== 'object') continue;
    const prototype = Object.getPrototypeOf(instance);
    scanner.scanFromPrototype(instance, prototype, (method) => {
      const jobType = Reflect.getMetadata(JOB_HANDLER_METADATA, prototype[method]);
      if (jobType) {
        registry.register(jobType, (payload, ctx) =>
          prototype[method].call(instance, payload, ctx),
        );
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Module({})
export class JobsModule {
  static forInMemory(options: InMemoryOptions): DynamicModule {
    const schedOpts: SchedulerOptions = {
      defaultWeight: options.fairness?.defaultWeight ?? 1,
      minSharePct: options.fairness?.minSharePct ?? 0.1,
      tenantCap: options.concurrency?.tenantCap ?? 10,
    };
    const backend = new InMemoryBackend();
    const runner = options.contextRunner ?? defaultContextRunner;

    const providers: Provider[] = [
      { provide: JOBS_BACKEND, useValue: backend },
      HandlerRegistry,
      {
        provide: JobsService,
        useFactory: (registry: HandlerRegistry) => {
          const schedulers = new Map<string, Scheduler>();
          for (const jobType of options.jobTypes) {
            schedulers.set(jobType, new Scheduler(schedOpts));
          }
          return new JobsService({
            backend,
            registry,
            schedulers,
            jobTypes: options.jobTypes,
            contextExtractor: options.contextExtractor ?? defaultContextExtractor,
            contextRunner: runner,
          });
        },
        inject: [HandlerRegistry],
      },
      {
        provide: JOBS_WORKERS,
        useFactory: (
          service: JobsService,
          registry: HandlerRegistry,
          discovery: DiscoveryService,
          scanner: MetadataScanner,
        ) => {
          registerHandlers(registry, discovery, scanner);
          return options.jobTypes.map(
            (jobType) =>
              new FairWorker({
                jobType,
                backend,
                scheduler: service.scheduler(jobType),
                registry,
                contextRunner: runner,
                onStart: options.onJobStart,
                onFinish: options.onJobFinish,
                onFail: options.onJobFail,
              }),
          );
        },
        inject: [JobsService, HandlerRegistry, DiscoveryService, MetadataScanner],
      },
      InMemoryWorkersHost,
    ];

    return {
      module: JobsModule,
      imports: [DiscoveryModule],
      providers,
      exports: [JobsService, HandlerRegistry, JOBS_BACKEND, JOBS_WORKERS],
      global: true,
    };
  }

  static forBullMQ(options: BullMQOptions): DynamicModule {
    const runner = options.contextRunner ?? defaultContextRunner;
    const providers: Provider[] = [
      { provide: JOBS_BACKEND, useValue: options.backend },
      HandlerRegistry,
      {
        provide: JobsService,
        useFactory: (registry: HandlerRegistry) =>
          new JobsService({
            backend: options.backend,
            registry,
            jobTypes: options.jobTypes,
            contextExtractor: options.contextExtractor ?? defaultContextExtractor,
            contextRunner: runner,
          }),
        inject: [HandlerRegistry],
      },
      {
        provide: JOBS_WORKERS,
        useFactory: (
          registry: HandlerRegistry,
          discovery: DiscoveryService,
          scanner: MetadataScanner,
        ) => {
          registerHandlers(registry, discovery, scanner);
          options.backend.startConsumer(options.jobTypes, {
            registry,
            contextRunner: runner,
            onStart: options.onJobStart,
            onFinish: options.onJobFinish,
            onFail: options.onJobFail,
          });
          return [];
        },
        inject: [HandlerRegistry, DiscoveryService, MetadataScanner],
      },
    ];

    return {
      module: JobsModule,
      imports: [DiscoveryModule],
      providers,
      exports: [JobsService, HandlerRegistry, JOBS_BACKEND],
      global: true,
    };
  }
}
