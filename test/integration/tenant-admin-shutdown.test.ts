import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createFakeJobs, JobsModule, JobsService } from '../../src';

describe('tenant admin and colocated late publisher', () => {
  it('filters tenant-facing reads without leaking another tenant or system job', async () => {
    const fake = createFakeJobs({ jobTypes: ['job'] });
    const id = await fake.service.enqueue('job', {}, { context: { tenantId: 'A' } });
    const system = await fake.service.enqueue('job', {});
    expect(await fake.service.getJobForTenant(id, 'A')).toMatchObject({ id });
    expect(await fake.service.getJobForTenant(id, 'B')).toBeNull();
    expect(await fake.service.getJobForTenant(system, 'A')).toBeNull();
    expect(await fake.service.getJobForTenant('missing', 'A')).toBeNull();
    await expect(fake.service.getJobForTenant(id, undefined as never)).rejects.toMatchObject({
      code: 'jobs_invalid_input',
    });
  });
  it('rejects a late shutdown publish so the source can retain its unacknowledged row', async () => {
    let error: unknown;
    @Injectable()
    class LatePublisher implements OnApplicationShutdown {
      constructor(private readonly jobs: JobsService) {}
      async onApplicationShutdown(): Promise<void> {
        try {
          await this.jobs.enqueue('job', {});
        } catch (failure) {
          error = failure;
        }
      }
    }
    const app = await Test.createTestingModule({
      imports: [JobsModule.forInMemory({ jobTypes: ['job'] })],
      providers: [LatePublisher],
    }).compile();
    await app.init();
    await app.close();
    expect(error).toMatchObject({ code: 'jobs_backend_closed' });
  });
});
