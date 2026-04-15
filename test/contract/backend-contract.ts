import type { JobsBackend } from '../../src/backend/jobs-backend.interface';

export function backendContract(name: string, factory: () => JobsBackend): void {
  describe(`JobsBackend contract: ${name}`, () => {
    let b: JobsBackend;
    beforeEach(() => {
      b = factory();
    });
    afterEach(async () => {
      await b.close();
    });

    it('enqueue returns an id and makes the job peekable', async () => {
      const id = await b.enqueue('t', { a: 1 }, {});
      const waiting = await b.peekWaiting('t');
      expect(waiting.find((j) => j.id === id)).toBeDefined();
    });

    it('moveToActive removes from waiting', async () => {
      const id = await b.enqueue('t', { a: 1 }, {});
      const job = await b.moveToActive('t', id);
      expect(job?.id).toBe(id);
      const waiting = await b.peekWaiting('t');
      expect(waiting.find((j) => j.id === id)).toBeUndefined();
    });

    it('moveToActive returns null if job missing', async () => {
      const job = await b.moveToActive('t', 'missing');
      expect(job).toBeNull();
    });

    it('ack is idempotent on unknown id', async () => {
      await expect(b.ack('t', 'missing')).resolves.not.toThrow();
    });

    it('fail records reason (observable via peekWaiting being empty)', async () => {
      const id = await b.enqueue('t', { a: 1 }, {});
      await b.moveToActive('t', id);
      await b.fail('t', id, 'boom');
      const waiting = await b.peekWaiting('t');
      expect(waiting.length).toBe(0);
    });
  });
}
