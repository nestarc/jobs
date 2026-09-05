import {
  FairWorker,
  FakeClock,
  HandlerRegistry,
  InMemoryBackend,
  JobsService,
  Scheduler,
} from '../../src';

describe('worker operation reconciliation', () => {
  it.each(['moveToActive', 'ack', 'fail'] as const)(
    'recovers %s before and after commit without repeating handler work',
    async (operation) => {
      for (const commit of [false, true]) {
        const clock = new FakeClock();
        const backend = new InMemoryBackend({ now: () => clock.now() });
        const scheduler = new Scheduler({
          defaultWeight: 1,
          minSharePct: 0,
          tenantCap: 1,
          clock: () => clock.now(),
        });
        const registry = new HandlerRegistry();
        const handler = jest.fn(async () => {
          if (operation === 'fail') throw new Error('business');
        });
        registry.register('job', handler);
        const service = new JobsService({
          backend,
          registry,
          schedulers: new Map([['job', scheduler]]),
        });
        const worker = new FairWorker({
          backend,
          registry,
          scheduler,
          jobType: 'job',
          contextRunner: async (_ctx, fn) => fn(),
        });
        const id = await service.enqueue('job', {}, { attempts: 1 });
        const original = backend[operation].bind(backend);
        const spy = jest.spyOn(backend, operation);
        spy.mockImplementationOnce(async (...args: unknown[]) => {
          if (commit) await (original as (...args: unknown[]) => Promise<unknown>)(...args);
          throw new Error('response lost');
        });
        await expect(worker.tick()).rejects.toThrow('response lost');
        expect(scheduler.snapshot()[0].inflight).toBe(0);
        spy.mockRestore();
        clock.advanceBy(100);
        await worker.tick();
        expect((await backend.getJob(id))?.status).toBe(
          operation === 'fail' ? 'dead_letter' : 'succeeded',
        );
        expect(handler).toHaveBeenCalledTimes(1);
        expect((await backend.getJob(id))?.attempt).toBe(1);
      }
    },
  );
});

describe('reconciliation reads', () => {
  it('retries a failed getJob read without losing scheduler ownership', async () => {
    const clock = new FakeClock();
    const backend = new InMemoryBackend({ now: () => clock.now() });
    const scheduler = new Scheduler({
      defaultWeight: 1,
      minSharePct: 0,
      tenantCap: 1,
      clock: () => clock.now(),
    });
    const registry = new HandlerRegistry();
    const service = new JobsService({
      backend,
      registry,
      schedulers: new Map([['job', scheduler]]),
    });
    const id = await service.enqueue('job', {});
    await backend.markCancelled('job', id);
    const read = jest.spyOn(backend, 'getJob').mockRejectedValueOnce(new Error('read unavailable'));
    const worker = new FairWorker({
      backend,
      registry,
      scheduler,
      jobType: 'job',
      contextRunner: async (_ctx, fn) => fn(),
    });
    await expect(worker.tick()).rejects.toThrow('read unavailable');
    clock.advanceBy(50);
    await expect(worker.tick()).resolves.toBe(true);
    expect((await backend.getJob(id))?.status).toBe('cancelled');
    expect(scheduler.snapshot()[0]).toMatchObject({ waiting: 0, inflight: 0 });
    read.mockRestore();
  });
});
