import { Test } from '@nestjs/testing';
import { BullMQBackend, JobsModule, createFakeJobs } from '../../src';

describe('maintenance remaining contracts', () => {
  it('producer role never starts consumers and still closes resources', async () => {
    const backend = new BullMQBackend({ connection: {} });
    jest.spyOn(backend, 'registerJobTypes').mockImplementation(() => undefined);
    const start = jest.spyOn(backend, 'startConsumer').mockImplementation(() => undefined);
    const close = jest.spyOn(backend, 'close').mockResolvedValue();
    const app = await Test.createTestingModule({
      imports: [
        JobsModule.forBullMQ({
          backend,
          jobTypes: ['remote'],
          ...{ role: 'producer' as const },
        }),
      ],
    }).compile();
    try {
      await app.init();
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('worker bootstrap rejects missing intended handlers before starting a worker', async () => {
    const backend = new BullMQBackend({ connection: {} });
    jest.spyOn(backend, 'registerJobTypes').mockImplementation(() => undefined);
    const start = jest.spyOn(backend, 'startConsumer').mockImplementation(() => undefined);
    jest.spyOn(backend, 'close').mockResolvedValue();
    const app = await Test.createTestingModule({
      imports: [
        JobsModule.forBullMQ({
          backend,
          jobTypes: ['remote'],
          ...{ role: 'worker' as const },
        }),
      ],
    }).compile();
    try {
      await expect(app.init()).rejects.toMatchObject({ code: 'jobs_handler_not_found' });
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  it('history reads cannot mutate stored entries, dates or errors', async () => {
    const fake = createFakeJobs({ jobTypes: ['task'] });
    fake.registry.register('task', async () => {
      throw new Error('original');
    });
    const id = await fake.service.enqueue('task', {});
    await fake.drain();
    const first = await fake.backend.getJobHistory(id);
    const expected = await fake.backend.getJobHistory(id);
    const snapshot = expected.map((entry) => ({
      ...entry,
      at: new Date(entry.at),
      error: entry.error ? { ...entry.error } : undefined,
    }));
    first[0].status = 'active';
    first[0].at.setTime(0);
    for (const entry of first) if (entry.error) entry.error.message = 'mutated';
    expect(await fake.backend.getJobHistory(id)).toEqual(snapshot);
  });

  it('drain refuses to silently leave the 1001st ready job', async () => {
    const fake = createFakeJobs({ jobTypes: ['task'] });
    fake.registry.register('task', async () => undefined);
    for (let i = 0; i < 1001; i++) await fake.service.enqueue('task', {});
    await expect(fake.drain()).rejects.toMatchObject({ code: 'jobs_drain_limit_exceeded' });
    await fake.drain();
    expect(fake.backend.pendingJobIds()).toEqual([]);
  });

  it('drains through a cancelled head and accepts exact-limit completion and future idle', async () => {
    const fake = createFakeJobs({ jobTypes: ['task'] });
    fake.registry.register('task', async () => undefined);
    const cancelled = await fake.service.enqueue('task', {});
    await fake.backend.markCancelled('task', cancelled);
    const ready = await fake.service.enqueue('task', {});
    await fake.drain(2);
    expect((await fake.service.getJob(ready))?.status).toBe('succeeded');
    await fake.service.enqueue('task', {}, { delayMs: 1000 });
    await expect(fake.drain(1)).resolves.toBeUndefined();
  });
});

describe('bounded fake drain', () => {
  it('reports an indefinitely replenished ready queue and validates its limit', async () => {
    const fake = createFakeJobs({ jobTypes: ['loop'] });
    fake.registry.register('loop', async () => {
      await fake.service.enqueue('loop', {});
    });
    await fake.service.enqueue('loop', {});
    await expect(fake.drain(10)).rejects.toMatchObject({ code: 'jobs_drain_limit_exceeded' });
    await expect(fake.drain(Infinity)).rejects.toMatchObject({ code: 'jobs_invalid_input' });
  });
});
