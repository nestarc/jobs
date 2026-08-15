import { createOutboxJobsPublisher, FakeJobsService, type OutboxRecord } from '../../src';
import type { Type } from '@nestjs/common';

interface FirstPartyOutboxPublisher {
  publish(
    event: OutboxRecord & {
      status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
      createdAt: Date;
      updatedAt: Date;
      processedAt: Date | null;
      retryCount: number;
      maxRetries: number;
      lastError: string | null;
    },
  ): Promise<void>;
}

const record: OutboxRecord = {
  id: 'b4a47f36-f5da-4bc8-ab0d-524c1127d968',
  eventType: 'invoice.issued',
  payload: { invoiceId: 'inv_1' },
  tenantId: 'tenant_1',
  correlationId: null,
  causationId: 'command_1',
  idempotencyKey: 'source-key',
  occurredAt: new Date('2026-08-15T00:00:00.000Z'),
};

describe('createOutboxJobsPublisher', () => {
  it('is structurally compatible with the first-party OutboxPublisher transport', () => {
    const Publisher: Type<FirstPartyOutboxPublisher> = createOutboxJobsPublisher({
      map: { 'invoice.issued': 'invoice.process' },
    });

    expect(Publisher).toBeDefined();
  });

  it('preserves lineage and suppresses duplicate delivery by outbox event id', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    const handled: Array<{ payload: unknown; context: unknown }> = [];
    fake.registry.register('invoice.process', async (payload, context) => {
      handled.push({ payload, context });
      return null;
    });
    const Publisher = createOutboxJobsPublisher({
      map: { 'invoice.issued': 'invoice.process' },
    });
    const publisher = new Publisher(fake.service);

    await publisher.publish(record);
    await publisher.publish(record);
    await fake.drain();

    expect(handled).toEqual([
      {
        payload: record.payload,
        context: expect.objectContaining({
          tenantId: 'tenant_1',
          outboxEventId: record.id,
          correlationId: record.id,
          causationId: 'command_1',
        }),
      },
    ]);
    expect(await fake.service.getJob(record.id)).toMatchObject({
      id: record.id,
      idempotencyKey: record.id,
      metadata: expect.objectContaining({
        source: '@nestarc/outbox',
        outboxEventId: record.id,
        correlationId: record.id,
        outboxIdempotencyKey: 'source-key',
      }),
    });
  });

  it('fails closed for unmapped events and missing required tenants', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    const Publisher = createOutboxJobsPublisher({
      map: { 'invoice.issued': 'invoice.process' },
    });
    const publisher = new Publisher(fake.service);

    await expect(publisher.publish({ ...record, eventType: 'invoice.unknown' })).rejects.toThrow(
      'No jobs mapping',
    );
    await expect(publisher.publish({ ...record, tenantId: null })).rejects.toThrow(
      'requires a tenantId',
    );
    expect(await fake.backend.peekWaiting('invoice.process')).toEqual([]);
  });

  it('allows an explicit system mapping while keeping identity fields invariant', async () => {
    const fake = new FakeJobsService({ jobTypes: ['system.reindex'] });
    const Publisher = createOutboxJobsPublisher({
      map: {
        'system.reindex_requested': {
          job: 'system.reindex',
          tenant: 'optional',
          options: {
            jobId: 'cannot-override',
            idempotencyKey: 'cannot-override',
            context: { correlationId: 'cannot-override' },
            metadata: { outboxEventId: 'cannot-override', custom: true },
          },
        },
      },
    });
    const publisher = new Publisher(fake.service);
    const systemRecord = {
      ...record,
      id: 'dd09fc66-13cc-4c8d-a7e4-9145ef51a194',
      eventType: 'system.reindex_requested',
      tenantId: null,
      correlationId: 'correlation_1',
    };

    await publisher.publish(systemRecord);

    expect(await fake.service.getJob(systemRecord.id)).toMatchObject({
      id: systemRecord.id,
      idempotencyKey: systemRecord.id,
      context: expect.objectContaining({ correlationId: 'correlation_1' }),
      metadata: expect.objectContaining({
        outboxEventId: systemRecord.id,
        custom: true,
      }),
    });
  });
});
