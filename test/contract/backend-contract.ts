import type { JobsBackend } from '../../src/backend/jobs-backend.interface';

export function backendContract(name: string, factory: () => JobsBackend): void {
  describe(`JobsBackend contract: ${name}`, () => {
    let b: JobsBackend;
    let cleanup: (() => Promise<unknown>) | undefined;
    beforeEach(() => {
      b = factory();
      cleanup = undefined;
    });
    afterEach(async () => {
      await cleanup?.();
      await b.close();
    });

    it('enqueue returns an id and makes the job peekable', async () => {
      const id = await b.enqueue('t', { a: 1 }, {});
      cleanup = async () => {
        const active = await b.moveToActive('t', id);
        if (active) await b.ack('t', id, active.activationId!);
      };
      const waiting = await b.peekWaiting('t');
      expect(waiting.find((j) => j.id === id)).toBeDefined();
    });

    it('moveToActive removes from waiting', async () => {
      const id = await b.enqueue('t', { a: 1 }, {});
      cleanup = async () => {
        const active = await b.moveToActive('t', id);
        if (active) await b.ack('t', id, active.activationId!);
      };
      const job = await b.moveToActive('t', id);
      cleanup = () => b.ack('t', id, job!.activationId!);
      expect(job?.id).toBe(id);
      const waiting = await b.peekWaiting('t');
      expect(waiting.find((j) => j.id === id)).toBeUndefined();
    });

    it('moveToActive returns null if job missing', async () => {
      const job = await b.moveToActive('t', 'missing');
      expect(job).toBeNull();
    });

    it('ack rejects an unknown activation', async () => {
      await expect(b.ack('t', 'missing', 'missing')).rejects.toMatchObject({
        code: 'jobs_activation_conflict',
      });
    });

    it('fail records reason (observable via peekWaiting being empty)', async () => {
      const id = await b.enqueue('t', { a: 1 }, {});
      cleanup = async () => {
        const active = await b.moveToActive('t', id);
        if (active) await b.ack('t', id, active.activationId!);
      };
      const activation = await b.moveToActive('t', id);
      await b.fail('t', id, 'boom', activation!.activationId!);
      const waiting = await b.peekWaiting('t');
      expect(waiting.length).toBe(0);
    });
  });
}
