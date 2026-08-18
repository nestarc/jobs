import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  defineJobs,
  job,
  JobHandler,
  JobsModule,
  JobsService,
  type TypedJobHandler,
} from '../../src';

const jobs = defineJobs({
  'email.send': job<{ messageId: string }>().context<{ tenantId: string }>(),
});

@Injectable()
class EmailHandler implements TypedJobHandler<typeof jobs, 'email.send'> {
  static received: { messageId: string; tenantId: string } | undefined;

  @JobHandler('email.send')
  async handle(payload: { messageId: string }, context: { tenantId: string }): Promise<void> {
    EmailHandler.received = { messageId: payload.messageId, tenantId: context.tenantId };
  }
}

let observerJobsHandled = 0;

@Injectable()
class ObserverHandler {
  @JobHandler('observer.job')
  async handle(): Promise<void> {
    observerJobsHandled += 1;
  }
}

describe('v0.2 module options and lifecycle events', () => {
  it('accepts job contracts and emits lifecycle events', async () => {
    EmailHandler.received = undefined;
    const events: string[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobs,
          jobTypes: ['email.send'],
          events: {
            onEvent: (event) => events.push(event.type),
          },
        }),
      ],
      providers: [EmailHandler],
    }).compile();

    await moduleRef.init();
    try {
      const service = moduleRef.get(JobsService);
      await service.enqueue(
        'email.send',
        { messageId: 'msg_1' },
        {
          context: { tenantId: 'tenant_1' },
        },
      );

      for (let i = 0; i < 20 && !events.includes('job.succeeded'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(events).toEqual(
        expect.arrayContaining(['job.enqueued', 'job.started', 'job.succeeded']),
      );
      expect(EmailHandler.received).toEqual({ messageId: 'msg_1', tenantId: 'tenant_1' });
    } finally {
      await moduleRef.close();
    }
  });

  it('isolates lifecycle observer failures from enqueue and worker state', async () => {
    observerJobsHandled = 0;
    const observerFailure = () => {
      throw new Error('observer unavailable');
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobsModule.forInMemory({
          jobTypes: ['observer.job'],
          events: { onEvent: observerFailure },
          onJobStart: observerFailure,
          onJobFinish: observerFailure,
          onJobFail: observerFailure,
        }),
      ],
      providers: [ObserverHandler],
    }).compile();

    await moduleRef.init();
    try {
      const service = moduleRef.get(JobsService);
      const firstId = await service.enqueue('observer.job', { sequence: 1 });
      const secondId = await service.enqueue('observer.job', { sequence: 2 });

      for (let i = 0; i < 30; i += 1) {
        const records = await Promise.all([service.getJob(firstId), service.getJob(secondId)]);
        if (records.every((record) => record?.status === 'succeeded')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(observerJobsHandled).toBe(2);
      await expect(service.getJob(firstId)).resolves.toMatchObject({
        status: 'succeeded',
        failedAt: undefined,
      });
      await expect(service.getJob(secondId)).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      await moduleRef.close();
    }
  });
});
