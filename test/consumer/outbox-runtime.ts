import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import * as outboxApi from '@nestarc/outbox';
import { OutboxEmitter, OutboxEvent, OutboxModule } from '@nestarc/outbox';
import {
  BullMQBackend,
  createOutboxJobsPublisher,
  HandlerRegistry,
  JobsModule,
  JobsService,
  type OutboxRecord,
} from '@nestarc/jobs';
import { PrismaClient } from './generated/client';

// Only disposable loopback fixtures are accepted. Every run owns a fresh schema
// and Redis namespace; no shared tables or queues are truncated or flushed.
function fixtureUrl(name: string, protocols: string[], database?: string): URL {
  const url = new URL(process.env[name] ?? '');
  assert(protocols.includes(url.protocol), `${name}: protocol`);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${name}: loopback required`);
  if (database) assert.equal(url.pathname, `/${database}`, `${name}: test database required`);
  return url;
}
const database = fixtureUrl(
  'JOBS_OUTBOX_DATABASE_URL',
  ['postgres:', 'postgresql:'],
  'jobs_outbox_test',
);
const redis = fixtureUrl('JOBS_OUTBOX_REDIS_URL', ['redis:']);
const schema = process.env.JOBS_OUTBOX_SCHEMA ?? `jobs_outbox_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^jobs_outbox_[a-f0-9]{32}$/);
const namespace = process.env.JOBS_OUTBOX_NAMESPACE ?? `p0-${randomUUID()}`;
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: database.href,
    options: `-c search_path=${schema},public`,
  }),
});
const emitter = new OutboxEmitter({ prisma });
const connection = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  maxRetriesPerRequest: null,
};
const backend = () => new BullMQBackend({ namespace, connection });
const stopToken = (
  outboxApi as unknown as {
    OutboxPoller?: new (...args: never[]) => {
      stop(options?: { timeoutMs?: number }): Promise<void>;
    };
  }
).OutboxPoller;

class Work extends OutboxEvent {
  static readonly eventType = 'p0.work';
  constructor(
    public readonly key: string,
    public readonly mode = 'normal',
  ) {
    super();
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(20);
  }
  throw new Error(`Timeout: ${label}`);
}

type Row = { id: string; status: string; retry_count: number; tenant_id: string };
async function rows(key: string): Promise<Row[]> {
  return prisma.$queryRaw<
    Row[]
  >`SELECT id, status, retry_count, tenant_id FROM outbox_events WHERE payload->>'key' = ${key} ORDER BY tenant_id`;
}
async function emit(key: string, tenant = 'A', mode = 'normal'): Promise<Row> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO commands (key, tenant) VALUES (${key}, ${tenant})`;
    await emitter.emit(tx, new Work(key, mode), {
      tenantId: tenant,
      correlationId: `trace-${key}`,
      causationId: `command-${key}`,
    });
  });
  return (await rows(key)).find((row) => row.tenant_id === tenant)!;
}

async function relay(
  afterPublish?: (record: OutboxRecord) => Promise<void>,
): Promise<TestingModule> {
  const Base = createOutboxJobsPublisher({
    map: {
      'p0.work': {
        job: 'work',
        options: (record) => ({
          dedupe: { key: String(record.payload.key), mode: 'until_completed' },
        }),
      },
    },
  });
  class Publisher extends Base {
    async publish(record: OutboxRecord): Promise<void> {
      await super.publish(record);
      await afterPublish?.(record);
    }
  }
  const app = await Test.createTestingModule({
    imports: [
      JobsModule.forBullMQ({ backend: backend(), role: 'producer', jobTypes: ['work'] }),
      OutboxModule.forRoot({
        prisma,
        transport: Publisher,
        delivery: { mode: 'publisher' },
        polling: { enabled: true, interval: 20, batchSize: 10 },
        lease: { duration: 500, heartbeatInterval: 100 },
        retry: { maxRetries: 3, backoff: 'fixed', initialDelay: 100 },
      }),
    ],
  }).compile();
  await app.init();
  return app;
}

async function closeRelay(app: TestingModule): Promise<void> {
  // Published 0.4.0 has no public drain API. Its lane closes only after all rows
  // are terminal; Outbox 0.4.1 and later additionally verify an active drain.
  if (stopToken) await app.get(stopToken).stop();
  await app.close();
}

async function child(): Promise<void> {
  await relay(async (record) => {
    process.send?.({ enqueued: record.id });
    await new Promise<void>(() => {}); // Parent kills only this owned child.
  });
}

async function killChild(childProcess: ChildProcess): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => childProcess.once('exit', () => resolve()));
  childProcess.kill('SIGKILL');
  await exited;
}

async function main(): Promise<void> {
  if (process.env.OUTBOX_REQUIRE_STOP === 'true')
    assert(stopToken, 'Outbox must export OutboxPoller.stop');
  const admin = new Client({ connectionString: database.href });
  const apps = new Set<TestingModule>();
  let crashProcess: ChildProcess | undefined;
  let worker: TestingModule | undefined;
  let releaseBlocked: (() => void) | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}", public`);
    await admin.query(
      readFileSync(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'), 'utf8'),
    );
    await admin.query(
      'CREATE TABLE commands (key text, tenant text); CREATE TABLE effects (key text, tenant text, event_id text, correlation text, causation text)',
    );

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO commands VALUES ('rollback', 'A')`;
        await emitter.emit(tx, new Work('rollback'), { tenantId: 'A' });
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await rows('rollback')).length, 0);
    assert.equal((await admin.query("SELECT * FROM commands WHERE key = 'rollback'")).rowCount, 0);

    const crashed = await emit('crash');
    crashProcess = fork(__filename, ['relay-child'], {
      env: {
        ...process.env,
        JOBS_OUTBOX_SCHEMA: schema,
        JOBS_OUTBOX_NAMESPACE: namespace,
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child enqueue timeout')), 20_000);
      crashProcess!.once('message', (message: { enqueued?: string }) => {
        clearTimeout(timer);
        try {
          assert.equal(message.enqueued, crashed.id);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      crashProcess!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      crashProcess!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('child exited before enqueue'));
      });
    });
    assert.equal((await rows('crash'))[0].status, 'PROCESSING');
    await killChild(crashProcess);

    await emit('same-key', 'A');
    await emit('same-key', 'B');
    await emit('lost-ack');
    const lost = new Set<string>();
    let source = await relay(async (record) => {
      if (record.payload.key === 'lost-ack' && !lost.has(record.id)) {
        lost.add(record.id);
        throw new Error('simulated lost enqueue acknowledgement');
      }
    });
    apps.add(source);
    for (const key of ['crash', 'same-key', 'lost-ack']) {
      await waitFor(
        () => rows(key),
        (records) => records.length > 0 && records.every((row) => row.status === 'SENT'),
        key,
      );
    }
    assert.equal((await rows('lost-ack'))[0].retry_count, 1);
    assert.equal((await rows('crash'))[0].retry_count, 0);

    worker = await Test.createTestingModule({
      imports: [
        JobsModule.forBullMQ({
          backend: backend(),
          role: 'worker',
          jobTypes: ['work'],
        }),
      ],
    }).compile();
    worker.get(HandlerRegistry).register('work', async (payload, context) => {
      const value = payload as { key: string };
      await prisma.$executeRaw`INSERT INTO effects VALUES (${value.key}, ${String(context.tenantId)}, ${String(context.outboxEventId)}, ${String(context.correlationId)}, ${String(context.causationId)})`;
    });
    await worker.init();
    await waitFor(
      () => admin.query('SELECT * FROM effects'),
      (result) => result.rowCount === 4,
      'exactly four logical jobs',
    );
    for (const key of ['crash', 'same-key', 'lost-ack']) {
      for (const row of await rows(key)) {
        await waitFor(
          () => worker!.get(JobsService).getJob(row.id),
          (job) => job?.status === 'succeeded',
          'job succeeded',
        );
        const effects = await admin.query('SELECT * FROM effects WHERE event_id = $1', [row.id]);
        assert.equal(effects.rowCount, 1);
        assert.equal(effects.rows[0].tenant, row.tenant_id);
        assert.equal(effects.rows[0].correlation, `trace-${key}`);
        assert.equal(effects.rows[0].causation, `command-${key}`);
        // A late redelivery after handler success must still adopt the retained
        // Redis identity, rather than creating another job or database effect.
        await source.get(outboxApi.OUTBOX_TRANSPORT).publish({
          id: row.id,
          eventType: Work.eventType,
          payload: { key },
          tenantId: row.tenant_id,
        });
        assert.equal((await worker.get(JobsService).getJob(row.id))?.status, 'succeeded');
      }
    }
    assert.equal((await admin.query('SELECT * FROM effects')).rowCount, 4);
    await closeRelay(source);
    apps.delete(source);

    if (stopToken) {
      let entered!: () => void;
      const publishing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseBlocked = resolve;
      });
      source = await relay(async (record) => {
        if (record.payload.key === 'drain') {
          entered();
          await blocked;
        }
      });
      apps.add(source);
      await emit('drain');
      await publishing;
      await emit('after-stop');
      const poller = source.get(stopToken);
      await assert.rejects(poller.stop({ timeoutMs: 10 }), { code: 'OUTBOX_SHUTDOWN_INCOMPLETE' });
      assert.equal((await rows('drain'))[0].status, 'PROCESSING');
      assert.equal((await rows('after-stop'))[0].status, 'PENDING');
      releaseBlocked!();
      await poller.stop();
      await source.close();
      apps.delete(source);
      assert.equal((await rows('drain'))[0].status, 'SENT');
      assert.equal((await rows('drain'))[0].retry_count, 0);
      assert.equal((await rows('after-stop'))[0].retry_count, 0);
      source = await relay();
      apps.add(source);
      await waitFor(
        () => rows('after-stop'),
        (records) => records[0]?.status === 'SENT',
        'restart after stop',
      );
      await waitFor(
        () => admin.query('SELECT * FROM effects'),
        (result) => result.rowCount === 6,
        'drained and resumed jobs',
      );
      await closeRelay(source);
      apps.delete(source);
    }
    console.log(
      JSON.stringify({
        integration: 'passed',
        postgres: true,
        redis: true,
        rollback: true,
        processLossAfterEnqueue: true,
        redeliveryDeduplication: true,
        tenantIsolation: true,
        lineage: true,
        activeShutdown: stopToken ? 'passed' : 'not available in published 0.4.0',
      }),
    );
  } finally {
    releaseBlocked?.();
    if (crashProcess) await killChild(crashProcess);
    // Settle producers before consumers; leave no owned child or DB connection.
    for (const app of apps) await closeRelay(app);
    await worker?.close();
    await prisma.$disconnect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

void (process.argv.includes('relay-child') ? child() : main()).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
