import { FairWorker } from '../../src/fair-worker';
import { Scheduler } from '../../src/scheduler';
import { InMemoryBackend } from '../../src/backend/in-memory-backend';
import { HandlerRegistry } from '../../src/handler-registry';
import { attachContext } from '../../src/context-serializer';

function setup() {
  const backend = new InMemoryBackend();
  const registry = new HandlerRegistry();
  const scheduler = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
  const worker = new FairWorker({
    jobType: 'doThing',
    backend,
    scheduler,
    registry,
    contextRunner: async (_ctx, fn) => fn(),
    onStart: jest.fn(),
    onFinish: jest.fn(),
    onFail: jest.fn(),
  });
  return { backend, registry, scheduler, worker };
}

describe('FairWorker', () => {
  it('dispatches a single job through scheduler to handler', async () => {
    const { backend, registry, scheduler, worker } = setup();
    const fn = jest.fn(async () => null);
    registry.register('doThing', fn);
    const id = await backend.enqueue(
      'doThing',
      attachContext({ msg: 'hi' }, { tenantId: 't1' }),
      {},
    );
    scheduler.onEnqueue(id, 't1');
    await worker.tick();
    expect(fn).toHaveBeenCalledWith({ msg: 'hi' }, { tenantId: 't1' });
  });

  it('ack releases scheduler inflight so next tick progresses', async () => {
    const { backend, registry, scheduler, worker } = setup();
    registry.register('doThing', async () => null);
    const a = await backend.enqueue('doThing', attachContext({}, { tenantId: 't1' }), {});
    const b = await backend.enqueue('doThing', attachContext({}, { tenantId: 't1' }), {});
    scheduler.onEnqueue(a, 't1');
    scheduler.onEnqueue(b, 't1');
    await worker.tick();
    await worker.tick();
    expect(scheduler.snapshot().find((s) => s.tenantId === 't1')!.inflight).toBe(0);
  });

  it('routes failure through onFail and marks job failed', async () => {
    const { backend, registry, scheduler, worker } = setup();
    registry.register('doThing', async () => {
      throw new Error('boom');
    });
    const id = await backend.enqueue('doThing', attachContext({}, { tenantId: 't1' }), {});
    scheduler.onEnqueue(id, 't1');
    await worker.tick();
    const waiting = await backend.peekWaiting('doThing');
    expect(waiting.length).toBe(0);
  });

  it('noop tick returns false when nothing to pick', async () => {
    const { worker } = setup();
    expect(await worker.tick()).toBe(false);
  });
});
