import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ConnectionOptions, Job, JobsOptions, MinimalJob, Queue, Worker } from 'bullmq';
import { detachContext } from '../context-serializer';
import { JobsError, JobsErrorCode } from '../errors';
import { computeBackoffDelayMs, type BackoffPolicy } from '../retry';
import type { JobsBackend } from './jobs-backend.interface';
import type { DedupeOptions, EnqueueOptions, JobContext, JobEnvelope, JobEvent } from '../types';
import type { HandlerRegistry } from '../handler-registry';
import type {
  BackendCapabilities,
  EnqueueResult,
  JobEventsOptions,
  JobHistoryEntry,
  JobRecord,
  JobStatus,
} from '../lifecycle';

const INTERNAL_KEY = '__nestarcJob';
const INTERNAL_VERSION = 1;
const CUSTOM_BACKOFF_TYPE = 'nestarc';

type BullMQModule = typeof import('bullmq');

interface PersistedJobMetadata {
  version: typeof INTERNAL_VERSION;
  metadata: Record<string, unknown>;
  scheduledFor?: number;
  idempotencyKey?: string;
  dedupeKey?: string;
  enqueueToken: string;
  backoff?: BackoffPolicy;
}

interface DecodedEnvelope {
  payload: Record<string, unknown>;
  context: JobContext;
  internal?: PersistedJobMetadata;
}

export interface BullMQBackendOptions {
  namespace?: string;
  /** BullMQ/ioredis connection object. Kept structural so BullMQ remains an optional peer. */
  connection: object;
  workerConcurrency?: number;
}

export interface BullMQRawQueue {
  add(name: string, data: unknown, options?: unknown): Promise<{ id?: string | number }>;
  getJob(jobId: string): Promise<unknown>;
  close(): Promise<void>;
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
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: BullMQBackendOptions) {}

  capabilities(): BackendCapabilities {
    return {
      durable: true,
      distributed: true,
      delayed: true,
      retries: true,
      backoff: true,
      timeout: false,
      statusQuery: true,
      history: false,
      idempotency: true,
      deadLetter: false,
      fairness: 'none',
      manualDrain: false,
    };
  }

  registerJobTypes(jobTypes: Iterable<string>): void {
    for (const jobType of jobTypes) this.getOrCreateQueue(jobType);
  }

  async enqueue(
    jobType: string,
    envelope: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<string> {
    return (await this.enqueueDetailed(jobType, envelope, opts)).jobId;
  }

  async enqueueDetailed(
    jobType: string,
    envelope: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<EnqueueResult> {
    if (opts.timeoutMs !== undefined) throw this.unsupported('timeout');
    if (Object.prototype.hasOwnProperty.call(envelope, INTERNAL_KEY)) {
      throw new JobsError(JobsErrorCode.ReservedPayloadKey, INTERNAL_KEY);
    }

    const queue = this.getOrCreateQueue(jobType);
    const { context } = detachContext(envelope);
    const dedupeKey = this.resolveDedupeKey(context.tenantId, opts.dedupe);
    const enqueueToken = randomUUID();
    const scheduledFor = this.resolveScheduledFor(opts);
    const internal: PersistedJobMetadata = {
      version: INTERNAL_VERSION,
      metadata: opts.metadata ?? {},
      scheduledFor: scheduledFor?.getTime(),
      idempotencyKey: opts.idempotencyKey,
      dedupeKey,
      enqueueToken,
      backoff: opts.backoff,
    };
    const persistedEnvelope = { ...envelope, [INTERNAL_KEY]: internal };
    const jobId = await this.resolveJobId(queue, opts, dedupeKey);
    const addOptions: JobsOptions = {
      jobId,
      delay: scheduledFor ? Math.max(0, scheduledFor.getTime() - Date.now()) : undefined,
      attempts: Math.max(1, opts.attempts ?? 1),
      backoff: opts.backoff
        ? { type: CUSTOM_BACKOFF_TYPE, delay: opts.backoff.delayMs }
        : undefined,
      deduplication:
        opts.dedupe && (opts.dedupe.mode ?? 'until_completed') === 'while_active'
          ? { id: this.hash(`dedupe:${dedupeKey}`), ttl: opts.dedupe.ttlMs }
          : undefined,
    };
    const added = await queue.add(jobType, persistedEnvelope, addOptions);
    const stored = await queue.getJob(String(added.id));
    const storedToken = stored
      ? this.decode(stored.data as Record<string, unknown>).internal?.enqueueToken
      : undefined;
    if (storedToken !== enqueueToken) {
      return { status: 'deduped', jobId: String(added.id), existingJobId: String(added.id) };
    }
    return { status: 'created', jobId: String(added.id) };
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    this.assertOpen();
    for (const [queueName, queue] of this.queues.entries()) {
      const job = await queue.getJob(jobId);
      if (!job) continue;
      const state = await job.getState();
      const status = this.mapState(state);
      const decoded = this.decode(job.data as Record<string, unknown>);
      return {
        id: String(job.id),
        type: String(job.name),
        status,
        payload: decoded.payload,
        context: decoded.context,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
        enqueuedAt: new Date(job.timestamp),
        scheduledFor: decoded.internal?.scheduledFor
          ? new Date(decoded.internal.scheduledFor)
          : job.delay
            ? new Date(job.timestamp + job.delay)
            : undefined,
        startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
        failedAt:
          status === 'failed' && job.finishedOn ? new Date(job.finishedOn) : undefined,
        completedAt:
          status === 'succeeded' && job.finishedOn ? new Date(job.finishedOn) : undefined,
        error:
          status === 'failed' && job.failedReason
            ? { message: job.failedReason }
            : undefined,
        idempotencyKey: decoded.internal?.idempotencyKey,
        dedupeKey: decoded.internal?.dedupeKey,
        metadata: { ...(decoded.internal?.metadata ?? {}), queueName },
      };
    }
    return null;
  }

  async getJobHistory(_jobId: string): Promise<JobHistoryEntry[]> {
    throw this.unsupported('history');
  }

  async peekWaiting(_jobType: string): Promise<JobEnvelope[]> {
    throw this.unsupported('manualDrain');
  }

  async moveToActive(_jobType: string, _jobId: string): Promise<JobEnvelope | null> {
    throw this.unsupported('manualDrain');
  }

  async ack(_jobType: string, _jobId: string): Promise<void> {
    throw this.unsupported('manualDrain');
  }

  async fail(_jobType: string, _jobId: string, _reason: string): Promise<void> {
    throw this.unsupported('manualDrain');
  }

  startConsumer(jobTypes: string[], consumer: BullMQConsumerOptions): void {
    this.registerJobTypes(jobTypes);
    const { Worker } = loadBullMQ();
    for (const jobType of jobTypes) {
      const name = this.queueName(jobType);
      if (this.workers.has(name)) continue;
      const worker = new Worker(name, async (job: Job) => this.processJob(jobType, job, consumer), {
        connection: this.connection(),
        concurrency: this.opts.workerConcurrency ?? 10,
        settings: {
          backoffStrategy: (
            attemptsMade: number,
            type?: string,
            _err?: Error,
            job?: MinimalJob,
          ) => {
            if (type !== CUSTOM_BACKOFF_TYPE || !job) return -1;
            const internal = this.decode(job.data as Record<string, unknown>).internal;
            return computeBackoffDelayMs(internal?.backoff, attemptsMade);
          },
        },
      });
      this.workers.set(name, worker);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const closing = this.closeResources();
    this.closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.closePromise === closing) this.closePromise = null;
    }
  }

  getRawQueue<TQueue = BullMQRawQueue>(jobType: string): TQueue {
    return this.getOrCreateQueue(jobType) as unknown as TQueue;
  }

  private async processJob(
    jobType: string,
    job: Job,
    consumer: BullMQConsumerOptions,
  ): Promise<unknown> {
    const { payload, context, internal } = this.decode(job.data as Record<string, unknown>);
    const tenantId = typeof context.tenantId === 'string' ? context.tenantId : undefined;
    const startedAt = new Date();
    const event: JobEvent = { jobId: String(job.id), jobType, tenantId, startedAt };
    const metadata = internal?.metadata;
    consumer.onStart?.(event);
    consumer.events?.onEvent?.({
      type: 'job.started',
      jobId: String(job.id),
      jobType,
      tenantId,
      attempt: job.attemptsMade + 1,
      at: startedAt,
      metadata,
    });
    try {
      const result = await consumer.contextRunner(context, () =>
        consumer.registry.invoke(jobType, payload, context),
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
        metadata,
      });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const attempt = job.attemptsMade + 1;
      const { UnrecoverableError } = loadBullMQ();
      const willRetry =
        !(error instanceof UnrecoverableError) && attempt < (job.opts.attempts ?? 1);
      consumer.onFail?.(event, error);
      consumer.events?.onEvent?.({
        type: willRetry ? 'job.retry_scheduled' : 'job.failed',
        jobId: String(job.id),
        jobType,
        tenantId,
        attempt,
        at: new Date(),
        error: { message: error.message, name: error.name },
        metadata,
      });
      throw error;
    }
  }

  private async resolveJobId(
    queue: Queue,
    opts: EnqueueOptions,
    dedupeKey: string | undefined,
  ): Promise<string> {
    if (opts.jobId) return opts.jobId;
    if (opts.idempotencyKey) return `id-${this.hash(opts.idempotencyKey)}`;
    if (!opts.dedupe || !dedupeKey || (opts.dedupe.mode ?? 'until_completed') === 'while_active') {
      return randomUUID();
    }

    const jobId = `dedupe-${this.hash(dedupeKey)}`;
    if (opts.dedupe.ttlMs !== undefined) {
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        const terminal = state === 'completed' || state === 'failed';
        const terminalAt = existing.finishedOn ?? existing.timestamp;
        if (terminal && Date.now() - terminalAt >= opts.dedupe.ttlMs) await existing.remove();
      }
    }
    return jobId;
  }

  private resolveDedupeKey(
    tenantId: unknown,
    dedupe: DedupeOptions | undefined,
  ): string | undefined {
    if (!dedupe) return undefined;
    if ((dedupe.scope ?? 'global') === 'tenant') {
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new JobsError(
          JobsErrorCode.FairnessMisconfig,
          'tenant-scoped dedupe requires a tenantId',
        );
      }
      return `tenant:${tenantId}:${dedupe.key}`;
    }
    return `global:${dedupe.key}`;
  }

  private resolveScheduledFor(opts: EnqueueOptions): Date | undefined {
    if (opts.scheduledFor) return opts.scheduledFor;
    const delayMs = opts.delayMs ?? opts.delay;
    return delayMs === undefined ? undefined : new Date(Date.now() + Math.max(0, delayMs));
  }

  private decode(envelope: Record<string, unknown>): DecodedEnvelope {
    const rawInternal = envelope[INTERNAL_KEY];
    if (!this.isPersistedMetadata(rawInternal)) {
      const { payload, context } = detachContext(envelope);
      return { payload, context };
    }
    const persistedEnvelope = { ...envelope };
    delete persistedEnvelope[INTERNAL_KEY];
    const { payload, context } = detachContext(persistedEnvelope);
    return { payload, context, internal: rawInternal };
  }

  private isPersistedMetadata(value: unknown): value is PersistedJobMetadata {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { version?: unknown }).version === INTERNAL_VERSION &&
      typeof (value as { metadata?: unknown }).metadata === 'object' &&
      (value as { metadata?: unknown }).metadata !== null &&
      typeof (value as { enqueueToken?: unknown }).enqueueToken === 'string'
    );
  }

  private async closeResources(): Promise<void> {
    const failures: unknown[] = [];
    const workers = [...this.workers.entries()];
    const workerResults = await Promise.allSettled(
      workers.map(([, worker]) => worker.close()),
    );
    workerResults.forEach((result, index) => {
      if (result.status === 'fulfilled') this.workers.delete(workers[index][0]);
      else failures.push(result.reason);
    });

    const queues = [...this.queues.entries()];
    const queueResults = await Promise.allSettled(queues.map(([, queue]) => queue.close()));
    queueResults.forEach((result, index) => {
      if (result.status === 'fulfilled') this.queues.delete(queues[index][0]);
      else failures.push(result.reason);
    });

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'BullMQ backend close failed');
  }

  private mapState(state: string): JobStatus {
    if (state === 'completed') return 'succeeded';
    if (state === 'failed') return 'failed';
    if (state === 'active') return 'active';
    if (state === 'delayed') return 'delayed';
    return 'queued';
  }

  private queueName(jobType: string): string {
    const namespace = this.opts.namespace ?? 'nestarc';
    return `${namespace}.${jobType}`;
  }

  private getOrCreateQueue(jobType: string): Queue {
    this.assertOpen();
    const name = this.queueName(jobType);
    let queue = this.queues.get(name);
    if (!queue) {
      const { Queue } = loadBullMQ();
      queue = new Queue(name, { connection: this.connection() });
      this.queues.set(name, queue);
    }
    return queue;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private connection(): ConnectionOptions {
    return this.opts.connection as ConnectionOptions;
  }

  private unsupported(capability: string): JobsError {
    return new JobsError(
      JobsErrorCode.CapabilityUnsupported,
      `${capability} is unavailable for the BullMQ backend`,
    );
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new JobsError(JobsErrorCode.BackendClosed, 'BullMQ backend is closed');
    }
  }
}

let bullmqModule: BullMQModule | undefined;
const requireModule = createRequire(__filename);

function loadBullMQ(): BullMQModule {
  bullmqModule ??= requireModule('bullmq') as BullMQModule;
  return bullmqModule;
}
