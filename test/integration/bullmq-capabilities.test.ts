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
    await expect(instance.peekWaiting('test.job')).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.getJobHistory('job_1')).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.moveToActive('test.job', 'job_1')).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.ack('test.job', 'job_1')).rejects.toMatchObject({
      code: JobsErrorCode.CapabilityUnsupported,
    });
    await expect(instance.fail('test.job', 'job_1', 'boom')).rejects.toMatchObject({
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
});
