import 'reflect-metadata';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { JobsModule, JobsService, HandlerRegistry, type InMemoryOptions } from '@nestarc/jobs';

async function main(): Promise<void> {
  for (const peer of ['bullmq', '@nestarc/outbox']) {
    assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' });
  }
  const options: InMemoryOptions = {
    jobTypes: ['one', 'two'],
    concurrency: { poolSize: 2, tenantCap: 1, typeCap: 1 },
  };
  const app = await NestFactory.createApplicationContext(JobsModule.forInMemory(options), {
    logger: false,
  });
  const jobs = app.get(JobsService);
  const registry = app.get(HandlerRegistry);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: unknown[] = [];
  for (const type of options.jobTypes) {
    registry.register(type, async (payload, context) => {
      seen.push({ payload, tenantId: context.tenantId });
      assert.ok(context.signal instanceof AbortSignal);
      assert.equal(Object.getOwnPropertyDescriptor(context, 'signal')?.enumerable, false);
      await barrier;
    });
  }
  try {
    const date = new Date('2026-01-01T00:00:00Z');
    const first = await jobs.enqueue('one', { date }, { metadata: { date } });
    await jobs.enqueue('two', {}, { context: { tenantId: '__default__' } });
    const deadline = Date.now() + 2000;
    while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(seen, [
      { payload: { date: date.toISOString() }, tenantId: undefined },
      { payload: {}, tenantId: '__default__' },
    ]);
    assert.deepEqual((await jobs.getJob(first))?.metadata, { date: date.toISOString() });
    await assert.rejects(jobs.enqueue('one', {}, { attempts: 0 }), { code: 'jobs_invalid_input' });
    await assert.rejects(jobs.enqueue('one', { nested: { value: 1n } }), {
      code: 'jobs_serialization_invalid',
    });
    jobs.setTenantWeight('one', undefined, 1);
  } finally {
    release();
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
