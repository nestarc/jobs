import { Inject } from '@nestjs/common';
import {
  defineJobs,
  InjectJobs,
  JOBS_SERVICE,
  job,
  type JobInstance,
  type TypedJobHandler,
  type TypedJobsService,
} from './contracts';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';

interface SendPayload {
  messageId: string;
}

interface TenantContext {
  tenantId: string;
}

const appJobs = defineJobs({
  'email.send': job<SendPayload>().context<TenantContext>().result<void>().defaults({
    attempts: 3,
  }),
});

type AppJobs = typeof appJobs;

describe('job contracts', () => {
  it('keeps runtime metadata for defaults', () => {
    expect(appJobs['email.send'].defaults).toEqual({ attempts: 3 });
  });

  it('provides a typed service shape', async () => {
    const service: TypedJobsService<AppJobs> = {
      enqueue: jest.fn().mockResolvedValue('job_1'),
      enqueueDetailed: jest.fn().mockResolvedValue({ status: 'created', jobId: 'job_1' }),
      getJob: jest.fn().mockResolvedValue(null),
      getJobHistory: jest.fn().mockResolvedValue([]),
      capabilities: jest.fn().mockReturnValue({}),
      listDeadLetters: jest.fn().mockResolvedValue([]),
      replayDeadLetter: jest.fn().mockResolvedValue('job_2'),
      discardDeadLetter: jest.fn().mockResolvedValue(undefined),
    } as unknown as TypedJobsService<AppJobs>;

    await service.enqueue('email.send', { messageId: 'msg_1' }, {
      context: { tenantId: 'tenant_1' },
    });

    expect(service.enqueue).toHaveBeenCalledWith('email.send', { messageId: 'msg_1' }, {
      context: { tenantId: 'tenant_1' },
    });
  });

  it('supports typed handler instances', async () => {
    class SendHandler implements TypedJobHandler<AppJobs, 'email.send'> {
      async handle(jobToHandle: JobInstance<AppJobs, 'email.send'>): Promise<void> {
        expect(jobToHandle.payload.messageId).toBe('msg_1');
        expect(jobToHandle.context.tenantId).toBe('tenant_1');
      }
    }

    await new SendHandler().handle({
      id: 'job_1',
      type: 'email.send',
      payload: { messageId: 'msg_1' },
      context: { tenantId: 'tenant_1' },
      attempt: 1,
      maxAttempts: 3,
      signal: new AbortController().signal,
      metadata: {},
    });
  });

  it('creates a Nest injection decorator for JobsService', () => {
    class Consumer {
      constructor(@InjectJobs() readonly jobs: TypedJobsService<AppJobs>) {}
    }

    expect(Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, Consumer)).toEqual([
      { index: 0, param: JOBS_SERVICE },
    ]);
    expect(typeof Inject(JOBS_SERVICE)).toBe('function');
  });
});
