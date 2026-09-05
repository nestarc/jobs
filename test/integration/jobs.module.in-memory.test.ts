import 'reflect-metadata';
import { Injectable, Module, Scope, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JobHandler } from '../../src/decorators';
import {
  FairWorker,
  HandlerRegistry,
  InMemoryBackend,
  JOBS_BACKEND,
  JOBS_WORKERS,
  JobsModule,
  JobsService,
} from '../../src';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
class ReportHandler {
  readonly calls: Array<{ payload: Record<string, unknown>; tenantId?: string }> = [];

  @JobHandler('sendReport')
  async handle(payload: Record<string, unknown>, ctx: { tenantId?: string }): Promise<void> {
    this.calls.push({ payload, tenantId: ctx.tenantId });
  }
}

@Injectable()
class ReadyDependency implements OnModuleInit {
  moduleReady = false;

  onModuleInit(): void {
    this.moduleReady = true;
  }
}

@Injectable()
class InjectedJobHandler {
  static handledBy: InjectedJobHandler | undefined;
  readonly calls: Array<{ moduleReady: boolean; value: string }> = [];

  constructor(private readonly dependency: ReadyDependency) {}

  @JobHandler('dependency.job')
  async handle(payload: Record<string, unknown>): Promise<void> {
    InjectedJobHandler.handledBy = this;
    this.calls.push({
      moduleReady: this.dependency.moduleReady,
      value: String(payload.value),
    });
  }
}

@Module({ providers: [ReadyDependency], exports: [ReadyDependency] })
class DependencyModule {}

@Module({
  imports: [JobsModule.forInMemory({ jobTypes: ['dependency.job'] }), DependencyModule],
  providers: [InjectedJobHandler],
  exports: [InjectedJobHandler],
})
class FeatureModule {}

@Module({ imports: [FeatureModule] })
class RootTestingModule {}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedJobHandler {
  @JobHandler('scoped.job')
  async handle(): Promise<void> {}
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientJobHandler {
  @JobHandler('scoped.job')
  async handle(): Promise<void> {}
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedDependency {}

@Injectable()
class StaticHandlerWithRequestDependency {
  constructor(private readonly _dependency: RequestScopedDependency) {}

  @JobHandler('scoped.job')
  async handle(): Promise<void> {}
}

describe('JobsModule.forInMemory', () => {
  it('discovers an injected parent-module handler after module initialization', async () => {
    InjectedJobHandler.handledBy = undefined;
    const moduleRef = await Test.createTestingModule({
      imports: [RootTestingModule],
    }).compile();

    try {
      const jobs = moduleRef.get(JobsService);
      const registry = moduleRef.get(HandlerRegistry);
      const handler = moduleRef.get(InjectedJobHandler);
      const jobId = await jobs.enqueue('dependency.job', { value: 'ready' });

      expect(registry.list()).toEqual([]);
      expect(handler.calls).toEqual([]);

      await moduleRef.init();

      for (let i = 0; i < 30 && handler.calls.length === 0; i++) {
        await sleep(10);
      }

      expect(registry.list()).toEqual(['dependency.job']);
      expect(handler.calls).toEqual([{ moduleReady: true, value: 'ready' }]);
      expect(InjectedJobHandler.handledBy).toBe(handler);
      await Promise.all(
        moduleRef.get<FairWorker[]>(JOBS_WORKERS).map((worker) => worker.waitForIdle()),
      );
      await expect(jobs.getJob(jobId)).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      await moduleRef.close();
    }
  });

  it('starts workers automatically and drains queued jobs', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JobsModule.forInMemory({ jobTypes: ['sendReport'] })],
      providers: [ReportHandler],
    }).compile();

    await moduleRef.init();
    try {
      const jobs = moduleRef.get(JobsService);
      const handler = moduleRef.get(ReportHandler);
      const backend = moduleRef.get<InMemoryBackend>(JOBS_BACKEND);

      await jobs.enqueue('sendReport', { userId: 'u1' }, { context: { tenantId: 't1' } });

      for (let i = 0; i < 20 && handler.calls.length === 0; i++) {
        await sleep(10);
      }

      expect(handler.calls).toEqual([{ payload: { userId: 'u1' }, tenantId: 't1' }]);
      expect(await backend.peekWaiting('sendReport')).toEqual([]);
    } finally {
      await moduleRef.close();
    }
  });

  it.each([
    ['request-scoped handler', RequestScopedJobHandler, []],
    ['transient handler', TransientJobHandler, []],
    [
      'singleton handler with a request-scoped dependency',
      StaticHandlerWithRequestDependency,
      [RequestScopedDependency],
    ],
  ])('rejects a %s during bootstrap', async (_scope, handler, dependencies) => {
    const moduleRef = await Test.createTestingModule({
      imports: [JobsModule.forInMemory({ jobTypes: ['scoped.job'] })],
      providers: [handler, ...dependencies],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(
      '@JobHandler() provider ' + handler.name + ' must use singleton scope',
    );
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

@Injectable()
class ShutdownDependency {
  destroyed = false;
  onModuleDestroy(): void {
    this.destroyed = true;
  }
}

@Module({ providers: [ShutdownDependency], exports: [ShutdownDependency] })
class ShutdownFeatureModule {}

describe('M01 in-memory shutdown lifecycle', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  async function setup(timeoutMs = 1_000) {
    const app = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['shutdown'],
          shutdown: { timeoutMs },
          concurrency: { poolSize: 1 },
        }),
        ShutdownFeatureModule,
      ],
    }).compile();
    return {
      app,
      backend: app.get<InMemoryBackend>(JOBS_BACKEND),
      service: app.get(JobsService),
      registry: app.get(HandlerRegistry),
      dependency: app.get(ShutdownDependency),
    };
  }

  it('drains active, queued, delayed and retrying work before dependencies and backend close', async () => {
    const { app, backend, service, registry, dependency } = await setup();
    const gate = deferred();
    const calls: string[] = [];
    registry.register('shutdown', async (payload) => {
      expect(dependency.destroyed).toBe(false);
      const kind = String(payload.kind);
      calls.push(kind);
      if (kind === 'active') await gate.promise;
      if (kind === 'retry' && calls.filter((value) => value === 'retry').length === 1)
        throw new Error('retry');
    });
    const close = jest.spyOn(backend, 'close');
    await app.init();
    await service.enqueue('shutdown', { kind: 'active' });
    await service.enqueue('shutdown', { kind: 'queued' });
    await service.enqueue('shutdown', { kind: 'delayed' }, { delayMs: 50 });
    await service.enqueue(
      'shutdown',
      { kind: 'retry' },
      { attempts: 2, backoff: { type: 'fixed', delayMs: 20 } },
    );
    await jest.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['active']);
    let closed = false;
    const closing = Promise.all([app.close(), app.close()]).then(() => {
      closed = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(backend.lifecycleState).toBe('closing');
      expect(closed).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await expect(service.enqueue('shutdown', {})).rejects.toMatchObject({
        code: 'jobs_backend_closed',
      });
    } finally {
      gate.resolve();
      await jest.advanceTimersByTimeAsync(100);
      await closing;
    }
    expect(calls).toEqual(['active', 'queued', 'retry', 'retry', 'delayed']);
    expect(dependency.destroyed).toBe(true);
    expect(backend.lifecycleState).toBe('closed');
    expect(close).toHaveBeenCalledTimes(1);
    await app.close();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(service.enqueue('shutdown', {})).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });
  });

  it.each([false, true])(
    'reports a timeout-ignoring invocation at the shutdown deadline (cancelled=%s)',
    async (cancelled) => {
      const { app, backend, service, registry, dependency } = await setup(20);
      const gate = deferred();
      let signal: AbortSignal | undefined;
      registry.register('shutdown', async (_payload, ctx) => {
        signal = ctx.signal;
        await gate.promise;
      });
      const close = jest.spyOn(backend, 'close');
      await app.init();
      const id = await service.enqueue('shutdown', {}, { timeoutMs: 5 });
      await jest.advanceTimersByTimeAsync(10);
      if (cancelled) await backend.markCancelled('shutdown', id);
      const closing = app.close();
      const rejection = expect(closing).rejects.toMatchObject({
        code: 'jobs_shutdown_incomplete',
        reason: 'deadline',
        remainingJobIds: [id],
        remainingCount: 1,
      });
      try {
        await jest.advanceTimersByTimeAsync(20);
        await rejection;
        expect(signal?.aborted).toBe(true);
        expect(backend.lifecycleState).toBe('closing');
        expect(await backend.getJob(id)).toMatchObject({
          status: cancelled ? 'cancelled' : 'active',
          attempt: 1,
        });
        expect(close).not.toHaveBeenCalled();
        expect(dependency.destroyed).toBe(false);
      } finally {
        gate.resolve();
        await jest.advanceTimersByTimeAsync(20);
        await app.close();
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect(backend.lifecycleState).toBe('closed');
    },
  );

  it('drains work accepted before bootstrap when the compiled module is closed', async () => {
    const { app, backend, service, registry } = await setup();
    const handler = jest.fn(async () => undefined);
    registry.register('shutdown', handler);
    await service.enqueue('shutdown', {});
    const closing = app.close();
    await jest.advanceTimersByTimeAsync(10);
    await closing;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(backend.lifecycleState).toBe('closed');
  });

  it('observes the shutdown deadline during immediately settling retries', async () => {
    const { app, backend, service, registry } = await setup(20);
    const gate = deferred();
    let attempts = 0;
    registry.register('shutdown', async () => {
      attempts += 1;
      if (attempts === 1) await gate.promise;
      throw new Error('retry immediately');
    });
    await app.init();
    const id = await service.enqueue('shutdown', {}, { attempts: 100 });
    await jest.advanceTimersByTimeAsync(10);
    const closing = app.close();
    const rejection = expect(closing).rejects.toMatchObject({
      code: 'jobs_shutdown_incomplete',
      reason: 'deadline',
      remainingJobIds: [id],
    });
    await jest.advanceTimersByTimeAsync(0);
    gate.resolve();
    try {
      await jest.advanceTimersByTimeAsync(20);
      await rejection;
      expect(attempts).toBeLessThan(100);
      expect(backend.lifecycleState).toBe('closing');
    } finally {
      await jest.advanceTimersByTimeAsync(200);
      await app.close();
    }
    expect(attempts).toBe(100);
    expect(backend.lifecycleState).toBe('closed');
  });

  it.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])(
    'rejects an invalid shutdown deadline %s',
    (timeoutMs) => {
      expect(() => JobsModule.forInMemory({ jobTypes: [], shutdown: { timeoutMs } })).toThrow(
        'shutdown.timeoutMs',
      );
    },
  );
});
