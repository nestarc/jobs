import {
  createOutboxJobsPublisher,
  FakeJobsService,
  type OutboxRecord,
  type OutboxJobTarget,
} from '../../src';
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
        tenantId: 'tenant_1',
        outboxIdempotencyKey: 'source-key',
      }),
    });
  });

  it('applies mapping-level dedupe across different outbox records', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    let executions = 0;
    fake.registry.register('invoice.process', async () => {
      executions += 1;
      return null;
    });
    const Publisher = createOutboxJobsPublisher({
      map: {
        'invoice.issued': {
          job: 'invoice.process',
          options: { dedupe: { key: 'invoice-stream', mode: 'until_completed' } },
        },
      },
    });
    const publisher = new Publisher(fake.service);
    const secondRecord = {
      ...record,
      id: 'a998c217-194d-4370-ad1e-2157229e73b8',
    };

    await publisher.publish(record);
    await publisher.publish(secondRecord);
    await fake.drain();

    expect(executions).toBe(1);
    expect(await fake.service.getJob(secondRecord.id)).toBeNull();
    expect(await fake.service.getJob(record.id)).toMatchObject({ status: 'succeeded' });
  });

  it.each([undefined, 'tenant', 'global'] as const)(
    'isolates tenants unless dedupe scope is explicitly global (%s)',
    async (scope) => {
      const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
      const handled: unknown[] = [];
      fake.registry.register('invoice.process', async (_payload, context) => {
        handled.push(context.tenantId);
      });
      const options = Object.freeze({
        dedupe: Object.freeze({ key: 'shared-key', scope, mode: 'until_completed' as const }),
      });
      const Publisher = createOutboxJobsPublisher({
        map: { 'invoice.issued': { job: 'invoice.process', options } },
      });
      const publisher = new Publisher(fake.service);
      const second = { ...record, id: 'tenant-b-event', tenantId: 'tenant_2' };
      await publisher.publish(record);
      await publisher.publish(second);
      await publisher.publish(record);
      await publisher.publish(second);

      // Publish acknowledges enqueue/dedupe before any handler runs.
      expect(handled).toEqual([]);
      expect(await fake.service.getJob(record.id)).toMatchObject({
        id: record.id,
        idempotencyKey: record.id,
        status: 'queued',
      });
      if (scope === 'global') {
        expect(await fake.service.getJob(second.id)).toBeNull();
      } else {
        expect(await fake.service.getJob(second.id)).toMatchObject({
          id: second.id,
          idempotencyKey: second.id,
          context: expect.objectContaining({ tenantId: 'tenant_2' }),
        });
      }
      await fake.drain();
      expect(handled.sort()).toEqual(scope === 'global' ? ['tenant_1'] : ['tenant_1', 'tenant_2']);
      expect(options.dedupe.scope).toBe(scope);
    },
  );

  it('uses the explicitly remapped tenant for function-level dedupe options', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    const Publisher = createOutboxJobsPublisher({
      map: {
        'invoice.issued': {
          job: 'invoice.process',
          tenant: (event) => String(event.payload.owner),
          options: () => ({ dedupe: { key: 'shared-key' }, context: { tenantId: 'stale' } }),
        },
      },
    });
    const publisher = new Publisher(fake.service);
    for (const owner of ['a', 'b']) {
      await publisher.publish({ ...record, id: owner, payload: { owner } });
      expect(await fake.service.getJob(owner)).toMatchObject({ context: { tenantId: owner } });
    }
  });

  it('keeps tenantless optional mappings global and rejects explicit tenant scope', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    for (const scope of [undefined, 'tenant'] as const) {
      const Publisher = createOutboxJobsPublisher({
        map: {
          'invoice.issued': {
            job: 'invoice.process',
            tenant: 'optional',
            options: { dedupe: { key: 'system', scope }, context: { tenantId: 'stale' } },
          },
        },
      });
      const publisher = new Publisher(fake.service);
      const first = { ...record, id: 'system-a', tenantId: null };
      if (scope === 'tenant') {
        await expect(publisher.publish(first)).rejects.toThrow();
      } else {
        await publisher.publish(first);
        await publisher.publish({ ...first, id: 'system-b' });
        expect((await fake.service.getJob(first.id))?.context).not.toHaveProperty('tenantId');
        expect(await fake.service.getJob('system-b')).toBeNull();
      }
    }
  });

  it('preserves the generic JobsService global dedupe default', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    const ids = [];
    for (const tenantId of ['a', 'b']) {
      ids.push(
        await fake.service.enqueue(
          'invoice.process',
          {},
          {
            context: { tenantId },
            dedupe: { key: 'generic' },
          },
        ),
      );
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it('clears absent reserved lineage while preserving custom mapping fields', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    const stale = {
      source: 'forged',
      outboxEventId: 'forged',
      outboxEventType: 'forged',
      tenantId: 'forged',
      correlationId: 'forged',
      causationId: 'forged',
      aggregateType: 'forged',
      aggregateId: 'forged',
      partitionKey: 'forged',
      outboxIdempotencyKey: 'forged',
      outboxHeaders: { stale: true },
      outboxOccurredAt: 'forged',
    };
    const Publisher = createOutboxJobsPublisher({
      map: {
        'invoice.issued': {
          job: 'invoice.process',
          tenant: 'optional',
          options: { context: { ...stale, custom: true }, metadata: { ...stale, custom: true } },
        },
      },
    });
    await new Publisher(fake.service).publish({
      ...record,
      tenantId: null,
      correlationId: null,
      causationId: null,
      idempotencyKey: null,
      occurredAt: null,
    });
    const job = await fake.service.getJob(record.id);
    expect(job?.context).toMatchObject({
      custom: true,
      outboxEventId: record.id,
      correlationId: record.id,
    });
    expect(job?.context).not.toHaveProperty('tenantId');
    expect(job?.context).not.toHaveProperty('causationId');
    expect(job?.metadata).toEqual({
      custom: true,
      source: '@nestarc/outbox',
      outboxEventId: record.id,
      outboxEventType: record.eventType,
      correlationId: record.id,
    });
  });

  it.each(['tenant', 'options', 'payload'] as const)(
    'snapshots source identity and nested lineage before the %s callback',
    async (callback) => {
      const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
      const source = {
        ...record,
        headers: { nested: { trace: 'original' } },
        occurredAt: new Date('2026-08-15T00:00:00.000Z'),
      };
      const mutate = (event: OutboxRecord) => {
        event.id = 'forged';
        event.eventType = 'forged';
        event.tenantId = 'forged';
        event.correlationId = 'forged';
        event.causationId = 'forged';
        event.idempotencyKey = 'forged';
        event.aggregateId = 'forged';
        (event.headers?.nested as { trace: string }).trace = 'forged';
        (event.occurredAt as Date).setUTCFullYear(2000);
      };
      const target: OutboxJobTarget = { job: 'invoice.process' };
      if (callback === 'tenant')
        target.tenant = (event) => {
          mutate(event);
          return 'remapped';
        };
      if (callback === 'options')
        target.options = (event) => {
          mutate(event);
          return {};
        };
      if (callback === 'payload')
        target.payload = (event) => {
          mutate(event);
          return { mapped: true };
        };
      const Publisher = createOutboxJobsPublisher({ map: { 'invoice.issued': target } });
      await new Publisher(fake.service).publish(source);
      expect(await fake.service.getJob(record.id)).toMatchObject({
        id: record.id,
        idempotencyKey: record.id,
        context: {
          tenantId: callback === 'tenant' ? 'remapped' : record.tenantId,
          outboxEventId: record.id,
          correlationId: record.id,
          causationId: record.causationId,
        },
        metadata: {
          outboxEventId: record.id,
          outboxEventType: record.eventType,
          outboxIdempotencyKey: 'source-key',
          outboxHeaders: { nested: { trace: 'original' } },
          outboxOccurredAt: '2026-08-15T00:00:00.000Z',
        },
      });
      expect((await fake.service.getJob(record.id))?.metadata).not.toHaveProperty('aggregateId');
      expect(await fake.service.getJob('forged')).toBeNull();
    },
  );

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

  it('treats inherited object property names as unmapped events', async () => {
    const fake = new FakeJobsService({ jobTypes: ['invoice.process'] });
    const Publisher = createOutboxJobsPublisher({
      map: { 'invoice.issued': 'invoice.process' },
      unmapped: 'ignore',
    });
    const publisher = new Publisher(fake.service);

    for (const eventType of ['toString', 'constructor', '__proto__']) {
      await expect(publisher.publish({ ...record, eventType })).resolves.toBeUndefined();
    }
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
