import { Scheduler } from './scheduler';
import { JobsError } from './errors';

describe('Scheduler', () => {
  it('round-robins across tenants with equal weight', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 100 });
    s.onEnqueue('j1', 't1');
    s.onEnqueue('j2', 't2');
    s.onEnqueue('j3', 't1');
    s.onEnqueue('j4', 't2');
    const picks = [s.pickNext(), s.pickNext(), s.pickNext(), s.pickNext()].map((p) => p?.tenantId);
    expect(picks).toEqual(['t1', 't2', 't1', 't2']);
  });

  it('applies the tenant weight ratio under balanced supply', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 100 });
    s.setWeight('t1', 3);
    s.setWeight('t2', 1);
    for (let i = 0; i < 100; i++) s.onEnqueue(`t1-${i}`, 't1');
    for (let i = 0; i < 100; i++) s.onEnqueue(`t2-${i}`, 't2');
    const picks: Array<string | undefined> = [];
    for (let i = 0; i < 40; i++) {
      const p = s.pickNext();
      if (!p) break;
      picks.push(p.tenantId);
      s.onAck(p.jobId);
    }
    const t1 = picks.filter((p) => p === 't1').length;
    const t2 = picks.filter((p) => p === 't2').length;
    expect(picks).toHaveLength(40);
    expect(t1 / t2).toBeGreaterThanOrEqual(2.5);
    expect(t1 / t2).toBeLessThanOrEqual(3.5);
  });

  it('stops picking a tenant that hits its cap', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 2 });
    for (let i = 0; i < 5; i++) s.onEnqueue(`j${i}`, 't1');
    const p1 = s.pickNext();
    const p2 = s.pickNext();
    const p3 = s.pickNext();
    expect(p1?.jobId).toBeDefined();
    expect(p2?.jobId).toBeDefined();
    expect(p3).toBeNull();
  });

  it('releases cap on ack so new jobs can be picked', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
    s.onEnqueue('a', 't1');
    s.onEnqueue('b', 't1');
    const first = s.pickNext();
    expect(s.pickNext()).toBeNull();
    s.onAck(first!.jobId);
    expect(s.pickNext()?.jobId).toBe('b');
  });

  it('does not enqueue the same waiting or active job twice', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    s.onEnqueue('a', 't1');
    s.onEnqueue('a', 't1');
    expect(s.snapshot()).toEqual([
      { tenantId: 't1', waiting: 1, inflight: 0, weight: 1, starvationTokens: 0 },
    ]);

    expect(s.pickNext()?.jobId).toBe('a');
    s.onEnqueue('a', 't1');
    expect(s.snapshot()).toEqual([
      { tenantId: 't1', waiting: 0, inflight: 1, weight: 1, starvationTokens: 0 },
    ]);
  });

  it('ack only releases the acknowledged tenant inflight slot', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
    s.onEnqueue('a1', 't1');
    s.onEnqueue('b1', 't2');
    s.onEnqueue('a2', 't1');

    const first = s.pickNext();
    const second = s.pickNext();
    expect(first?.tenantId).toBe('t1');
    expect(second?.tenantId).toBe('t2');

    s.onAck(first!.jobId);

    expect(s.snapshot()).toEqual([
      { tenantId: 't1', waiting: 1, inflight: 0, weight: 1, starvationTokens: 1 },
      { tenantId: 't2', waiting: 0, inflight: 1, weight: 1, starvationTokens: 0 },
    ]);
    expect(s.pickNext()?.jobId).toBe('a2');
  });

  it('resets credits when only waiting tenants are exhausted', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    s.setWeight('t1', 1);
    s.setWeight('t2', 3);
    for (let i = 0; i < 5; i++) s.onEnqueue(`a${i}`, 't1');
    s.onEnqueue('b0', 't2');

    const picks: Array<string | null> = [];
    for (let i = 0; i < 6; i++) {
      const picked = s.pickNext();
      picks.push(picked?.tenantId ?? null);
      if (picked) s.onAck(picked.jobId);
    }

    expect(picks).toEqual(['t1', 't2', 't1', 't1', 't1', 't1']);
  });

  it('enforces minimum share for zero-weight tenants', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0.2, tenantCap: 100 });
    s.setWeight('big', 100);
    s.setWeight('tiny', 0);
    for (let i = 0; i < 50; i++) s.onEnqueue(`b${i}`, 'big');
    for (let i = 0; i < 50; i++) s.onEnqueue(`t${i}`, 'tiny');
    const picks: Array<string | undefined> = [];
    for (let i = 0; i < 20; i++) {
      const p = s.pickNext();
      if (!p) break;
      picks.push(p.tenantId);
      s.onAck(p.jobId);
    }
    const tiny = picks.filter((p) => p === 'tiny').length;
    expect(tiny).toBeGreaterThanOrEqual(Math.floor(20 * 0.2));
  });

  it('maintains the configured minimum share over a long run', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0.1, tenantCap: 1 });
    s.setWeight('big', 1_000);
    s.setWeight('tiny', 0);
    for (let i = 0; i < 1_000; i++) s.onEnqueue(`b${i}`, 'big');
    for (let i = 0; i < 1_000; i++) s.onEnqueue(`t${i}`, 'tiny');

    let tinyPicks = 0;
    for (let i = 0; i < 1_000; i++) {
      const picked = s.pickNext();
      expect(picked).not.toBeNull();
      if (picked?.tenantId === 'tiny') tinyPicks += 1;
      s.onAck(picked!.jobId);
    }

    expect(tinyPicks).toBeGreaterThanOrEqual(100);
  });

  it('uses idle capacity for zero-weight work covered by minimum share', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0.2, tenantCap: 1 });
    s.setWeight('tiny', 0);
    s.onEnqueue('big', 'big');
    s.onEnqueue('tiny', 'tiny');

    const first = s.pickNext();
    expect(first?.tenantId).toBe('big');
    s.onAck(first!.jobId);

    expect(s.pickNext()).toEqual({ jobId: 'tiny', tenantId: 'tiny' });
  });

  it('keeps future work out of WRR until it becomes due', () => {
    let now = new Date('2026-08-19T00:00:00.000Z');
    const s = new Scheduler({
      defaultWeight: 1,
      minSharePct: 0.5,
      tenantCap: 1,
      clock: () => new Date(now),
    });
    s.onEnqueue('future', 'future-tenant', { delayMs: 1_000 });
    s.onEnqueue('future', 'duplicate-tenant');
    s.onEnqueue('ready-1', 'ready-tenant');
    s.onEnqueue('ready-2', 'ready-tenant');

    const first = s.pickNext();
    expect(first).toEqual({ jobId: 'ready-1', tenantId: 'ready-tenant' });
    s.onAck(first!.jobId);
    const second = s.pickNext();
    expect(second).toEqual({ jobId: 'ready-2', tenantId: 'ready-tenant' });
    s.onAck(second!.jobId);
    expect(s.pickNext()).toBeNull();
    expect(s.snapshot().find((shard) => shard.tenantId === 'future-tenant')).toMatchObject({
      waiting: 1,
      starvationTokens: 0,
    });

    now = new Date('2026-08-19T00:00:01.000Z');
    expect(s.pickNext()).toEqual({ jobId: 'future', tenantId: 'future-tenant' });
  });

  it('preserves enqueue order for work with the same future due time', () => {
    let now = new Date('2026-08-19T00:00:00.000Z');
    const s = new Scheduler({
      defaultWeight: 1,
      minSharePct: 0,
      tenantCap: 10,
      clock: () => new Date(now),
    });
    s.onEnqueue('first', 'tenant', { delayMs: 1_000 });
    s.onEnqueue('second', 'tenant', { delayMs: 1_000 });

    now = new Date('2026-08-19T00:00:01.000Z');
    expect(s.pickNext()?.jobId).toBe('first');
    expect(s.pickNext()?.jobId).toBe('second');
  });

  it('promotes future work in due-time order', () => {
    let now = new Date('2026-08-19T00:00:00.000Z');
    const s = new Scheduler({
      defaultWeight: 1,
      minSharePct: 0,
      tenantCap: 10,
      clock: () => new Date(now),
    });
    s.onEnqueue('later', 'tenant', { delayMs: 2_000 });
    s.onEnqueue('earlier', 'tenant', { delayMs: 1_000 });

    now = new Date('2026-08-19T00:00:01.000Z');
    expect(s.pickNext()?.jobId).toBe('earlier');
    expect(s.pickNext()).toBeNull();

    now = new Date('2026-08-19T00:00:02.000Z');
    expect(s.pickNext()?.jobId).toBe('later');
  });

  it('clears stale credits when lowering a tenant weight to zero', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
    s.setWeight('tenant', 1_000);
    s.onEnqueue('first', 'tenant');
    s.onEnqueue('second', 'tenant');
    const first = s.pickNext();
    s.onAck(first!.jobId);

    s.setWeight('tenant', 0);

    expect(s.pickNext()).toBeNull();
  });

  it('releases an inflight slot for the system shard', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
    s.onEnqueue('first', undefined);
    s.onEnqueue('second', undefined);
    const first = s.pickNext();
    s.onAck(first!.jobId);

    expect(s.pickNext()?.jobId).toBe('second');
  });

  it('treats non-finite enqueue delays and invalid dates as immediately ready', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 10 });
    s.onEnqueue('positive-infinity', 'tenant', { delayMs: Number.POSITIVE_INFINITY });
    s.onEnqueue('negative-infinity', 'tenant', { delayMs: Number.NEGATIVE_INFINITY });
    s.onEnqueue('nan', 'tenant', { delayMs: Number.NaN });
    s.onEnqueue('invalid-date', 'tenant', { scheduledFor: new Date(Number.NaN) });

    expect(
      [s.pickNext(), s.pickNext(), s.pickNext(), s.pickNext()].map((pick) => pick?.jobId),
    ).toEqual(['positive-infinity', 'negative-infinity', 'nan', 'invalid-date']);
  });

  it('rejects non-positive defaultWeight', () => {
    expect(() => new Scheduler({ defaultWeight: 0, minSharePct: 0, tenantCap: 1 })).toThrow(
      JobsError,
    );
  });

  it('rejects minSharePct outside [0,1]', () => {
    expect(() => new Scheduler({ defaultWeight: 1, minSharePct: 1.5, tenantCap: 1 })).toThrow(
      JobsError,
    );
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    0.5,
    0,
    -1,
  ])('rejects invalid defaultWeight %p', (defaultWeight) => {
    expect(() => new Scheduler({ defaultWeight, minSharePct: 0, tenantCap: 1 })).toThrow(JobsError);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    0.5,
    0,
    -1,
  ])('rejects invalid tenantCap %p', (tenantCap) => {
    expect(() => new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap })).toThrow(JobsError);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    0.5,
    -1,
  ])('rejects invalid tenant weight %p', (weight) => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
    expect(() => s.setWeight('tenant', weight)).toThrow(JobsError);
  });

  it('allows zero as a runtime tenant weight', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 1 });
    expect(() => s.setWeight('tenant', 0)).not.toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite minSharePct %p',
    (minSharePct) => {
      expect(() => new Scheduler({ defaultWeight: 1, minSharePct, tenantCap: 1 })).toThrow(
        JobsError,
      );
    },
  );
});
