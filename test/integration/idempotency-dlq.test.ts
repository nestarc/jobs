import { HandlerRegistry, InMemoryBackend, JobsService } from '../../src';

function setup() {
  const backend = new InMemoryBackend();
  const service = new JobsService({
    backend,
    registry: new HandlerRegistry(),
    jobTypes: ['report.generate'],
  });
  return { backend, service };
}

describe('v0.2 idempotency and DLQ APIs', () => {
  it('preserves enqueue return compatibility while exposing detailed dedupe result', async () => {
    const { service } = setup();
    const first = await service.enqueueDetailed('report.generate', {}, {
      idempotencyKey: 'idem_1',
    });
    const secondId = await service.enqueue('report.generate', {}, {
      idempotencyKey: 'idem_1',
    });
    const second = await service.enqueueDetailed('report.generate', {}, {
      idempotencyKey: 'idem_1',
    });

    expect(first).toMatchObject({ status: 'created' });
    expect(secondId).toBe(first.jobId);
    expect(second).toMatchObject({
      status: 'deduped',
      jobId: first.jobId,
      existingJobId: first.jobId,
    });
  });

  it('requires tenant context for tenant-scoped dedupe', async () => {
    const { service } = setup();
    await expect(service.enqueueDetailed('report.generate', {}, {
      dedupe: { key: 'monthly', scope: 'tenant' },
    })).rejects.toThrow('tenant');
  });

  it('lists, replays, and discards dead-lettered jobs', async () => {
    const { backend, service } = setup();
    const jobId = await service.enqueue('report.generate', {}, { attempts: 1 });
    await backend.moveToActive('report.generate', jobId);
    await backend.fail('report.generate', jobId, 'boom');

    expect(await service.listDeadLetters()).toEqual([
      expect.objectContaining({ id: jobId, status: 'dead_letter' }),
    ]);

    const replayedId = await service.replayDeadLetter(jobId);
    expect(replayedId).not.toBe(jobId);
    expect(await service.getJob(replayedId)).toMatchObject({ status: 'queued' });

    await service.discardDeadLetter(jobId, 'handled manually');
    expect(await service.getJob(jobId)).toMatchObject({ status: 'cancelled' });
  });
});
