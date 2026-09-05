import type Redis from 'ioredis';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { BullMQBackend, HandlerRegistry, JobsModule, JobsService } from '../../src';

const url = new URL(process.env.REDIS_URL ?? 'redis://missing');
const connection = { host: url.hostname, port: Number(url.port) };
async function eventually(fn: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fn();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe('maintenance Redis contracts', () => {
  beforeAll(() => {
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL required');
  });
  it('a separate producer process never consumes jobs intended for a worker app', async () => {
    const namespace = `role-${randomUUID()}`;
    const backend = new BullMQBackend({ namespace, connection });
    backend.registerJobTypes(['role']);
    const queue = backend.getRawQueue<Queue>('role');
    const child = fork(path.resolve('test/fixtures/redis-producer.cjs'), {
      env: { ...process.env, JOBS_NAMESPACE: namespace },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const app = await Test.createTestingModule({
      imports: [JobsModule.forBullMQ({ backend, jobTypes: ['role'], role: 'worker' })],
    }).compile();
    const handler = jest.fn(async () => undefined);
    app.get(HandlerRegistry).register('role', handler);
    try {
      const [message] = (await once(child, 'message')) as [{ id?: string; error?: string }];
      if (message.error) throw new Error(message.error);
      const id = message.id!;
      expect(await queue.getWorkers()).toHaveLength(0);
      expect(await backend.getJob(id)).toMatchObject({ status: 'queued', attempt: 0 });
      await app.init();
      await expect(app.get(JobsService).enqueue('role', {})).rejects.toMatchObject({
        code: 'jobs_capability_unsupported',
      });
      await eventually(async () => {
        expect((await backend.getJob(id))?.status).toBe('succeeded');
      });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      if (child.connected) {
        const exited = once(child, 'exit');
        child.send('close');
        await exited;
      }
      await queue.obliterate({ force: true });
      await app.close();
    }
  });
  it('prunes expired terminal records and identity keys while retaining fresh identity acknowledgement', async () => {
    const namespace = `retention-${randomUUID()}`;
    const backend = new BullMQBackend({
      namespace,
      connection,
      retention: { terminalAgeMs: 100, recoveryHorizonMs: 100 },
    });
    backend.registerJobTypes(['job']);
    const queue = backend.getRawQueue<Queue>('job');
    const registry = new HandlerRegistry();
    registry.register('job', async () => undefined);
    backend.startConsumer(['job'], { registry, contextRunner: async (_ctx, fn) => fn() });
    try {
      const ids = [];
      for (let i = 0; i < 30; i++)
        ids.push(
          await backend.enqueue(
            'job',
            { value: i },
            { idempotencyKey: `key-${i}`, dedupe: { key: `dedupe-${i}` } },
          ),
        );
      await eventually(async () => {
        expect(await queue.getCompletedCount()).toBe(30);
      });
      await queue.pause();
      await eventually(async () => {
        expect(await queue.getActiveCount()).toBe(0);
      });
      const client = (await queue.client) as unknown as Redis;
      // Explicitly age only this fixture's terminal records; avoid clock-dependent sleeps.
      for (const id of ids) await client.hset(queue.toKey(id), 'finishedOn', Date.now() - 200);
      expect(await backend.pruneTerminal({ producersStopped: true })).toBe(30);
      expect(await queue.getCompletedCount()).toBe(0);
      for (const id of ids) expect(await backend.getJob(id)).toBeNull();
      let cursor = '0';
      const keys: string[] = [];
      do {
        const page = await client.scan(cursor, 'MATCH', `*${namespace}*`, 'COUNT', 200);
        cursor = page[0];
        keys.push(...page[1]);
      } while (cursor !== '0');
      expect(keys.filter((key) => key.includes(':nestarc:identity:'))).toEqual([]);
      const next = await backend.enqueue('job', {}, { idempotencyKey: 'fresh' });
      expect(await backend.enqueue('job', {}, { idempotencyKey: 'fresh' })).toBe(next);
      expect(await backend.pruneTerminal({ producersStopped: true })).toBe(0);
    } finally {
      await queue.obliterate({ force: true });
      await backend.close();
    }
  });
});
