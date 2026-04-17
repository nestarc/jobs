/**
 * jobs benchmark — measures queue overhead and validates weighted tenant fairness.
 *
 * Scenarios:
 *   A) Baseline: direct async function call (no queue) — the floor you're replacing
 *   B) enqueue() overhead — per-call cost, no drain
 *   C) enqueue + drain, 1 job — end-to-end latency
 *   D) Throughput: 10,000 jobs, 1 tenant (FIFO) — fairness-scheduler minimum cost
 *   E) Throughput: 10,000 jobs, 100 tenants equal weight — fairness overhead
 *   F) Fairness correctness: N jobs, 3 tenants at weights 3:2:1 —
 *      actual dispatch ratio must be within FAIRNESS_TOLERANCE of expected
 *
 * Key measurement: F validates the package's central claim (weighted tenant
 * fairness). The observed dispatch counts for tenants a/b/c (weight 3/2/1)
 * should land within ±10% of the ideal 50/33/17 split across N jobs. If
 * scheduler state drifts, this test catches it.
 *
 * Usage:
 *   npx ts-node bench/jobs.bench.ts
 *   npx ts-node bench/jobs.bench.ts --iterations 20000
 */
import { FakeJobsService } from '../src/fake-jobs.service';

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const ITERATIONS = Number(flag('iterations', '10000'));
const WARMUP = Number(flag('warmup', '1000'));
// Throughput scenarios use a separate, smaller job count because Array.shift()
// on a single-tenant waiting queue is O(N), so 10k single-tenant jobs hit an
// artifactual O(N²) wall that muddies interpretation. Keeping it at 5k jobs
// per scenario gives stable numbers and still shows the fairness cost vs FIFO.
const THROUGHPUT_JOBS = Number(flag('throughput-jobs', '5000'));
const FAIRNESS_JOBS = Number(flag('fairness-jobs', '6000'));
const FAIRNESS_TOLERANCE = Number(flag('fairness-tolerance', '0.10')); // ±10%

// ── Stats ─────────────────────────────────────────────────────────────
interface Stats { avg: number; p50: number; p95: number; p99: number }

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(1)}µs` : `${ms.toFixed(3)}ms`;
}

function printStats(label: string, stats: Stats): void {
  console.log(
    `  ${label.padEnd(56)} Avg ${fmt(stats.avg).padStart(9)}  P50 ${fmt(stats.p50).padStart(9)}  P95 ${fmt(stats.p95).padStart(9)}  P99 ${fmt(stats.p99).padStart(9)}`,
  );
}

async function measure(
  label: string,
  fn: (i: number) => Promise<void>,
  iters = ITERATIONS,
  warmup = WARMUP,
): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn(iters + i);
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    await fn(i);
    samples.push(performance.now() - start);
  }
  const stats = computeStats(samples);
  printStats(label, stats);
  return stats;
}

// ── Main ──────────────────────────────────────────────────────────────
async function run() {
  console.log(`\njobs Benchmark`);
  console.log(`  iterations: ${ITERATIONS}, warmup: ${WARMUP}, fairness-jobs: ${FAIRNESS_JOBS}\n`);

  // ── A) Baseline: direct async call ─────────────────────────────
  let directCalls = 0;
  const directHandler = async (payload: { i: number }) => {
    directCalls += payload.i & 1 ? 1 : 0; // pretend to do something
  };
  const baselineStats = await measure(
    'A) Baseline: direct async function call',
    async (i) => {
      await directHandler({ i });
    },
  );

  // ── B) enqueue() only ──────────────────────────────────────────
  const enqueueOnly = new FakeJobsService({
    jobTypes: ['bench'],
    tenantCap: 1000,
  });
  // Register a no-op handler so enqueued jobs don't error later.
  enqueueOnly.registry.register('bench', async () => undefined);
  const enqueueStats = await measure(
    'B) enqueue() — no drain',
    async (i) => {
      await enqueueOnly.service.enqueue('bench', { i }, { context: { tenantId: 'single' } });
    },
  );

  // ── C) enqueue + drain, 1 job ──────────────────────────────────
  const latencyBed = new FakeJobsService({
    jobTypes: ['bench'],
    tenantCap: 1000,
  });
  latencyBed.registry.register('bench', async () => undefined);
  const e2eStats = await measure(
    'C) enqueue + drain, 1 job — end-to-end latency',
    async (i) => {
      await latencyBed.service.enqueue('bench', { i }, { context: { tenantId: 'single' } });
      await latencyBed.drain();
    },
  );

  // ── D) Throughput: 10k jobs, 1 tenant (FIFO) ──────────────────
  const singleTenantBed = new FakeJobsService({
    jobTypes: ['bench'],
    tenantCap: 1000,
  });
  let handledSingle = 0;
  singleTenantBed.registry.register('bench', async () => {
    handledSingle += 1;
  });
  const singleStart = performance.now();
  for (let i = 0; i < THROUGHPUT_JOBS; i++) {
    await singleTenantBed.service.enqueue('bench', { i }, { context: { tenantId: 'single' } });
  }
  await singleTenantBed.drain(THROUGHPUT_JOBS * 2);
  const singleDuration = performance.now() - singleStart;
  console.log(`  D) Throughput: ${THROUGHPUT_JOBS} jobs, 1 tenant              ${singleDuration.toFixed(1)}ms total  (${((THROUGHPUT_JOBS * 1000) / singleDuration).toFixed(0)} jobs/sec)`);
  if (handledSingle !== THROUGHPUT_JOBS) {
    console.error(`\n  ✗ FAIL — expected ${THROUGHPUT_JOBS} handled, got ${handledSingle}`);
    process.exit(1);
  }

  // ── E) Throughput: 10k jobs, 100 tenants ──────────────────────
  const multiTenantBed = new FakeJobsService({
    jobTypes: ['bench'],
    tenantCap: 1000,
  });
  let handledMulti = 0;
  multiTenantBed.registry.register('bench', async () => {
    handledMulti += 1;
  });
  const multiStart = performance.now();
  for (let i = 0; i < THROUGHPUT_JOBS; i++) {
    const tenantId = `t-${i % 100}`;
    await multiTenantBed.service.enqueue('bench', { i }, { context: { tenantId } });
  }
  await multiTenantBed.drain(THROUGHPUT_JOBS * 2);
  const multiDuration = performance.now() - multiStart;
  console.log(`  E) Throughput: ${THROUGHPUT_JOBS} jobs, 100 tenants equal weight  ${multiDuration.toFixed(1)}ms total  (${((THROUGHPUT_JOBS * 1000) / multiDuration).toFixed(0)} jobs/sec)`);
  if (handledMulti !== THROUGHPUT_JOBS) {
    console.error(`\n  ✗ FAIL — expected ${THROUGHPUT_JOBS} handled, got ${handledMulti}`);
    process.exit(1);
  }

  // ── F) Fairness correctness: 3 tenants at weights 3:2:1 ────────
  const fairnessBed = new FakeJobsService({
    jobTypes: ['bench'],
    tenantCap: 1000,
    defaultWeight: 1,
    minSharePct: 0,
  });
  fairnessBed.service.setTenantWeight('bench', 'a', 3);
  fairnessBed.service.setTenantWeight('bench', 'b', 2);
  fairnessBed.service.setTenantWeight('bench', 'c', 1);

  const dispatchOrder: string[] = [];
  fairnessBed.registry.register('bench', async (payload) => {
    dispatchOrder.push(payload.tenant as string);
  });

  // Enqueue equal counts for a/b/c to see if fair scheduler weights the dispatch.
  const perTenant = Math.floor(FAIRNESS_JOBS / 3);
  for (let i = 0; i < perTenant; i++) {
    await fairnessBed.service.enqueue('bench', { tenant: 'a' }, { context: { tenantId: 'a' } });
    await fairnessBed.service.enqueue('bench', { tenant: 'b' }, { context: { tenantId: 'b' } });
    await fairnessBed.service.enqueue('bench', { tenant: 'c' }, { context: { tenantId: 'c' } });
  }
  await fairnessBed.drain(FAIRNESS_JOBS * 2);

  const counts = { a: 0, b: 0, c: 0 };
  for (const t of dispatchOrder) counts[t as 'a' | 'b' | 'c'] += 1;

  // Final counts will be equal (everyone drains eventually). What we measure is
  // the dispatch ORDER across the FIRST portion — that's where weights matter.
  // Look at the first (perTenant * 3 / 2) dispatches: during that prefix, every
  // tenant still has work available, so weighted dispatch should dominate.
  const sampleSize = Math.floor(dispatchOrder.length / 2);
  const prefix = dispatchOrder.slice(0, sampleSize);
  const prefixCounts = { a: 0, b: 0, c: 0 };
  for (const t of prefix) prefixCounts[t as 'a' | 'b' | 'c'] += 1;

  const totalWeight = 3 + 2 + 1;
  const expected = {
    a: (3 / totalWeight) * sampleSize,
    b: (2 / totalWeight) * sampleSize,
    c: (1 / totalWeight) * sampleSize,
  };
  const ratio = {
    a: prefixCounts.a / sampleSize,
    b: prefixCounts.b / sampleSize,
    c: prefixCounts.c / sampleSize,
  };
  const expectedRatio = {
    a: 3 / totalWeight,
    b: 2 / totalWeight,
    c: 1 / totalWeight,
  };

  console.log('\n  Fairness correctness (F)');
  console.log(`  ──────────────────────────────────────────────────────`);
  console.log(`  Setup: 3 tenants with weights a=3, b=2, c=1; ${perTenant} jobs each.`);
  console.log(`  Sampling first ${sampleSize} dispatches (contested window).`);
  console.log(`  Expected ratios:  a=${expectedRatio.a.toFixed(3)}  b=${expectedRatio.b.toFixed(3)}  c=${expectedRatio.c.toFixed(3)}`);
  console.log(`  Observed ratios:  a=${ratio.a.toFixed(3)}  b=${ratio.b.toFixed(3)}  c=${ratio.c.toFixed(3)}`);
  console.log(`  Observed counts:  a=${prefixCounts.a}  b=${prefixCounts.b}  c=${prefixCounts.c}`);
  console.log(`  Expected counts:  a=${expected.a.toFixed(0)}  b=${expected.b.toFixed(0)}  c=${expected.c.toFixed(0)}`);
  console.log(`  Tolerance:        ±${(FAIRNESS_TOLERANCE * 100).toFixed(0)}%`);

  const deviations = {
    a: Math.abs(ratio.a - expectedRatio.a) / expectedRatio.a,
    b: Math.abs(ratio.b - expectedRatio.b) / expectedRatio.b,
    c: Math.abs(ratio.c - expectedRatio.c) / expectedRatio.c,
  };
  const worstDeviation = Math.max(deviations.a, deviations.b, deviations.c);
  console.log(`  Worst deviation:  ${(worstDeviation * 100).toFixed(1)}%`);

  if (worstDeviation > FAIRNESS_TOLERANCE) {
    console.error(`\n  ✗ FAIL — dispatch ratios deviate from weights by more than ±${(FAIRNESS_TOLERANCE * 100).toFixed(0)}%.`);
    console.error(`       Per-tenant deviations: a=${(deviations.a * 100).toFixed(1)}%  b=${(deviations.b * 100).toFixed(1)}%  c=${(deviations.c * 100).toFixed(1)}%`);
    process.exit(1);
  }
  console.log(`  ✓ PASS — all tenant dispatch ratios are within ±${(FAIRNESS_TOLERANCE * 100).toFixed(0)}% of weight-ideal.`);

  // ── Summary ────────────────────────────────────────────────────
  console.log('\n  Summary');
  console.log(`  ──────────────────────────────────────────────────────`);
  const queueOverhead = enqueueStats.avg - baselineStats.avg;
  const e2eOverhead = e2eStats.avg - baselineStats.avg;
  console.log(`  Queue enqueue overhead (B − A):                   ~${fmt(queueOverhead)}  (vs ${fmt(baselineStats.avg)} direct call)`);
  console.log(`  End-to-end latency (C, avg):                      ~${fmt(e2eStats.avg)}`);
  console.log(`  End-to-end overhead (C − A):                      ~${fmt(e2eOverhead)}`);
  console.log(`  Single-tenant throughput (D, ${THROUGHPUT_JOBS} jobs):           ~${((THROUGHPUT_JOBS * 1000) / singleDuration).toFixed(0)} jobs/sec`);
  console.log(`  100-tenant fair throughput (E, ${THROUGHPUT_JOBS} jobs):         ~${((THROUGHPUT_JOBS * 1000) / multiDuration).toFixed(0)} jobs/sec  (${((multiDuration / singleDuration - 1) * 100).toFixed(1)}% vs D)`);
  console.log(`  Note: single-queue throughput degrades super-linearly for very`);
  console.log(`  large waiting queues (Array.shift() is O(N)). Partition across`);
  console.log(`  tenants or use BullMQ backend for bulk ingest workloads.`);

  // Keep a reference to directCalls so the compiler doesn't DCE baseline work.
  if (directCalls < 0) console.log('unreachable', directCalls);

  console.log('\nDone.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
