import { createFakeJobs } from '../../src';

describe('v0.2 fake jobs runtime', () => {
  it('drains jobs deterministically and exposes status', async () => {
    const fake = createFakeJobs({
      jobTypes: ['webhook.deliver'],
      now: new Date('2026-06-20T00:00:00.000Z'),
    });
    fake.registry.register('webhook.deliver', async () => undefined);

    const jobId = await fake.service.enqueue('webhook.deliver', { deliveryId: 'del_1' }, {
      delayMs: 1_000,
    });

    await fake.drainUntilIdle();
    expect(await fake.service.getJob(jobId)).toMatchObject({ status: 'delayed' });

    fake.clock.advanceBy(1_000);
    await fake.drainUntilIdle();
    expect(await fake.service.getJob(jobId)).toMatchObject({ status: 'succeeded' });
  });
});
