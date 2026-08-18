import { FairWorker, HandlerRegistry, InMemoryBackend, Scheduler } from '../../src';

function setupWorker(handler: jest.Mock, now = () => new Date()) {
  const backend = new InMemoryBackend({ now });
  const registry = new HandlerRegistry();
  registry.register('task', handler);
  const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
  const worker = new FairWorker({
    jobType: 'task',
    backend,
    scheduler,
    registry,
    contextRunner: async (_ctx, fn) => fn(),
  });
  return { backend, scheduler, worker };
}

describe('v0.2 retry and timeout', () => {
  it('requeues failed jobs until attempts are exhausted', async () => {
    let calls = 0;
    const handler = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
    });
    const { backend, scheduler, worker } = setupWorker(handler);
    const jobId = await backend.enqueue(
      'task',
      { ok: true },
      {
        attempts: 2,
        backoff: { type: 'fixed', delayMs: 0 },
      },
    );
    scheduler.onEnqueue(jobId, '__default__');

    await worker.tick();
    expect(await backend.getJob(jobId)).toMatchObject({ status: 'queued', attempt: 1 });

    await worker.tick();
    expect(await backend.getJob(jobId)).toMatchObject({ status: 'succeeded', attempt: 2 });
  });

  it('moves exhausted failures to dead_letter', async () => {
    const { backend, scheduler, worker } = setupWorker(
      jest.fn(async () => {
        throw new Error('permanent');
      }),
    );
    const jobId = await backend.enqueue('task', { ok: true }, { attempts: 1 });
    scheduler.onEnqueue(jobId, '__default__');

    await worker.tick();

    expect(await backend.getJob(jobId)).toMatchObject({
      status: 'dead_letter',
      attempt: 1,
      error: { message: 'permanent' },
    });
  });

  it('normalizes unstringifiable non-Error rejections without stalling the worker', async () => {
    const { backend, scheduler, worker } = setupWorker(
      jest.fn(async () => {
        throw Object.create(null) as unknown;
      }),
    );
    const jobId = await backend.enqueue('task', { ok: true }, { attempts: 1 });
    scheduler.onEnqueue(jobId, '__default__');

    await expect(worker.tick()).resolves.toBe(true);
    expect(await backend.getJob(jobId)).toMatchObject({
      status: 'dead_letter',
      error: { message: 'Job handler rejected with a non-error value' },
    });
    expect(scheduler.snapshot()).toEqual([expect.objectContaining({ waiting: 0, inflight: 0 })]);
  });

  it('handles a synchronous context runner failure without stranding active work', async () => {
    const backend = new InMemoryBackend();
    const registry = new HandlerRegistry();
    registry.register('task', async () => undefined);
    const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    const worker = new FairWorker({
      jobType: 'task',
      backend,
      scheduler,
      registry,
      contextRunner: () => {
        throw new Error('context setup failed');
      },
    });
    const jobId = await backend.enqueue('task', {}, {});
    scheduler.onEnqueue(jobId, '__default__');

    await expect(worker.tick()).resolves.toBe(true);
    await expect(backend.getJob(jobId)).resolves.toMatchObject({
      status: 'dead_letter',
      error: { message: 'context setup failed' },
    });
    expect(scheduler.snapshot()).toEqual([expect.objectContaining({ waiting: 0, inflight: 0 })]);
  });

  it('clears retry scheduling fields when the final attempt is exhausted', async () => {
    let now = new Date('2026-08-16T00:00:00.000Z');
    const { backend, scheduler, worker } = setupWorker(
      jest.fn(async () => {
        throw new Error('permanent');
      }),
      () => now,
    );
    const jobId = await backend.enqueue(
      'task',
      { ok: true },
      { attempts: 2, backoff: { type: 'fixed', delayMs: 100 } },
    );
    scheduler.onEnqueue(jobId, '__default__');

    await worker.tick();
    expect(await backend.getJob(jobId)).toMatchObject({
      status: 'delayed',
      nextAttemptAt: new Date('2026-08-16T00:00:00.100Z'),
    });

    now = new Date('2026-08-16T00:00:00.100Z');
    await worker.tick();
    expect(await backend.getJob(jobId)).toMatchObject({
      status: 'dead_letter',
      nextAttemptAt: undefined,
      scheduledFor: undefined,
    });
  });

  it('passes an abort signal and fails timed out jobs', async () => {
    let signal: AbortSignal | undefined;
    const handler = jest.fn(
      async (_payload, ctx) =>
        new Promise<void>((resolve) => {
          signal = ctx.signal as AbortSignal;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const { backend, scheduler, worker } = setupWorker(handler);
    const jobId = await backend.enqueue('task', {}, { timeoutMs: 1 });
    scheduler.onEnqueue(jobId, '__default__');

    await worker.tick();

    expect(signal?.aborted).toBe(true);
    expect(await backend.getJob(jobId)).toMatchObject({
      status: 'dead_letter',
      error: { reason: 'timeout' },
    });
  });

  it('snapshots the started event date before invoking lifecycle observers', async () => {
    const backend = new InMemoryBackend();
    const registry = new HandlerRegistry();
    registry.register('task', async () => undefined);
    const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    let finishStartedAt: Date | undefined;
    let succeededDurationMs: number | undefined;
    const worker = new FairWorker({
      jobType: 'task',
      backend,
      scheduler,
      registry,
      contextRunner: async (_ctx, fn) => fn(),
      onFinish: (event) => {
        finishStartedAt = event.startedAt;
      },
      events: {
        onEvent: (event) => {
          if (event.type === 'job.started') event.at.setTime(0);
          if (event.type === 'job.succeeded') succeededDurationMs = event.durationMs;
        },
      },
    });
    const jobId = await backend.enqueue('task', {}, {});
    scheduler.onEnqueue(jobId, '__default__');

    await worker.tick();

    expect(finishStartedAt?.getTime()).not.toBe(0);
    expect(succeededDurationMs).toBeDefined();
    expect(succeededDurationMs!).toBeLessThan(10_000);
  });
});
