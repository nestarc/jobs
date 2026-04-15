import { FakeJobsService } from '../../src/fake-jobs.service';

describe('Fairness end-to-end', () => {
  it('one tenant flooding does not starve another', async () => {
    const fake = new FakeJobsService({
      jobTypes: ['work'],
      tenantCap: 2,
      defaultWeight: 1,
      minSharePct: 0.2,
    });
    const order: string[] = [];
    fake.registry.register('work', async (_p, ctx) => {
      order.push(ctx.tenantId as string);
      return null;
    });

    for (let i = 0; i < 100; i++) {
      await fake.service.enqueue('work', { i }, { context: { tenantId: 'big' } });
    }
    for (let i = 0; i < 10; i++) {
      await fake.service.enqueue('work', { i }, { context: { tenantId: 'small' } });
    }

    await fake.drain();
    const firstWindow = order.slice(0, 20);
    const smallInWindow = firstWindow.filter((t) => t === 'small').length;
    expect(smallInWindow).toBeGreaterThanOrEqual(4);
  });
});
