import {
  InMemoryBackend,
  JobsModule,
  JobsService,
  HandlerRegistry,
  BullMQBackend,
} from '../../src';
import { attachContext } from '../../src/context-serializer';

const invalidOptions = [
  { attempts: 0 },
  { attempts: 1.5 },
  { attempts: Number.MAX_SAFE_INTEGER + 1 },
  { delay: -1 },
  { delayMs: Infinity },
  { timeoutMs: 0 },
  { timeoutMs: 2147483648 },
  { scheduledFor: new Date(NaN) },
  { scheduledFor: new Date(8640000000000000) },
  { dedupe: { key: '' } },
  { dedupe: { key: 'k', scope: 'typo' } },
  { dedupe: { key: 'k', mode: 'typo' } },
  { dedupe: { key: 'k', ttlMs: NaN } },
  { idempotencyKey: '' },
  { backoff: { type: 'typo', delayMs: 1 } },
  { backoff: { type: 'fixed', delayMs: -1 } },
  { backoff: { type: 'fixed', delayMs: 1, jitter: 2 } },
];

describe('maintenance input boundary', () => {
  it.each(invalidOptions)(
    'rejects invalid options before reserving identity: %j',
    async (invalid) => {
      const backend = new InMemoryBackend();
      const service = new JobsService({
        backend,
        registry: new HandlerRegistry(),
        jobTypes: ['job'],
      });
      const opts = { jobId: 'reusable', ...invalid } as never;
      await expect(service.enqueue('job', {}, opts)).rejects.toMatchObject({
        code: 'jobs_invalid_input',
      });
      await expect(backend.enqueue('job', {}, opts)).rejects.toMatchObject({
        code: 'jobs_invalid_input',
      });
      expect(await backend.getJob('reusable')).toBeNull();
      expect(await backend.enqueue('job', {}, { jobId: 'reusable' })).toBe('reusable');
    },
  );

  it('validates all module job types and defaults eagerly', () => {
    expect(() => JobsModule.forInMemory({ jobTypes: ['valid', ''] })).toThrow();
    expect(() => JobsModule.forInMemory({ jobTypes: ['same', 'same'] })).toThrow();
    expect(() =>
      JobsModule.forInMemory({ jobTypes: ['job'], jobs: { job: { defaults: { attempts: 0 } } } }),
    ).toThrow();
    expect(() => new BullMQBackend({ connection: {}, workerConcurrency: 1.5 })).toThrow();
  });

  it.each([
    { shutdown: { timeoutMs: null } },
    { concurrency: { poolSize: null } },
    { concurrency: { typeCap: 0 } },
    { concurrency: { tenantCap: Infinity } },
    { concurrency: null },
    { shutdown: false },
    { jobs: { job: null } },
  ])('rejects malformed runtime configuration without silent defaults: %j', (options) => {
    expect(() => JobsModule.forInMemory({ jobTypes: ['job'], ...options } as never)).toThrow(
      'jobs_invalid_input',
    );
  });

  it.each([
    1n,
    () => 1,
    Symbol('x'),
    new Map(),
    new Set(),
    new Date(NaN),
    new (class Custom {})(),
    NaN,
    Infinity,
  ])('rejects nested nonportable values: %p', async (value) => {
    const backend = new InMemoryBackend();
    for (const envelope of [{ value: { nested: value } }, { __nestarcCtx: { nested: value } }]) {
      await expect(backend.enqueue('job', envelope, {})).rejects.toMatchObject({
        code: 'jobs_serialization_invalid',
      });
    }
    await expect(backend.enqueue('job', {}, { metadata: { nested: value } })).rejects.toMatchObject(
      { code: 'jobs_serialization_invalid' },
    );
  });

  it('enforces exact identifier and tenant contracts in both direct backends', async () => {
    const backends = [new InMemoryBackend(), new BullMQBackend({ connection: {} })];
    for (const backend of backends) {
      for (const jobType of ['', ' ', 'x'.repeat(257), 'queue:invalid']) {
        await expect(backend.enqueue(jobType, {}, {})).rejects.toMatchObject({
          code: 'jobs_invalid_input',
        });
      }
      for (const value of ['', ' ', 42, null, 'x'.repeat(1025)]) {
        await expect(backend.enqueue('job', {}, { jobId: value } as never)).rejects.toMatchObject({
          code: 'jobs_invalid_input',
        });
        await expect(
          backend.enqueue('job', { __nestarcCtx: { tenantId: value } }, {}),
        ).rejects.toMatchObject({ code: 'jobs_invalid_input' });
      }
      await expect(
        backend.enqueue('job', {}, { dedupe: { key: 'k', scope: 'tenant' } }),
      ).rejects.toMatchObject({ code: 'jobs_invalid_input' });
      await backend.close();
    }
  });

  it('rejects accessors, symbol keys and reserved envelopes without invoking user code', async () => {
    const getter = jest.fn(() => 'value');
    const value = Object.defineProperty({}, 'x', { get: getter, enumerable: true });
    const backend = new InMemoryBackend();
    for (const payload of [
      value,
      { [Symbol('x')]: 1 },
      {
        nested: {
          toJSON() {
            return {};
          },
        },
      },
    ]) {
      await expect(backend.enqueue('job', payload, {})).rejects.toMatchObject({
        code: 'jobs_serialization_invalid',
      });
    }
    expect(getter).not.toHaveBeenCalled();
    await expect(backend.enqueue('job', { __nestarcJob: undefined }, {})).rejects.toMatchObject({
      code: 'jobs_reserved_payload_key',
    });
  });

  it('normalizes Dates and undefined with JSON semantics and snapshots input', async () => {
    const backend = new InMemoryBackend();
    const value = {
      date: new Date('2026-01-01Z'),
      list: [undefined, { x: 1 }],
      omitted: undefined,
    };
    const id = await backend.enqueue('job', attachContext({ value }, {}), {
      metadata: { date: value.date },
    });
    value.list[1] = { x: 2 };
    const record = await backend.getJob(id);
    expect(record?.payload).toEqual({
      value: { date: '2026-01-01T00:00:00.000Z', list: [null, { x: 1 }] },
    });
    expect(record?.metadata).toEqual({ date: '2026-01-01T00:00:00.000Z' });
  });

  it('rejects cycles, oversized and deeply nested values', async () => {
    const backend = new InMemoryBackend();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 70; i++) deep = { deep };
    for (const value of [cycle, deep, { text: 'x'.repeat(1048577) }]) {
      await expect(backend.enqueue('job', value, {})).rejects.toMatchObject({
        code: 'jobs_serialization_invalid',
      });
    }
  });
});
