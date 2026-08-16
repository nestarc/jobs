import { Inject, Injectable, type Type } from '@nestjs/common';
import { JOBS_SERVICE } from '../contracts';
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
      const configuredTarget = publisherOptions.map[record.eventType];
      if (!configuredTarget) {
        if (publisherOptions.unmapped === 'ignore') return;
        throw new Error(`No jobs mapping exists for outbox event "${record.eventType}"`);
      }

      const target: OutboxJobTarget =
        typeof configuredTarget === 'string' ? { job: configuredTarget } : configuredTarget;
      const tenantId = this.resolveTenant(record, target.tenant ?? 'required');
      const configuredOptions =
        typeof target.options === 'function' ? target.options(record) : (target.options ?? {});
      const correlationId = record.correlationId ?? record.id;
      const context: JobContext = {
        ...(configuredOptions.context as JobContext | undefined),
        ...(tenantId ? { tenantId } : {}),
        outboxEventId: record.id,
        correlationId,
        ...(record.causationId ? { causationId: record.causationId } : {}),
      };
      const metadata: Record<string, unknown> = {
        ...configuredOptions.metadata,
        source: '@nestarc/outbox',
        outboxEventId: record.id,
        outboxEventType: record.eventType,
        correlationId,
        ...(record.causationId ? { causationId: record.causationId } : {}),
        ...(record.aggregateType ? { aggregateType: record.aggregateType } : {}),
        ...(record.aggregateId ? { aggregateId: record.aggregateId } : {}),
        ...(record.partitionKey ? { partitionKey: record.partitionKey } : {}),
        ...(record.idempotencyKey ? { outboxIdempotencyKey: record.idempotencyKey } : {}),
        ...(record.headers ? { outboxHeaders: record.headers } : {}),
        ...(record.occurredAt
          ? {
              outboxOccurredAt:
                record.occurredAt instanceof Date
                  ? record.occurredAt.toISOString()
                  : record.occurredAt,
            }
          : {}),
      };

      await this.jobs.enqueue(target.job, target.payload?.(record) ?? record.payload, {
        ...configuredOptions,
        context,
        metadata,
        jobId: record.id,
        idempotencyKey: record.id,
      });
    }

    private resolveTenant(
      record: OutboxRecord,
      strategy: NonNullable<OutboxJobTarget['tenant']>,
    ): string | undefined {
      const tenantId =
        typeof strategy === 'function' ? strategy(record) : (record.tenantId ?? undefined);
      if (strategy !== 'optional' && (!tenantId || tenantId.length === 0)) {
        throw new Error(`Outbox event "${record.id}" requires a tenantId`);
      }
      return tenantId || undefined;
    }
  }

  return OutboxJobsPublisher;
}
