import { randomUUID } from 'node:crypto';
import { detachContext } from '../context-serializer';
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
import { JobsError, JobsErrorCode } from '../errors';
import { snapshotLifecycleValue } from '../lifecycle-observer';

interface Slot {
  envelope: JobEnvelope;
  state: JobStatus;
  identityLineage: IdentityLineage;
  initialScheduledFor?: Date;
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
  ttlMs?: number;
}

interface IdentityLineage {
  idempotencyMapKeys: Set<string>;
  dedupePolicies: Map<string, Omit<DedupeEntry, 'jobId'>>;
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
    const idempotencyMapKey = idempotencyKey
      ? this.scopedIdentityKey(jobType, idempotencyKey)
      : undefined;
    const dedupeKey = this.resolveDedupeKey(context.tenantId, opts);
    const dedupeMapKey = dedupeKey ? this.scopedIdentityKey(jobType, dedupeKey) : undefined;
    const existingJobId = this.findExistingJobId(idempotencyMapKey, dedupeMapKey);
    if (existingJobId) {
      this.backfillIdentityMappings(existingJobId, idempotencyMapKey, dedupeMapKey, opts.dedupe);
      return { status: 'deduped', jobId: existingJobId, existingJobId };
    }

    const id = opts.jobId ?? randomUUID();
    if (opts.jobId) {
      const existingJobType = this.jobTypesById.get(id);
      if (existingJobType && existingJobType !== jobType) {
        throw new JobsError(
          JobsErrorCode.IdentityConflict,
          `job ID ${id} already belongs to ${existingJobType}`,
        );
      }
      if (this.bucketOf(jobType).has(id)) {
        this.backfillIdentityMappings(id, idempotencyMapKey, dedupeMapKey, opts.dedupe);
        return { status: 'deduped', jobId: id, existingJobId: id };
      }
    }
    const enqueuedAt = this.now();
    const scheduledFor = opts.scheduledFor ?? this.resolveScheduledFor(enqueuedAt, opts);
    const state: JobStatus =
      scheduledFor && scheduledFor.getTime() > enqueuedAt.getTime() ? 'delayed' : 'queued';

    this.bucketOf(jobType).set(id, {
      state,
      initialScheduledFor: scheduledFor ? new Date(scheduledFor.getTime()) : undefined,
      identityLineage: this.createIdentityLineage(idempotencyMapKey, dedupeMapKey, opts.dedupe),
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
    if (idempotencyMapKey) this.idempotency.set(idempotencyMapKey, id);
    if (dedupeMapKey) {
      this.dedupe.set(dedupeMapKey, {
        jobId: id,
        mode: opts.dedupe?.mode ?? 'until_completed',
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
    slot.nextAttemptAt = undefined;
    this.recordHistory(jobId, 'active', slot.envelope.attempts);
    return { ...slot.envelope };
  }

  async ack(jobType: string, jobId: string): Promise<JobRecord | void> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (!slot) return;
    slot.state = 'succeeded';
    slot.completedAt = this.now();
    slot.terminalAt = new Date(slot.completedAt.getTime());
    slot.failedAt = undefined;
    slot.nextAttemptAt = undefined;
    slot.envelope.scheduledFor = slot.initialScheduledFor
      ? new Date(slot.initialScheduledFor.getTime())
      : undefined;
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
    slot.terminalAt = slot.failedAt ? new Date(slot.failedAt.getTime()) : undefined;
    slot.nextAttemptAt = undefined;
    slot.envelope.scheduledFor = slot.initialScheduledFor
      ? new Date(slot.initialScheduledFor.getTime())
      : undefined;
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
    slot.terminalAt ??= this.now();
    slot.nextAttemptAt = undefined;
    slot.envelope.scheduledFor = slot.initialScheduledFor
      ? new Date(slot.initialScheduledFor.getTime())
      : undefined;
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

    const replayIdentityJobId = this.findReplayIdentityJob(slot, jobId);
    if (replayIdentityJobId) {
      this.rebindReplayIdentities(slot, jobId, replayIdentityJobId);
      slot.state = 'cancelled';
      this.recordHistory(
        jobId,
        'cancelled',
        slot.envelope.attempts,
        `replayed as ${replayIdentityJobId}`,
      );
      return replayIdentityJobId;
    }

    const newJobId = options.preserveOriginalId ? jobId : randomUUID();
    const replayAttempt = options.resetAttempts === false ? slot.envelope.attempts : 0;
    const replaySlot: Slot = {
      state: 'queued',
      identityLineage: this.cloneIdentityLineage(slot.identityLineage),
      envelope: {
        id: newJobId,
        jobType: slot.envelope.jobType,
        payload: slot.envelope.payload,
        context: slot.envelope.context,
        enqueuedAt: this.now(),
        attempts: replayAttempt,
        maxAttempts: slot.envelope.maxAttempts,
        timeoutMs: slot.envelope.timeoutMs,
        backoff: slot.envelope.backoff,
        metadata: { ...slot.envelope.metadata, ...options.metadata, replayOf: jobId },
        idempotencyKey: slot.envelope.idempotencyKey,
        dedupeKey: slot.envelope.dedupeKey,
      },
    };

    this.bucketOf(slot.envelope.jobType).set(newJobId, replaySlot);
    this.jobTypesById.set(newJobId, slot.envelope.jobType);
    this.rebindReplayIdentities(slot, jobId, newJobId);
    this.recordHistory(newJobId, 'queued', replayAttempt);
    if (newJobId !== jobId) {
      slot.state = 'cancelled';
      this.recordHistory(jobId, 'cancelled', slot.envelope.attempts, `replayed as ${newJobId}`);
    }
    return newJobId;
  }

  async discardDeadLetter(jobId: string, reason = 'discarded'): Promise<void> {
    const slot = this.slotById(jobId);
    if (!slot || slot.state !== 'dead_letter') return;
    slot.state = 'cancelled';
    slot.terminalAt ??= this.now();
    slot.nextAttemptAt = undefined;
    slot.envelope.scheduledFor = slot.initialScheduledFor
      ? new Date(slot.initialScheduledFor.getTime())
      : undefined;
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
    idempotencyMapKey: string | undefined,
    dedupeMapKey: string | undefined,
  ): string | undefined {
    let foundJobId: string | undefined;
    if (idempotencyMapKey) {
      const existing = this.idempotency.get(idempotencyMapKey);
      if (existing && this.slotById(existing)?.state !== 'cancelled') {
        foundJobId = this.mergeIdentityCandidates(foundJobId, existing);
      }
    }
    if (dedupeMapKey) {
      const entry = this.dedupe.get(dedupeMapKey);
      if (entry) {
        const slot = this.slotById(entry.jobId);
        const terminal =
          !slot ||
          slot.state === 'succeeded' ||
          slot.state === 'failed' ||
          slot.state === 'dead_letter' ||
          slot.state === 'cancelled';
        const now = this.now().getTime();
        const terminalExpired =
          terminal &&
          entry.ttlMs !== undefined &&
          !!slot?.terminalAt &&
          slot.terminalAt.getTime() + Math.max(0, entry.ttlMs) <= now;
        if (
          !slot ||
          (entry.mode === 'while_active' && terminal) ||
          (entry.mode === 'until_completed' && terminalExpired)
        ) {
          this.dedupe.delete(dedupeMapKey);
        } else {
          foundJobId = this.mergeIdentityCandidates(foundJobId, entry.jobId);
        }
      }
    }
    return foundJobId;
  }

  private backfillIdentityMappings(
    jobId: string,
    idempotencyMapKey: string | undefined,
    dedupeMapKey: string | undefined,
    dedupe: EnqueueOptions['dedupe'],
  ): void {
    const slot = this.slotById(jobId);
    if (idempotencyMapKey) {
      const mappedJobId = this.idempotency.get(idempotencyMapKey);
      if (!mappedJobId || this.slotById(mappedJobId)?.state === 'cancelled') {
        this.idempotency.set(idempotencyMapKey, jobId);
      }
      if (this.idempotency.get(idempotencyMapKey) === jobId) {
        slot?.identityLineage.idempotencyMapKeys.add(idempotencyMapKey);
      }
    }
    if (dedupeMapKey) {
      let entry = this.dedupe.get(dedupeMapKey);
      if (!entry) {
        entry = {
          jobId,
          mode: dedupe?.mode ?? 'until_completed',
          ttlMs: dedupe?.ttlMs,
        };
        this.dedupe.set(dedupeMapKey, entry);
      }
      if (entry.jobId === jobId) {
        slot?.identityLineage.dedupePolicies.set(dedupeMapKey, {
          mode: entry.mode,
          ttlMs: entry.ttlMs,
        });
      }
    }
  }

  private findReplayIdentityJob(slot: Slot, originalJobId: string): string | undefined {
    let foundJobId: string | undefined;
    for (const mapKey of slot.identityLineage.idempotencyMapKeys) {
      const mappedJobId = this.idempotency.get(mapKey);
      if (mappedJobId && mappedJobId !== originalJobId && this.isLiveReplayTarget(mappedJobId)) {
        foundJobId = this.mergeIdentityCandidates(foundJobId, mappedJobId);
      }
    }

    for (const mapKey of slot.identityLineage.dedupePolicies.keys()) {
      const mappedJobId = this.findExistingJobId(undefined, mapKey);
      if (mappedJobId && mappedJobId !== originalJobId && this.isLiveReplayTarget(mappedJobId)) {
        foundJobId = this.mergeIdentityCandidates(foundJobId, mappedJobId);
      }
    }
    return foundJobId;
  }

  private rebindReplayIdentities(slot: Slot, originalJobId: string, replayJobId: string): void {
    const replaySlot = this.slotById(replayJobId);
    for (const mapKey of slot.identityLineage.idempotencyMapKeys) {
      const mappedJobId = this.idempotency.get(mapKey);
      if (!mappedJobId || mappedJobId === originalJobId || !this.isLiveReplayTarget(mappedJobId)) {
        this.idempotency.set(mapKey, replayJobId);
      }
      if (this.idempotency.get(mapKey) === replayJobId) {
        replaySlot?.identityLineage.idempotencyMapKeys.add(mapKey);
      }
    }
    for (const [mapKey, policy] of slot.identityLineage.dedupePolicies) {
      const mappedJobId = this.dedupe.get(mapKey)?.jobId;
      if (!mappedJobId || mappedJobId === originalJobId || !this.isLiveReplayTarget(mappedJobId)) {
        this.dedupe.set(mapKey, { jobId: replayJobId, ...policy });
      }
      const rebound = this.dedupe.get(mapKey);
      if (rebound?.jobId === replayJobId) {
        replaySlot?.identityLineage.dedupePolicies.set(mapKey, {
          mode: rebound.mode,
          ttlMs: rebound.ttlMs,
        });
      }
    }
  }

  private createIdentityLineage(
    idempotencyMapKey: string | undefined,
    dedupeMapKey: string | undefined,
    dedupe: EnqueueOptions['dedupe'],
  ): IdentityLineage {
    const dedupePolicies = new Map<string, Omit<DedupeEntry, 'jobId'>>();
    if (dedupeMapKey) {
      dedupePolicies.set(dedupeMapKey, {
        mode: dedupe?.mode ?? 'until_completed',
        ttlMs: dedupe?.ttlMs,
      });
    }
    return {
      idempotencyMapKeys: new Set(idempotencyMapKey ? [idempotencyMapKey] : []),
      dedupePolicies,
    };
  }

  private cloneIdentityLineage(lineage: IdentityLineage): IdentityLineage {
    return {
      idempotencyMapKeys: new Set(lineage.idempotencyMapKeys),
      dedupePolicies: new Map(
        [...lineage.dedupePolicies].map(([mapKey, policy]) => [mapKey, { ...policy }]),
      ),
    };
  }

  private isLiveReplayTarget(jobId: string): boolean {
    const target = this.slotById(jobId);
    return !!target && target.state !== 'cancelled';
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

  private resolveDedupeKey(tenantId: unknown, opts: EnqueueOptions): string | undefined {
    if (!opts.dedupe) return undefined;
    const scope = opts.dedupe.scope ?? 'global';
    if (scope === 'tenant') {
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new Error('tenant-scoped dedupe requires a tenantId');
      }
      return JSON.stringify(['tenant', tenantId, opts.dedupe.key]);
    }
    return JSON.stringify(['global', opts.dedupe.key]);
  }

  private scopedIdentityKey(jobType: string, value: string): string {
    return JSON.stringify([jobType, value]);
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
    return snapshotLifecycleValue({
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
    });
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
