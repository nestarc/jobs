import { Scheduler } from './scheduler';
import { JobsError } from './errors';

describe('Scheduler', () => {
  it('round-robins across tenants with equal weight', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 100 });
    s.onEnqueue('j1', 't1');
    s.onEnqueue('j2', 't2');
    s.onEnqueue('j3', 't1');
    s.onEnqueue('j4', 't2');
    const picks = [s.pickNext(), s.pickNext(), s.pickNext(), s.pickNext()]
      .map((p) => p?.tenantId);
    expect(picks).toEqual(['t1', 't2', 't1', 't2']);
  });

  it('respects tenant weight ratio over many picks', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0, tenantCap: 100 });
    s.setWeight('t1', 3);
    s.setWeight('t2', 1);
    for (let i = 0; i < 40; i++) s.onEnqueue(`j-${i}`, i % 2 === 0 ? 't1' : 't2');
    const picks: string[] = [];
    while (true) {
      const p = s.pickNext();
      if (!p) break;
      picks.push(p.tenantId);
      s.onAck(p.jobId);
    }
    const t1 = picks.filter((p) => p === 't1').length;
    const t2 = picks.filter((p) => p === 't2').length;
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

  it('enforces minimum share — a tenant with 0 weight still runs under min share', () => {
    const s = new Scheduler({ defaultWeight: 1, minSharePct: 0.2, tenantCap: 100 });
    s.setWeight('big', 100);
    s.setWeight('tiny', 0);
    for (let i = 0; i < 50; i++) s.onEnqueue(`b${i}`, 'big');
    for (let i = 0; i < 50; i++) s.onEnqueue(`t${i}`, 'tiny');
    const picks: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = s.pickNext();
      if (!p) break;
      picks.push(p.tenantId);
      s.onAck(p.jobId);
    }
    const tiny = picks.filter((p) => p === 'tiny').length;
    expect(tiny).toBeGreaterThanOrEqual(Math.floor(20 * 0.2));
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
});
