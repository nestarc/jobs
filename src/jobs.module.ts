import { ExecutionBudget } from './execution-budget';
import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Provider,
  Scope,
} from '@nestjs/common';
import { createRequire } from 'node:module';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { assertJobConfiguration, assertPositiveInteger, invalidInput } from './enqueue-validation';
import { JobsService } from './jobs.service';
import { HandlerRegistry } from './handler-registry';
import { Scheduler, SchedulerOptions } from './scheduler';
import { FairWorker } from './fair-worker';
import { JOB_HANDLER_METADATA } from './decorators/job-handler.decorator';
import { defaultContextExtractor, defaultContextRunner } from './tenancy-defaults';
import { InMemoryBackend } from './backend/in-memory-backend';
import type { BullMQBackend } from './backend/bullmq-backend';
import type { JobsBackend } from './backend/jobs-backend.interface';
import type { JobContext, JobEvent } from './types';
import { JOBS_SERVICE } from './contracts';
import type { JobDefinitions } from './contracts';
import type { JobEventsOptions } from './lifecycle';
import { JobsError, JobsErrorCode, JobsShutdownError } from './errors';

export const JOBS_BACKEND = Symbol('JOBS_BACKEND');
export const JOBS_WORKERS = Symbol('JOBS_WORKERS');
const BULLMQ_CONSUMER_CONFIG = Symbol('BULLMQ_CONSUMER_CONFIG');
const IN_MEMORY_POOL_SIZE = Symbol('IN_MEMORY_POOL_SIZE');
const IN_MEMORY_SHUTDOWN_TIMEOUT = Symbol('IN_MEMORY_SHUTDOWN_TIMEOUT');

const IN_MEMORY_WORKER_IDLE_MS = 10;
const requireModule = createRequire(__filename);
const WORKER_SHUTDOWN_DISTANCE =
  nestCoreMajorVersion() >= 11 ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;

@Injectable()
class HandlerDiscovery {
  private complete = false;

  constructor(
    private readonly registry: HandlerRegistry,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  discover(): void {
    if (this.complete) return;
    registerHandlers(this.registry, this.discovery, this.scanner);
    this.complete = true;
  }
}

@Injectable()
class InMemoryWorkersHost implements OnApplicationBootstrap, OnModuleDestroy {
  private running = false;
  private loop: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private cursor = 0;
  private loopFailure: { error: unknown } | null = null;

  constructor(
    @Inject(JOBS_WORKERS) private readonly workers: FairWorker[],
    @Inject(JOBS_BACKEND) private readonly backend: InMemoryBackend,
    @Inject(IN_MEMORY_POOL_SIZE) private readonly poolSize: number,
    @Inject(IN_MEMORY_SHUTDOWN_TIMEOUT) private readonly shutdownTimeoutMs: number,
    private readonly handlerDiscovery: HandlerDiscovery,
    discovery: DiscoveryService,
  ) {
    // Drain before feature dependencies are destroyed in either supported Nest major.
    for (const provider of discovery.getProviders()) {
      if (provider.token === InMemoryWorkersHost && provider.host) {
        provider.host.distance = WORKER_SHUTDOWN_DISTANCE;
      }
    }
  }

  onApplicationBootstrap(): void {
    if (this.running || this.backend.lifecycleState !== 'open') return;
    this.handlerDiscovery.discover();
    this.running = true;
    this.loop = this.run().catch((error) => {
      this.loopFailure = { error };
      this.running = false;
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.backend.beginClose();
    this.running = false;
    this.draining ??= this.drain();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.draining,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new JobsShutdownError('deadline', this.remainingJobIds())),
            this.shutdownTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private remainingJobIds(): string[] {
    return [
      ...new Set([
        ...this.backend.pendingJobIds(),
        ...this.workers.flatMap((worker) => worker.outstandingJobIds()),
      ]),
    ];
  }

  private async drain(): Promise<void> {
    try {
      await this.loop;
      while (this.remainingJobIds().length) {
        if (this.loopFailure) {
          await Promise.all(this.workers.map((worker) => worker.waitForIdle()));
          throw this.loopFailure.error;
        }
        const picked = this.dispatch();
        // Yield even under an immediate retry backlog so deadlines can run.
        await sleep(picked ? 0 : IN_MEMORY_WORKER_IDLE_MS);
      }
      if (this.loopFailure) throw this.loopFailure.error;
      await Promise.all(this.workers.map((worker) => worker.waitForIdle()));
      await this.backend.close();
    } catch (error) {
      throw new JobsShutdownError('worker_error', this.remainingJobIds(), error);
    }
  }

  private dispatch(): boolean {
    let picked = false;
    // A synchronous tick reserves scheduler capacity before its first await.
    // Rotate types per dispatch to avoid a busy type monopolizing newly free slots.
    for (let slot = 0; slot < this.poolSize; slot++) {
      let roundPicked = false;
      for (let checked = 0; checked < this.workers.length; checked++) {
        const worker = this.workers[this.cursor];
        this.cursor = (this.cursor + 1) % this.workers.length;
        const before = worker.outstandingJobIds().length;
        void worker.tick().catch((error) => {
          this.loopFailure ??= { error };
          this.running = false;
        });
        if (worker.outstandingJobIds().length > before) {
          roundPicked = picked = true;
          break;
        }
      }
      if (!roundPicked) break;
    }
    return picked;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const picked = this.dispatch();
      await sleep(picked ? 0 : IN_MEMORY_WORKER_IDLE_MS);
    }
  }
}

interface BullMQConsumerConfig {
  jobTypes: string[];
  contextRunner: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
  onJobStart?: (event: JobEvent) => void;
  onJobFinish?: (event: JobEvent) => void;
  onJobFail?: (event: JobEvent, error: Error) => void;
  events?: JobEventsOptions;
}

@Injectable()
class BullMQWorkersHost implements OnApplicationBootstrap, OnModuleDestroy {
  private started = false;

  constructor(
    @Inject(JOBS_BACKEND) private readonly backend: BullMQBackend,
    @Inject(JOBS_WORKERS) private readonly _workers: unknown[],
    @Inject(BULLMQ_CONSUMER_CONFIG) private readonly consumerConfig: BullMQConsumerConfig,
    private readonly handlerDiscovery: HandlerDiscovery,
    private readonly registry: HandlerRegistry,
    discovery: DiscoveryService,
  ) {
    // Nest 10 destroys modules in descending distance order, while Nest 11
    // reverses that order. Keep the BullMQ host first in either version so
    // active handlers drain before feature dependencies are destroyed.
    for (const provider of discovery.getProviders()) {
      if (provider.token === BullMQWorkersHost && provider.host) {
        provider.host.distance = WORKER_SHUTDOWN_DISTANCE;
      }
    }
  }

  onApplicationBootstrap(): void {
    if (this.started) return;
    this.handlerDiscovery.discover();
    this.backend.startConsumer(this.consumerConfig.jobTypes, {
      registry: this.registry,
      contextRunner: this.consumerConfig.contextRunner,
      onStart: this.consumerConfig.onJobStart,
      onFinish: this.consumerConfig.onJobFinish,
      onFail: this.consumerConfig.onJobFail,
      events: this.consumerConfig.events,
    });
    this.started = true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.backend.close();
  }
}

export interface InMemoryOptions {
  /** Graceful drain deadline (default 30 seconds). Timeout rejects; draining continues. */
  shutdown?: { timeoutMs?: number };
  jobTypes: string[];
  jobs?: JobDefinitions;
  global?: boolean;
  strictCapabilities?: boolean;
  events?: JobEventsOptions;
  /** Local module-wide invocation limits. Defaults: pool 10, tenant 10, type = pool. */
  concurrency?: { poolSize?: number; tenantCap?: number; typeCap?: number };
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
  jobs?: JobDefinitions;
  global?: boolean;
  strictCapabilities?: boolean;
  events?: JobEventsOptions;
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
    const instanceIsObject =
      instance !== null && (typeof instance === 'object' || typeof instance === 'function');
    const metatypePrototype =
      typeof provider.metatype === 'function' && 'prototype' in provider.metatype
        ? provider.metatype.prototype
        : undefined;
    const prototype = instanceIsObject ? Object.getPrototypeOf(instance) : metatypePrototype;
    if (!prototype) continue;

    const handlers = scanner
      .getAllMethodNames(prototype)
      .map((method) => ({
        jobType: Reflect.getMetadata(JOB_HANDLER_METADATA, prototype[method]) as string | undefined,
        method,
      }))
      .filter((handler): handler is { jobType: string; method: string } =>
        Boolean(handler.jobType),
      );
    if (handlers.length === 0) continue;

    if (
      provider.scope === Scope.REQUEST ||
      provider.scope === Scope.TRANSIENT ||
      !provider.isDependencyTreeStatic()
    ) {
      throw new TypeError(
        `@JobHandler() provider ${providerName(provider.token)} must use singleton scope; ` +
          'request/transient-scoped handlers and non-static dependency trees are unsupported',
      );
    }
    if (!instanceIsObject) {
      throw new Error(
        `@JobHandler() provider ${providerName(provider.token)} has no initialized singleton instance`,
      );
    }

    for (const { jobType, method } of handlers) {
      const handler = (instance as Record<string, unknown>)[method];
      if (typeof handler !== 'function') continue;
      registry.register(jobType, (payload, ctx) => handler.call(instance, payload, ctx));
    }
  }
}

function providerName(token: unknown): string {
  if (typeof token === 'function' && token.name) return token.name;
  if (typeof token === 'symbol') return token.description ?? token.toString();
  return String(token);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nestCoreMajorVersion(): number {
  try {
    const packageJson = requireModule('@nestjs/core/package.json') as { version?: unknown };
    const major = Number.parseInt(String(packageJson.version).split('.')[0], 10);
    return Number.isFinite(major) ? major : 10;
  } catch {
    return 10;
  }
}

function assertJobDefaultsSupported(
  backend: JobsBackend,
  jobs: JobDefinitions | undefined,
  jobTypes: Iterable<string>,
): void {
  if (!jobs) return;
  const capabilities = backend.capabilities();
  for (const jobType of jobTypes) {
    const definition = jobs[jobType];
    if (!definition) continue;
    if (typeof definition.defaults !== 'object' || definition.defaults === null) continue;
    const defaults = definition.defaults;
    if (defaults.timeoutMs !== undefined && !capabilities.timeout) {
      throw new JobsError(
        JobsErrorCode.CapabilityUnsupported,
        `timeout is unavailable for job defaults on ${jobType}`,
      );
    }
    if ((defaults.attempts ?? 1) > 1 && !capabilities.retries) {
      throw new JobsError(
        JobsErrorCode.CapabilityUnsupported,
        `retries are unavailable for job defaults on ${jobType}`,
      );
    }
    if (defaults.backoff && !capabilities.backoff) {
      throw new JobsError(
        JobsErrorCode.CapabilityUnsupported,
        `backoff is unavailable for job defaults on ${jobType}`,
      );
    }
  }
}

@Module({})
export class JobsModule {
  static forInMemory(options: InMemoryOptions): DynamicModule {
    assertJobConfiguration(options.jobTypes, options.jobs);
    for (const field of ['concurrency', 'shutdown', 'fairness'] as const) {
      const value = options[field];
      if (
        value !== undefined &&
        (typeof value !== 'object' || value === null || Array.isArray(value))
      )
        invalidInput(`${field} must be an object`);
    }
    const shutdownTimeoutMs =
      options.shutdown?.timeoutMs === undefined ? 30_000 : options.shutdown.timeoutMs;
    if (
      !Number.isSafeInteger(shutdownTimeoutMs) ||
      shutdownTimeoutMs <= 0 ||
      shutdownTimeoutMs > 2_147_483_647
    ) {
      invalidInput('shutdown.timeoutMs must be a positive timer-safe integer');
    }
    for (const field of ['poolSize', 'tenantCap', 'typeCap'] as const) {
      if (options.concurrency?.[field] !== undefined)
        assertPositiveInteger(options.concurrency[field], `concurrency.${field}`);
    }
    const poolSize = options.concurrency?.poolSize ?? 10;
    const tenantCap = options.concurrency?.tenantCap ?? 10;
    const typeCap = options.concurrency?.typeCap ?? poolSize;
    const budget = new ExecutionBudget(poolSize, tenantCap);
    assertPositiveInteger(typeCap, 'concurrency.typeCap');
    const schedOpts: SchedulerOptions = {
      budget,
      typeCap,
      defaultWeight:
        options.fairness?.defaultWeight === undefined ? 1 : options.fairness.defaultWeight,
      minSharePct: options.fairness?.minSharePct === undefined ? 0.1 : options.fairness.minSharePct,
      tenantCap,
    };
    const backend = new InMemoryBackend();
    if (options.strictCapabilities) {
      assertJobDefaultsSupported(backend, options.jobs, options.jobTypes);
    }
    const runner = options.contextRunner ?? defaultContextRunner;

    const providers: Provider[] = [
      { provide: IN_MEMORY_POOL_SIZE, useValue: poolSize },
      { provide: IN_MEMORY_SHUTDOWN_TIMEOUT, useValue: shutdownTimeoutMs },
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
            events: options.events,
            jobs: options.jobs,
          });
        },
        inject: [HandlerRegistry],
      },
      { provide: JOBS_SERVICE, useExisting: JobsService },
      HandlerDiscovery,
      {
        provide: JOBS_WORKERS,
        useFactory: (service: JobsService, registry: HandlerRegistry) =>
          options.jobTypes.map(
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
                events: options.events,
              }),
          ),
        inject: [JobsService, HandlerRegistry],
      },
      InMemoryWorkersHost,
    ];

    return {
      module: JobsModule,
      imports: [DiscoveryModule],
      providers,
      exports: [JobsService, JOBS_SERVICE, HandlerRegistry, JOBS_BACKEND, JOBS_WORKERS],
      global: options.global ?? true,
    };
  }

  static forBullMQ(options: BullMQOptions): DynamicModule {
    assertJobConfiguration(options.jobTypes, options.jobs);
    const runner = options.contextRunner ?? defaultContextRunner;
    if (options.strictCapabilities) {
      assertJobDefaultsSupported(options.backend, options.jobs, options.jobTypes);
    }
    options.backend.registerJobTypes(options.jobTypes);
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
            events: options.events,
            jobs: options.jobs,
          }),
        inject: [HandlerRegistry],
      },
      { provide: JOBS_SERVICE, useExisting: JobsService },
      HandlerDiscovery,
      {
        provide: BULLMQ_CONSUMER_CONFIG,
        useValue: {
          jobTypes: options.jobTypes,
          contextRunner: runner,
          onJobStart: options.onJobStart,
          onJobFinish: options.onJobFinish,
          onJobFail: options.onJobFail,
          events: options.events,
        } satisfies BullMQConsumerConfig,
      },
      {
        provide: JOBS_WORKERS,
        useValue: [],
      },
      BullMQWorkersHost,
    ];

    return {
      module: JobsModule,
      imports: [DiscoveryModule],
      providers,
      exports: [JobsService, JOBS_SERVICE, HandlerRegistry, JOBS_BACKEND],
      global: options.global ?? true,
    };
  }
}
