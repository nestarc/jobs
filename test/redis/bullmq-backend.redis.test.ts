import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Backoffs, Job, Queue } from 'bullmq';
import {
  BullMQBackend,
  createOutboxJobsPublisher,
  HandlerRegistry,
  JobHandler,
  JobsModule,
  JobsService,
  type JobLifecycleEvent,
} from '../../src';

let moduleHandlerEntered = false;
let releaseModuleHandler: () => void = () => undefined;

@Injectable()
class RedisModuleHandler {
  @JobHandler('module.job')
  async handle(): Promise<void> {
    moduleHandlerEntered = true;
    await new Promise<void>((resolve) => {
      releaseModuleHandler = resolve;
    });
  }
}

let nestedHandlerEntered = false;
let releaseNestedHandler: () => void = () => undefined;
const nestedShutdownTimeline: string[] = [];

@Injectable()
class NestedShutdownDependency implements OnModuleDestroy {
  use(): void {
    nestedShutdownTimeline.push('dependency-use');
  }

  onModuleDestroy(): void {
    nestedShutdownTimeline.push('dependency-destroy');
  }
}

@Injectable()
class NestedShutdownHandler {
  constructor(private readonly dependency: NestedShutdownDependency) {}

  @JobHandler('nested.module.job')
  async handle(): Promise<void> {
    nestedShutdownTimeline.push('handler-enter');
    nestedHandlerEntered = true;
    await new Promise<void>((resolve) => {
      releaseNestedHandler = resolve;
    });
    this.dependency.use();
  }
}

@Module({ providers: [NestedShutdownDependency, NestedShutdownHandler] })
class NestedShutdownLeafModule {}

@Module({ imports: [NestedShutdownLeafModule] })
class NestedShutdownFeatureModule {}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL is required for the Redis integration suite');
}

const parsedRedisUrl = new URL(redisUrl);
const connection = {
  host: parsedRedisUrl.hostname,
  port: Number(parsedRedisUrl.port || 6379),
  username: parsedRedisUrl.username || undefined,
  password: parsedRedisUrl.password || undefined,
  maxRetriesPerRequest: null,
};

describe('BullMQBackend with Redis', () => {
  const backends: BullMQBackend[] = [];
  const queues = new Set<string>();

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    await Promise.all(
      [...queues].map(async (name) => {
        const queue = new Queue(name, { connection });
        try {
          await queue.obliterate({ force: true });
        } finally {
          await queue.close();
        }
      }),
    );
    queues.clear();
  });

  it('rejects dotted namespaces without changing dotted job-type queue names', () => {
    const namespace = `nestarc-namespace-${randomUUID()}`;
    const jobType = 'group.work';
    const collidingNamespace = `${namespace}.group`;

    expect(`${namespace}.${jobType}`).toBe(`${collidingNamespace}.work`);
    const instance = backend(namespace, jobType);
    expect(instance.getRawQueue<Queue>(jobType).name).toBe(`${namespace}.${jobType}`);
    expect(() => new BullMQBackend({ namespace: collidingNamespace, connection })).toThrow(
      'BullMQ namespace must not contain "."',
    );
  });

  it('persists schedule, context, metadata, and registered queue discovery across restart', async () => {
    const { namespace, jobType } = testIdentity('restart');
    const first = backend(namespace, jobType);
    const scheduledFor = new Date(Date.now() + 350);
    const serviceA = service(first, jobType);
    const jobId = await serviceA.enqueue(
      jobType,
      { invoiceId: 'inv_1' },
      {
        context: { tenantId: 'tenant_1', correlationId: 'corr_1' },
        metadata: { source: 'redis-test' },
        scheduledFor,
        delayMs: 5_000,
      },
    );

    await first.close();
    const second = backend(namespace, jobType);
    const persisted = await second.getJob(jobId);
    expect(persisted).toMatchObject({
      status: 'delayed',
      payload: { invoiceId: 'inv_1' },
      context: { tenantId: 'tenant_1', correlationId: 'corr_1' },
      metadata: expect.objectContaining({ source: 'redis-test' }),
    });
    expect(
      Math.abs((persisted?.scheduledFor?.getTime() ?? 0) - scheduledFor.getTime()),
    ).toBeLessThan(50);

    const registry = new HandlerRegistry();
    let handledAt = 0;
    registry.register(jobType, async () => {
      handledAt = Date.now();
      return null;
    });
    second.startConsumer([jobType], consumer(registry));
    await waitFor(async () => (await second.getJob(jobId))?.status === 'succeeded');

    expect(handledAt).toBeGreaterThanOrEqual(scheduledFor.getTime() - 25);
    expect(await second.getJob(jobId)).toMatchObject({
      status: 'succeeded',
      metadata: expect.objectContaining({ source: 'redis-test' }),
    });
  });

  it('uses package backoff semantics and emits retry lifecycle events', async () => {
    const { namespace, jobType } = testIdentity('retry');
    const instance = backend(namespace, jobType);
    const registry = new HandlerRegistry();
    const attempts: number[] = [];
    const events: JobLifecycleEvent[] = [];
    registry.register(jobType, async (payload) => {
      if (payload.permanent) throw new Error('permanent');
      attempts.push(Date.now());
      if (attempts.length < 3) throw new Error(`retry ${attempts.length}`);
      return null;
    });
    instance.startConsumer(
      [jobType],
      consumer(registry, { onEvent: (event) => events.push(event) }),
    );
    const jobId = await service(instance, jobType).enqueue(
      jobType,
      {},
      { attempts: 3, backoff: { type: 'fixed', delayMs: 150 } },
    );

    await waitFor(
      async () =>
        (await instance.getJob(jobId))?.status === 'succeeded' &&
        events.at(-1)?.type === 'job.succeeded',
    );

    expect(await instance.getJob(jobId)).toMatchObject({
      status: 'succeeded',
      completedAt: expect.any(Date),
      failedAt: undefined,
      error: undefined,
    });

    expect(attempts).toHaveLength(3);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(100);
    expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(100);
    expect(events.map((event) => event.type)).toEqual([
      'job.started',
      'job.retry_scheduled',
      'job.started',
      'job.retry_scheduled',
      'job.started',
      'job.succeeded',
    ]);

    const failedJobId = await service(instance, jobType).enqueue(
      jobType,
      { permanent: true },
      { attempts: 1 },
    );
    await waitFor(
      async () =>
        (await instance.getJob(failedJobId))?.status === 'failed' &&
        events.at(-1)?.type === 'job.failed',
    );
    expect(await instance.getJob(failedJobId)).toMatchObject({ status: 'failed' });
    expect(events.slice(-2).map((event) => event.type)).toEqual(['job.started', 'job.failed']);
  });

  it('translates queued v0.2 backoff options before retry scheduling', async () => {
    const { namespace, jobType } = testIdentity('legacy-backoff');
    const instance = backend(namespace, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const attempts: number[] = [];
    const registry = new HandlerRegistry();
    registry.register(jobType, async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) throw new Error('retry legacy job');
      return null;
    });

    const legacy = await rawQueue.add(jobType, { source: 'v0.2', __nestarcCtx: {} }, {
      jobId: 'legacy-backoff-job',
      attempts: 2,
      backoff: { type: 'fixed', delayMs: 200 },
    } as never);
    instance.startConsumer([jobType], consumer(registry));

    await waitFor(async () => (await instance.getJob(String(legacy.id)))?.status === 'succeeded');
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(150);
  });

  it('reports an unrecoverable error as terminal instead of scheduling a retry', async () => {
    const { namespace, jobType } = testIdentity('unrecoverable');
    const instance = backend(namespace, jobType);
    const registry = new HandlerRegistry();
    const events: JobLifecycleEvent[] = [];
    registry.register(jobType, async () => {
      const error = new Error('stop immediately');
      error.name = 'UnrecoverableError';
      throw error;
    });
    instance.startConsumer(
      [jobType],
      consumer(registry, { onEvent: (event) => events.push(event) }),
    );

    const jobId = await service(instance, jobType).enqueue(jobType, {}, { attempts: 3 });
    await waitFor(
      async () =>
        (await instance.getJob(jobId))?.status === 'failed' && events.at(-1)?.type === 'job.failed',
    );

    expect(events.map((event) => event.type)).toEqual(['job.started', 'job.failed']);
    expect(await instance.getJob(jobId)).toMatchObject({ status: 'failed', attempt: 1 });
  });

  it('normalizes unstringifiable non-Error handler rejections', async () => {
    const { namespace, jobType } = testIdentity('non-error-rejection');
    const instance = backend(namespace, jobType);
    const registry = new HandlerRegistry();
    registry.register(jobType, async () => {
      throw Object.create(null) as unknown;
    });
    instance.startConsumer([jobType], consumer(registry));

    const jobId = await service(instance, jobType).enqueue(jobType, {});
    await waitFor(async () => (await instance.getJob(jobId))?.status === 'failed');
    expect(await instance.getJob(jobId)).toMatchObject({
      status: 'failed',
      error: { message: 'Job handler rejected with a non-error value' },
    });
  });

  it('emits failure only after BullMQ rejects a non-serializable handler result', async () => {
    const { namespace, jobType } = testIdentity('return-serialization');
    const instance = backend(namespace, jobType);
    const registry = new HandlerRegistry();
    const events: JobLifecycleEvent[] = [];
    let finishes = 0;
    let failures = 0;
    const expectedWorkerError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    registry.register(jobType, async () => 1n);
    instance.startConsumer([jobType], {
      ...consumer(registry, { onEvent: (event) => events.push(event) }),
      onFinish: () => {
        finishes += 1;
      },
      onFail: () => {
        failures += 1;
      },
    });

    try {
      const jobId = await service(instance, jobType).enqueue(jobType, {}, { attempts: 1 });
      await waitFor(
        async () =>
          (await instance.getJob(jobId))?.status === 'failed' &&
          events.at(-1)?.type === 'job.failed',
      );

      expect(events.map((event) => event.type)).toEqual(['job.started', 'job.failed']);
      expect({ finishes, failures }).toEqual({ finishes: 0, failures: 1 });
      expect(await instance.getJob(jobId)).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('BigInt') },
      });
    } finally {
      expectedWorkerError.mockRestore();
    }
  });

  it('reports the actual delayed retry timestamp', async () => {
    const { namespace, jobType } = testIdentity('retry-timestamp');
    const instance = backend(namespace, jobType);
    const registry = new HandlerRegistry();
    registry.register(jobType, async () => {
      throw new Error('retry later');
    });
    instance.startConsumer([jobType], consumer(registry));

    const jobId = await service(instance, jobType).enqueue(
      jobType,
      {},
      { attempts: 2, backoff: { type: 'fixed', delayMs: 3_000 } },
    );
    await waitFor(async () => {
      const record = await instance.getJob(jobId);
      return record?.status === 'delayed' && record.attempt === 1;
    });

    const record = await instance.getJob(jobId);
    expect(record).toMatchObject({
      status: 'delayed',
      attempt: 1,
      nextAttemptAt: expect.any(Date),
      scheduledFor: expect.any(Date),
    });
    expect(record?.scheduledFor?.getTime()).toBe(record?.nextAttemptAt?.getTime());
    expect(record?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + 1_000);
  });

  it('uses globally unique generated and persistent identity IDs across job type queues', async () => {
    const namespace = `nestarc-multi-queue-${randomUUID()}`;
    const jobTypes = ['type.a', 'type.b'];
    const instance = new BullMQBackend({ namespace, connection });
    instance.registerJobTypes(jobTypes);
    backends.push(instance);
    jobTypes.forEach((jobType) => queues.add(`${namespace}.${jobType}`));
    const jobs = new JobsService({
      backend: instance,
      registry: new HandlerRegistry(),
      jobTypes,
    });

    const firstId = await jobs.enqueue('type.a', { marker: 'a' });
    const secondId = await jobs.enqueue('type.b', { marker: 'b' });

    expect(firstId).not.toBe(secondId);
    expect(await instance.getJob(firstId)).toMatchObject({
      id: firstId,
      type: 'type.a',
      payload: { marker: 'a' },
    });
    expect(await instance.getJob(secondId)).toMatchObject({
      id: secondId,
      type: 'type.b',
      payload: { marker: 'b' },
    });

    const firstIdempotent = await jobs.enqueueDetailed(
      'type.a',
      { marker: 'id-a' },
      { idempotencyKey: 'shared-key' },
    );
    const secondIdempotent = await jobs.enqueueDetailed(
      'type.b',
      { marker: 'id-b' },
      { idempotencyKey: 'shared-key' },
    );
    expect(firstIdempotent.status).toBe('created');
    expect(secondIdempotent.status).toBe('created');
    expect(firstIdempotent.jobId).not.toBe(secondIdempotent.jobId);
    expect(await instance.getJob(secondIdempotent.jobId)).toMatchObject({
      type: 'type.b',
      payload: { marker: 'id-b' },
    });

    const firstDedupe = await jobs.enqueueDetailed(
      'type.a',
      { marker: 'dedupe-a' },
      { dedupe: { key: 'shared-key', mode: 'until_completed' } },
    );
    const secondDedupe = await jobs.enqueueDetailed(
      'type.b',
      { marker: 'dedupe-b' },
      { dedupe: { key: 'shared-key', mode: 'until_completed' } },
    );
    expect(firstDedupe.status).toBe('created');
    expect(secondDedupe.status).toBe('created');
    expect(firstDedupe.jobId).not.toBe(secondDedupe.jobId);

    await expect(
      jobs.enqueueDetailed('type.a', { marker: 'explicit-a' }, { jobId: 'shared-explicit-id' }),
    ).resolves.toMatchObject({ status: 'created', jobId: 'shared-explicit-id' });
    await expect(
      jobs.enqueueDetailed('type.b', { marker: 'explicit-b' }, { jobId: 'shared-explicit-id' }),
    ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
  });

  it('isolates lifecycle observer failures from BullMQ handler outcomes', async () => {
    const { namespace, jobType } = testIdentity('observer-failure');
    const instance = backend(namespace, jobType);
    const registry = new HandlerRegistry();
    let executions = 0;
    registry.register(jobType, async () => {
      executions += 1;
      return null;
    });
    const observerFailure = () => {
      throw new Error('observer unavailable');
    };
    instance.startConsumer([jobType], {
      registry,
      contextRunner: async (_context, fn) => fn(),
      onStart: observerFailure,
      onFinish: observerFailure,
      onFail: observerFailure,
      events: {
        onEvent: async () => {
          throw new Error('async observer unavailable');
        },
      },
    });

    const jobId = await service(instance, jobType).enqueue(jobType, {});
    await waitFor(async () => (await instance.getJob(jobId))?.status === 'succeeded');

    expect(executions).toBe(1);
    expect(await instance.getJob(jobId)).toMatchObject({
      status: 'succeeded',
      failedAt: undefined,
      error: undefined,
    });
  });

  it('rejects the internal envelope key while preserving legacy payload lookalikes', async () => {
    const { namespace, jobType } = testIdentity('reserved-envelope');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);

    await expect(
      jobs.enqueue(jobType, { __nestarcJob: { customerValue: true }, keep: 1 }),
    ).rejects.toMatchObject({ code: 'jobs_reserved_payload_key' });

    const legacyId = randomUUID();
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    await rawQueue.add(
      jobType,
      { __nestarcJob: { customerValue: true }, keep: 1 },
      { jobId: legacyId },
    );
    expect(await instance.getJob(legacyId)).toMatchObject({
      payload: { __nestarcJob: { customerValue: true }, keep: 1 },
    });
  });

  it('atomically suppresses concurrent idempotent enqueue across producers and restart', async () => {
    const { namespace, jobType } = testIdentity('idempotency');
    const first = backend(namespace, jobType);
    const second = backend(namespace, jobType);
    const options = { idempotencyKey: 'outbox:event/123' };

    const results = await Promise.all([
      service(first, jobType).enqueueDetailed(jobType, { producer: 'a' }, options),
      service(second, jobType).enqueueDetailed(jobType, { producer: 'b' }, options),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['created', 'deduped']);
    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    const originalJobId = results[0].jobId;
    expect(originalJobId).toMatch(/^id-[a-f0-9]{64}$/);

    await first.close();
    const restarted = backend(namespace, jobType);
    await expect(
      service(restarted, jobType).enqueueDetailed(jobType, {}, options),
    ).resolves.toMatchObject({ status: 'deduped', jobId: originalJobId });
  });

  it('adopts a v0.2 raw idempotency job during an in-place upgrade', async () => {
    const { namespace, jobType } = testIdentity('legacy-idempotency');
    const first = backend(namespace, jobType);
    const legacyIdempotencyKey = 'business-key-from-v0.2';
    const rawQueue = first.getRawQueue<Queue>(jobType);
    await rawQueue.add(jobType, { source: 'v0.2' }, { jobId: legacyIdempotencyKey });

    await expect(
      service(first, jobType).enqueueDetailed(
        jobType,
        { source: 'v0.3' },
        { jobId: 'explicit-v0.3-id', idempotencyKey: legacyIdempotencyKey },
      ),
    ).resolves.toMatchObject({
      status: 'deduped',
      jobId: legacyIdempotencyKey,
      existingJobId: legacyIdempotencyKey,
    });
    expect(await rawQueue.getJob('explicit-v0.3-id')).toBeUndefined();
    expect(
      await rawQueue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed'),
    ).toBe(1);

    await first.close();
    const restarted = backend(namespace, jobType);
    await expect(
      service(restarted, jobType).enqueueDetailed(
        jobType,
        { source: 'v0.3-restart' },
        { idempotencyKey: legacyIdempotencyKey },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: legacyIdempotencyKey });
  });

  it('adopts the same v0.2 idempotency key independently across job type queues', async () => {
    const namespace = `nestarc-legacy-multi-type-${randomUUID()}`;
    const firstType = 'type.a';
    const secondType = 'type.b';
    const first = backend(namespace, firstType);
    const second = backend(namespace, secondType);
    const firstQueue = first.getRawQueue<Queue>(firstType);
    const secondQueue = second.getRawQueue<Queue>(secondType);
    const legacyIdempotencyKey = 'shared-v0.2-business-key';
    await firstQueue.add(firstType, { source: 'v0.2-a' }, { jobId: legacyIdempotencyKey });
    await secondQueue.add(secondType, { source: 'v0.2-b' }, { jobId: legacyIdempotencyKey });

    await expect(
      service(first, firstType).enqueueDetailed(
        firstType,
        { source: 'v0.3-a' },
        { idempotencyKey: legacyIdempotencyKey },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: legacyIdempotencyKey });
    await expect(
      service(second, secondType).enqueueDetailed(
        secondType,
        { source: 'v0.3-b' },
        { idempotencyKey: legacyIdempotencyKey },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: legacyIdempotencyKey });
    await expect(firstQueue.getJob(legacyIdempotencyKey)).resolves.toMatchObject({
      data: { source: 'v0.2-a' },
    });
    await expect(secondQueue.getJob(legacyIdempotencyKey)).resolves.toMatchObject({
      data: { source: 'v0.2-b' },
    });
  });

  it('revalidates a v0.2 idempotency job after acquiring identity locks', async () => {
    const { namespace, jobType } = testIdentity('legacy-idempotency-removal-race');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const legacyIdempotencyKey = 'removed-v0.2-business-key';
    await rawQueue.add(jobType, { source: 'v0.2' }, { jobId: legacyIdempotencyKey });
    const mutableQueue = rawQueue as unknown as {
      getJob(jobId: string): Promise<Awaited<ReturnType<Queue['getJob']>>>;
    };
    const originalGetJob = mutableQueue.getJob.bind(mutableQueue);
    let removed = false;
    mutableQueue.getJob = async (jobId) => {
      const job = await originalGetJob(jobId);
      if (jobId === legacyIdempotencyKey && job && !removed) {
        removed = true;
        await job.remove();
      }
      return job;
    };

    try {
      await expect(
        jobs.enqueueDetailed(
          jobType,
          { source: 'v0.3' },
          { jobId: 'replacement-id', idempotencyKey: legacyIdempotencyKey },
        ),
      ).resolves.toMatchObject({ status: 'created', jobId: 'replacement-id' });
      expect(await originalGetJob(legacyIdempotencyKey)).toBeUndefined();
      expect(await originalGetJob('replacement-id')).toBeDefined();
    } finally {
      mutableQueue.getJob = originalGetJob;
    }
  });

  it('claims an adopted v0.2 job ID across every queue in the namespace', async () => {
    const namespace = `nestarc-legacy-global-${randomUUID()}`;
    const legacyType = 'type.a';
    const peerType = 'type.b';
    const legacy = backend(namespace, legacyType);
    const rawQueue = legacy.getRawQueue<Queue>(legacyType);
    const legacyId = 'legacy-shared-id';
    await rawQueue.add(legacyType, { source: 'v0.2' }, { jobId: legacyId });

    await expect(
      service(legacy, legacyType).enqueueDetailed(
        legacyType,
        { source: 'v0.3' },
        { idempotencyKey: legacyId },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: legacyId });

    const peer = backend(namespace, peerType);
    await expect(
      service(peer, peerType).enqueueDetailed(peerType, { source: 'peer' }, { jobId: legacyId }),
    ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
  });

  it('does not adopt an unrelated v0.3 explicit job as legacy idempotency state', async () => {
    const { namespace, jobType } = testIdentity('v3-explicit-idempotency-collision');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);

    await expect(
      jobs.enqueueDetailed(jobType, { source: 'explicit' }, { jobId: 'collision-key' }),
    ).resolves.toMatchObject({ status: 'created', jobId: 'collision-key' });
    await expect(
      jobs.enqueueDetailed(
        jobType,
        { source: 'idempotent' },
        { jobId: 'expected-new', idempotencyKey: 'collision-key' },
      ),
    ).resolves.toMatchObject({ status: 'created', jobId: 'expected-new' });
    await expect(
      jobs.enqueueDetailed(jobType, {}, { idempotencyKey: 'collision-key' }),
    ).resolves.toMatchObject({ status: 'deduped', jobId: 'expected-new' });
    expect(
      await rawQueue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed'),
    ).toBe(2);
  });

  it('rejects a generated idempotency ID already claimed by an explicit job', async () => {
    const { namespace, jobType } = testIdentity('generated-id-collision');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const key = 'generated-collision';
    const generatedId = `id-${createHash('sha256')
      .update(`${namespace}.${jobType}\u0000${key}`)
      .digest('hex')}`;

    await expect(
      jobs.enqueueDetailed(jobType, { source: 'explicit' }, { jobId: generatedId }),
    ).resolves.toMatchObject({ status: 'created', jobId: generatedId });
    await expect(
      jobs.enqueueDetailed(jobType, { source: 'idempotent' }, { idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
    await expect(instance.getJob(generatedId)).resolves.toMatchObject({
      payload: { source: 'explicit' },
    });
  });

  it('backfills composite identities and avoids tenant delimiter collisions', async () => {
    const { namespace, jobType } = testIdentity('identity-backfill');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const first = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        idempotencyKey: 'identity-a',
        dedupe: { key: 'shared', mode: 'while_active' },
      },
    );
    await expect(
      jobs.enqueueDetailed(
        jobType,
        {},
        {
          idempotencyKey: 'identity-b',
          dedupe: { key: 'shared', mode: 'while_active' },
        },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: first.jobId });
    await expect(
      jobs.enqueueDetailed(
        jobType,
        {},
        {
          idempotencyKey: 'identity-b',
          dedupe: { key: 'different', mode: 'while_active' },
        },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: first.jobId });

    const tenantOne = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        context: { tenantId: 'a:b' },
        dedupe: { key: 'c', scope: 'tenant' },
      },
    );
    const tenantTwo = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        context: { tenantId: 'a' },
        dedupe: { key: 'b:c', scope: 'tenant' },
      },
    );
    expect(tenantTwo.status).toBe('created');
    expect(tenantTwo.jobId).not.toBe(tenantOne.jobId);
  });

  it('rejects composite identities that already resolve to different jobs', async () => {
    const { namespace, jobType } = testIdentity('identity-conflict');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const idempotent = await jobs.enqueueDetailed(
      jobType,
      {},
      { idempotencyKey: 'conflicting-idempotency' },
    );
    const deduped = await jobs.enqueueDetailed(
      jobType,
      {},
      { dedupe: { key: 'conflicting-dedupe', mode: 'until_completed' } },
    );

    await expect(
      jobs.enqueueDetailed(
        jobType,
        {},
        {
          idempotencyKey: 'conflicting-idempotency',
          dedupe: { key: 'conflicting-dedupe', mode: 'until_completed' },
        },
      ),
    ).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
    await expect(
      jobs.enqueueDetailed(jobType, {}, { idempotencyKey: 'conflicting-idempotency' }),
    ).resolves.toMatchObject({ jobId: idempotent.jobId });
    await expect(
      jobs.enqueueDetailed(
        jobType,
        {},
        { dedupe: { key: 'conflicting-dedupe', mode: 'until_completed' } },
      ),
    ).resolves.toMatchObject({ jobId: deduped.jobId });
  });

  it('reconciles a committed add when the producer loses the Queue.add response', async () => {
    const { namespace, jobType } = testIdentity('ambiguous-add');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const mutableQueue = rawQueue as unknown as {
      add(name: string, data: unknown, options?: unknown): Promise<unknown>;
    };
    const originalAdd = mutableQueue.add.bind(mutableQueue);
    let injected = false;
    mutableQueue.add = async (name, data, options) => {
      const added = await originalAdd(name, data, options);
      if (!injected) {
        injected = true;
        mutableQueue.add = originalAdd;
        throw new Error('simulated response loss after Redis commit');
      }
      return added;
    };

    try {
      const first = await jobs.enqueueDetailed(
        jobType,
        { sequence: 1 },
        { dedupe: { key: 'ambiguous', mode: 'until_completed' } },
      );
      expect(first.status).toBe('created');

      await expect(
        jobs.enqueueDetailed(
          jobType,
          { sequence: 2 },
          { dedupe: { key: 'ambiguous', mode: 'until_completed' } },
        ),
      ).resolves.toMatchObject({ status: 'deduped', jobId: first.jobId });
      expect(
        await rawQueue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed'),
      ).toBe(1);
    } finally {
      mutableQueue.add = originalAdd;
    }
  });

  it('retains an identity reservation when a committed add cannot be reconciled immediately', async () => {
    const { namespace, jobType } = testIdentity('indeterminate-add');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const mutableQueue = rawQueue as unknown as {
      add(name: string, data: unknown, options?: unknown): Promise<unknown>;
      getJob(jobId: string): Promise<unknown>;
    };
    const originalAdd = mutableQueue.add.bind(mutableQueue);
    const originalGetJob = mutableQueue.getJob.bind(mutableQueue);
    let addCommitted = false;
    let reconciliationFailed = false;
    mutableQueue.add = async (name, data, options) => {
      await originalAdd(name, data, options);
      addCommitted = true;
      throw new Error('simulated response loss after Redis commit');
    };
    mutableQueue.getJob = async (jobId) => {
      if (addCommitted && !reconciliationFailed) {
        reconciliationFailed = true;
        throw new Error('simulated reconciliation lookup failure');
      }
      return await originalGetJob(jobId);
    };
    const options = {
      dedupe: { key: 'indeterminate', mode: 'until_completed' as const },
    };

    try {
      await expect(jobs.enqueueDetailed(jobType, { sequence: 1 }, options)).rejects.toThrow(
        'simulated response loss after Redis commit',
      );
      expect(reconciliationFailed).toBe(true);

      const redis = (await rawQueue.client) as unknown as {
        get(key: string): Promise<string | null>;
        keys(pattern: string): Promise<string[]>;
      };
      const reservationKeys = (
        await redis.keys(rawQueue.toKey('*nestarc:identity:dedupe:*'))
      ).filter((key) => !key.endsWith(':lock'));
      expect(reservationKeys).toHaveLength(1);
      const rawReservation = await redis.get(reservationKeys[0]);
      expect(rawReservation).not.toBeNull();
      const reservation = JSON.parse(rawReservation!) as { jobId?: unknown };
      expect(reservation).toEqual(expect.objectContaining({ jobId: expect.any(String) }));
      const reservedJobId = reservation.jobId as string;
      await expect(originalGetJob(reservedJobId)).resolves.not.toBeNull();

      mutableQueue.add = originalAdd;
      mutableQueue.getJob = originalGetJob;
      await expect(jobs.enqueueDetailed(jobType, { sequence: 2 }, options)).resolves.toMatchObject({
        status: 'deduped',
        jobId: reservedJobId,
      });
      expect(
        await rawQueue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed'),
      ).toBe(1);
    } finally {
      mutableQueue.add = originalAdd;
      mutableQueue.getJob = originalGetJob;
    }
  });

  it('adopts an in-flight reservation when the identity lock lease is lost', async () => {
    const { namespace, jobType } = testIdentity('lost-identity-lease');
    const firstBackend = backend(namespace, jobType);
    const secondBackend = backend(namespace, jobType);
    const firstJobs = service(firstBackend, jobType);
    const secondJobs = service(secondBackend, jobType);
    const rawQueue = firstBackend.getRawQueue<Queue>(jobType);
    const mutableQueue = rawQueue as unknown as {
      add(name: string, data: unknown, options?: unknown): Promise<unknown>;
    };
    const originalAdd = mutableQueue.add.bind(mutableQueue);
    let releaseFirstAdd: () => void = () => undefined;
    const firstAddRelease = new Promise<void>((resolve) => {
      releaseFirstAdd = resolve;
    });
    let markFirstAddBlocked: () => void = () => undefined;
    const firstAddBlocked = new Promise<void>((resolve) => {
      markFirstAddBlocked = resolve;
    });
    mutableQueue.add = async (name, data, options) => {
      mutableQueue.add = originalAdd;
      markFirstAddBlocked();
      await firstAddRelease;
      return await originalAdd(name, data, options);
    };

    const firstEnqueue = firstJobs.enqueueDetailed(
      jobType,
      { producer: 'first' },
      { dedupe: { key: 'lost-lease', mode: 'until_completed' } },
    );
    try {
      await firstAddBlocked;
      const redis = (await rawQueue.client) as unknown as {
        keys(pattern: string): Promise<string[]>;
        del(...keys: string[]): Promise<number>;
      };
      const lockKeys = await redis.keys(`${rawQueue.toKey('*nestarc:identity:dedupe:*')}:lock`);
      expect(lockKeys).toHaveLength(1);
      await redis.del(...lockKeys);

      const second = await secondJobs.enqueueDetailed(
        jobType,
        { producer: 'second' },
        {
          jobId: 'reservation-recovery-id',
          dedupe: { key: 'lost-lease', mode: 'until_completed' },
        },
      );
      releaseFirstAdd();
      const first = await firstEnqueue;

      expect([first.status, second.status].sort()).toEqual(['created', 'deduped']);
      expect(first.jobId).toBe(second.jobId);
      expect(
        await rawQueue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed'),
      ).toBe(1);
      await expect(
        secondJobs.enqueueDetailed(
          jobType,
          { producer: 'explicit-only' },
          { jobId: 'reservation-recovery-id' },
        ),
      ).resolves.toMatchObject({ status: 'created', jobId: 'reservation-recovery-id' });
      expect(
        await rawQueue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed'),
      ).toBe(2);
    } finally {
      releaseFirstAdd();
      mutableQueue.add = originalAdd;
      await Promise.allSettled([firstEnqueue]);
    }
  });

  it('does not overwrite a peer identity mapping when the lease is lost before reservation', async () => {
    const { namespace, jobType } = testIdentity('lost-lease-before-reservation');
    const firstBackend = backend(namespace, jobType);
    const secondBackend = backend(namespace, jobType);
    const firstJobs = service(firstBackend, jobType);
    const secondJobs = service(secondBackend, jobType);
    const rawQueue = firstBackend.getRawQueue<Queue>(jobType);
    const redis = (await rawQueue.client) as unknown as {
      keys(pattern: string): Promise<string[]>;
      del(...keys: string[]): Promise<number>;
    };
    const mutableRedis = redis as unknown as {
      eval(script: string, numberOfKeys: number, ...args: unknown[]): Promise<unknown>;
    };
    const originalEval = mutableRedis.eval.bind(mutableRedis);
    let releaseReservation: () => void = () => undefined;
    const reservationRelease = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    let markReservationBlocked: () => void = () => undefined;
    const reservationBlocked = new Promise<void>((resolve) => {
      markReservationBlocked = resolve;
    });
    let blocked = false;
    mutableRedis.eval = async (script, numberOfKeys, ...args) => {
      const isIdentityReservation = script.includes("redis.call('exists', key)");
      if (isIdentityReservation && !blocked) {
        blocked = true;
        markReservationBlocked();
        await reservationRelease;
      }
      return await originalEval(script, numberOfKeys, ...args);
    };

    const firstEnqueue = firstJobs.enqueueDetailed(
      jobType,
      { producer: 'first' },
      { dedupe: { key: 'reservation-race', mode: 'until_completed' } },
    );
    try {
      await reservationBlocked;
      const lockKeys = await redis.keys(`${rawQueue.toKey('*nestarc:identity:dedupe:*')}:lock`);
      expect(lockKeys).toHaveLength(1);
      await redis.del(...lockKeys);

      const second = await secondJobs.enqueueDetailed(
        jobType,
        { producer: 'second' },
        { dedupe: { key: 'reservation-race', mode: 'until_completed' } },
      );
      expect(second.status).toBe('created');

      releaseReservation();
      await expect(firstEnqueue).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
      expect(
        await rawQueue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed'),
      ).toBe(1);
      await expect(
        secondJobs.enqueueDetailed(
          jobType,
          { producer: 'third' },
          { dedupe: { key: 'reservation-race', mode: 'until_completed' } },
        ),
      ).resolves.toMatchObject({ status: 'deduped', jobId: second.jobId });
    } finally {
      releaseReservation();
      mutableRedis.eval = originalEval;
      await Promise.allSettled([firstEnqueue]);
    }
  });

  it('binds composite reservations atomically after identity lock lease loss', async () => {
    const { namespace, jobType } = testIdentity('partial-reservation-rollback');
    const firstBackend = backend(namespace, jobType);
    const secondBackend = backend(namespace, jobType);
    const firstJobs = service(firstBackend, jobType);
    const secondJobs = service(secondBackend, jobType);
    const rawQueue = firstBackend.getRawQueue<Queue>(jobType);
    const redis = (await rawQueue.client) as unknown as {
      keys(pattern: string): Promise<string[]>;
      del(...keys: string[]): Promise<number>;
      eval(script: string, numberOfKeys: number, ...args: unknown[]): Promise<unknown>;
    };
    const originalEval = redis.eval.bind(redis);
    let releaseDedupeReservation: () => void = () => undefined;
    const dedupeReservationRelease = new Promise<void>((resolve) => {
      releaseDedupeReservation = resolve;
    });
    let markDedupeReservationBlocked: () => void = () => undefined;
    const dedupeReservationBlocked = new Promise<void>((resolve) => {
      markDedupeReservationBlocked = resolve;
    });
    let blocked = false;
    redis.eval = async (script, numberOfKeys, ...args) => {
      const isCompositeReservation =
        script.includes("redis.call('exists', key)") && numberOfKeys > 1;
      if (isCompositeReservation && !blocked) {
        blocked = true;
        markDedupeReservationBlocked();
        await dedupeReservationRelease;
      }
      return await originalEval(script, numberOfKeys, ...args);
    };

    const composite = {
      idempotencyKey: 'partial-idempotency',
      dedupe: { key: 'partial-dedupe', mode: 'until_completed' as const },
    };
    const firstEnqueue = firstJobs.enqueueDetailed(jobType, { producer: 'first' }, composite);
    try {
      await dedupeReservationBlocked;
      const lockKeys = await redis.keys(`bull:${namespace}*nestarc:identity:*:lock`);
      expect(lockKeys.length).toBeGreaterThanOrEqual(3);
      await redis.del(...lockKeys);

      const second = await secondJobs.enqueueDetailed(
        jobType,
        { producer: 'second' },
        { dedupe: composite.dedupe },
      );
      releaseDedupeReservation();

      await expect(firstEnqueue).rejects.toMatchObject({ code: 'jobs_identity_conflict' });
      await expect(
        firstJobs.enqueueDetailed(jobType, { producer: 'retry' }, composite),
      ).resolves.toMatchObject({ status: 'deduped', jobId: second.jobId });
      const identityKeys = await redis.keys(`bull:${namespace}*nestarc:identity:*`);
      const hashTags = identityKeys
        .map((key) => key.match(/\{[^}]+\}/)?.[0])
        .filter((value): value is string => value !== undefined);
      expect(identityKeys.length).toBeGreaterThanOrEqual(2);
      expect(new Set(hashTags).size).toBe(1);
    } finally {
      releaseDedupeReservation();
      redis.eval = originalEval;
      await Promise.allSettled([firstEnqueue]);
    }
  });

  it('keeps the first dedupe mode and TTL authoritative until identity release', async () => {
    const { namespace, jobType } = testIdentity('dedupe-policy');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);

    const whileActive = await jobs.enqueueDetailed(
      jobType,
      { policy: 'while-active' },
      { dedupe: { key: 'mode-a', mode: 'while_active' } },
    );
    await expect(
      jobs.enqueueDetailed(
        jobType,
        { policy: 'until-completed' },
        { dedupe: { key: 'mode-a', mode: 'until_completed' } },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: whileActive.jobId });

    const untilCompleted = await jobs.enqueueDetailed(
      jobType,
      { policy: 'until-completed' },
      { dedupe: { key: 'mode-b', mode: 'until_completed' } },
    );
    await expect(
      jobs.enqueueDetailed(
        jobType,
        { policy: 'while-active' },
        { dedupe: { key: 'mode-b', mode: 'while_active' } },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: untilCompleted.jobId });

    const registry = new HandlerRegistry();
    registry.register(jobType, async () => null);
    instance.startConsumer([jobType], consumer(registry));
    const retained = await jobs.enqueueDetailed(
      jobType,
      { policy: 'retained' },
      { dedupe: { key: 'ttl', mode: 'until_completed', ttlMs: 60_000 } },
    );
    await waitFor(async () => (await instance.getJob(retained.jobId))?.status === 'succeeded');

    await expect(
      jobs.enqueueDetailed(
        jobType,
        { policy: 'weakened' },
        { dedupe: { key: 'ttl', mode: 'until_completed', ttlMs: 0 } },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: retained.jobId });
  });

  it('releases or expires created dedupe mappings at the terminal transition', async () => {
    const { namespace, jobType } = testIdentity('terminal-dedupe-cleanup');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const redis = (await rawQueue.client) as unknown as {
      get(key: string): Promise<string | null>;
      keys(pattern: string): Promise<string[]>;
      pttl(key: string): Promise<number>;
    };
    const identityPattern = rawQueue.toKey('*nestarc:identity:dedupe:*');
    const mappingKeyFor = async (jobId: string): Promise<string | undefined> => {
      for (const key of await redis.keys(identityPattern)) {
        const rawMapping = await redis.get(key);
        if (!rawMapping) continue;
        try {
          if ((JSON.parse(rawMapping) as { jobId?: unknown }).jobId === jobId) return key;
        } catch {
          continue;
        }
      }
      return undefined;
    };

    const completed = await jobs.enqueueDetailed(
      jobType,
      { outcome: 'completed' },
      { dedupe: { key: 'completed', mode: 'while_active' } },
    );
    const failed = await jobs.enqueueDetailed(
      jobType,
      { outcome: 'failed' },
      { dedupe: { key: 'failed', mode: 'while_active' } },
    );
    const retained = await jobs.enqueueDetailed(
      jobType,
      { outcome: 'retained' },
      { dedupe: { key: 'retained', mode: 'until_completed', ttlMs: 5_000 } },
    );

    await expect(mappingKeyFor(completed.jobId)).resolves.toBeDefined();
    await expect(mappingKeyFor(failed.jobId)).resolves.toBeDefined();
    await expect(mappingKeyFor(retained.jobId)).resolves.toBeDefined();

    const registry = new HandlerRegistry();
    registry.register(jobType, async (payload) => {
      if (payload.outcome === 'failed') throw new Error('terminal failure');
      return null;
    });
    instance.startConsumer([jobType], consumer(registry));

    await waitFor(async () => {
      const [completedRecord, failedRecord, retainedRecord] = await Promise.all([
        instance.getJob(completed.jobId),
        instance.getJob(failed.jobId),
        instance.getJob(retained.jobId),
      ]);
      return (
        completedRecord?.status === 'succeeded' &&
        failedRecord?.status === 'failed' &&
        retainedRecord?.status === 'succeeded'
      );
    });
    await waitFor(async () => {
      const [completedKey, failedKey, retainedKey] = await Promise.all([
        mappingKeyFor(completed.jobId),
        mappingKeyFor(failed.jobId),
        mappingKeyFor(retained.jobId),
      ]);
      if (completedKey || failedKey || !retainedKey) return false;
      const ttlMs = await redis.pttl(retainedKey);
      return ttlMs > 0 && ttlMs <= 5_000;
    });

    await expect(mappingKeyFor(completed.jobId)).resolves.toBeUndefined();
    await expect(mappingKeyFor(failed.jobId)).resolves.toBeUndefined();
    const retainedKey = await mappingKeyFor(retained.jobId);
    expect(retainedKey).toBeDefined();
    const ttlMs = await redis.pttl(retainedKey!);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(5_000);
  });

  it('treats a custom backoff -1 result as terminal for events and dedupe cleanup', async () => {
    const { namespace, jobType } = testIdentity('terminal-custom-backoff');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const redis = (await rawQueue.client) as unknown as {
      get(key: string): Promise<string | null>;
      keys(pattern: string): Promise<string[]>;
    };
    const identityPattern = rawQueue.toKey('*nestarc:identity:dedupe:*');
    const mappingExistsFor = async (jobId: string): Promise<boolean> => {
      for (const key of await redis.keys(identityPattern)) {
        const rawMapping = await redis.get(key);
        if (!rawMapping) continue;
        try {
          if ((JSON.parse(rawMapping) as { jobId?: unknown }).jobId === jobId) return true;
        } catch {
          continue;
        }
      }
      return false;
    };
    const events: JobLifecycleEvent[] = [];
    const registry = new HandlerRegistry();
    registry.register(jobType, async () => {
      throw new Error('stop retrying');
    });
    const job = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        attempts: 3,
        backoff: { type: 'fixed', delayMs: 100 },
        dedupe: { key: 'custom-backoff', mode: 'while_active' },
      },
    );
    await expect(mappingExistsFor(job.jobId)).resolves.toBe(true);
    const calculate = jest.spyOn(Backoffs, 'calculate').mockReturnValue(-1);

    try {
      instance.startConsumer(
        [jobType],
        consumer(registry, { onEvent: (event) => events.push(event) }),
      );
      await waitFor(
        async () =>
          (await instance.getJob(job.jobId))?.status === 'failed' &&
          events.at(-1)?.type === 'job.failed',
      );
      await waitFor(async () => !(await mappingExistsFor(job.jobId)));

      expect(await instance.getJob(job.jobId)).toMatchObject({ status: 'failed', attempt: 1 });
      expect(events.map((event) => event.type)).toEqual(['job.started', 'job.failed']);
    } finally {
      calculate.mockRestore();
    }
  });

  it('treats a discarded failure as terminal for events and dedupe cleanup', async () => {
    const { namespace, jobType } = testIdentity('terminal-discarded');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const redis = (await rawQueue.client) as unknown as {
      get(key: string): Promise<string | null>;
      keys(pattern: string): Promise<string[]>;
    };
    const identityPattern = rawQueue.toKey('*nestarc:identity:dedupe:*');
    const mappingExistsFor = async (jobId: string): Promise<boolean> => {
      for (const key of await redis.keys(identityPattern)) {
        const rawMapping = await redis.get(key);
        if (!rawMapping) continue;
        try {
          if ((JSON.parse(rawMapping) as { jobId?: unknown }).jobId === jobId) return true;
        } catch {
          continue;
        }
      }
      return false;
    };
    const events: JobLifecycleEvent[] = [];
    const registry = new HandlerRegistry();
    registry.register(jobType, async () => {
      throw new Error('discard this failure');
    });
    const job = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        attempts: 3,
        backoff: { type: 'fixed', delayMs: 100 },
        dedupe: { key: 'discarded', mode: 'while_active' },
      },
    );
    await expect(mappingExistsFor(job.jobId)).resolves.toBe(true);
    const originalMoveToFailed = Job.prototype.moveToFailed;
    const moveToFailed = jest.spyOn(Job.prototype, 'moveToFailed').mockImplementation(function <
      E extends Error,
    >(this: Job, error: E, token: string, fetchNext?: boolean) {
      this.discard();
      return originalMoveToFailed.call(this, error, token, fetchNext);
    });

    try {
      instance.startConsumer(
        [jobType],
        consumer(registry, { onEvent: (event) => events.push(event) }),
      );
      await waitFor(
        async () =>
          (await instance.getJob(job.jobId))?.status === 'failed' &&
          events.at(-1)?.type === 'job.failed',
      );
      await waitFor(async () => !(await mappingExistsFor(job.jobId)));

      expect(await instance.getJob(job.jobId)).toMatchObject({ status: 'failed', attempt: 1 });
      expect(events.map((event) => event.type)).toEqual(['job.started', 'job.failed']);
    } finally {
      moveToFailed.mockRestore();
    }
  });

  it('preserves dedupe when a failed event has no terminal transition marker', async () => {
    const { namespace, jobType } = testIdentity('indeterminate-failed-transition');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const redis = (await rawQueue.client) as unknown as {
      get(key: string): Promise<string | null>;
      keys(pattern: string): Promise<string[]>;
    };
    const identityPattern = rawQueue.toKey('*nestarc:identity:dedupe:*');
    const mappingExistsFor = async (jobId: string): Promise<boolean> => {
      for (const key of await redis.keys(identityPattern)) {
        const rawMapping = await redis.get(key);
        if (!rawMapping) continue;
        try {
          if ((JSON.parse(rawMapping) as { jobId?: unknown }).jobId === jobId) return true;
        } catch {
          continue;
        }
      }
      return false;
    };
    const events: JobLifecycleEvent[] = [];
    const registry = new HandlerRegistry();
    registry.register(jobType, async () => {
      const error = new Error('transition outcome is indeterminate');
      error.name = 'UnrecoverableError';
      throw error;
    });
    const job = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        attempts: 1,
        dedupe: { key: 'indeterminate-failed-transition', mode: 'while_active' },
      },
    );
    await expect(mappingExistsFor(job.jobId)).resolves.toBe(true);
    const moveToFailed = jest
      .spyOn(Job.prototype, 'moveToFailed')
      .mockImplementation(async () => undefined);

    try {
      instance.startConsumer(
        [jobType],
        consumer(registry, { onEvent: (event) => events.push(event) }),
      );
      await waitFor(async () => events.length >= 2);

      expect(events.map((event) => event.type)).toEqual(['job.started', 'job.retry_scheduled']);
      await expect(mappingExistsFor(job.jobId)).resolves.toBe(true);
    } finally {
      moveToFailed.mockRestore();
    }
  });

  it('preserves outbox identity and lineage through Redis restart and redelivery', async () => {
    const { namespace, jobType } = testIdentity('outbox');
    const first = backend(namespace, jobType);
    const Publisher = createOutboxJobsPublisher({
      map: { 'test.requested': jobType },
    });
    const publisher = new Publisher(service(first, jobType));
    const eventId = randomUUID();
    const record = {
      id: eventId,
      eventType: 'test.requested',
      payload: { value: 'preserved' },
      tenantId: 'tenant_1',
      correlationId: null,
      causationId: 'command_1',
    };

    await publisher.publish(record);
    await publisher.publish(record);
    await first.close();

    const restarted = backend(namespace, jobType);
    expect(await restarted.getJob(eventId)).toMatchObject({
      id: eventId,
      payload: record.payload,
      context: expect.objectContaining({
        tenantId: 'tenant_1',
        outboxEventId: eventId,
        correlationId: eventId,
        causationId: 'command_1',
      }),
      metadata: expect.objectContaining({
        source: '@nestarc/outbox',
        outboxEventId: eventId,
        correlationId: eventId,
      }),
    });
    let executions = 0;
    const registry = new HandlerRegistry();
    registry.register(jobType, async () => {
      executions += 1;
      return null;
    });
    restarted.startConsumer([jobType], consumer(registry));
    await waitFor(async () => (await restarted.getJob(eventId))?.status === 'succeeded');
    expect(executions).toBe(1);
  });

  it('supports global and tenant dedupe scopes with terminal release modes', async () => {
    const { namespace, jobType } = testIdentity('dedupe');
    const instance = backend(namespace, jobType);
    const jobs = service(instance, jobType);
    const global = { dedupe: { key: 'monthly', mode: 'while_active' as const } };

    const first = await jobs.enqueueDetailed(jobType, { sequence: 1 }, global);
    await expect(jobs.enqueueDetailed(jobType, { sequence: 2 }, global)).resolves.toMatchObject({
      status: 'deduped',
      jobId: first.jobId,
    });

    const tenantA = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        context: { tenantId: 'tenant_a' },
        dedupe: { key: 'monthly', scope: 'tenant', mode: 'until_completed' },
      },
    );
    const tenantB = await jobs.enqueueDetailed(
      jobType,
      {},
      {
        context: { tenantId: 'tenant_b' },
        dedupe: { key: 'monthly', scope: 'tenant', mode: 'until_completed' },
      },
    );
    expect(tenantA.jobId).not.toBe(tenantB.jobId);
    await expect(
      jobs.enqueueDetailed(
        jobType,
        {},
        {
          dedupe: { key: 'missing-tenant', scope: 'tenant' },
        },
      ),
    ).rejects.toThrow('tenantId');

    const explicitFirst = await jobs.enqueueDetailed(
      jobType,
      { sequence: 'explicit-1' },
      {
        jobId: 'explicit-1',
        dedupe: { key: 'explicit-business-key', mode: 'until_completed' },
      },
    );
    await expect(
      jobs.enqueueDetailed(
        jobType,
        { sequence: 'explicit-2' },
        {
          jobId: 'explicit-2',
          dedupe: { key: 'explicit-business-key', mode: 'until_completed' },
        },
      ),
    ).resolves.toMatchObject({ status: 'deduped', jobId: explicitFirst.jobId });

    const registry = new HandlerRegistry();
    registry.register(jobType, async () => null);
    instance.startConsumer([jobType], consumer(registry));
    await waitFor(async () => (await instance.getJob(first.jobId))?.status === 'succeeded');
    await expect(jobs.enqueueDetailed(jobType, { sequence: 3 }, global)).resolves.toMatchObject({
      status: 'created',
    });

    const delayedWhileActive = {
      delayMs: 250,
      dedupe: { key: 'active-with-ttl', mode: 'while_active' as const, ttlMs: 25 },
    };
    const delayedActiveJob = await jobs.enqueueDetailed(jobType, {}, delayedWhileActive);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await expect(jobs.enqueueDetailed(jobType, {}, delayedWhileActive)).resolves.toMatchObject({
      status: 'deduped',
      jobId: delayedActiveJob.jobId,
    });
    await waitFor(
      async () => (await instance.getJob(delayedActiveJob.jobId))?.status === 'succeeded',
    );
    await expect(jobs.enqueueDetailed(jobType, {}, delayedWhileActive)).resolves.toMatchObject({
      status: 'created',
    });

    const retained = {
      dedupe: { key: 'retained', mode: 'until_completed' as const, ttlMs: 100 },
    };
    const retainedJob = await jobs.enqueueDetailed(jobType, {}, retained);
    await waitFor(async () => (await instance.getJob(retainedJob.jobId))?.status === 'succeeded');
    await expect(jobs.enqueueDetailed(jobType, {}, retained)).resolves.toMatchObject({
      status: 'deduped',
      jobId: retainedJob.jobId,
    });
    await new Promise((resolve) => setTimeout(resolve, 125));
    const peer = backend(namespace, jobType);
    const renewed = await Promise.all([
      jobs.enqueueDetailed(jobType, { producer: 'a' }, retained),
      service(peer, jobType).enqueueDetailed(jobType, { producer: 'b' }, retained),
    ]);
    expect(renewed.map((result) => result.status).sort()).toEqual(['created', 'deduped']);
    expect(new Set(renewed.map((result) => result.jobId)).size).toBe(1);
    expect(renewed[0].jobId).not.toBe(retainedJob.jobId);
    expect(await instance.getJob(renewed[0].jobId)).toMatchObject({
      payload: expect.objectContaining({ producer: expect.stringMatching(/^[ab]$/) }),
    });
  });

  it('starts an until-completed TTL at completion even with a stale active snapshot', async () => {
    const { namespace, jobType } = testIdentity('dedupe-completion-race');
    const instance = backend(namespace, jobType, 1);
    const jobs = service(instance, jobType);
    const registry = new HandlerRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register(jobType, async () => blocked);
    instance.startConsumer([jobType], consumer(registry));

    const options = {
      dedupe: { key: 'completion-race', mode: 'until_completed' as const, ttlMs: 100 },
    };
    const first = await jobs.enqueueDetailed(jobType, {}, options);
    await waitFor(async () => (await instance.getJob(first.jobId))?.status === 'active');
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const activeSnapshot = await rawQueue.getJob(first.jobId);
    expect(activeSnapshot?.finishedOn).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 125));
    release();
    await waitFor(async () => (await instance.getJob(first.jobId))?.status === 'succeeded');

    const originalGetJob = rawQueue.getJob.bind(rawQueue);
    const getJob = jest
      .spyOn(rawQueue, 'getJob')
      .mockImplementationOnce(async () => activeSnapshot)
      .mockImplementation((jobId) => originalGetJob(jobId));
    try {
      await expect(jobs.enqueueDetailed(jobType, {}, options)).resolves.toMatchObject({
        status: 'deduped',
        jobId: first.jobId,
      });
    } finally {
      getJob.mockRestore();
    }
  });

  it('emits enqueued before worker lifecycle events for fast jobs', async () => {
    const { namespace, jobType } = testIdentity('event-order');
    const instance = backend(namespace, jobType);
    const registry = new HandlerRegistry();
    const events: JobLifecycleEvent[] = [];
    registry.register(jobType, async () => null);
    instance.startConsumer(
      [jobType],
      consumer(registry, { onEvent: (event) => events.push(event) }),
    );
    const jobs = new JobsService({
      backend: instance,
      registry: new HandlerRegistry(),
      jobTypes: [jobType],
      events: { onEvent: (event) => events.push(event) },
    });

    const jobIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      jobIds.push(await jobs.enqueue(jobType, { index }));
    }
    await waitFor(
      async () =>
        (await Promise.all(jobIds.map((jobId) => instance.getJob(jobId)))).every(
          (record) => record?.status === 'succeeded',
        ) && events.filter((event) => event.type === 'job.succeeded').length === jobIds.length,
    );

    for (const jobId of jobIds) {
      const types = events.filter((event) => event.jobId === jobId).map((event) => event.type);
      expect(types).toEqual(['job.enqueued', 'job.started', 'job.succeeded']);
    }
  });

  it('reports the first active BullMQ attempt as one', async () => {
    const { namespace, jobType } = testIdentity('active-attempt');
    const instance = backend(namespace, jobType, 1);
    const registry = new HandlerRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register(jobType, async () => blocked);
    instance.startConsumer([jobType], consumer(registry));

    const jobId = await service(instance, jobType).enqueue(jobType, {});
    await waitFor(async () => (await instance.getJob(jobId))?.status === 'active');
    await expect(instance.getJob(jobId)).resolves.toMatchObject({ status: 'active', attempt: 1 });
    release();
  });

  it('does not create global job-ID mappings for ordinary generated IDs', async () => {
    const { namespace, jobType } = testIdentity('ordinary-id-cleanup');
    const instance = backend(namespace, jobType);
    await service(instance, jobType).enqueue(jobType, {});
    const rawQueue = instance.getRawQueue<Queue>(jobType);
    const client = (await rawQueue.client) as unknown as {
      keys(pattern: string): Promise<string[]>;
    };

    await expect(client.keys(`bull:${namespace}:*nestarc:identity:jobId:*`)).resolves.toEqual([]);
  });

  it('waits for active work on close and leaves waiting work durable for another worker', async () => {
    const { namespace, jobType } = testIdentity('shutdown');
    const first = backend(namespace, jobType, 1);
    const registry = new HandlerRegistry();
    const jobs = service(first, jobType);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    registry.register(jobType, async (payload) => {
      if (payload.order === 1) {
        entered = true;
        await blocked;
        await jobs.enqueue(jobType, { order: 3 });
      }
      return null;
    });
    first.startConsumer([jobType], consumer(registry));
    const firstId = await jobs.enqueue(jobType, { order: 1 });
    const secondId = await jobs.enqueue(jobType, { order: 2 });
    await waitFor(() => entered);

    let closed = false;
    const closing = first.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(closed).toBe(false);
    await expect(jobs.enqueue(jobType, { order: 4 })).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });
    release();
    await closing;
    await expect(jobs.enqueue(jobType, { order: 5 })).rejects.toMatchObject({
      code: 'jobs_backend_closed',
    });

    const second = backend(namespace, jobType, 1);
    const resumedRegistry = new HandlerRegistry();
    resumedRegistry.register(jobType, async () => null);
    second.startConsumer([jobType], consumer(resumedRegistry));
    await waitFor(async () => (await second.getJob(secondId))?.status === 'succeeded');
    const rawQueue = second.getRawQueue<Queue>(jobType);
    await waitFor(async () => {
      const completed = await rawQueue.getJobs(['completed']);
      return completed.some((job) => (job.data as { order?: number }).order === 3);
    });
    expect(await second.getJob(firstId)).toMatchObject({ status: 'succeeded' });
  });

  it('waits for an enqueue that entered before close and releases its identity lock', async () => {
    const { namespace, jobType } = testIdentity('enqueue-close-race');
    const first = backend(namespace, jobType);
    const jobs = service(first, jobType);
    const rawQueue = first.getRawQueue<Queue>(jobType);
    const originalAdd = rawQueue.add.bind(rawQueue);
    let releaseAdd!: () => void;
    let enteredAdd!: () => void;
    const addEntered = new Promise<void>((resolve) => {
      enteredAdd = resolve;
    });
    const addBlocked = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const add = jest.spyOn(rawQueue, 'add').mockImplementation(async (...args) => {
      enteredAdd();
      await addBlocked;
      return originalAdd(...args);
    });

    try {
      const enqueue = jobs.enqueueDetailed(
        jobType,
        { source: 'closing-producer' },
        { idempotencyKey: 'closing-identity' },
      );
      await addEntered;
      let closed = false;
      const closing = first.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe(false);
      releaseAdd();
      await expect(enqueue).resolves.toMatchObject({ status: 'created' });
      await closing;

      const peer = backend(namespace, jobType);
      await expect(
        service(peer, jobType).enqueueDetailed(
          jobType,
          { source: 'retry' },
          { idempotencyKey: 'closing-identity' },
        ),
      ).resolves.toMatchObject({ status: 'deduped' });
    } finally {
      add.mockRestore();
      releaseAdd?.();
    }
  });

  it('closes the BullMQ backend through the Nest application lifecycle', async () => {
    moduleHandlerEntered = false;
    releaseModuleHandler = () => undefined;
    const namespace = `nestarc-module-${randomUUID()}`;
    const jobType = 'module.job';
    const instance = backend(namespace, jobType, 1);
    const app = await Test.createTestingModule({
      imports: [JobsModule.forBullMQ({ backend: instance, jobTypes: [jobType] })],
      providers: [RedisModuleHandler],
    }).compile();
    const jobs = app.get(JobsService);
    await jobs.enqueue(jobType, {});
    await waitFor(() => moduleHandlerEntered);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(closed).toBe(false);
    releaseModuleHandler();
    await closing;
    expect(closed).toBe(true);
  });

  it('drains BullMQ handlers before nested feature providers are destroyed', async () => {
    nestedHandlerEntered = false;
    releaseNestedHandler = () => undefined;
    nestedShutdownTimeline.length = 0;
    const namespace = `nestarc-nested-module-${randomUUID()}`;
    const jobType = 'nested.module.job';
    const instance = backend(namespace, jobType, 1);
    const app = await Test.createTestingModule({
      imports: [
        JobsModule.forBullMQ({ backend: instance, jobTypes: [jobType] }),
        NestedShutdownFeatureModule,
      ],
    }).compile();
    const jobs = app.get(JobsService);
    const jobId = await jobs.enqueue(jobType, {});
    await waitFor(() => nestedHandlerEntered);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(closed).toBe(false);
    expect(nestedShutdownTimeline).toEqual(['handler-enter']);
    releaseNestedHandler();
    await closing;

    expect(nestedShutdownTimeline).toEqual([
      'handler-enter',
      'dependency-use',
      'dependency-destroy',
    ]);
    const peer = backend(namespace, jobType);
    expect(await peer.getJob(jobId)).toMatchObject({ status: 'succeeded' });
  });

  function backend(namespace: string, jobType: string, workerConcurrency?: number): BullMQBackend {
    const instance = new BullMQBackend({ namespace, connection, workerConcurrency });
    instance.registerJobTypes([jobType]);
    backends.push(instance);
    queues.add(`${namespace}.${jobType}`);
    return instance;
  }
});

function service(backend: BullMQBackend, jobType: string): JobsService {
  return new JobsService({ backend, registry: new HandlerRegistry(), jobTypes: [jobType] });
}

function consumer(
  registry: HandlerRegistry,
  events?: { onEvent: (event: JobLifecycleEvent) => void },
) {
  return {
    registry,
    contextRunner: async (_context: unknown, fn: () => Promise<unknown>) => fn(),
    events,
  };
}

function testIdentity(label: string): { namespace: string; jobType: string } {
  return {
    namespace: `nestarc-${label}-${randomUUID()}`,
    jobType: 'test.job',
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}
