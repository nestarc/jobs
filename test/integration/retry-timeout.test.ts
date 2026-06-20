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
    const jobId = await backend.enqueue('task', { ok: true }, {
      attempts: 2,
      backoff: { type: 'fixed', delayMs: 0 },
    });
    scheduler.onEnqueue(jobId, '__default__');

    await worker.tick();
    expect(await backend.getJob(jobId)).toMatchObject({ status: 'queued', attempt: 1 });

    await worker.tick();
    expect(await backend.getJob(jobId)).toMatchObject({ status: 'succeeded', attempt: 2 });
  });

  it('moves exhausted failures to dead_letter', async () => {
    const { backend, scheduler, worker } = setupWorker(jest.fn(async () => {
      throw new Error('permanent');
    }));
    const jobId = await backend.enqueue('task', { ok: true }, { attempts: 1 });
    scheduler.onEnqueue(jobId, '__default__');

    await worker.tick();

    expect(await backend.getJob(jobId)).toMatchObject({
      status: 'dead_letter',
      attempt: 1,
      error: { message: 'permanent' },
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
});
