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

  it('rejects fairness controls when scheduler state is unavailable', () => {
    const service = new JobsService({
      backend: new InMemoryBackend(),
      registry: new HandlerRegistry(),
      jobTypes: ['doThing'],
    });

    expect(() => service.setTenantWeight('doThing', 't1', 2)).toThrow(
      'jobs_fairness_misconfig',
    );
  });
});
