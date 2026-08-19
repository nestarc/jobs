import { createFakeJobs, defineJobs, job } from '../../src';

describe('v0.2 fake jobs runtime', () => {
  it('drains jobs deterministically and exposes status', async () => {
    const fake = createFakeJobs({
      jobTypes: ['webhook.deliver'],
      now: new Date('2026-06-20T00:00:00.000Z'),
    });
    fake.registry.register('webhook.deliver', async () => undefined);

    const jobId = await fake.service.enqueue(
      'webhook.deliver',
      { deliveryId: 'del_1' },
      {
        delayMs: 1_000,
      },
    );

    await fake.drainUntilIdle();
    expect(await fake.service.getJob(jobId)).toMatchObject({ status: 'delayed' });

    fake.clock.advanceBy(1_000);
    await fake.drainUntilIdle();
    expect(await fake.service.getJob(jobId)).toMatchObject({ status: 'succeeded' });
  });

  it('drains ready work behind a future delayed job', async () => {
    const fake = createFakeJobs({
      jobTypes: ['webhook.deliver'],
      now: new Date('2026-06-20T00:00:00.000Z'),
    });
    const handled: string[] = [];
    fake.registry.register('webhook.deliver', async (payload) => {
      handled.push(payload.deliveryId as string);
    });
    const moveToActive = jest.spyOn(fake.backend, 'moveToActive');

    const delayedId = await fake.service.enqueue(
      'webhook.deliver',
      { deliveryId: 'delayed' },
      { context: { tenantId: 'tenant-a' }, delayMs: 1_000 },
    );
    const readyId = await fake.service.enqueue(
      'webhook.deliver',
      { deliveryId: 'ready' },
      { context: { tenantId: 'tenant-b' } },
    );

    await fake.drainUntilIdle();

    expect(handled).toEqual(['ready']);
    expect(moveToActive).toHaveBeenCalledTimes(1);
    expect(await fake.service.getJob(delayedId)).toMatchObject({ status: 'delayed' });
    expect(await fake.service.getJob(readyId)).toMatchObject({ status: 'succeeded' });
  });

  it('applies typed job defaults in the fake runtime', async () => {
    const jobs = defineJobs({
      'webhook.deliver': job<{ deliveryId: string }>().defaults({
        attempts: 3,
        timeoutMs: 250,
        backoff: { type: 'fixed', delayMs: 100 },
      }),
    });
    const fake = createFakeJobs({
      jobs,
      jobTypes: Object.keys(jobs),
      now: new Date('2026-06-20T00:00:00.000Z'),
    });

    await fake.service.enqueue('webhook.deliver', { deliveryId: 'del_defaults' });

    expect(await fake.backend.peekWaiting('webhook.deliver')).toEqual([
      expect.objectContaining({
        maxAttempts: 3,
        timeoutMs: 250,
        backoff: { type: 'fixed', delayMs: 100 },
      }),
    ]);
  });
});
