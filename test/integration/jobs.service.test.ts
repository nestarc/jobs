import { JobsService } from '../../src/jobs.service';
import { HandlerRegistry } from '../../src/handler-registry';
import { Scheduler } from '../../src/scheduler';
import { InMemoryBackend } from '../../src/backend/in-memory-backend';

function setup() {
  const backend = new InMemoryBackend();
  const registry = new HandlerRegistry();
  const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
  const service = new JobsService({
    backend,
    registry,
    schedulers: new Map([['doThing', scheduler]]),
    contextExtractor: () => ({ tenantId: 't1' }),
    contextRunner: async (_ctx, fn) => fn(),
  });
  return { service, scheduler, backend, registry };
}

describe('JobsService', () => {
  it('enqueue attaches context from extractor', async () => {
    const { service, backend } = setup();
    await service.enqueue('doThing', { msg: 'hi' });
    const waiting = await backend.peekWaiting('doThing');
    expect(waiting[0].context).toEqual({ tenantId: 't1' });
    expect(waiting[0].payload).toEqual({ msg: 'hi' });
  });

  it('enqueue registers the job with the correct scheduler', async () => {
    const { service, scheduler } = setup();
    await service.enqueue('doThing', { msg: 'hi' });
    const snap = scheduler.snapshot();
    expect(snap.find((s) => s.tenantId === 't1')?.waiting).toBe(1);
  });

  it('isolates queued state from producer and handler input mutation', async () => {
    const { service, scheduler, backend } = setup();
    const payload = { nested: { value: 'payload' } };
    const context = { tenantId: 't1', nested: { value: 'context' } };
    const metadata = { nested: { value: 'metadata' } };

    const jobId = await service.enqueue('doThing', payload, { context, metadata });
    payload.nested.value = 'producer-mutated';
    context.tenantId = 't2';
    context.nested.value = 'producer-mutated';
    metadata.nested.value = 'producer-mutated';

    expect(scheduler.snapshot()).toContainEqual(
      expect.objectContaining({ tenantId: 't1', waiting: 1 }),
    );
    const active = await backend.moveToActive('doThing', jobId);
    (active?.payload as typeof payload).nested.value = 'handler-mutated';
    active!.context.tenantId = 't3';
    (active?.metadata as typeof metadata).nested.value = 'handler-mutated';

    await expect(service.getJob(jobId)).resolves.toMatchObject({
      payload: { nested: { value: 'payload' } },
      context: { tenantId: 't1', nested: { value: 'context' } },
      metadata: { nested: { value: 'metadata' } },
    });
  });

  it('setTenantWeight updates the scheduler', async () => {
    const { service, scheduler } = setup();
    service.setTenantWeight('doThing', 't1', 5);
    await service.enqueue('doThing', {});
    expect(scheduler.snapshot().find((s) => s.tenantId === 't1')?.weight).toBe(5);
  });

  it('throws when jobType has no scheduler registered', async () => {
    const { service } = setup();
    await expect(service.enqueue('unknown', {})).rejects.toMatchObject({
      code: 'jobs_queue_not_found',
    });
  });

  it('can enqueue without scheduler state when the job type is registered', async () => {
    const backend = new InMemoryBackend();
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['doThing'],
    });

    await service.enqueue('doThing', { msg: 'hi' }, { context: { tenantId: 't1' } });

    const waiting = await backend.peekWaiting('doThing');
    expect(waiting).toHaveLength(1);
    expect(waiting[0].context).toEqual({ tenantId: 't1' });
  });

  it('isolates persisted metadata from lifecycle observer mutation', async () => {
    const backend = new InMemoryBackend();
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['doThing'],
      events: {
        onEvent: (event) => {
          const metadata = event.metadata as { nested?: { value: string } } | undefined;
          if (metadata?.nested) metadata.nested.value = 'observer-mutated';
        },
      },
    });

    const jobId = await service.enqueue(
      'doThing',
      {},
      { metadata: { nested: { value: 'persisted' } } },
    );

    await expect(service.getJob(jobId)).resolves.toMatchObject({
      metadata: { nested: { value: 'persisted' } },
    });
  });

  it('snapshots buffers, function properties, and custom prototypes for observers', async () => {
    const backend = new InMemoryBackend();
    const marker = Object.assign(() => undefined, { state: { value: 'persisted' } });
    const prototype = { state: { value: 'persisted' } };
    const custom = Object.create(prototype) as Record<string, unknown>;
    let observedBuffer = '';
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      jobTypes: ['doThing'],
      events: {
        onEvent: (event) => {
          const metadata = event.metadata as {
            bytes: Buffer;
            marker: typeof marker;
            custom: Record<string, unknown>;
          };
          observedBuffer = metadata.bytes.toString('utf8');
          metadata.marker.state.value = 'observer-mutated';
          (Object.getPrototypeOf(metadata.custom) as typeof prototype).state.value =
            'observer-mutated';
        },
      },
    });

    const jobId = await service.enqueue(
      'doThing',
      {},
      {
        metadata: { bytes: Buffer.from('snapshot'), marker, custom },
      },
    );

    expect(observedBuffer).toBe('snapshot');
    expect(marker.state.value).toBe('persisted');
    expect(prototype.state.value).toBe('persisted');
    const record = await service.getJob(jobId);
    expect((record?.metadata.marker as typeof marker).state.value).toBe('persisted');
  });

  it('rejects fairness controls when scheduler state is unavailable', () => {
    const service = new JobsService({
      backend: new InMemoryBackend(),
      registry: new HandlerRegistry(),
      jobTypes: ['doThing'],
    });

    expect(() => service.setTenantWeight('doThing', 't1', 2)).toThrow('jobs_fairness_misconfig');
  });

  it.each([false, true])(
    'does not report a committed replay as failed when statusQuery=%s',
    async (statusQuery) => {
      class ReplayBackend extends InMemoryBackend {
        replayed = false;
        getJobCalls = 0;

        override capabilities() {
          return { ...super.capabilities(), statusQuery };
        }

        override async replayDeadLetter(): Promise<string> {
          this.replayed = true;
          return 'replayed-job';
        }

        override async getJob(): Promise<never> {
          this.getJobCalls += 1;
          throw new Error('status query unavailable');
        }
      }

      const backend = new ReplayBackend();
      const service = new JobsService({
        backend,
        registry: new HandlerRegistry(),
        jobTypes: ['doThing'],
      });

      await expect(service.replayDeadLetter('dead-job')).resolves.toBe('replayed-job');
      expect(backend.replayed).toBe(true);
      expect(backend.getJobCalls).toBe(statusQuery ? 1 : 0);
    },
  );

  it('registers a replay with a local scheduler when status queries are unavailable', async () => {
    class NoStatusBackend extends InMemoryBackend {
      override capabilities() {
        return { ...super.capabilities(), statusQuery: false };
      }

      override async getJob(): Promise<never> {
        throw new Error('status query unavailable');
      }
    }

    const backend = new NoStatusBackend();
    const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    const service = new JobsService({
      backend,
      registry: new HandlerRegistry(),
      schedulers: new Map([['doThing', scheduler]]),
    });
    const originalId = await service.enqueue(
      'doThing',
      {},
      { attempts: 1, context: { tenantId: 'tenant_1' } },
    );
    expect(scheduler.pickNext()?.jobId).toBe(originalId);
    const activation = await backend.moveToActive('doThing', originalId);
    await backend.fail('doThing', originalId, 'boom', activation!.activationId!);
    scheduler.onAck(originalId);

    const replayedId = await service.replayDeadLetter(originalId);
    expect(scheduler.pickNext()).toEqual({ jobId: replayedId, tenantId: 'tenant_1' });
  });
});
