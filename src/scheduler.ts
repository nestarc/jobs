import { JobsError, JobsErrorCode } from './errors';

export interface SchedulerOptions {
  defaultWeight: number;
  minSharePct: number;
  tenantCap: number;
}

interface Shard {
  tenantId: string;
  waiting: string[];
  inflight: number;
  weight: number;
  creditsLeftInCycle: number;
  cyclesSincePick: number;
}

export interface PickedJob {
  jobId: string;
  tenantId: string;
}

export class Scheduler {
  private readonly shards = new Map<string, Shard>();
  private readonly activeJobs = new Map<string, string>();
  private orderedTenants: string[] = [];
  private cursor = 0;

  constructor(private readonly opts: SchedulerOptions) {
    if (opts.defaultWeight <= 0) {
      throw new JobsError(JobsErrorCode.FairnessMisconfig, 'defaultWeight must be > 0');
    }
    if (opts.minSharePct < 0 || opts.minSharePct > 1) {
      throw new JobsError(JobsErrorCode.FairnessMisconfig, 'minSharePct must be within [0,1]');
    }
  }

  setWeight(tenantId: string, weight: number): void {
    const shard = this.ensureShard(tenantId);
    shard.weight = Math.max(0, weight);
  }

  onEnqueue(jobId: string, tenantId: string): void {
    const shard = this.ensureShard(tenantId);
    shard.waiting.push(jobId);
  }

  onAck(jobId: string): void {
    const tenantId = this.activeJobs.get(jobId);
    if (!tenantId) return;
    this.activeJobs.delete(jobId);

    const shard = this.shards.get(tenantId);
    if (!shard || shard.inflight === 0) return;
    shard.inflight -= 1;
  }

  pickNext(): PickedJob | null {
    if (this.orderedTenants.length === 0) return null;

    for (let attempt = 0; attempt < 2; attempt++) {
      // lap 1 (min-share boost) runs first so starved tenants preempt weight credits.
      // lap 0 (weight-credit WRR) runs second for normal scheduling.
      for (const lap of [1, 0]) {
        for (let i = 0; i < this.orderedTenants.length; i++) {
          const tenantId = this.orderedTenants[(this.cursor + i) % this.orderedTenants.length];
          const shard = this.shards.get(tenantId)!;
          if (!this.canPickFromShard(shard, lap)) continue;
          const jobId = shard.waiting.shift();
          if (!jobId) continue;
          shard.inflight += 1;
          shard.creditsLeftInCycle = Math.max(0, shard.creditsLeftInCycle - 1);
          this.activeJobs.set(jobId, tenantId);
          this.markPicked(tenantId);
          this.cursor = (this.cursor + i + 1) % this.orderedTenants.length;
          return { jobId, tenantId };
        }
      }
      if (!this.resetCreditsForSchedulableShards()) return null;
    }

    return null;
  }

  private markPicked(tenantId: string): void {
    for (const shard of this.shards.values()) {
      if (shard.tenantId === tenantId) {
        shard.cyclesSincePick = 0;
      } else {
        shard.cyclesSincePick += 1;
      }
    }
  }

  snapshot(): Array<{ tenantId: string; waiting: number; inflight: number; weight: number; starvationTokens: number }> {
    return [...this.shards.values()].map((s) => ({
      tenantId: s.tenantId,
      waiting: s.waiting.length,
      inflight: s.inflight,
      weight: s.weight,
      starvationTokens: s.cyclesSincePick,
    }));
  }

  private canPickFromShard(shard: Shard, lap: number): boolean {
    if (shard.inflight >= this.opts.tenantCap) return false;
    if (shard.waiting.length === 0) return false;
    if (lap === 0) return shard.creditsLeftInCycle > 0;
    const starved = shard.cyclesSincePick >= this.minShareStarvationThreshold();
    return starved;
  }

  private minShareStarvationThreshold(): number {
    if (this.opts.minSharePct <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.floor(1 / this.opts.minSharePct));
  }

  private ensureShard(tenantId: string): Shard {
    const existing = this.shards.get(tenantId);
    if (existing) return existing;
    const shard: Shard = {
      tenantId,
      waiting: [],
      inflight: 0,
      weight: this.opts.defaultWeight,
      creditsLeftInCycle: this.opts.defaultWeight,
      cyclesSincePick: 0,
    };
    this.shards.set(tenantId, shard);
    this.orderedTenants.push(tenantId);
    return shard;
  }

  private resetCreditsForSchedulableShards(): boolean {
    const schedulable = [...this.shards.values()].filter(
      (s) => s.waiting.length > 0 && s.inflight < this.opts.tenantCap,
    );
    if (schedulable.length === 0) return false;
    if (schedulable.some((s) => s.creditsLeftInCycle > 0)) return false;
    if (!schedulable.some((s) => s.weight > 0)) return false;

    for (const shard of this.shards.values()) {
      shard.creditsLeftInCycle = shard.weight;
    }
    return true;
  }
}
