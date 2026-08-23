import 'reflect-metadata';
import {
  Injectable,
  Module,
  Scope,
  type OnModuleInit,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JobHandler } from '../../src/decorators';
import {
  HandlerRegistry,
  InMemoryBackend,
  JOBS_BACKEND,
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
  imports: [
    JobsModule.forInMemory({ jobTypes: ['dependency.job'] }),
    DependencyModule,
  ],
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
