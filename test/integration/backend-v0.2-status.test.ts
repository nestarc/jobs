import { HandlerRegistry, InMemoryBackend, JobsService } from '../../src';

function serviceWithBackend() {
  const backend = new InMemoryBackend();
  const service = new JobsService({
    backend,
    registry: new HandlerRegistry(),
    jobTypes: ['email.send'],
  });
  return { backend, service };
}

describe('v0.2 backend status and capabilities', () => {
  it('reports in-memory capabilities', () => {
    const { service } = serviceWithBackend();
    expect(service.capabilities()).toMatchObject({
      durable: false,
      distributed: false,
      delayed: true,
      retries: true,
      backoff: true,
      timeout: true,
      statusQuery: true,
      history: true,
      idempotency: true,
      deadLetter: true,
      fairness: 'local-tenant',
      manualDrain: true,
    });
  });

  it('records queued and succeeded status history', async () => {
    const { backend, service } = serviceWithBackend();
    const jobId = await service.enqueue('email.send', { messageId: 'msg_1' });

    expect(await service.getJob(jobId)).toMatchObject({
      id: jobId,
      type: 'email.send',
      status: 'queued',
      attempt: 0,
      maxAttempts: 1,
    });

    await backend.moveToActive('email.send', jobId);
    await backend.ack('email.send', jobId);

    expect(await service.getJob(jobId)).toMatchObject({
      id: jobId,
      status: 'succeeded',
      attempt: 1,
    });
    expect((await service.getJobHistory(jobId)).map((entry) => entry.status)).toEqual([
      'queued',
      'active',
      'succeeded',
    ]);
  });
});
