import { HandlerRegistry, InMemoryBackend, JobsService, Scheduler } from '../../src';

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
    const first = await service.enqueueDetailed(
      'report.generate',
      {},
      {
        idempotencyKey: 'idem_1',
      },
    );
    const secondId = await service.enqueue(
      'report.generate',
      {},
      {
        idempotencyKey: 'idem_1',
      },
    );
    const second = await service.enqueueDetailed(
      'report.generate',
      {},
      {
        idempotencyKey: 'idem_1',
      },
    );

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
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        {
          dedupe: { key: 'monthly', scope: 'tenant' },
        },
      ),
    ).rejects.toThrow('tenant');
  });

  it('does not add phantom scheduler work for a deduped enqueue', async () => {
    const backend = new InMemoryBackend();
    const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      schedulers: new Map([['report.generate', scheduler]]),
    });
    const options = {
      context: { tenantId: 'tenant_1' },
      idempotencyKey: 'report_1',
    };

    await service.enqueueDetailed('report.generate', {}, options);
    await service.enqueueDetailed('report.generate', {}, options);

    expect(scheduler.snapshot()).toEqual([
      expect.objectContaining({ tenantId: 'tenant_1', waiting: 1 }),
    ]);
  });

  it('applies dedupe mode and TTL consistently in memory', async () => {
    let now = new Date('2026-08-15T00:00:00.000Z');
    const backend = new InMemoryBackend({ now: () => now });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['report.generate'],
    });
    const whileActive = {
      dedupe: { key: 'active', mode: 'while_active' as const },
    };
    const activeId = await service.enqueue('report.generate', {}, whileActive);
    await backend.moveToActive('report.generate', activeId);
    await backend.ack('report.generate', activeId);
    await expect(
      service.enqueueDetailed('report.generate', {}, whileActive),
    ).resolves.toMatchObject({
      status: 'created',
    });

    const untilCompleted = {
      dedupe: { key: 'retained', mode: 'until_completed' as const, ttlMs: 1_000 },
    };
    const retainedId = await service.enqueue('report.generate', {}, untilCompleted);
    await backend.moveToActive('report.generate', retainedId);
    now = new Date(now.getTime() + 5_000);
    await backend.ack('report.generate', retainedId);
    await expect(
      service.enqueueDetailed('report.generate', {}, untilCompleted),
    ).resolves.toMatchObject({ status: 'deduped', jobId: retainedId });

    now = new Date(now.getTime() + 1_001);
    await expect(
      service.enqueueDetailed('report.generate', {}, untilCompleted),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('lists, replays, and discards dead-lettered jobs', async () => {
    const { backend, service } = setup();
    const jobId = await service.enqueue(
      'report.generate',
      {},
      { attempts: 1, context: { tenantId: 'tenant_1', correlationId: 'corr_1' } },
    );
    await backend.moveToActive('report.generate', jobId);
    await backend.fail('report.generate', jobId, 'boom');

    expect(await service.listDeadLetters()).toEqual([
      expect.objectContaining({ id: jobId, status: 'dead_letter' }),
    ]);

    const replayedId = await service.replayDeadLetter(jobId);
    expect(replayedId).not.toBe(jobId);
    expect(await service.getJob(replayedId)).toMatchObject({
      status: 'queued',
      context: { tenantId: 'tenant_1', correlationId: 'corr_1' },
    });

    await service.discardDeadLetter(jobId, 'handled manually');
    expect(await service.getJob(jobId)).toMatchObject({ status: 'cancelled' });
  });
});
