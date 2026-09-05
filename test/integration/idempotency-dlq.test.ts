import {
  HandlerRegistry,
  InMemoryBackend,
  JobsService,
  Scheduler,
  type JobLifecycleEvent,
} from '../../src';

function setup(events?: JobLifecycleEvent[]) {
  const backend = new InMemoryBackend();
  const service = new JobsService({
    backend,
    registry: new HandlerRegistry(),
    jobTypes: ['report.generate'],
    events: events ? { onEvent: (event) => events.push(event) } : undefined,
  });
  return { backend, service };
}

describe('v0.2 idempotency and DLQ APIs', () => {
  it('rejects an empty explicit job ID before scheduler or indexes are changed', async () => {
    const { backend, service } = setup();

    await expect(
      service.enqueueDetailed('report.generate', { generation: 'invalid' }, { jobId: '' }),
    ).rejects.toThrow('jobId must be a non-empty string');
    await expect(backend.peekWaiting('report.generate')).resolves.toEqual([]);
  });

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

  it('preserves an existing in-memory job when an explicit job ID is reused', async () => {
    const { backend, service } = setup();
    const first = await service.enqueueDetailed(
      'report.generate',
      { generation: 'first' },
      { jobId: 'fixed-job-id' },
    );
    await backend.moveToActive('report.generate', first.jobId);

    await expect(
      service.enqueueDetailed(
        'report.generate',
        { generation: 'second' },
        { jobId: 'fixed-job-id' },
      ),
    ).resolves.toEqual({
      status: 'deduped',
      jobId: first.jobId,
      existingJobId: first.jobId,
    });
    await expect(service.getJob(first.jobId)).resolves.toMatchObject({
      status: 'active',
      attempt: 1,
      payload: { generation: 'first' },
    });
  });

  it('rejects an explicit in-memory job ID already owned by another job type', async () => {
    const backend = new InMemoryBackend();
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['type.a', 'type.b'],
    });
    await service.enqueueDetailed('type.a', { owner: 'a' }, { jobId: 'shared-explicit-id' });

    await expect(
      service.enqueueDetailed('type.b', { owner: 'b' }, { jobId: 'shared-explicit-id' }),
    ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
    await expect(service.getJob('shared-explicit-id')).resolves.toMatchObject({
      type: 'type.a',
      payload: { owner: 'a' },
    });
  });

  it('rejects an explicit job ID that conflicts with another supplied identity', async () => {
    const { service } = setup();
    const explicit = await service.enqueueDetailed(
      'report.generate',
      { owner: 'explicit' },
      { jobId: 'explicit-job' },
    );
    const idempotent = await service.enqueueDetailed(
      'report.generate',
      { owner: 'idempotent' },
      { idempotencyKey: 'existing-idempotency' },
    );

    expect(explicit.jobId).not.toBe(idempotent.jobId);
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        { jobId: explicit.jobId, idempotencyKey: 'existing-idempotency' },
      ),
    ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        { jobId: explicit.jobId, dedupe: { key: 'unused', mode: 'until_completed' } },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: explicit.jobId });
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
      dedupe: { key: 'active', mode: 'while_active' as const, ttlMs: 1_000 },
    };
    const activeId = await service.enqueue('report.generate', {}, whileActive);
    const activation = await backend.moveToActive('report.generate', activeId);
    now = new Date(now.getTime() + 5_000);
    await expect(
      service.enqueueDetailed('report.generate', {}, whileActive),
    ).resolves.toMatchObject({
      status: 'deduped',
      jobId: activeId,
    });
    await backend.ack('report.generate', activeId, activation!.activationId!);
    await expect(
      service.enqueueDetailed('report.generate', {}, whileActive),
    ).resolves.toMatchObject({ status: 'created' });

    const untilCompleted = {
      dedupe: { key: 'retained', mode: 'until_completed' as const, ttlMs: 1_000 },
    };
    const retainedId = await service.enqueue('report.generate', {}, untilCompleted);
    const nextActivation1 = await backend.moveToActive('report.generate', retainedId);
    now = new Date(now.getTime() + 5_000);
    await backend.ack('report.generate', retainedId, nextActivation1!.activationId!);
    await expect(
      service.enqueueDetailed('report.generate', {}, untilCompleted),
    ).resolves.toMatchObject({ status: 'deduped', jobId: retainedId });

    now = new Date(now.getTime() + 1_001);
    await expect(
      service.enqueueDetailed('report.generate', {}, untilCompleted),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('does not expose mutable terminal timestamps through job records', async () => {
    let now = new Date('2026-08-18T00:00:00.000Z');
    const backend = new InMemoryBackend({ now: () => now });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['report.generate'],
    });
    const options = {
      dedupe: { key: 'immutable-terminal', mode: 'until_completed' as const, ttlMs: 1_000 },
    };
    const jobId = await service.enqueue('report.generate', {}, options);
    const activation = await backend.moveToActive('report.generate', jobId);
    await backend.ack('report.generate', jobId, activation!.activationId!);

    const record = await service.getJob(jobId);
    record?.completedAt?.setTime(0);
    now = new Date('2026-08-18T00:00:00.500Z');

    await expect(service.enqueueDetailed('report.generate', {}, options)).resolves.toMatchObject({
      status: 'deduped',
      jobId,
    });
  });

  it('scopes idempotency and dedupe identities to each job type', async () => {
    const backend = new InMemoryBackend();
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['type.a', 'type.b'],
    });

    const firstIdempotent = await service.enqueueDetailed(
      'type.a',
      {},
      { idempotencyKey: 'shared' },
    );
    const secondIdempotent = await service.enqueueDetailed(
      'type.b',
      {},
      { idempotencyKey: 'shared' },
    );
    expect(firstIdempotent.status).toBe('created');
    expect(secondIdempotent.status).toBe('created');
    expect(firstIdempotent.jobId).not.toBe(secondIdempotent.jobId);

    const firstDedupe = await service.enqueueDetailed(
      'type.a',
      {},
      { dedupe: { key: 'shared', mode: 'until_completed' } },
    );
    const secondDedupe = await service.enqueueDetailed(
      'type.b',
      {},
      { dedupe: { key: 'shared', mode: 'until_completed' } },
    );
    expect(firstDedupe.status).toBe('created');
    expect(secondDedupe.status).toBe('created');
    expect(firstDedupe.jobId).not.toBe(secondDedupe.jobId);
  });

  it('backfills every supplied identity when one identity dedupes the enqueue', async () => {
    const { backend, service } = setup();
    const first = await service.enqueueDetailed(
      'report.generate',
      {},
      {
        idempotencyKey: 'identity-a',
        dedupe: { key: 'shared', mode: 'while_active' },
      },
    );
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        {
          idempotencyKey: 'identity-b',
          dedupe: { key: 'shared', mode: 'while_active' },
        },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: first.jobId });

    const activation = await backend.moveToActive('report.generate', first.jobId);
    await backend.ack('report.generate', first.jobId, activation!.activationId!);

    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        {
          idempotencyKey: 'identity-b',
          dedupe: { key: 'different', mode: 'while_active' },
        },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: first.jobId });
  });

  it('rejects supplied identities that already resolve to different jobs', async () => {
    const { service } = setup();
    const idempotent = await service.enqueueDetailed(
      'report.generate',
      {},
      { idempotencyKey: 'conflicting-idempotency' },
    );
    const deduped = await service.enqueueDetailed(
      'report.generate',
      {},
      { dedupe: { key: 'conflicting-dedupe', mode: 'until_completed' } },
    );

    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        {
          idempotencyKey: 'conflicting-idempotency',
          dedupe: { key: 'conflicting-dedupe', mode: 'until_completed' },
        },
      ),
    ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
    await expect(
      service.enqueueDetailed('report.generate', {}, { idempotencyKey: 'conflicting-idempotency' }),
    ).resolves.toMatchObject({ jobId: idempotent.jobId });
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        { dedupe: { key: 'conflicting-dedupe', mode: 'until_completed' } },
      ),
    ).resolves.toMatchObject({ jobId: deduped.jobId });
  });

  it('encodes tenant dedupe identities without delimiter collisions', async () => {
    const { service } = setup();
    const first = await service.enqueueDetailed(
      'report.generate',
      {},
      {
        context: { tenantId: 'a:b' },
        dedupe: { key: 'c', scope: 'tenant' },
      },
    );
    const second = await service.enqueueDetailed(
      'report.generate',
      {},
      {
        context: { tenantId: 'a' },
        dedupe: { key: 'b:c', scope: 'tenant' },
      },
    );

    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('lists, replays, and discards dead-lettered jobs', async () => {
    const { backend, service } = setup();
    const jobId = await service.enqueue(
      'report.generate',
      {},
      { attempts: 1, context: { tenantId: 'tenant_1', correlationId: 'corr_1' } },
    );
    const activation = await backend.moveToActive('report.generate', jobId);
    await backend.fail('report.generate', jobId, 'boom', activation!.activationId!);

    expect(await service.listDeadLetters()).toEqual([
      expect.objectContaining({ id: jobId, status: 'dead_letter' }),
    ]);

    const replayedId = await service.replayDeadLetter(jobId);
    expect(replayedId).not.toBe(jobId);
    expect(await service.getJob(replayedId)).toMatchObject({
      status: 'queued',
      attempt: 0,
      context: { tenantId: 'tenant_1', correlationId: 'corr_1' },
    });

    await service.discardDeadLetter(jobId, 'handled manually');
    expect(await service.getJob(jobId)).toMatchObject({ status: 'cancelled' });
  });

  it('emits discarded only when a dead-letter transition commits', async () => {
    const events: JobLifecycleEvent[] = [];
    const { backend, service } = setup(events);
    const jobId = await service.enqueue(
      'report.generate',
      { reportId: 'report_1' },
      {
        attempts: 1,
        context: { tenantId: 'tenant_1' },
        metadata: { source: 'operator' },
      },
    );
    const queuedId = await service.enqueue('report.generate', { reportId: 'queued' });
    const activation = await backend.moveToActive('report.generate', jobId);
    await backend.fail('report.generate', jobId, 'boom', activation!.activationId!);

    await service.discardDeadLetter(jobId, 'handled manually');
    await service.discardDeadLetter(jobId, 'already discarded');
    await service.discardDeadLetter(queuedId, 'not a dead letter');
    await service.discardDeadLetter('missing', 'not found');

    expect(events.filter((event) => event.type === 'job.discarded')).toEqual([
      expect.objectContaining({
        type: 'job.discarded',
        jobId,
        jobType: 'report.generate',
        tenantId: 'tenant_1',
        attempt: 1,
        at: expect.any(Date),
        metadata: { source: 'operator' },
      }),
    ]);
    await expect(service.getJobHistory(jobId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'cancelled', reason: 'handled manually' }),
      ]),
    );
  });

  it('isolates replay payload, context, and metadata from the cancelled source record', async () => {
    const { backend, service } = setup();
    const originalId = await service.enqueue(
      'report.generate',
      { nested: { value: 'source' } },
      {
        attempts: 1,
        context: { tenantId: 'tenant_1', nested: { value: 'source' } },
        metadata: { nested: { value: 'source' } },
      },
    );
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'boom', activation!.activationId!);

    const replayedId = await service.replayDeadLetter(originalId);
    const replayed = await backend.moveToActive('report.generate', replayedId);
    (replayed?.payload as { nested: { value: string } }).nested.value = 'replayed';
    (replayed?.context.nested as { value: string }).value = 'replayed';
    (replayed?.metadata.nested as { value: string }).value = 'replayed';

    await expect(service.getJob(originalId)).resolves.toMatchObject({
      payload: { nested: { value: 'source' } },
      context: { nested: { value: 'source' } },
      metadata: { nested: { value: 'source' } },
    });
  });

  it('preserves a real __default__ tenant ID in replay events', async () => {
    const events: JobLifecycleEvent[] = [];
    const { backend, service } = setup(events);
    const originalId = await service.enqueue(
      'report.generate',
      {},
      { attempts: 1, context: { tenantId: '__default__' } },
    );
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'boom', activation!.activationId!);

    const replayedId = await service.replayDeadLetter(originalId);
    expect(events.filter((event) => event.type === 'job.replayed')).toEqual([
      expect.objectContaining({ jobId: replayedId, tenantId: '__default__' }),
    ]);
  });

  it('rebinds replay identity and honors resetAttempts=false', async () => {
    const events: JobLifecycleEvent[] = [];
    const { backend, service } = setup(events);
    const options = {
      attempts: 1,
      idempotencyKey: 'replay-identity',
      dedupe: { key: 'replay-dedupe', mode: 'until_completed' as const },
      metadata: { original: true },
    };
    const originalId = await service.enqueue('report.generate', {}, options);
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'boom', activation!.activationId!);

    const replayedId = await service.replayDeadLetter(originalId, {
      resetAttempts: false,
      metadata: { operator: 'manual' },
    });

    expect(replayedId).not.toBe(originalId);
    expect(await service.getJob(originalId)).toMatchObject({ status: 'cancelled' });
    expect(await service.getJob(replayedId)).toMatchObject({
      status: 'queued',
      attempt: 1,
      idempotencyKey: 'replay-identity',
      metadata: { original: true, operator: 'manual', replayOf: originalId },
    });
    await expect(service.enqueueDetailed('report.generate', {}, options)).resolves.toMatchObject({
      status: 'deduped',
      jobId: replayedId,
    });
    expect(events.filter((event) => event.type === 'job.replayed')).toEqual([
      expect.objectContaining({
        jobId: replayedId,
        attempt: 1,
        metadata: { original: true, operator: 'manual', replayOf: originalId },
      }),
    ]);
  });

  it('preserves backfilled identity lineage across dead-letter replay', async () => {
    const { backend, service } = setup();
    const originalId = await service.enqueue(
      'report.generate',
      {},
      { idempotencyKey: 'backfilled-replay-idempotency' },
    );
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        {
          idempotencyKey: 'backfilled-replay-idempotency',
          dedupe: { key: 'backfilled-replay-dedupe', mode: 'until_completed' },
        },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: originalId });
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'boom', activation!.activationId!);

    const replayedId = await service.replayDeadLetter(originalId);
    expect(replayedId).not.toBe(originalId);
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        { dedupe: { key: 'backfilled-replay-dedupe', mode: 'until_completed' } },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: replayedId });
  });

  it('rebinds every identity when replay converges on an existing job', async () => {
    let now = new Date('2026-08-16T00:00:00.000Z');
    const backend = new InMemoryBackend({ now: () => now });
    const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      schedulers: new Map([['report.generate', scheduler]]),
    });
    const originalId = await service.enqueue(
      'report.generate',
      {},
      {
        context: { tenantId: 'tenant_1' },
        idempotencyKey: 'converged-replay-idempotency',
        dedupe: { key: 'converged-replay-dedupe', mode: 'until_completed', ttlMs: 10 },
      },
    );
    expect(scheduler.pickNext()?.jobId).toBe(originalId);
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'boom', activation!.activationId!);
    scheduler.onAck(originalId);

    now = new Date('2026-08-16T00:00:00.020Z');
    const existing = await service.enqueueDetailed(
      'report.generate',
      {},
      {
        context: { tenantId: 'tenant_1' },
        dedupe: { key: 'converged-replay-dedupe', mode: 'until_completed', ttlMs: 10 },
      },
    );
    expect(existing.status).toBe('created');

    await expect(service.replayDeadLetter(originalId)).resolves.toBe(existing.jobId);
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        { idempotencyKey: 'converged-replay-idempotency' },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: existing.jobId });
    expect(scheduler.snapshot()).toEqual([
      expect.objectContaining({ tenantId: 'tenant_1', waiting: 1 }),
    ]);
  });

  it('creates runnable work instead of converging replay onto a terminal job', async () => {
    let now = new Date('2026-08-16T00:00:00.000Z');
    const backend = new InMemoryBackend({ now: () => now });
    const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    const events: JobLifecycleEvent[] = [];
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      schedulers: new Map([['report.generate', scheduler]]),
      events: { onEvent: (event) => events.push(event) },
    });
    const originalId = await service.enqueue(
      'report.generate',
      {},
      {
        idempotencyKey: 'terminal-replay-idempotency',
        dedupe: { key: 'terminal-replay-dedupe', mode: 'until_completed', ttlMs: 10 },
      },
    );
    scheduler.pickNext();
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'first failure', activation!.activationId!);
    scheduler.onAck(originalId);

    now = new Date('2026-08-16T00:00:00.020Z');
    const terminalTarget = await service.enqueueDetailed(
      'report.generate',
      {},
      { dedupe: { key: 'terminal-replay-dedupe', mode: 'until_completed', ttlMs: 1_000 } },
    );
    scheduler.pickNext();
    const nextActivation1 = await backend.moveToActive('report.generate', terminalTarget.jobId);
    await backend.ack('report.generate', terminalTarget.jobId, nextActivation1!.activationId!);
    scheduler.onAck(terminalTarget.jobId);

    const replayedId = await service.replayDeadLetter(originalId);

    expect(replayedId).not.toBe(terminalTarget.jobId);
    await expect(service.getJob(replayedId)).resolves.toMatchObject({ status: 'queued' });
    expect(scheduler.snapshot()).toEqual([
      expect.objectContaining({ tenantId: '__default__', waiting: 1 }),
    ]);
    expect(events.filter((event) => event.type === 'job.replayed')).toEqual([
      expect.objectContaining({ jobId: replayedId }),
    ]);
  });

  it('preserves the current terminal dedupe policy when replay replaces its mapping', async () => {
    let now = new Date('2026-08-16T00:00:00.000Z');
    const backend = new InMemoryBackend({ now: () => now });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['report.generate'],
    });
    const originalId = await service.enqueue(
      'report.generate',
      {},
      { dedupe: { key: 'retained-replay-policy', mode: 'until_completed', ttlMs: 10 } },
    );
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'first failure', activation!.activationId!);

    now = new Date('2026-08-16T00:00:00.020Z');
    const terminalTarget = await service.enqueueDetailed(
      'report.generate',
      {},
      { dedupe: { key: 'retained-replay-policy', mode: 'until_completed', ttlMs: 1_000 } },
    );
    const nextActivation1 = await backend.moveToActive('report.generate', terminalTarget.jobId);
    await backend.ack('report.generate', terminalTarget.jobId, nextActivation1!.activationId!);

    const replayedId = await service.replayDeadLetter(originalId);
    const nextActivation2 = await backend.moveToActive('report.generate', replayedId);
    await backend.ack('report.generate', replayedId, nextActivation2!.activationId!);

    now = new Date('2026-08-16T00:00:00.031Z');
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        { dedupe: { key: 'retained-replay-policy', mode: 'until_completed', ttlMs: 5 } },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: replayedId });

    now = new Date('2026-08-16T00:00:01.021Z');
    await expect(
      service.enqueueDetailed(
        'report.generate',
        {},
        { dedupe: { key: 'retained-replay-policy', mode: 'until_completed', ttlMs: 5 } },
      ),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('preserves converged identity lineage through a later replay generation', async () => {
    let now = new Date('2026-08-16T00:00:00.000Z');
    const backend = new InMemoryBackend({ now: () => now });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['report.generate'],
    });
    const originalId = await service.enqueue(
      'report.generate',
      {},
      {
        idempotencyKey: 'multi-hop-idempotency',
        dedupe: { key: 'multi-hop-dedupe', mode: 'until_completed', ttlMs: 10 },
      },
    );
    const activation = await backend.moveToActive('report.generate', originalId);
    await backend.fail('report.generate', originalId, 'first failure', activation!.activationId!);

    now = new Date('2026-08-16T00:00:00.020Z');
    const convergedTarget = await service.enqueueDetailed(
      'report.generate',
      {},
      { dedupe: { key: 'multi-hop-dedupe', mode: 'until_completed', ttlMs: 10 } },
    );
    await expect(service.replayDeadLetter(originalId)).resolves.toBe(convergedTarget.jobId);

    const nextActivation1 = await backend.moveToActive('report.generate', convergedTarget.jobId);
    await backend.fail(
      'report.generate',
      convergedTarget.jobId,
      'second failure',
      nextActivation1!.activationId!,
    );
    const replayedId = await service.replayDeadLetter(convergedTarget.jobId);

    await expect(
      service.enqueueDetailed('report.generate', {}, { idempotencyKey: 'multi-hop-idempotency' }),
    ).resolves.toMatchObject({ status: 'deduped', jobId: replayedId });
  });

  it('does not restart an expired dedupe retention window when a dead letter is discarded', async () => {
    let now = new Date('2026-08-16T00:00:00.000Z');
    const backend = new InMemoryBackend({ now: () => now });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['report.generate'],
    });
    const options = {
      dedupe: { key: 'discarded', mode: 'until_completed' as const, ttlMs: 100 },
    };
    const jobId = await service.enqueue('report.generate', {}, options);
    const activation = await backend.moveToActive('report.generate', jobId);
    await backend.fail('report.generate', jobId, 'boom', activation!.activationId!);

    now = new Date('2026-08-16T00:00:00.200Z');
    await service.discardDeadLetter(jobId);

    await expect(service.enqueueDetailed('report.generate', {}, options)).resolves.toMatchObject({
      status: 'created',
    });
  });
});
