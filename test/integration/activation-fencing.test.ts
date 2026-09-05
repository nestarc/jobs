import {
  FairWorker,
  HandlerRegistry,
  InMemoryBackend,
  JobsError,
  JobsErrorCode,
  Scheduler,
} from '../../src';

const conflict = { code: 'jobs_activation_conflict' };
const tokenOf = (job: unknown): string => (job as { activationId: string }).activationId;
const ack = (b: InMemoryBackend, id: string, token: string) => b.ack('task', id, token);
const fail = (b: InMemoryBackend, id: string, token: string) => b.fail('task', id, 'boom', token);

describe('M02 activation fencing', () => {
  it('rejects queued completion without consuming an attempt or changing history', async () => {
    const b = new InMemoryBackend();
    const id = await b.enqueue('task', {}, { attempts: 2 });
    const history = await b.getJobHistory(id);
    await expect(ack(b, id, 'forged')).rejects.toMatchObject(conflict);
    await expect(fail(b, id, 'forged')).rejects.toMatchObject(conflict);
    expect(await b.getJob(id)).toMatchObject({ status: 'queued', attempt: 0 });
    expect(await b.getJobHistory(id)).toEqual(history);
  });

  it('rejects stale and wrong tokens after a retry, and duplicate/opposite terminal completion', async () => {
    const b = new InMemoryBackend();
    const id = await b.enqueue('task', {}, { attempts: 2 });
    const first = tokenOf(await b.moveToActive('task', id));
    expect(first).toEqual(expect.any(String));
    await expect(ack(b, id, 'forged')).rejects.toMatchObject(conflict);
    await fail(b, id, first);
    const second = tokenOf(await b.moveToActive('task', id));
    expect(second).not.toBe(first);
    await expect(ack(b, id, first)).rejects.toMatchObject(conflict);
    await expect(fail(b, id, first)).rejects.toMatchObject(conflict);
    await ack(b, id, second);
    const history = await b.getJobHistory(id);
    await expect(ack(b, id, second)).rejects.toMatchObject(conflict);
    await expect(fail(b, id, second)).rejects.toMatchObject(conflict);
    await b.markCancelled('task', id);
    expect(await b.getJob(id)).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(await b.getJobHistory(id)).toEqual(history);
  });

  it('cancellation wins over a late active completion', async () => {
    const b = new InMemoryBackend();
    const id = await b.enqueue('task', {}, {});
    const token = tokenOf(await b.moveToActive('task', id));
    await b.markCancelled('task', id);
    await expect(ack(b, id, token)).rejects.toMatchObject(conflict);
    await expect(fail(b, id, token)).rejects.toMatchObject(conflict);
    expect(await b.getJob(id)).toMatchObject({ status: 'cancelled', attempt: 1 });
  });

  it('fences replay of the same ID and keeps its attempt history monotonic', async () => {
    const b = new InMemoryBackend();
    const id = await b.enqueue('task', {}, {});
    const oldToken = tokenOf(await b.moveToActive('task', id));
    await fail(b, id, oldToken);
    await b.replayDeadLetter(id, { preserveOriginalId: true });
    const newToken = tokenOf(await b.moveToActive('task', id));
    await expect(ack(b, id, oldToken)).rejects.toMatchObject(conflict);
    await ack(b, id, newToken);
    const attempts = (await b.getJobHistory(id)).map((entry) => entry.attempt);
    expect(attempts).toEqual([...attempts].sort((a, z) => a - z));
    expect(await b.getJob(id)).toMatchObject({ status: 'succeeded', attempt: 2 });
  });
});

describe('M02 transition boundaries', () => {
  it('does not activate future-delayed work or permit completion in the wrong job type', async () => {
    let now = new Date(0);
    const backend = new InMemoryBackend({ now: () => now });
    const id = await backend.enqueue('task', {}, { delayMs: 100 });
    expect(await backend.moveToActive('task', id)).toBeNull();
    await expect(backend.fail('task', id, 'boom', 'forged')).rejects.toMatchObject(conflict);
    now = new Date(100);
    const active = await backend.moveToActive('task', id);
    await expect(backend.ack('other', id, active!.activationId!)).rejects.toMatchObject(conflict);
    expect(await backend.getJob(id)).toMatchObject({ status: 'active', attempt: 1 });
  });

  it('admin discard cannot undo a replay and an old failure cannot affect the replay generation', async () => {
    const backend = new InMemoryBackend();
    const id = await backend.enqueue('task', {}, {});
    const first = await backend.moveToActive('task', id);
    await backend.fail('task', id, 'boom', first!.activationId!);
    await backend.replayDeadLetter(id, { preserveOriginalId: true });
    const next = await backend.moveToActive('task', id);
    await backend.discardDeadLetter(id);
    await expect(
      backend.markFailed('task', id, 'late', first!.activationId!),
    ).rejects.toMatchObject(conflict);
    await backend.ack('task', id, next!.activationId!);
    expect(await backend.getJob(id)).toMatchObject({ status: 'succeeded', attempt: 2 });
  });
});

it('fails closed before claiming work for a legacy custom backend', () => {
  const backend = new InMemoryBackend();
  jest
    .spyOn(backend, 'capabilities')
    .mockReturnValue({ ...backend.capabilities(), activationFencing: undefined });
  expect(
    () =>
      new FairWorker({
        jobType: 'task',
        backend,
        registry: new HandlerRegistry(),
        scheduler: new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 }),
        contextRunner: async (_ctx, fn) => fn(),
      }),
  ).toThrow('FairWorker requires activation fencing');
});

it('does not confuse a handler-thrown conflict error with a backend ownership conflict', async () => {
  const backend = new InMemoryBackend();
  const registry = new HandlerRegistry();
  const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
  registry.register('task', async () => {
    throw new JobsError(JobsErrorCode.ActivationConflict, 'application error');
  });
  const worker = new FairWorker({
    jobType: 'task',
    backend,
    registry,
    scheduler,
    contextRunner: async (_ctx, fn) => fn(),
  });
  const id = await backend.enqueue('task', {}, {});
  scheduler.onEnqueue(id, 'tenant');
  await worker.tick();
  expect(await backend.getJob(id)).toMatchObject({ status: 'dead_letter', attempt: 1 });
});
