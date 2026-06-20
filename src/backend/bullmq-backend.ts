import { Queue, Worker, ConnectionOptions } from 'bullmq';
import { detachContext } from '../context-serializer';
import { JobsError, JobsErrorCode } from '../errors';
import type { JobsBackend } from './jobs-backend.interface';
import type { EnqueueOptions, JobContext, JobEnvelope, JobEvent } from '../types';
import type { HandlerRegistry } from '../handler-registry';
import type {
  BackendCapabilities,
  JobEventsOptions,
  JobHistoryEntry,
  JobRecord,
  JobStatus,
} from '../lifecycle';

export interface BullMQBackendOptions {
  namespace?: string;
  connection: ConnectionOptions;
  workerConcurrency?: number;
}

export interface BullMQConsumerOptions {
  registry: HandlerRegistry;
  contextRunner: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
  onStart?: (e: JobEvent) => void;
  onFinish?: (e: JobEvent) => void;
  onFail?: (e: JobEvent, err: Error) => void;
  events?: JobEventsOptions;
}

export class BullMQBackend implements JobsBackend {
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  constructor(private readonly opts: BullMQBackendOptions) {}

  capabilities(): BackendCapabilities {
    return {
      durable: true,
      distributed: true,
      delayed: true,
      retries: true,
      backoff: true,
      timeout: true,
      statusQuery: true,
      history: true,
      idempotency: true,
      deadLetter: true,
      fairness: 'none',
      manualDrain: true,
    };
  }

  async enqueue(
    jobType: string,
    envelope: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<string> {
    const queue = this.getOrCreateQueue(jobType);
    const job = await queue.add(jobType, envelope, {
      jobId: opts.jobId ?? opts.idempotencyKey,
      delay: opts.delayMs ?? opts.delay,
      attempts: opts.attempts,
      backoff: opts.backoff,
    });
    return String(job.id);
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    for (const [queueName, queue] of this.queues.entries()) {
      const job = await queue.getJob(jobId);
      if (!job) continue;
      const state = await job.getState();
      const { payload, context } = detachContext(job.data as Record<string, unknown>);
      return {
        id: String(job.id),
        type: String(job.name),
        status: this.mapState(state),
        payload,
        context,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
        enqueuedAt: new Date(job.timestamp),
        scheduledFor: job.delay ? new Date(job.timestamp + job.delay) : undefined,
        failedAt: job.failedReason ? new Date(job.finishedOn ?? Date.now()) : undefined,
        completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
        error: job.failedReason ? { message: job.failedReason } : undefined,
        metadata: { queueName },
      };
    }
    return null;
  }

  async getJobHistory(jobId: string): Promise<JobHistoryEntry[]> {
    const record = await this.getJob(jobId);
    if (!record) return [];
    return [{ jobId, status: record.status, attempt: record.attempt, at: new Date() }];
  }

  // Pull-based operations are unsupported on BullMQ backend in v0.2.
  // These throw so callers that expect FairWorker semantics fail loudly
  // rather than silently degrading.
  async peekWaiting(): Promise<JobEnvelope[]> {
    throw new JobsError(
      JobsErrorCode.FairnessMisconfig,
      'BullMQ backend does not support pull-based fairness in v0.2. Use InMemory for fairness; BullMQ delivers FIFO via startConsumer().',
    );
  }
  async moveToActive(): Promise<JobEnvelope | null> {
    throw new JobsError(JobsErrorCode.FairnessMisconfig, 'not supported on BullMQ backend in v0.2');
  }
  async ack(): Promise<void> {
    throw new JobsError(JobsErrorCode.FairnessMisconfig, 'not supported on BullMQ backend in v0.2');
  }
  async fail(): Promise<void> {
    throw new JobsError(JobsErrorCode.FairnessMisconfig, 'not supported on BullMQ backend in v0.2');
  }

  startConsumer(jobTypes: string[], consumer: BullMQConsumerOptions): void {
    for (const jobType of jobTypes) {
      const name = this.queueName(jobType);
      const worker = new Worker(
        name,
        async (job) => {
          const { payload, context } = detachContext(job.data as Record<string, unknown>);
          const tenantId = (context.tenantId as string | undefined) ?? undefined;
          const startedAt = new Date();
          const event: JobEvent = { jobId: String(job.id), jobType, tenantId, startedAt };
          consumer.onStart?.(event);
          consumer.events?.onEvent?.({
            type: 'job.started',
            jobId: String(job.id),
            jobType,
            tenantId,
            attempt: job.attemptsMade + 1,
            at: startedAt,
          });
          try {
            const result = await consumer.contextRunner(context, () =>
              consumer.registry.invoke(jobType, payload as Record<string, unknown>, context),
            );
            const finishedAt = new Date();
            consumer.onFinish?.({
              ...event,
              finishedAt,
              durationMs: finishedAt.getTime() - startedAt.getTime(),
            });
            consumer.events?.onEvent?.({
              type: 'job.succeeded',
              jobId: String(job.id),
              jobType,
              tenantId,
              attempt: job.attemptsMade + 1,
              at: finishedAt,
              durationMs: finishedAt.getTime() - startedAt.getTime(),
            });
            return result;
          } catch (err) {
            consumer.onFail?.(event, err as Error);
            consumer.events?.onEvent?.({
              type: 'job.failed',
              jobId: String(job.id),
              jobType,
              tenantId,
              attempt: job.attemptsMade + 1,
              at: new Date(),
              error: { message: (err as Error).message, name: (err as Error).name },
            });
            throw err;
          }
        },
        {
          connection: this.opts.connection,
          concurrency: this.opts.workerConcurrency ?? 10,
        },
      );
      this.workers.set(name, worker);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    this.workers.clear();
  }

  private mapState(state: string): JobStatus {
    if (state === 'completed') return 'succeeded';
    if (state === 'failed') return 'dead_letter';
    if (state === 'active') return 'active';
    if (state === 'delayed') return 'delayed';
    if (state === 'waiting' || state === 'waiting-children' || state === 'prioritized') {
      return 'queued';
    }
    return 'queued';
  }

  getRawQueue(jobType: string): Queue {
    return this.getOrCreateQueue(jobType);
  }

  private queueName(jobType: string): string {
    const ns = this.opts.namespace ?? 'nestarc';
    return `${ns}.${jobType}`;
  }

  private getOrCreateQueue(jobType: string): Queue {
    const name = this.queueName(jobType);
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.opts.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }
}
