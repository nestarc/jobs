import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  JobsModule,
  JobsService,
  HandlerRegistry,
  createFakeJobs,
  InMemoryBackend,
  JOBS_BACKEND,
  type JobLifecycleEvent,
} from '../../src';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function eventually(check: () => void): Promise<void> {
  const deadline = Date.now() + 1500;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

describe('maintenance concurrency and system identity', () => {
  it('runs independent types while respecting global, cross-type tenant and type caps through shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['one', 'two'],
          concurrency: { poolSize: 3, tenantCap: 1, typeCap: 2 },
        } as Parameters<typeof JobsModule.forInMemory>[0]),
      ],
    }).compile();
    const release = deferred();
    const entered: string[] = [];
    const registry = moduleRef.get(HandlerRegistry);
    const jobs = moduleRef.get(JobsService);
    for (const type of ['one', 'two'])
      registry.register(type, async (payload) => {
        entered.push(String(payload.name));
        await release.promise;
      });
    try {
      await jobs.enqueue('one', { name: 'A1' }, { context: { tenantId: 'A' } });
      await jobs.enqueue('two', { name: 'A2' }, { context: { tenantId: 'A' } });
      await jobs.enqueue('one', { name: 'B' }, { context: { tenantId: 'B' } });
      await jobs.enqueue('one', { name: 'C' }, { context: { tenantId: 'C' } });
      await jobs.enqueue('two', { name: 'D' }, { context: { tenantId: 'D' } });
      await moduleRef.init();
      await eventually(() => expect(entered).toHaveLength(3));
      expect(entered).toEqual(expect.arrayContaining(['A1', 'B', 'D']));
      expect(
        jobs
          .scheduler('one')
          .snapshot()
          .reduce((n, s) => n + s.inflight, 0),
      ).toBe(2);
      const closing = moduleRef.close();
      release.resolve();
      await closing;
      expect(entered.sort()).toEqual(['A1', 'A2', 'B', 'C', 'D']);
    } finally {
      release.resolve();
      await moduleRef.close();
    }
  });

  it('retains the shared tenant slot after timeout until settlement, then retries without overlap', async () => {
    const events: JobLifecycleEvent[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['one', 'two'],
          concurrency: { poolSize: 2, tenantCap: 1 },
          events: { onEvent: (event) => events.push(event) },
        }),
      ],
    }).compile();
    const release = deferred();
    const entered: string[] = [];
    const jobs = moduleRef.get(JobsService);
    const registry = moduleRef.get(HandlerRegistry);
    registry.register('one', async () => {
      entered.push('one');
      await release.promise;
    });
    registry.register('two', async (payload) => {
      entered.push(String(payload.name));
    });
    try {
      const id = await jobs.enqueue(
        'one',
        {},
        { context: { tenantId: 'A' }, timeoutMs: 5, attempts: 2 },
      );
      await jobs.enqueue('two', { name: 'A' }, { context: { tenantId: 'A' } });
      await jobs.enqueue('two', { name: 'B' }, { context: { tenantId: 'B' } });
      await moduleRef.init();
      await eventually(() => expect(events.some((e) => e.type === 'job.timed_out')).toBe(true));
      await eventually(() => expect(entered).toContain('B'));
      expect(entered).toEqual(['one', 'B']);
      expect((await jobs.getJob(id))?.attempt).toBe(1);
      expect(jobs.scheduler('one').snapshot()[0].inflight).toBe(1);
      release.resolve();
      await moduleRef.close();
      expect(entered.filter((x) => x === 'one')).toHaveLength(2);
      expect(entered).toContain('A');
      expect(events.filter((e) => e.type === 'job.retry_scheduled')).toHaveLength(1);
    } finally {
      release.resolve();
      await moduleRef.close();
    }
  });

  it('releases pool capacity and reports worker failure without hiding pending work', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['job'],
          concurrency: { poolSize: 2 },
          shutdown: { timeoutMs: 1000 },
        }),
      ],
    }).compile();
    const jobs = moduleRef.get(JobsService);
    const backend = moduleRef.get<InMemoryBackend>(JOBS_BACKEND);
    moduleRef.get(HandlerRegistry).register('job', async () => undefined);
    const id = await jobs.enqueue('job', {});
    const move = jest
      .spyOn(backend, 'moveToActive')
      .mockRejectedValue(new Error('backend unavailable'));
    await moduleRef.init();
    await eventually(() => expect(move).toHaveBeenCalled());
    await eventually(() => expect(jobs.scheduler('job').snapshot()[0].inflight).toBe(0));
    await expect(moduleRef.close()).rejects.toMatchObject({
      code: 'jobs_shutdown_incomplete',
      reason: 'worker_error',
      remainingJobIds: [id],
    });
    move.mockRestore();
    await backend.markCancelled('job', id);
    await backend.close();
  });

  it('separates missing tenant from every real string across events, retry, replay and weights', async () => {
    const fake = createFakeJobs({ jobTypes: ['job'], minSharePct: 0 });
    const tenants: Array<string | undefined> = [];
    fake.registry.register('job', async (_p, context) => {
      tenants.push(context.tenantId);
      throw new Error('retry');
    });
    await fake.service.enqueue('job', {}, { attempts: 2 });
    await fake.service.enqueue('job', {}, { context: { tenantId: '__default__' } });
    fake.service.setTenantWeight('job', '__default__', 0);
    await fake.drain();
    expect(tenants).toEqual([undefined, undefined]);
    const dead = await fake.service.listDeadLetters();
    await fake.service.replayDeadLetter(dead[0].id);
    await fake.drain();
    expect(tenants).toHaveLength(4);
    expect(fake.service.scheduler('job').snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: undefined, inflight: 0, waiting: 0 }),
        expect.objectContaining({ tenantId: '__default__', waiting: 1 }),
      ]),
    );
    fake.service.setTenantWeight('job', '__default__', 1);
    await fake.drain();
    expect(tenants.at(-1)).toBe('__default__');
  });

  it('keeps absent tenant undefined in start and terminal observer events', async () => {
    const events: JobLifecycleEvent[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['job'],
          events: { onEvent: (event) => events.push(event) },
        }),
      ],
    }).compile();
    moduleRef.get(HandlerRegistry).register('job', async () => undefined);
    await moduleRef.get(JobsService).enqueue('job', {});
    await moduleRef.init();
    await moduleRef.close();
    expect(events.map((e) => e.type)).toEqual(['job.enqueued', 'job.started', 'job.succeeded']);
    expect(events.every((e) => e.tenantId === undefined)).toBe(true);
  });
});

describe('automatic loop backend recovery', () => {
  it('observes a transient backend error, continues another type and drains recovered work', async () => {
    const errors: unknown[] = [];
    const app = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['one', 'two'],
          onWorkerError: (error) => errors.push(error),
        }),
      ],
    }).compile();
    const backend = app.get<InMemoryBackend>(JOBS_BACKEND);
    const jobs = app.get(JobsService);
    const calls: string[] = [];
    for (const type of ['one', 'two'])
      app.get(HandlerRegistry).register(type, async () => {
        calls.push(type);
      });
    const first = await jobs.enqueue('one', {});
    await jobs.enqueue('two', {});
    jest.spyOn(backend, 'moveToActive').mockRejectedValueOnce(new Error('transient'));
    await app.init();
    await eventually(() => expect(calls).toContain('two'));
    await eventually(() => expect(calls).toContain('one'));
    expect(errors).toHaveLength(1);
    expect((await backend.getJob(first))?.attempt).toBe(1);
    await app.close();
  });
});

describe('shutdown reconciliation ownership', () => {
  it('waits for a commit-then-throw acknowledgement to reconcile before closing', async () => {
    const events: JobLifecycleEvent[] = [];
    const app = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['job'],
          events: { onEvent: (event) => events.push(event) },
        }),
      ],
    }).compile();
    const backend = app.get<InMemoryBackend>(JOBS_BACKEND);
    const jobs = app.get(JobsService);
    const handler = jest.fn(async () => undefined);
    app.get(HandlerRegistry).register('job', handler);
    const ack = backend.ack.bind(backend);
    jest.spyOn(backend, 'ack').mockImplementationOnce(async (...args) => {
      await ack(...args);
      throw new Error('ack response lost');
    });
    const fail = jest.spyOn(backend, 'fail');
    await jobs.enqueue('job', {});
    await app.init();
    await app.close();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'job.succeeded')).toHaveLength(1);
  });
});
