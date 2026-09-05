import type { ExecutionBudget } from './execution-budget';
import { assertIdentifier, assertPositiveInteger } from './enqueue-validation';
import { JobsError, JobsErrorCode } from './errors';

export interface SchedulerOptions {
  defaultWeight: number;
  minSharePct: number;
  tenantCap: number;
  clock?: () => Date;
  typeCap?: number;
  budget?: ExecutionBudget;
}

export interface SchedulerEnqueueTiming {
  scheduledFor?: Date;
  delayMs?: number;
}

interface Shard {
  tenantId: string | undefined;
  waiting: string[];
  deferred: number;
  inflight: number;
  weight: number;
  creditsLeftInCycle: number;
  cyclesSincePick: number;
}

interface DeferredJob {
  jobId: string;
  tenantId: string | undefined;
  dueAt: number;
  sequence: number;
}

export interface PickedJob {
  jobId: string;
  tenantId: string | undefined;
}

export class Scheduler {
  private readonly shards = new Map<string | symbol, Shard>();
  private readonly activeJobs = new Map<string, string | undefined>();
  private readonly waitingJobs = new Set<string>();
  private readonly deferredJobs = new Map<string, DeferredJob>();
  private readonly deferredHeap: DeferredJob[] = [];
  private orderedTenants: Array<string | undefined> = [];
  private readonly system = Symbol('system shard');
  private cursor = 0;
  private deferredSequence = 0;

  constructor(private readonly opts: SchedulerOptions) {
    if (opts.typeCap !== undefined) assertPositiveInteger(opts.typeCap, 'concurrency.typeCap');
    if (!Number.isSafeInteger(opts.defaultWeight) || opts.defaultWeight <= 0) {
      throw new JobsError(
        JobsErrorCode.FairnessMisconfig,
        'defaultWeight must be a positive safe integer',
      );
    }
    if (!Number.isFinite(opts.minSharePct) || opts.minSharePct < 0 || opts.minSharePct > 1) {
      throw new JobsError(JobsErrorCode.FairnessMisconfig, 'minSharePct must be within [0,1]');
    }
    if (!Number.isSafeInteger(opts.tenantCap) || opts.tenantCap <= 0) {
      throw new JobsError(
        JobsErrorCode.FairnessMisconfig,
        'tenantCap must be a positive safe integer',
      );
    }
  }

  setWeight(tenantId: string | undefined, weight: number): void {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new JobsError(
        JobsErrorCode.FairnessMisconfig,
        'weight must be a non-negative safe integer',
      );
    }
    const shard = this.ensureShard(tenantId);
    const creditsConsumed = Math.max(0, shard.weight - shard.creditsLeftInCycle);
    shard.weight = weight;
    shard.creditsLeftInCycle = Math.max(0, weight - creditsConsumed);
  }

  onEnqueue(jobId: string, tenantId: string | undefined, timing?: SchedulerEnqueueTiming): void {
    if (this.waitingJobs.has(jobId) || this.activeJobs.has(jobId)) return;
    const shard = this.ensureShard(tenantId);
    const now = this.nowMs();
    const dueAt = this.resolveDueAt(timing, now);
    if (dueAt !== undefined && dueAt > now) {
      const deferred: DeferredJob = {
        jobId,
        tenantId,
        dueAt,
        sequence: this.deferredSequence++,
      };
      shard.deferred += 1;
      this.waitingJobs.add(jobId);
      this.deferredJobs.set(jobId, deferred);
      this.pushDeferred(deferred);
      return;
    }
    shard.waiting.push(jobId);
    this.waitingJobs.add(jobId);
  }

  onAck(jobId: string): void {
    if (!this.activeJobs.has(jobId)) return;
    const tenantId = this.activeJobs.get(jobId);
    this.activeJobs.delete(jobId);
    this.opts.budget?.release(tenantId);

    const shard = this.shards.get(tenantId ?? this.system);
    if (!shard || shard.inflight === 0) return;
    shard.inflight -= 1;
  }

  hasReadyJobs(): boolean {
    this.promoteDueJobs();
    return [...this.shards.values()].some(
      (shard) =>
        shard.waiting.length > 0 &&
        this.hasCapacity(shard) &&
        (shard.weight > 0 || this.opts.minSharePct > 0),
    );
  }

  pickNext(): PickedJob | null {
    if (this.activeJobs.size >= (this.opts.typeCap ?? Infinity)) return null;
    this.promoteDueJobs();
    if (this.orderedTenants.length === 0) return null;

    for (let attempt = 0; attempt < 2; attempt++) {
      // lap 1 (min-share boost) runs first so starved tenants preempt weight credits.
      // lap 0 (weight-credit WRR) runs second for normal scheduling.
      for (const lap of [1, 0]) {
        for (let i = 0; i < this.orderedTenants.length; i++) {
          const tenantId = this.orderedTenants[(this.cursor + i) % this.orderedTenants.length];
          const shard = this.shards.get(tenantId ?? this.system)!;
          if (!this.canPickFromShard(shard, lap)) continue;
          const picked = this.pickFromShard(shard, i);
          if (picked) return picked;
        }
      }
      if (!this.resetCreditsForSchedulableShards()) break;
    }

    return this.pickFromIdleMinShare();
  }

  private markPicked(tenantId: string | undefined): void {
    for (const shard of this.shards.values()) {
      if (shard.tenantId === tenantId) {
        shard.cyclesSincePick = 0;
      } else if (shard.waiting.length > 0) {
        shard.cyclesSincePick += 1;
      }
    }
  }

  snapshot(): Array<{
    tenantId: string | undefined;
    waiting: number;
    inflight: number;
    weight: number;
    starvationTokens: number;
  }> {
    return [...this.shards.values()].map((s) => ({
      tenantId: s.tenantId,
      waiting: s.waiting.length + s.deferred,
      inflight: s.inflight,
      weight: s.weight,
      starvationTokens: s.cyclesSincePick,
    }));
  }

  private hasCapacity(shard: Shard): boolean {
    return (
      shard.inflight < this.opts.tenantCap && (this.opts.budget?.canAcquire(shard.tenantId) ?? true)
    );
  }

  private canPickFromShard(shard: Shard, lap: number): boolean {
    if (!this.hasCapacity(shard)) return false;
    if (shard.waiting.length === 0) return false;
    if (lap === 0) return shard.creditsLeftInCycle > 0;
    const starved = shard.cyclesSincePick >= this.minShareStarvationThreshold();
    return starved;
  }

  private pickFromShard(shard: Shard, cursorOffset: number): PickedJob | null {
    const jobId = shard.waiting.shift();
    if (jobId === undefined) return null;
    this.waitingJobs.delete(jobId);
    shard.inflight += 1;
    this.opts.budget?.acquire(shard.tenantId);
    shard.creditsLeftInCycle = Math.max(0, shard.creditsLeftInCycle - 1);
    this.activeJobs.set(jobId, shard.tenantId);
    this.markPicked(shard.tenantId);
    this.cursor = (this.cursor + cursorOffset + 1) % this.orderedTenants.length;
    return { jobId, tenantId: shard.tenantId };
  }

  private pickFromIdleMinShare(): PickedJob | null {
    if (this.opts.minSharePct <= 0) return null;
    for (let i = 0; i < this.orderedTenants.length; i++) {
      const tenantId = this.orderedTenants[(this.cursor + i) % this.orderedTenants.length];
      const shard = this.shards.get(tenantId ?? this.system)!;
      if (shard.waiting.length === 0 || !this.hasCapacity(shard)) continue;
      return this.pickFromShard(shard, i);
    }
    return null;
  }

  private minShareStarvationThreshold(): number {
    if (this.opts.minSharePct <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.floor(1 / this.opts.minSharePct) - 1);
  }

  private ensureShard(tenantId: string | undefined): Shard {
    if (tenantId !== undefined) assertIdentifier(tenantId, 'tenantId');
    const existing = this.shards.get(tenantId ?? this.system);
    if (existing) return existing;
    const shard: Shard = {
      tenantId,
      waiting: [],
      deferred: 0,
      inflight: 0,
      weight: this.opts.defaultWeight,
      creditsLeftInCycle: this.opts.defaultWeight,
      cyclesSincePick: 0,
    };
    this.shards.set(tenantId ?? this.system, shard);
    this.orderedTenants.push(tenantId);
    return shard;
  }

  private resetCreditsForSchedulableShards(): boolean {
    const schedulable = [...this.shards.values()].filter(
      (s) => s.waiting.length > 0 && this.hasCapacity(s),
    );
    if (schedulable.length === 0) return false;
    if (schedulable.some((s) => s.creditsLeftInCycle > 0)) return false;
    if (!schedulable.some((s) => s.weight > 0)) return false;

    for (const shard of this.shards.values()) {
      shard.creditsLeftInCycle = shard.weight;
    }
    return true;
  }

  private resolveDueAt(
    timing: SchedulerEnqueueTiming | undefined,
    now: number,
  ): number | undefined {
    if (!timing) return undefined;
    if (timing.scheduledFor !== undefined) {
      const scheduledFor = timing.scheduledFor.getTime();
      return Number.isFinite(scheduledFor) ? scheduledFor : undefined;
    }
    if (timing.delayMs === undefined || !Number.isFinite(timing.delayMs)) return undefined;
    return now + Math.max(0, timing.delayMs);
  }

  private promoteDueJobs(): void {
    const now = this.nowMs();
    while (this.deferredHeap.length > 0 && this.deferredHeap[0].dueAt <= now) {
      const deferred = this.popDeferred();
      if (this.deferredJobs.get(deferred.jobId) !== deferred) continue;
      this.deferredJobs.delete(deferred.jobId);
      const shard = this.shards.get(deferred.tenantId ?? this.system);
      if (!shard) continue;
      shard.deferred = Math.max(0, shard.deferred - 1);
      shard.waiting.push(deferred.jobId);
    }
  }

  private pushDeferred(job: DeferredJob): void {
    this.deferredHeap.push(job);
    let index = this.deferredHeap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.deferredComesBefore(job, this.deferredHeap[parent])) break;
      this.deferredHeap[index] = this.deferredHeap[parent];
      index = parent;
    }
    this.deferredHeap[index] = job;
  }

  private popDeferred(): DeferredJob {
    const first = this.deferredHeap[0];
    const last = this.deferredHeap.pop()!;
    if (this.deferredHeap.length === 0) return first;

    let index = 0;
    while (index < this.deferredHeap.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.deferredHeap.length) break;
      const next =
        right < this.deferredHeap.length &&
        this.deferredComesBefore(this.deferredHeap[right], this.deferredHeap[left])
          ? right
          : left;
      if (!this.deferredComesBefore(this.deferredHeap[next], last)) break;
      this.deferredHeap[index] = this.deferredHeap[next];
      index = next;
    }
    this.deferredHeap[index] = last;
    return first;
  }

  private deferredComesBefore(left: DeferredJob, right: DeferredJob): boolean {
    return (
      left.dueAt < right.dueAt || (left.dueAt === right.dueAt && left.sequence < right.sequence)
    );
  }

  private nowMs(): number {
    return (this.opts.clock?.() ?? new Date()).getTime();
  }
}
