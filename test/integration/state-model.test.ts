import { InMemoryBackend, type JobStatus } from '../../src';
function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
}
describe('seeded state-model invariants', () => {
  it.each([1, 7, 19, 41, 97, 20260905])(
    'preserves terminal and attempt monotonicity in trace seed %s',
    async (seed) => {
      const next = random(seed);
      const backend = new InMemoryBackend();
      const jobs: Array<{ id: string; status: JobStatus; attempt: number; token: string }> = [];
      for (let i = 0; i < 20; i++)
        jobs.push({
          id: await backend.enqueue('job', {}, { attempts: 3 }),
          status: 'queued',
          attempt: 0,
          token: '',
        });
      for (let step = 0; step < 500; step++) {
        const model = jobs[next() % jobs.length];
        const op = (next() >>> 16) % 5;
        if (op === 0) {
          const active = await backend.moveToActive('job', model.id);
          if (model.status === 'queued') {
            expect(active).not.toBeNull();
            model.status = 'active';
            model.attempt++;
            model.token = active!.activationId!;
          } else expect(active).toBeNull();
        } else if (op === 1 || op === 2 || op === 4) {
          const token = op === 4 ? 'stale' : model.token;
          const action =
            op === 2
              ? backend.fail('job', model.id, 'business', token)
              : backend.ack('job', model.id, token);
          if (model.status === 'active' && op !== 4) {
            await action;
            model.status = op === 1 ? 'succeeded' : model.attempt < 3 ? 'queued' : 'dead_letter';
          } else await expect(action).rejects.toMatchObject({ code: 'jobs_activation_conflict' });
        } else {
          await backend.markCancelled('job', model.id);
          if (model.status === 'queued' || model.status === 'active') model.status = 'cancelled';
        }
        expect(await backend.getJob(model.id)).toMatchObject({
          status: model.status,
          attempt: model.attempt,
        });
        const history = await backend.getJobHistory(model.id);
        expect(
          history.every(
            (entry, index) => index === 0 || entry.attempt >= history[index - 1].attempt,
          ),
        ).toBe(true);
      }
    },
  );
  it('rejects conflicting composite identities without partially binding a new key', async () => {
    const backend = new InMemoryBackend();
    for (let i = 0; i < 100; i++) {
      const a = await backend.enqueue('job', {}, { idempotencyKey: `a${i}` });
      const b = await backend.enqueue('job', {}, { dedupe: { key: `b${i}` } });
      await expect(
        backend.enqueue('job', {}, { idempotencyKey: `a${i}`, dedupe: { key: `b${i}` } }),
      ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
      expect(
        await backend.enqueue('job', {}, { idempotencyKey: `a${i}`, dedupe: { key: `new${i}` } }),
      ).toBe(a);
      expect(await backend.enqueue('job', {}, { dedupe: { key: `b${i}` } })).toBe(b);
      expect(await backend.enqueue('job', {}, { dedupe: { key: `new${i}` } })).toBe(a);
    }
  });
});
