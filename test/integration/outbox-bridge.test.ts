import { JobsOutboxBridge, OutboxSource } from '../../src/outbox/outbox-bridge.module';
import { FakeJobsService } from '../../src/fake-jobs.service';

type Event = { type: string; payload: Record<string, unknown>; tenantId: string };

class FakeOutboxSource implements OutboxSource {
  private cb: ((e: Event) => Promise<void>) | null = null;

  onEvent(cb: (e: Event) => Promise<void>): void {
    this.cb = cb;
  }

  async emit(e: Event): Promise<void> {
    if (this.cb) await this.cb(e);
  }
}

describe('JobsOutboxBridge', () => {
  it('enqueues a job for a mapped event with the source tenant context', async () => {
    const fake = new FakeJobsService({ jobTypes: ['handleErasure'] });
    const source = new FakeOutboxSource();
    const picked: Array<{ payload: Record<string, unknown>; tenantId?: string }> = [];
    fake.registry.register('handleErasure', async (payload, ctx) => {
      picked.push({ payload, tenantId: ctx.tenantId as string | undefined });
      return null;
    });

    new JobsOutboxBridge({
      jobs: fake.service,
      source,
      map: { 'data_subject.erasure_requested': 'handleErasure' },
    });

    await source.emit({
      type: 'data_subject.erasure_requested',
      payload: { requestId: 'x' },
      tenantId: 't1',
    });

    await fake.drain();

    expect(picked).toEqual([{ payload: { requestId: 'x' }, tenantId: 't1' }]);
  });

  it('supports tenantFrom overrides', async () => {
    const fake = new FakeJobsService({ jobTypes: ['handleErasure'] });
    const source = new FakeOutboxSource();
    const seenTenants: Array<string | undefined> = [];
    fake.registry.register('handleErasure', async (_payload, ctx) => {
      seenTenants.push(ctx.tenantId as string | undefined);
      return null;
    });

    new JobsOutboxBridge({
      jobs: fake.service,
      source,
      map: { 'data_subject.erasure_requested': 'handleErasure' },
      tenantFrom: (event) => `override:${event.tenantId}`,
    });

    await source.emit({
      type: 'data_subject.erasure_requested',
      payload: { requestId: 'x' },
      tenantId: 't1',
    });

    await fake.drain();

    expect(seenTenants).toEqual(['override:t1']);
  });

  it('ignores unmapped event types', async () => {
    const fake = new FakeJobsService({ jobTypes: ['handleErasure'] });
    const source = new FakeOutboxSource();
    fake.registry.register('handleErasure', async () => null);

    new JobsOutboxBridge({
      jobs: fake.service,
      source,
      map: { 'data_subject.erasure_requested': 'handleErasure' },
    });

    await source.emit({ type: 'other', payload: {}, tenantId: 't1' });

    expect(await fake.backend.peekWaiting('handleErasure')).toEqual([]);
  });
});
