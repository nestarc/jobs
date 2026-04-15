import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JobHandler } from '../../src/decorators';
import { InMemoryBackend, JOBS_BACKEND, JobsModule, JobsService } from '../../src';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
class ReportHandler {
  readonly calls: Array<{ payload: Record<string, unknown>; tenantId?: string }> = [];

  @JobHandler('sendReport')
  async handle(payload: Record<string, unknown>, ctx: { tenantId?: string }): Promise<void> {
    this.calls.push({ payload, tenantId: ctx.tenantId });
  }
}

describe('JobsModule.forInMemory', () => {
  it('starts workers automatically and drains queued jobs', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JobsModule.forInMemory({ jobTypes: ['sendReport'] })],
      providers: [ReportHandler],
    }).compile();

    await moduleRef.init();

    const jobs = moduleRef.get(JobsService);
    const handler = moduleRef.get(ReportHandler);
    const backend = moduleRef.get<InMemoryBackend>(JOBS_BACKEND);

    await jobs.enqueue('sendReport', { userId: 'u1' }, { context: { tenantId: 't1' } });

    for (let i = 0; i < 20 && handler.calls.length === 0; i++) {
      await sleep(10);
    }

    expect(handler.calls).toEqual([{ payload: { userId: 'u1' }, tenantId: 't1' }]);
    expect(await backend.peekWaiting('sendReport')).toEqual([]);

    await moduleRef.close();
  });
});
