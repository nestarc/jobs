import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { defineJobs, job, JobHandler, JobsModule, JobsService } from '../../src';

const jobs = defineJobs({
  'email.send': job<{ messageId: string }>().context<{ tenantId: string }>(),
});

@Injectable()
class EmailHandler {
  @JobHandler('email.send')
  async handle(): Promise<void> {}
}

describe('v0.2 module options and lifecycle events', () => {
  it('accepts job contracts and emits lifecycle events', async () => {
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
      await service.enqueue('email.send', { messageId: 'msg_1' }, {
        context: { tenantId: 'tenant_1' },
      });

      for (let i = 0; i < 20 && !events.includes('job.succeeded'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(events).toEqual(expect.arrayContaining([
        'job.enqueued',
        'job.started',
        'job.succeeded',
      ]));
    } finally {
      await moduleRef.close();
    }
  });
});
