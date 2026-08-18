import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ConnectionOptions, Job, JobsOptions, MinimalJob, Queue, Worker } from 'bullmq';
import { detachContext } from '../context-serializer';
import { JobsError, JobsErrorCode } from '../errors';
import { normalizeError } from '../error-utils';
import { computeBackoffDelayMs, type BackoffPolicy } from '../retry';
import {
  notifyLifecycleObserver,
  snapshotLifecycleError,
  snapshotLifecycleValue,
} from '../lifecycle-observer';
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
const IDENTITY_LOCK_TTL_MS = 60_000;
const IDENTITY_LOCK_WAIT_MS = 30_000;
const IDENTITY_LOCK_RETRY_MS = 10;
const IDENTITY_BIND_RETRY_LIMIT = 3;
const COMPARE_AND_DELETE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

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

type PersistentIdentity =
  | {
      kind: 'idempotency';
      mapKey: string;
    }
  | {
      kind: 'dedupe';
      mapKey: string;
      mode: 'while_active' | 'until_completed';
      ttlMs?: number;
    };

interface IdentityMapping {
  jobId: string;
  mode?: 'while_active' | 'until_completed';
  ttlMs?: number;
}

interface IdentityResolution {
  existingJobId?: string;
  reservedJobId?: string;
}

interface IdentityRedisClient {
  get(key: string): Promise<string | null>;
  zscore(key: string, member: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, condition: 'NX'): Promise<'OK' | null>;
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
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
  private readonly activeHandlerScope = new AsyncLocalStorage<boolean>();
  private closePromise: Promise<void> | null = null;
  private closing = false;
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
    const addJob = async (jobId: string): Promise<EnqueueResult> => {
      const addOptions: JobsOptions = {
        jobId,
        delay: scheduledFor ? Math.max(0, scheduledFor.getTime() - Date.now()) : undefined,
        attempts: Math.max(1, opts.attempts ?? 1),
        backoff: opts.backoff
          ? { type: CUSTOM_BACKOFF_TYPE, delay: opts.backoff.delayMs }
          : undefined,
      };
      const added = await queue.add(jobType, persistedEnvelope, addOptions);
      const addedJobId = String(added.id);
      const stored = await queue.getJob(addedJobId);
      const storedToken = stored
        ? this.decode(stored.data as Record<string, unknown>).internal?.enqueueToken
        : undefined;
      if (storedToken !== enqueueToken) {
        return { status: 'deduped', jobId: addedJobId, existingJobId: addedJobId };
      }
      return { status: 'created', jobId: addedJobId };
    };

    const identities = this.persistentIdentities(queue, opts, dedupeKey);
    if (identities.length === 0) {
      return await addJob(this.resolveJobId(queue, opts));
    }

    return await this.withIdentityLocks(queue, identities, async (client) => {
      const resolution = await this.resolveIdentityMappings(queue, client, identities);
      const idempotencyIdentity = identities.find((identity) => identity.kind === 'idempotency');
      const legacyJobId =
        idempotencyIdentity && !(await client.get(idempotencyIdentity.mapKey))
          ? await this.findLegacyIdempotencyJob(queue, opts)
          : undefined;
      const existingJobId = this.mergeIdentityCandidates(resolution.existingJobId, legacyJobId);
      if (existingJobId) {
        this.mergeIdentityCandidates(existingJobId, resolution.reservedJobId);
        await this.backfillIdentityMappings(client, identities, existingJobId);
        return {
          status: 'deduped',
          jobId: existingJobId,
          existingJobId,
        };
      }

      const reservedJobId = resolution.reservedJobId ?? this.resolveJobId(queue, opts);
      // Reserve before Queue.add so a producer crash cannot leave a job without
      // a durable identity mapping. If the lock lease is lost while Queue.add is
      // pending, a later producer adopts the same reservation/job ID so BullMQ's
      // job-ID uniqueness still prevents duplicate work.
      await this.reserveIdentityMappings(client, identities, reservedJobId);
      try {
        const result = await addJob(reservedJobId);
        if (result.jobId !== reservedJobId) {
          await Promise.all(
            identities.map((identity) =>
              client.set(identity.mapKey, this.serializeIdentityMapping(identity, result.jobId)),
            ),
          );
        }
        return result;
      } catch (error) {
        try {
          const recovered = await queue.getJob(reservedJobId);
          if (recovered) {
            const recoveredToken = this.decode(recovered.data as Record<string, unknown>).internal
              ?.enqueueToken;
            return recoveredToken === enqueueToken
              ? { status: 'created', jobId: reservedJobId }
              : { status: 'deduped', jobId: reservedJobId, existingJobId: reservedJobId };
          }

          await Promise.allSettled(
            identities.map((identity) =>
              client.eval(
                COMPARE_AND_DELETE_SCRIPT,
                1,
                identity.mapKey,
                this.serializeIdentityMapping(identity, reservedJobId),
              ),
            ),
          );
        } catch {
          // Keep the reservation when the add outcome cannot be reconciled. A
          // later producer will remove it only after confirming the job is absent.
        }
        throw error;
      }
    });
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    this.assertOpen();
    for (const [queueName, queue] of this.queues.entries()) {
      const job = await queue.getJob(jobId);
      if (!job) continue;
      const state = await job.getState();
      const status = this.mapState(state);
      const decoded = this.decode(job.data as Record<string, unknown>);
      const delayedAt =
        status === 'delayed' ? await this.getDelayedTimestamp(queue, String(job.id)) : undefined;
      const nextAttemptAt = job.attemptsMade > 0 ? delayedAt : undefined;
      return {
        id: String(job.id),
        type: String(job.name),
        status,
        payload: decoded.payload,
        context: decoded.context,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
        enqueuedAt: new Date(job.timestamp),
        scheduledFor:
          nextAttemptAt ??
          (decoded.internal?.scheduledFor
            ? new Date(decoded.internal.scheduledFor)
            : (delayedAt ?? (job.delay ? new Date(job.timestamp + job.delay) : undefined))),
        startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
        failedAt: status === 'failed' && job.finishedOn ? new Date(job.finishedOn) : undefined,
        completedAt:
          status === 'succeeded' && job.finishedOn ? new Date(job.finishedOn) : undefined,
        nextAttemptAt,
        error: status === 'failed' && job.failedReason ? { message: job.failedReason } : undefined,
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

  async peekWaiting(_jobType?: string): Promise<JobEnvelope[]> {
    throw this.unsupported('manualDrain');
  }

  async moveToActive(_jobType?: string, _jobId?: string): Promise<JobEnvelope | null> {
    throw this.unsupported('manualDrain');
  }

  async ack(_jobType?: string, _jobId?: string): Promise<void> {
    throw this.unsupported('manualDrain');
  }

  async fail(_jobType?: string, _jobId?: string, _reason?: string): Promise<void> {
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
      worker.on('completed', (job) => this.notifyCompleted(jobType, job, consumer));
      worker.on('failed', (job, error) => {
        if (job) this.notifyFailed(jobType, job, error, consumer);
      });
      this.workers.set(name, worker);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
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
    notifyLifecycleObserver(() => consumer.onStart?.(snapshotLifecycleValue(event)));
    notifyLifecycleObserver(() =>
      consumer.events?.onEvent?.({
        type: 'job.started',
        jobId: String(job.id),
        jobType,
        tenantId,
        attempt: job.attemptsMade + 1,
        at: startedAt,
        metadata: snapshotLifecycleValue(metadata),
      }),
    );
    try {
      return await this.activeHandlerScope.run(true, () =>
        consumer.contextRunner(context, () => consumer.registry.invoke(jobType, payload, context)),
      );
    } catch (error) {
      throw normalizeError(error);
    }
  }

  private notifyCompleted(jobType: string, job: Job, consumer: BullMQConsumerOptions): void {
    const { context, internal } = this.decode(job.data as Record<string, unknown>);
    const tenantId = typeof context.tenantId === 'string' ? context.tenantId : undefined;
    const startedAt = new Date(job.processedOn ?? job.timestamp);
    const finishedAt = new Date(job.finishedOn ?? Date.now());
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const event: JobEvent = {
      jobId: String(job.id),
      jobType,
      tenantId,
      startedAt,
      finishedAt,
      durationMs,
    };
    notifyLifecycleObserver(() => consumer.onFinish?.(snapshotLifecycleValue(event)));
    notifyLifecycleObserver(() =>
      consumer.events?.onEvent?.({
        type: 'job.succeeded',
        jobId: String(job.id),
        jobType,
        tenantId,
        attempt: job.attemptsMade,
        at: finishedAt,
        durationMs,
        metadata: snapshotLifecycleValue(internal?.metadata),
      }),
    );
  }

  private notifyFailed(
    jobType: string,
    job: Job,
    error: Error,
    consumer: BullMQConsumerOptions,
  ): void {
    const { context, internal } = this.decode(job.data as Record<string, unknown>);
    const tenantId = typeof context.tenantId === 'string' ? context.tenantId : undefined;
    const startedAt = new Date(job.processedOn ?? job.timestamp);
    const finishedAt = new Date(job.finishedOn ?? Date.now());
    const event: JobEvent = { jobId: String(job.id), jobType, tenantId, startedAt, finishedAt };
    const { UnrecoverableError } = loadBullMQ();
    const unrecoverable =
      error instanceof UnrecoverableError || error.name === 'UnrecoverableError';
    const willRetry = !unrecoverable && job.attemptsMade < (job.opts.attempts ?? 1);
    notifyLifecycleObserver(() =>
      consumer.onFail?.(snapshotLifecycleValue(event), snapshotLifecycleError(error)),
    );
    notifyLifecycleObserver(() =>
      consumer.events?.onEvent?.({
        type: willRetry ? 'job.retry_scheduled' : 'job.failed',
        jobId: String(job.id),
        jobType,
        tenantId,
        attempt: job.attemptsMade,
        at: finishedAt,
        error: snapshotLifecycleValue({ message: error.message, name: error.name }),
        metadata: snapshotLifecycleValue(internal?.metadata),
      }),
    );
  }

  private resolveJobId(queue: Queue, opts: EnqueueOptions): string {
    if (opts.jobId) return opts.jobId;
    if (opts.idempotencyKey) {
      return `id-${this.hash(`${queue.name}\u0000${opts.idempotencyKey}`)}`;
    }
    return randomUUID();
  }

  private persistentIdentities(
    queue: Queue,
    opts: EnqueueOptions,
    dedupeKey: string | undefined,
  ): PersistentIdentity[] {
    const identities: PersistentIdentity[] = [];
    if (opts.idempotencyKey) {
      identities.push({
        kind: 'idempotency',
        mapKey: this.identityMapKey(queue, 'idempotency', opts.idempotencyKey),
      });
    }
    if (opts.dedupe && dedupeKey && (opts.dedupe.mode ?? 'until_completed') === 'until_completed') {
      identities.push({
        kind: 'dedupe',
        mapKey: this.identityMapKey(queue, 'dedupe', dedupeKey),
        mode: 'until_completed',
        ttlMs: opts.dedupe.ttlMs,
      });
    } else if (opts.dedupe && dedupeKey) {
      identities.push({
        kind: 'dedupe',
        mapKey: this.identityMapKey(queue, 'dedupe', dedupeKey),
        mode: 'while_active',
        ttlMs: opts.dedupe.ttlMs,
      });
    }
    return identities;
  }

  private async resolveIdentityMappings(
    queue: Queue,
    client: IdentityRedisClient,
    identities: PersistentIdentity[],
  ): Promise<IdentityResolution> {
    let foundJobId: string | undefined;
    let reservedJobId: string | undefined;
    for (const identity of identities) {
      const rawMapping = await client.get(identity.mapKey);
      if (!rawMapping) continue;
      const mapping = this.parseIdentityMapping(identity, rawMapping);

      const existing = await queue.getJob(mapping.jobId);
      if (!existing) {
        reservedJobId = this.mergeIdentityCandidates(reservedJobId, mapping.jobId);
        continue;
      }
      if (identity.kind === 'idempotency') {
        foundJobId = this.mergeIdentityCandidates(foundJobId, mapping.jobId);
        continue;
      }

      const state = await existing.getState();
      const terminal = state === 'completed' || state === 'failed';
      if ((mapping.mode ?? identity.mode) === 'while_active' && terminal) {
        await client.eval(COMPARE_AND_DELETE_SCRIPT, 1, identity.mapKey, rawMapping);
        continue;
      }
      const ttlExpired =
        terminal &&
        mapping.ttlMs !== undefined &&
        Date.now() - (existing.finishedOn ?? existing.timestamp) >= Math.max(0, mapping.ttlMs);
      if (ttlExpired) {
        await client.eval(COMPARE_AND_DELETE_SCRIPT, 1, identity.mapKey, rawMapping);
        continue;
      }
      foundJobId = this.mergeIdentityCandidates(foundJobId, mapping.jobId);
    }
    return { existingJobId: foundJobId, reservedJobId };
  }

  private async reserveIdentityMappings(
    client: IdentityRedisClient,
    identities: PersistentIdentity[],
    reservedJobId: string,
  ): Promise<void> {
    await this.bindIdentityMappings(client, identities, reservedJobId);
  }

  private async backfillIdentityMappings(
    client: IdentityRedisClient,
    identities: PersistentIdentity[],
    jobId: string,
  ): Promise<void> {
    await this.bindIdentityMappings(client, identities, jobId);
  }

  private async bindIdentityMappings(
    client: IdentityRedisClient,
    identities: PersistentIdentity[],
    jobId: string,
  ): Promise<void> {
    for (const identity of identities) {
      const value = this.serializeIdentityMapping(identity, jobId);
      let bound = false;
      for (let attempt = 0; attempt < IDENTITY_BIND_RETRY_LIMIT; attempt += 1) {
        if ((await client.set(identity.mapKey, value, 'NX')) === 'OK') {
          bound = true;
          break;
        }

        const rawMapping = await client.get(identity.mapKey);
        if (!rawMapping) continue;
        const mapping = this.parseIdentityMapping(identity, rawMapping);
        this.mergeIdentityCandidates(jobId, mapping.jobId);
        bound = true;
        break;
      }
      if (!bound) {
        // Preserve any earlier reservation. A later producer can safely adopt
        // it, while deleting it here could orphan work another producer added.
        throw new Error(`identity mapping changed while binding: ${identity.mapKey}`);
      }
    }
  }

  private async findLegacyIdempotencyJob(
    queue: Queue,
    opts: EnqueueOptions,
  ): Promise<string | undefined> {
    if (!opts.idempotencyKey) return undefined;
    const legacy = await queue.getJob(opts.idempotencyKey);
    if (!legacy) return undefined;

    const internal = this.decode(legacy.data as Record<string, unknown>).internal;
    if (internal && internal.idempotencyKey !== opts.idempotencyKey) return undefined;
    return String(legacy.id);
  }

  private mergeIdentityCandidates(
    current: string | undefined,
    candidate: string | undefined,
  ): string | undefined {
    if (!candidate || !current || current === candidate) return current ?? candidate;
    throw new JobsError(
      JobsErrorCode.IdentityConflict,
      `supplied identities resolve to different jobs: ${current}, ${candidate}`,
    );
  }

  private async withIdentityLocks<T>(
    queue: Queue,
    identities: PersistentIdentity[],
    action: (client: IdentityRedisClient) => Promise<T>,
  ): Promise<T> {
    const client = (await queue.client) as unknown as IdentityRedisClient;
    const token = randomUUID();
    const lockKeys = [...new Set(identities.map((identity) => `${identity.mapKey}:lock`))].sort();
    const acquired: string[] = [];

    try {
      for (const lockKey of lockKeys) {
        await this.acquireIdentityLock(client, lockKey, token);
        acquired.push(lockKey);
      }
      return await action(client);
    } finally {
      await Promise.allSettled(
        acquired
          .reverse()
          .map((lockKey) => client.eval(COMPARE_AND_DELETE_SCRIPT, 1, lockKey, token)),
      );
    }
  }

  private async acquireIdentityLock(
    client: IdentityRedisClient,
    lockKey: string,
    token: string,
  ): Promise<void> {
    const deadline = Date.now() + IDENTITY_LOCK_WAIT_MS;
    do {
      const result = await client.set(lockKey, token, 'PX', IDENTITY_LOCK_TTL_MS, 'NX');
      if (result === 'OK') return;
      await sleep(IDENTITY_LOCK_RETRY_MS);
    } while (Date.now() < deadline);

    throw new Error(`timed out acquiring BullMQ identity lock: ${lockKey}`);
  }

  private identityMapKey(queue: Queue, kind: PersistentIdentity['kind'], value: string): string {
    return queue.toKey(`nestarc:identity:${kind}:${this.hash(value)}`);
  }

  private serializeIdentityMapping(identity: PersistentIdentity, jobId: string): string {
    const mapping: IdentityMapping =
      identity.kind === 'dedupe'
        ? { jobId, mode: identity.mode, ttlMs: identity.ttlMs }
        : { jobId };
    return JSON.stringify(mapping);
  }

  private parseIdentityMapping(identity: PersistentIdentity, value: string): IdentityMapping {
    try {
      const parsed = JSON.parse(value) as Partial<IdentityMapping>;
      if (typeof parsed.jobId === 'string') {
        if (identity.kind === 'dedupe') {
          return {
            jobId: parsed.jobId,
            mode:
              parsed.mode === 'while_active' || parsed.mode === 'until_completed'
                ? parsed.mode
                : identity.mode,
            ttlMs: parsed.ttlMs,
          };
        }
        return { jobId: parsed.jobId };
      }
    } catch {
      // v0.3 pre-release snapshots stored the job ID as a plain string.
    }

    return identity.kind === 'dedupe'
      ? { jobId: value, mode: identity.mode, ttlMs: identity.ttlMs }
      : { jobId: value };
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
      return JSON.stringify(['tenant', tenantId, dedupe.key]);
    }
    return JSON.stringify(['global', dedupe.key]);
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
    const workerResults = await Promise.allSettled(workers.map(([, worker]) => worker.close()));
    workerResults.forEach((result, index) => {
      if (result.status === 'fulfilled') this.workers.delete(workers[index][0]);
      else failures.push(result.reason);
    });

    // Active handlers have drained. Reject later producer work before queues
    // are closed, while still allowing handlers to enqueue follow-up jobs.
    this.closed = true;

    const queues = [...this.queues.entries()];
    const queueResults = await Promise.allSettled(queues.map(([, queue]) => queue.close()));
    queueResults.forEach((result, index) => {
      if (result.status === 'fulfilled') this.queues.delete(queues[index][0]);
      else failures.push(result.reason);
    });

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'BullMQ backend close failed');
  }

  private async getDelayedTimestamp(queue: Queue, jobId: string): Promise<Date | undefined> {
    const client = (await queue.client) as unknown as IdentityRedisClient;
    const score = await client.zscore(queue.toKey('delayed'), jobId);
    if (score === null) return undefined;
    const timestamp = Math.floor(Number(score) / 0x1000);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
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
    this.assertAcceptingWork();
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

  private assertAcceptingWork(): void {
    this.assertOpen();
    if (this.closing && !this.activeHandlerScope.getStore()) {
      throw new JobsError(JobsErrorCode.BackendClosed, 'BullMQ backend is closing');
    }
  }
}

let bullmqModule: BullMQModule | undefined;
const requireModule = createRequire(__filename);

function loadBullMQ(): BullMQModule {
  bullmqModule ??= requireModule('bullmq') as BullMQModule;
  return bullmqModule;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
