import { Queue, Worker, ConnectionOptions } from 'bullmq';
import { detachContext } from '../context-serializer';
import { JobsError, JobsErrorCode } from '../errors';
import type { JobsBackend } from './jobs-backend.interface';
import type { EnqueueOptions, JobContext, JobEnvelope, JobEvent } from '../types';
import type { HandlerRegistry } from '../handler-registry';

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
}

export class BullMQBackend implements JobsBackend {
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  constructor(private readonly opts: BullMQBackendOptions) {}

  async enqueue(
    jobType: string,
    envelope: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<string> {
    const queue = this.getOrCreateQueue(jobType);
    const job = await queue.add(jobType, envelope, {
      jobId: opts.jobId,
      delay: opts.delay,
      attempts: opts.attempts,
    });
    return String(job.id);
  }

  // Pull-based operations are unsupported on BullMQ backend in v0.1.
  // These throw so callers that expect FairWorker semantics fail loudly
  // rather than silently degrading.
  async peekWaiting(): Promise<JobEnvelope[]> {
    throw new JobsError(
      JobsErrorCode.FairnessMisconfig,
      'BullMQ backend does not support pull-based fairness in v0.1. Use InMemory for fairness; BullMQ delivers FIFO via startConsumer().',
    );
  }
  async moveToActive(): Promise<JobEnvelope | null> {
    throw new JobsError(JobsErrorCode.FairnessMisconfig, 'not supported on BullMQ backend in v0.1');
  }
  async ack(): Promise<void> {
    throw new JobsError(JobsErrorCode.FairnessMisconfig, 'not supported on BullMQ backend in v0.1');
  }
  async fail(): Promise<void> {
    throw new JobsError(JobsErrorCode.FairnessMisconfig, 'not supported on BullMQ backend in v0.1');
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
            return result;
          } catch (err) {
            consumer.onFail?.(event, err as Error);
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
