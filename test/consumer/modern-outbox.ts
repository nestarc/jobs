import assert from 'node:assert/strict';
import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import {
  OutboxModule,
  type OutboxPublisher as FirstPartyOutboxPublisher,
  type OutboxRecord as FirstPartyOutboxRecord,
} from '@nestarc/outbox';
import { createOutboxJobsPublisher, FakeJobsService } from '@nestarc/jobs';

async function main(): Promise<void> {
  assert.equal(typeof OutboxModule.forRoot, 'function');

  const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
  const handled: Array<{
    payload: Record<string, unknown>;
    context: Record<string, unknown>;
  }> = [];
  fake.registry.register('invoice.process', async (payload, context) => {
    handled.push({ payload, context });
    return null;
  });

  const Publisher: Type<FirstPartyOutboxPublisher> = createOutboxJobsPublisher({
    map: { 'invoice.issued': 'invoice.process' },
  });
  const publisher: FirstPartyOutboxPublisher = new Publisher(fake.service);
  const record: FirstPartyOutboxRecord = {
    id: '7b5f7ed7-87ba-45c1-80de-66d20e7d3566',
    eventType: 'invoice.issued',
    payload: { invoiceId: 'inv-modern-1' },
    status: 'PENDING',
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
    updatedAt: new Date('2026-08-30T00:00:00.000Z'),
    processedAt: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    tenantId: 'tenant-modern',
    aggregateType: 'invoice',
    aggregateId: 'inv-modern-1',
    partitionKey: 'tenant-modern',
    idempotencyKey: 'invoice-issued-modern-1',
    correlationId: null,
    causationId: 'command-modern-1',
    headers: { traceparent: '00-modern' },
    occurredAt: new Date('2026-08-30T00:00:00.000Z'),
  };

  await publisher.publish(record);
  await fake.drain();

  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0]?.payload, record.payload);
  assert.equal(handled[0]?.context.tenantId, record.tenantId);
  assert.equal(handled[0]?.context.outboxEventId, record.id);
  assert.equal(handled[0]?.context.correlationId, record.id);
  assert.equal(handled[0]?.context.causationId, record.causationId);

  const job = await fake.service.getJob(record.id);
  assert.equal(job?.id, record.id);
  assert.equal(job?.idempotencyKey, record.id);
  assert.equal(job?.metadata?.source, '@nestarc/outbox');
  assert.equal(job?.metadata?.outboxEventId, record.id);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
