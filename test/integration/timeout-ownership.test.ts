import {
  FairWorker,
  HandlerRegistry,
  InMemoryBackend,
  Scheduler,
  type JobLifecycleEvent,
} from '../../src';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(
  handler: (payload: Record<string, unknown>, ctx: { signal?: AbortSignal }) => Promise<void>,
) {
  const backend = new InMemoryBackend();
  const registry = new HandlerRegistry();
  const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
  const events: JobLifecycleEvent[] = [];
  registry.register('task', handler);
  const worker = new FairWorker({
    jobType: 'task',
    backend,
    registry,
    scheduler,
    contextRunner: async (_ctx, fn) => fn(),
    events: { onEvent: (e) => events.push(e) },
  });
  return { backend, scheduler, worker, events };
}

describe('M05 timeout ownership', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(['resolve', 'reject'] as const)(
    'holds the slot until a late %s, then retries once',
    async (settle) => {
      const first = deferred();
      let signal: AbortSignal | undefined;
      const handler = jest.fn(async (_payload, ctx) => {
        signal = ctx.signal;
        if (handler.mock.calls.length === 1) return first.promise;
      });
      const { backend, scheduler, worker, events } = setup(handler);
      const id = await backend.enqueue('task', {}, { attempts: 2, timeoutMs: 10 });
      scheduler.onEnqueue(id, 'tenant');
      let finished = false;
      const tick = worker.tick().then(() => {
        finished = true;
      });
      try {
        await jest.advanceTimersByTimeAsync(10);
        expect(signal?.aborted).toBe(true);
        expect(finished).toBe(false);
        expect(await backend.getJob(id)).toMatchObject({ status: 'active', attempt: 1 });
        expect(scheduler.snapshot()[0].inflight).toBe(1);
        await expect(worker.tick()).resolves.toBe(false);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(events.map((e) => e.type)).toEqual(['job.started', 'job.timed_out']);
      } finally {
        if (settle === 'resolve') first.resolve();
        else first.reject(new Error('late rejection'));
        await tick;
      }
      expect(events.map((e) => e.type)).toEqual([
        'job.started',
        'job.timed_out',
        'job.retry_scheduled',
      ]);
      await worker.tick();
      expect(await backend.getJob(id)).toMatchObject({ status: 'succeeded', attempt: 2 });
      expect(handler).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps a never-settling invocation owned after arbitrarily many timeout periods', async () => {
    const pending = deferred();
    const { backend, scheduler, worker } = setup(async () => pending.promise);
    const id = await backend.enqueue('task', {}, { attempts: 3, timeoutMs: 5 });
    scheduler.onEnqueue(id, 'tenant');
    let finished = false;
    const tick = worker.tick().then(() => {
      finished = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(60_000);
      expect(finished).toBe(false);
      expect(await backend.getJob(id)).toMatchObject({ status: 'active', attempt: 1 });
      await expect(worker.tick()).resolves.toBe(false);
    } finally {
      // Test cleanup only; the assertion above covers an invocation that never settles.
      pending.resolve();
      await tick;
    }
  });

  it('a cooperative abort still records timeout before its terminal outcome', async () => {
    const { backend, scheduler, worker, events } = setup(
      async (_payload, ctx) =>
        new Promise<void>((resolve) => ctx.signal!.addEventListener('abort', () => resolve())),
    );
    const id = await backend.enqueue('task', {}, { timeoutMs: 5 });
    scheduler.onEnqueue(id, 'tenant');
    const tick = worker.tick();
    await jest.advanceTimersByTimeAsync(5);
    await tick;
    expect(events.map((e) => e.type)).toEqual([
      'job.started',
      'job.timed_out',
      'job.dead_lettered',
    ]);
    expect(await backend.getJob(id)).toMatchObject({
      status: 'dead_letter',
      error: { reason: 'timeout' },
    });
  });
});
