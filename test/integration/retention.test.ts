import { InMemoryBackend, FakeClock, attachContext } from '../../src';

describe('offline terminal retention', () => {
  it('rejects a retention age shorter than the source recovery horizon', () => {
    expect(
      () => new InMemoryBackend({ retention: { terminalAgeMs: 10, recoveryHorizonMs: 20 } }),
    ).toThrow('recovery horizon');
  });
  it('bounds expired records, history and identity maps while preserving young and replayed ownership', async () => {
    const clock = new FakeClock(0);
    const backend = new InMemoryBackend({
      now: () => clock.now(),
      retention: { terminalAgeMs: 100, recoveryHorizonMs: 100 },
    });
    for (let wave = 0; wave < 3; wave++) {
      for (let i = 0; i < 30; i++) {
        const id = await backend.enqueue('job', attachContext({ value: i }, {}), {
          idempotencyKey: `key-${i}`,
        });
        const active = await backend.moveToActive('job', id);
        await backend.ack('job', id, active!.activationId!);
      }
      expect(await backend.pruneTerminal({ producersStopped: true })).toBe(0);
      clock.advanceBy(100);
      expect(await backend.pruneTerminal({ producersStopped: true })).toBe(30);
      const internal = backend as unknown as {
        history: Map<string, unknown>;
        idempotency: Map<string, unknown>;
        jobTypesById: Map<string, unknown>;
      };
      expect([
        internal.history.size,
        internal.idempotency.size,
        internal.jobTypesById.size,
      ]).toEqual([0, 0, 0]);
    }
    const id = await backend.enqueue('job', {}, { idempotencyKey: 'replay' });
    const active = await backend.moveToActive('job', id);
    await backend.fail('job', id, 'business', active!.activationId!);
    const replay = await backend.replayDeadLetter(id);
    clock.advanceBy(100);
    await backend.pruneTerminal({ producersStopped: true });
    expect(await backend.enqueue('job', {}, { idempotencyKey: 'replay' })).toBe(replay);
  });
});
