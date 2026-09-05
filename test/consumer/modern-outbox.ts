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

  const portableFake = new FakeJobsService({ jobTypes: ['invoice.process'] });
  const date = new Date('2026-01-01T00:00:00Z');
  const portableId = await portableFake.service.enqueue(
    'invoice.process',
    { nested: { date, list: [undefined, 1] } },
    { metadata: { date } },
  );
  const portable = await portableFake.service.getJob(portableId);
  assert.deepEqual(portable?.payload, { nested: { date: date.toISOString(), list: [null, 1] } });
  assert.deepEqual(portable?.metadata, { date: date.toISOString() });
  await assert.rejects(portableFake.service.enqueue('invoice.process', {}, { attempts: 0 }), {
    code: 'jobs_invalid_input',
  });
  await assert.rejects(portableFake.service.enqueue('invoice.process', { nested: { value: 1n } }), {
    code: 'jobs_serialization_invalid',
  });
  await portableFake.backend.markCancelled('invoice.process', portableId);
  await portableFake.backend.close();

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

  for (const scope of [undefined, 'global'] as const) {
    const isolated = new FakeJobsService({ jobTypes: ['invoice.process'] });
    const tenants: unknown[] = [];
    isolated.registry.register('invoice.process', async (_payload, context) => {
      tenants.push(context.tenantId);
    });
    const DedupePublisher: Type<FirstPartyOutboxPublisher> = createOutboxJobsPublisher({
      map: {
        'invoice.issued': {
          job: 'invoice.process',
          options: { dedupe: { key: 'shared-key', scope, mode: 'until_completed' } },
        },
      },
    });
    const dedupePublisher = new DedupePublisher(isolated.service);
    for (const tenantId of ['a', 'b']) {
      const event = { ...record, id: `event-${tenantId}`, tenantId };
      await dedupePublisher.publish(event);
      await dedupePublisher.publish(event);
      if (scope !== 'global' || tenantId === 'a') {
        const enqueued = await isolated.service.getJob(event.id);
        assert.equal(enqueued?.idempotencyKey, event.id);
        assert.equal(enqueued?.status, 'queued');
      } else {
        assert.equal(await isolated.service.getJob(event.id), null);
      }
    }
    assert.deepEqual(tenants, []);
    await isolated.drain();
    assert.deepEqual(tenants.sort(), scope === 'global' ? ['a'] : ['a', 'b']);
  }

  const SystemPublisher: Type<FirstPartyOutboxPublisher> = createOutboxJobsPublisher({
    map: {
      'invoice.issued': {
        job: 'invoice.process',
        tenant: 'optional',
        options: (event) => {
          event.id = 'forged';
          event.correlationId = 'forged';
          return {
            context: { tenantId: 'stale', causationId: 'stale', custom: true },
            metadata: { aggregateId: 'stale', outboxHeaders: { stale: true }, custom: true },
          };
        },
      },
    },
  });
  await new SystemPublisher(fake.service).publish({
    ...record,
    id: 'system-event',
    tenantId: null,
    correlationId: null,
    causationId: null,
    aggregateId: null,
    headers: {},
  });
  const systemJob = await fake.service.getJob<unknown, Record<string, unknown>>('system-event');
  assert.equal(systemJob?.idempotencyKey, 'system-event');
  assert.equal(systemJob?.context?.correlationId, 'system-event');
  for (const field of ['tenantId', 'causationId']) {
    assert.equal(Object.hasOwn(systemJob?.context ?? {}, field), false);
  }
  for (const field of ['aggregateId']) {
    assert.equal(Object.hasOwn(systemJob?.metadata ?? {}, field), false);
  }
  assert.deepEqual(systemJob?.metadata?.outboxHeaders, {});
  assert.equal(systemJob?.metadata?.custom, true);
  await fake.drain();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
