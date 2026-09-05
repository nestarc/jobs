import { InMemoryBackend } from '../../src';

describe('M01 backend admission and close', () => {
  it('reports accepted work instead of silently deleting it, then closes after explicit cancellation', async () => {
    const backend = new InMemoryBackend();
    const accepted = backend.enqueue('task', {}, { jobId: 'accepted' });
    await expect(backend.close()).rejects.toMatchObject({
      code: 'jobs_shutdown_incomplete',
      remainingJobIds: ['accepted'],
      remainingCount: 1,
    });
    expect(await accepted).toBe('accepted');
    expect(await backend.getJob('accepted')).toMatchObject({ status: 'queued' });
    await expect(backend.enqueue('task', {}, {})).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });
    await backend.markCancelled('task', 'accepted');
    await backend.close();
    await backend.close();
    await expect(backend.enqueueDetailed('task', {}, {})).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });
  });

  it('rejects post-close admission even when close wins in the same turn', async () => {
    const backend = new InMemoryBackend();
    const closing = backend.close();
    await expect(backend.enqueue('task', {}, {})).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });
    await closing;
  });
});

describe('M01 retained delayed work and replay admission', () => {
  it('reports both active and future-delayed jobs without waiting for their due date', async () => {
    const backend = new InMemoryBackend();
    const active = await backend.enqueue('task', {}, { jobId: 'active' });
    await backend.moveToActive('task', active);
    await backend.enqueue('task', {}, { jobId: 'delayed', delayMs: 60_000 });
    await expect(backend.close()).rejects.toMatchObject({
      remainingJobIds: ['active', 'delayed'],
      remainingCount: 2,
    });
    await backend.markCancelled('task', 'active');
    await backend.markCancelled('task', 'delayed');
    await backend.close();
    expect(backend.lifecycleState).toBe('closed');
  });

  it('blocks replay and deduped admission once closing begins', async () => {
    const backend = new InMemoryBackend();
    const id = await backend.enqueue('task', {}, { idempotencyKey: 'stable' });
    const activation = await backend.moveToActive('task', id);
    await backend.fail('task', id, 'boom', activation!.activationId!);
    backend.beginClose();
    await expect(backend.replayDeadLetter(id)).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });
    await expect(backend.enqueue('task', {}, { idempotencyKey: 'stable' })).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });
    expect(await backend.getJob(id)).toMatchObject({ status: 'dead_letter' });
    await backend.close();
  });
});
