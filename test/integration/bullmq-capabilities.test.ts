import {
  BullMQBackend,
  defineJobs,
  HandlerRegistry,
  job,
  JobsModule,
  JobsService,
  JobsErrorCode,
} from '../../src';

function backend(): BullMQBackend {
  return new BullMQBackend({ connection: { host: '127.0.0.1', port: 6379 } });
}

describe('BullMQ capability contract', () => {
  it('declares only the behavior implemented by the backend', () => {
    expect(backend().capabilities()).toEqual({
      durable: true,
      distributed: true,
      delayed: true,
      retries: true,
      backoff: true,
      timeout: false,
      statusQuery: true,
      history: false,
      idempotency: true,
      deadLetter: false,
      fairness: 'none',
      manualDrain: false,
    });
  });

  it('fails unsupported operations and options with a capability error', async () => {
    const instance = backend();
    const service = new JobsService({
      backend: instance,
      registry: new HandlerRegistry(),
      jobTypes: ['test.job'],
    });

    await expect(service.getJobHistory('job_1')).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(service.listDeadLetters()).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(service.enqueue('test.job', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.peekWaiting()).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.getJobHistory('job_1')).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.moveToActive()).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.ack()).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.fail()).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
  });

  it('validates unsupported typed defaults when strict capabilities are enabled', () => {
    const jobs = defineJobs({
      'test.job': job<Record<string, never>>().defaults({ timeoutMs: 100 }),
    });

    expect(() =>
      JobsModule.forBullMQ({
        backend: backend(),
        jobTypes: Object.keys(jobs),
        jobs,
        strictCapabilities: true,
      }),
    ).toThrow(JobsErrorCode.CapabilityUnsupported);
  });

  it('validates strict defaults only for registered job types', async () => {
    const jobs = defineJobs({
      enabled: job<Record<string, never>>().defaults({ attempts: 2 }),
      unused: job<Record<string, never>>().defaults({ timeoutMs: 100 }),
    });
    const instance = backend();
    jest.spyOn(instance, 'registerJobTypes').mockImplementation(() => undefined);

    expect(() =>
      JobsModule.forBullMQ({
        backend: instance,
        jobTypes: ['enabled'],
        jobs,
        strictCapabilities: true,
      }),
    ).not.toThrow();

    await instance.close();
  });

  it('continues queue cleanup after a worker close failure and allows retry', async () => {
    const instance = backend();
    let workerCloseCalls = 0;
    let queueCloseCalls = 0;
    const resources = instance as unknown as {
      workers: Map<string, { close(): Promise<void> }>;
      queues: Map<string, { close(): Promise<void> }>;
    };
    resources.workers.set('worker', {
      close: async () => {
        workerCloseCalls += 1;
        if (workerCloseCalls === 1) throw new Error('transient worker close failure');
      },
    });
    resources.queues.set('queue', {
      close: async () => {
        queueCloseCalls += 1;
      },
    });

    await expect(instance.close()).rejects.toThrow('transient worker close failure');
    expect(queueCloseCalls).toBe(1);

    await expect(instance.close()).resolves.toBeUndefined();
    expect(workerCloseCalls).toBe(2);
    expect(queueCloseCalls).toBe(1);
  });
});
