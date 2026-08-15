import { randomUUID } from 'node:crypto';
import { attachContext, detachContext } from '../context-serializer';
import type { JobsBackend } from './jobs-backend.interface';
import type { EnqueueOptions, JobEnvelope } from '../types';
import type {
  BackendCapabilities,
  DeadLetterFilter,
  EnqueueResult,
  JobErrorSummary,
  JobHistoryEntry,
  JobRecord,
  JobStatus,
  ReplayOptions,
} from '../lifecycle';
import { computeBackoffDelayMs } from '../retry';

interface Slot {
  envelope: JobEnvelope;
  state: JobStatus;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  nextAttemptAt?: Date;
  error?: JobErrorSummary;
  terminalAt?: Date;
}

interface DedupeEntry {
  jobId: string;
  mode: 'while_active' | 'until_completed';
  activeExpiresAt?: number;
  ttlMs?: number;
}

export interface InMemoryBackendOptions {
  now?: () => Date;
  deadLetter?: { enabled?: boolean };
}

export class InMemoryBackend implements JobsBackend {
  private readonly store = new Map<string, Map<string, Slot>>();
  private readonly jobTypesById = new Map<string, string>();
  private readonly history = new Map<string, JobHistoryEntry[]>();
  private readonly idempotency = new Map<string, string>();
  private readonly dedupe = new Map<string, DedupeEntry>();

  constructor(private readonly opts: InMemoryBackendOptions = {}) {}

  capabilities(): BackendCapabilities {
    return {
      durable: false,
      distributed: false,
      delayed: true,
      retries: true,
      backoff: true,
      timeout: true,
      statusQuery: true,
      history: true,
      idempotency: true,
      deadLetter: true,
      fairness: 'local-tenant',
      manualDrain: true,
    };
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
    const { payload, context } = detachContext(envelope);
    const idempotencyKey = opts.idempotencyKey;
    const dedupeKey = this.resolveDedupeKey(context.tenantId, opts);
    const existingJobId = this.findExistingJobId(idempotencyKey, dedupeKey);
    if (existingJobId) {
      return { status: 'deduped', jobId: existingJobId, existingJobId };
    }

    const id = opts.jobId ?? randomUUID();
    const enqueuedAt = this.now();
    const scheduledFor = opts.scheduledFor ?? this.resolveScheduledFor(enqueuedAt, opts);
    const state: JobStatus =
      scheduledFor && scheduledFor.getTime() > enqueuedAt.getTime() ? 'delayed' : 'queued';

    this.bucketOf(jobType).set(id, {
      state,
      envelope: {
        id,
        jobType,
        payload,
        context,
        enqueuedAt,
        attempts: 0,
        maxAttempts: Math.max(1, opts.attempts ?? 1),
        scheduledFor,
        timeoutMs: opts.timeoutMs,
        backoff: opts.backoff,
        metadata: opts.metadata ?? {},
        idempotencyKey,
        dedupeKey,
      },
    });

    this.jobTypesById.set(id, jobType);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, id);
    if (dedupeKey) {
      this.dedupe.set(dedupeKey, {
        jobId: id,
        mode: opts.dedupe?.mode ?? 'until_completed',
        activeExpiresAt:
          opts.dedupe?.ttlMs === undefined
            ? undefined
            : enqueuedAt.getTime() + Math.max(0, opts.dedupe.ttlMs),
        ttlMs: opts.dedupe?.ttlMs,
      });
    }
    this.recordHistory(id, state, 0);
    return { status: 'created', jobId: id };
  }

  async peekWaiting(jobType: string): Promise<JobEnvelope[]> {
    return [...this.bucketOf(jobType).values()]
      .filter((slot) => this.isWaiting(slot))
      .map((slot) => ({ ...slot.envelope }));
  }

  async moveToActive(jobType: string, jobId: string): Promise<JobEnvelope | null> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (!slot || !this.isWaiting(slot)) return null;
    if (slot.state === 'delayed' && !this.isDue(slot)) return null;
    slot.state = 'active';
    slot.envelope.attempts += 1;
    slot.startedAt = this.now();
    this.recordHistory(jobId, 'active', slot.envelope.attempts);
    return { ...slot.envelope };
  }

  async ack(jobType: string, jobId: string): Promise<JobRecord | void> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (!slot) return;
    slot.state = 'succeeded';
    slot.completedAt = this.now();
    slot.terminalAt = slot.completedAt;
    slot.failedAt = undefined;
    slot.nextAttemptAt = undefined;
    slot.error = undefined;
    this.recordHistory(jobId, 'succeeded', slot.envelope.attempts);
    return this.toRecord(slot);
  }

  async fail(jobType: string, jobId: string, reason: string): Promise<JobRecord | void> {
    const error = reason === 'timeout' ? { message: reason, reason: 'timeout' } : undefined;
    return (await this.markFailed(jobType, jobId, reason, error)) ?? undefined;
  }

  async markFailed(
    jobType: string,
    jobId: string,
    reason: string,
    error?: JobErrorSummary,
  ): Promise<JobRecord | null> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (!slot) return null;
    slot.failedAt = this.now();
    slot.error = error ?? { message: reason };

    const retryDelayMs = computeBackoffDelayMs(slot.envelope.backoff, slot.envelope.attempts);
    if (slot.envelope.attempts < slot.envelope.maxAttempts) {
      const nextAttemptAt = new Date(this.now().getTime() + retryDelayMs);
      slot.nextAttemptAt = nextAttemptAt;
      slot.envelope.scheduledFor = nextAttemptAt;
      slot.state = retryDelayMs > 0 ? 'delayed' : 'queued';
      this.recordHistory(jobId, 'retrying', slot.envelope.attempts, reason, slot.error);
      this.recordHistory(jobId, slot.state, slot.envelope.attempts);
      return this.toRecord(slot);
    }

    slot.state = this.opts.deadLetter?.enabled === false ? 'failed' : 'dead_letter';
    slot.terminalAt = slot.failedAt;
    this.recordHistory(jobId, slot.state, slot.envelope.attempts, reason, slot.error);
    return this.toRecord(slot);
  }

  async markCancelled(
    jobType: string,
    jobId: string,
    reason = 'cancelled',
  ): Promise<JobRecord | null> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (!slot) return null;
    slot.state = 'cancelled';
    slot.terminalAt = this.now();
    this.recordHistory(jobId, 'cancelled', slot.envelope.attempts, reason);
    return this.toRecord(slot);
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const slot = this.slotById(jobId);
    return slot ? this.toRecord(slot) : null;
  }

  async getJobHistory(jobId: string): Promise<JobHistoryEntry[]> {
    return [...(this.history.get(jobId) ?? [])];
  }

  async listDeadLetters(filter: DeadLetterFilter = {}): Promise<JobRecord[]> {
    const records: JobRecord[] = [];
    for (const [jobType, bucket] of this.store.entries()) {
      if (filter.type && filter.type !== jobType) continue;
      for (const slot of bucket.values()) {
        if (slot.state !== 'dead_letter') continue;
        const record = this.toRecord(slot);
        const tenantId = (record.context as { tenantId?: unknown } | undefined)?.tenantId;
        if (filter.tenantId && tenantId !== filter.tenantId) continue;
        records.push(record);
      }
    }
    return records;
  }

  async replayDeadLetter(jobId: string, options: ReplayOptions = {}): Promise<string> {
    const slot = this.slotById(jobId);
    if (!slot || slot.state !== 'dead_letter') {
      throw new Error(`dead-letter job not found: ${jobId}`);
    }
    const newJobId = await this.enqueue(
      slot.envelope.jobType,
      attachContext(slot.envelope.payload as Record<string, unknown>, slot.envelope.context),
      {
        jobId: options.preserveOriginalId ? jobId : undefined,
        context: slot.envelope.context,
        attempts: slot.envelope.maxAttempts,
        backoff: slot.envelope.backoff,
        timeoutMs: slot.envelope.timeoutMs,
        metadata: { ...slot.envelope.metadata, ...options.metadata, replayOf: jobId },
      },
    );
    this.recordHistory(jobId, 'queued', slot.envelope.attempts, 'replayed');
    return newJobId;
  }

  async discardDeadLetter(jobId: string, reason = 'discarded'): Promise<void> {
    const slot = this.slotById(jobId);
    if (!slot || slot.state !== 'dead_letter') return;
    slot.state = 'cancelled';
    slot.terminalAt = this.now();
    this.recordHistory(jobId, 'cancelled', slot.envelope.attempts, reason);
  }

  async close(): Promise<void> {
    this.store.clear();
    this.jobTypesById.clear();
    this.history.clear();
    this.idempotency.clear();
    this.dedupe.clear();
  }

  private bucketOf(jobType: string): Map<string, Slot> {
    let bucket = this.store.get(jobType);
    if (!bucket) {
      bucket = new Map();
      this.store.set(jobType, bucket);
    }
    return bucket;
  }

  private findExistingJobId(
    idempotencyKey: string | undefined,
    dedupeKey: string | undefined,
  ): string | undefined {
    if (idempotencyKey) {
      const existing = this.idempotency.get(idempotencyKey);
      if (existing && this.slotById(existing)?.state !== 'cancelled') return existing;
    }
    if (dedupeKey) {
      const entry = this.dedupe.get(dedupeKey);
      if (entry) {
        const slot = this.slotById(entry.jobId);
        const terminal =
          !slot ||
          slot.state === 'succeeded' ||
          slot.state === 'failed' ||
          slot.state === 'dead_letter' ||
          slot.state === 'cancelled';
        const now = this.now().getTime();
        const activeExpired =
          entry.activeExpiresAt !== undefined && entry.activeExpiresAt <= now;
        const terminalExpired =
          terminal &&
          entry.ttlMs !== undefined &&
          !!slot?.terminalAt &&
          slot.terminalAt.getTime() + Math.max(0, entry.ttlMs) <= now;
        if (
          !slot ||
          (entry.mode === 'while_active' && (terminal || activeExpired)) ||
          (entry.mode === 'until_completed' && terminalExpired)
        ) {
          this.dedupe.delete(dedupeKey);
        } else {
          return entry.jobId;
        }
      }
    }
    return undefined;
  }

  private resolveDedupeKey(tenantId: unknown, opts: EnqueueOptions): string | undefined {
    if (!opts.dedupe) return undefined;
    const scope = opts.dedupe.scope ?? 'global';
    if (scope === 'tenant') {
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new Error('tenant-scoped dedupe requires a tenantId');
      }
      return `tenant:${tenantId}:${opts.dedupe.key}`;
    }
    return `global:${opts.dedupe.key}`;
  }

  private resolveScheduledFor(now: Date, opts: EnqueueOptions): Date | undefined {
    const delayMs = opts.delayMs ?? opts.delay;
    return delayMs && delayMs > 0 ? new Date(now.getTime() + delayMs) : undefined;
  }

  private isWaiting(slot: Slot): boolean {
    if (slot.state === 'queued') return true;
    return slot.state === 'delayed' && this.isDue(slot);
  }

  private isDue(slot: Slot): boolean {
    return (
      !slot.envelope.scheduledFor || slot.envelope.scheduledFor.getTime() <= this.now().getTime()
    );
  }

  private slotById(jobId: string): Slot | null {
    const jobType = this.jobTypesById.get(jobId);
    if (!jobType) return null;
    return this.bucketOf(jobType).get(jobId) ?? null;
  }

  private toRecord(slot: Slot): JobRecord {
    return {
      id: slot.envelope.id,
      type: slot.envelope.jobType,
      status: slot.state,
      payload: slot.envelope.payload,
      context: slot.envelope.context,
      attempt: slot.envelope.attempts,
      maxAttempts: slot.envelope.maxAttempts,
      enqueuedAt: slot.envelope.enqueuedAt,
      scheduledFor: slot.envelope.scheduledFor,
      startedAt: slot.startedAt,
      completedAt: slot.completedAt,
      failedAt: slot.failedAt,
      nextAttemptAt: slot.nextAttemptAt,
      error: slot.error,
      idempotencyKey: slot.envelope.idempotencyKey,
      dedupeKey: slot.envelope.dedupeKey,
      metadata: slot.envelope.metadata,
    };
  }

  private recordHistory(
    jobId: string,
    status: JobStatus,
    attempt: number,
    reason?: string,
    error?: JobErrorSummary,
  ): void {
    const entries = this.history.get(jobId) ?? [];
    entries.push({ jobId, status, attempt, at: this.now(), reason, error });
    this.history.set(jobId, entries);
  }

  private now(): Date {
    return new Date(this.opts.now?.() ?? new Date());
  }
}
