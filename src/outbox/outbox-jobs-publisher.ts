import { Inject, Injectable, type Type } from '@nestjs/common';
import { JOBS_SERVICE } from '../contracts';
import { snapshotLifecycleValue } from '../lifecycle-observer';
import type { JobsService } from '../jobs.service';
import type { EnqueueOptions, JobContext } from '../types';

export interface OutboxRecord {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  status?: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  createdAt?: Date;
  updatedAt?: Date;
  processedAt?: Date | null;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string | null;
  tenantId?: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  partitionKey?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  headers?: Record<string, unknown> | null;
  occurredAt?: Date | string | null;
}

export interface OutboxPublisher {
  publish(record: OutboxRecord): Promise<void>;
}

export interface OutboxJobTarget {
  job: string;
  payload?: (record: OutboxRecord) => Record<string, unknown>;
  options?: EnqueueOptions | ((record: OutboxRecord) => EnqueueOptions);
  tenant?: 'required' | 'optional' | ((record: OutboxRecord) => string | undefined);
}

export interface OutboxJobsPublisherOptions {
  map: Record<string, string | OutboxJobTarget>;
  unmapped?: 'error' | 'ignore';
}

/**
 * Creates an OutboxPublisher-compatible Nest provider for use as
 * `OutboxModule.forRoot({ transport: createOutboxJobsPublisher(...),
 * delivery: { mode: 'publisher' } })`.
 */
export function createOutboxJobsPublisher(
  publisherOptions: OutboxJobsPublisherOptions,
): Type<OutboxPublisher> {
  @Injectable()
  class OutboxJobsPublisher implements OutboxPublisher {
    constructor(@Inject(JOBS_SERVICE) private readonly jobs: JobsService) {}

    async publish(record: OutboxRecord): Promise<void> {
      if (!Object.prototype.hasOwnProperty.call(publisherOptions.map, record.eventType)) {
        if (publisherOptions.unmapped === 'ignore') return;
        throw new Error(`No jobs mapping exists for outbox event "${record.eventType}"`);
      }
      const configuredTarget = publisherOptions.map[record.eventType];

      const target: OutboxJobTarget =
        typeof configuredTarget === 'string' ? { job: configuredTarget } : configuredTarget;
      // Capture source-owned lineage before any user mapping can mutate the record.
      const source = {
        ...record,
        headers: snapshotLifecycleValue(record.headers),
        occurredAt:
          record.occurredAt instanceof Date ? record.occurredAt.toISOString() : record.occurredAt,
      };
      const tenantId = this.resolveTenant(source, record, target.tenant ?? 'required');
      const configuredOptions =
        typeof target.options === 'function' ? target.options(record) : (target.options ?? {});
      const dedupe: EnqueueOptions['dedupe'] = configuredOptions.dedupe
        ? {
            ...configuredOptions.dedupe,
            scope: configuredOptions.dedupe.scope ?? (tenantId ? 'tenant' : 'global'),
          }
        : undefined;
      const correlationId = source.correlationId ?? source.id;
      const customContext = { ...(configuredOptions.context as JobContext | undefined) };
      for (const key of ['tenantId', 'outboxEventId', 'correlationId', 'causationId']) {
        delete customContext[key];
      }
      const customMetadata = { ...configuredOptions.metadata };
      for (const key of [
        'source',
        'outboxEventId',
        'outboxEventType',
        'tenantId',
        'correlationId',
        'causationId',
        'aggregateType',
        'aggregateId',
        'partitionKey',
        'outboxIdempotencyKey',
        'outboxHeaders',
        'outboxOccurredAt',
      ]) {
        delete customMetadata[key];
      }
      const context: JobContext = {
        ...customContext,
        ...(tenantId ? { tenantId } : {}),
        outboxEventId: source.id,
        correlationId,
        ...(source.causationId ? { causationId: source.causationId } : {}),
      };
      const metadata: Record<string, unknown> = {
        ...customMetadata,
        source: '@nestarc/outbox',
        outboxEventId: source.id,
        outboxEventType: source.eventType,
        correlationId,
        ...(tenantId ? { tenantId } : {}),
        ...(source.causationId ? { causationId: source.causationId } : {}),
        ...(source.aggregateType ? { aggregateType: source.aggregateType } : {}),
        ...(source.aggregateId ? { aggregateId: source.aggregateId } : {}),
        ...(source.partitionKey ? { partitionKey: source.partitionKey } : {}),
        ...(source.idempotencyKey ? { outboxIdempotencyKey: source.idempotencyKey } : {}),
        ...(source.headers ? { outboxHeaders: source.headers } : {}),
        ...(source.occurredAt ? { outboxOccurredAt: source.occurredAt } : {}),
      };

      await this.jobs.enqueue(target.job, target.payload?.(record) ?? record.payload, {
        ...configuredOptions,
        dedupe,
        context,
        metadata,
        jobId: source.id,
        idempotencyKey: source.id,
      });
    }

    private resolveTenant(
      source: OutboxRecord,
      record: OutboxRecord,
      strategy: NonNullable<OutboxJobTarget['tenant']>,
    ): string | undefined {
      const tenantId =
        typeof strategy === 'function' ? strategy(record) : (source.tenantId ?? undefined);
      if (strategy !== 'optional' && (!tenantId || tenantId.length === 0)) {
        throw new Error(`Outbox event "${source.id}" requires a tenantId`);
      }
      return tenantId || undefined;
    }
  }

  return OutboxJobsPublisher;
}
