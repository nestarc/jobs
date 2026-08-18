import { Inject } from '@nestjs/common';
import {
  defineJobs,
  InjectJobs,
  JOBS_SERVICE,
  job,
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
  it('requires object payload definitions', () => {
    const compileOnly = () => {
      // @ts-expect-error job payloads must be non-null objects
      job<string>();
      // @ts-expect-error arrays are not plain job payload objects
      job<string[]>();
      // @ts-expect-error built-in objects would lose their value during envelope creation
      job<Date>();
      // @ts-expect-error functions are not serializable job payload objects
      job<() => void>();
      // @ts-expect-error job contexts must be objects
      job<SendPayload>().context<string>();
    };
    expect(compileOnly).toEqual(expect.any(Function));
  });

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

    await service.enqueue(
      'email.send',
      { messageId: 'msg_1' },
      {
        context: { tenantId: 'tenant_1' },
      },
    );

    expect(service.enqueue).toHaveBeenCalledWith(
      'email.send',
      { messageId: 'msg_1' },
      {
        context: { tenantId: 'tenant_1' },
      },
    );
  });

  it('supports typed handler instances', async () => {
    class SendHandler implements TypedJobHandler<AppJobs, 'email.send'> {
      async handle(
        payload: SendPayload,
        context: TenantContext & { signal?: AbortSignal },
      ): Promise<void> {
        expect(payload.messageId).toBe('msg_1');
        expect(context.tenantId).toBe('tenant_1');
        void context.signal;
      }
    }

    await new SendHandler().handle({ messageId: 'msg_1' }, { tenantId: 'tenant_1' });
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
