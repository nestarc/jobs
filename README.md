# @nestarc/jobs

Tenant-aware background jobs for NestJS.

This package provides:

- `JobsModule.forInMemory()` for single-process apps and tests with weighted tenant fairness
- `JobsModule.forBullMQ()` for Redis-backed queues using BullMQ's standard `Worker`
- ALS-style context capture and restore through `contextExtractor` and `contextRunner`
- `@JobHandler()` discovery through Nest provider scanning
- `createOutboxJobsPublisher()` for first-party `@nestarc/outbox` delivery into jobs
- `JobsOutboxBridge` for legacy, generic outbox-like sources
- `FakeJobsService` for deterministic tests without Redis
- typed contracts, lifecycle events, retry/backoff, idempotency, and explicit backend capabilities

## Status

Current package version: `0.3.1`

### Backend matrix

| Capability                               | In-memory backend             | BullMQ backend                |
| ---------------------------------------- | ----------------------------- | ----------------------------- |
| Automatic worker startup in `JobsModule` | Yes                           | Yes                           |
| Tenant fairness                          | Local process only            | No                            |
| Per-tenant weight control                | Yes                           | No                            |
| ALS/context propagation                  | Yes                           | Yes                           |
| `@JobHandler()` discovery                | Yes                           | Yes                           |
| First-party outbox publisher             | Yes                           | Yes                           |
| Status query                             | Yes                           | Yes, for registered job types |
| Durable transition history               | Process lifetime              | No                            |
| Retry/backoff                            | Yes                           | Yes                           |
| Cooperative timeout                      | Yes                           | No                            |
| Idempotency/dedupe                       | Yes                           | Yes, Redis-backed             |
| DLQ list/replay/discard                  | Yes                           | No                            |
| Manual pull/drain                        | Yes                           | No                            |
| Automatic graceful shutdown              | Yes                           | Yes                           |
| `FakeJobsService` support                | Yes, with deterministic clock | N/A                           |

## Install

Core package:

```bash
npm install @nestarc/jobs
```

If you use the BullMQ backend, install BullMQ too:

```bash
npm install bullmq
```

If you use the first-party outbox publisher, install the matching outbox package:

```bash
npm install @nestarc/outbox
```

Peer expectations:

- Node.js `20`, `22`, or `24`
- NestJS `^10` or `^11`
- BullMQ `^5.74.1` when using `forBullMQ()`
- `@nestarc/outbox ^0.2.0` when using `createOutboxJobsPublisher()`
- `reflect-metadata`
- `rxjs`

### Nest 11 + Prisma 7 Outbox consumer gate

Jobs does not have a direct Prisma peer. Prisma compatibility for the first-party publisher is
therefore verified against the actual `@nestarc/outbox` package artifact. The existing
`@nestarc/outbox ^0.2.0` peer accepts the Prisma 7-ready `0.2.1` patch without requiring a Jobs
release.

Run the strict tarball consumer with an explicit candidate or published artifact:

```bash
OUTBOX_PACKAGE=/absolute/path/nestarc-outbox-0.2.1.tgz \
  npm run test:consumer:modern
```

The gate refuses npm force/legacy peer bypasses, installs exact NestJS `11.2.1` and Prisma
`7.10.0`, compiles against the real Outbox transport types with `skipLibCheck` disabled, and runs
an Outbox-to-Jobs enqueue smoke test. CI can run the same gate through the `modern_outbox_package`
manual workflow input once the artifact is reachable from the runner. Normal CI detects and starts
requiring exact `@nestarc/outbox@0.2.1` as soon as that release is published; Jobs releases require
it unconditionally.

## Choose a backend

### In-memory backend

Use `forInMemory()` when:

- you run a single Nest process
- tenant fairness matters
- you want the simplest local or test setup

Important behavior:

- workers start automatically when the Nest module initializes
- tenant fairness is enforced by the in-process `Scheduler`
- this backend is not distributed across multiple processes
- shutdown closes admission first, then drains accepted active, queued, delayed, and retrying work before destroying feature dependencies
- `shutdown: { timeoutMs: 30_000 }` sets the graceful drain deadline (30 seconds by default; positive integer up to 2,147,483,647)
- enqueue (including dedupe acknowledgement) and dead-letter replay during/after shutdown reject with `jobs_backend_closed`

If drain exceeds its deadline, `app.close()` rejects with `JobsShutdownError`
(`code: 'jobs_shutdown_incomplete'`, `reason: 'deadline'`, `remainingJobIds`,
`remainingCount`). Admission stays closed; records and identity mappings remain
available while drain continues in the background. A later `app.close()` joins the
same drain with a new deadline. Backend resources close exactly once after all
accepted work and outstanding handler invocations finish. Successful close releases
in-memory records and history. This is a pre-1.0 minor behavior change, planned for
0.4.0; it does not add crash durability.

A handler that ignores `ctx.signal` retains its slot until its actual promise
settles. Timeout emits `job.timed_out` and aborts the signal immediately; the job
stays active until settlement, then records timeout failure and schedules any retry.
Late success cannot turn a timeout into success. A never-settling handler prevents
graceful completion. Observe the shutdown error, arrange cooperative handler
settlement, or explicitly terminate the process knowing that in-memory work is
lost. Administrative cancellation changes logical state but cannot stop JavaScript
or make shutdown treat an outstanding invocation as finished. Delivery remains
at-least-once; side effects are not exactly-once.

Stop upstream producers before closing Jobs. Handler follow-up enqueue during drain
also rejects; applications that relied on it must move production before admission
closes or handle the rejection. Nest shutdown ordering drains Jobs before feature
provider destruction in Nest 10 and 11. A co-located Outbox poller must stop before
Jobs admission closes; this change does not coordinate its separate shutdown hooks.

For standalone `InMemoryBackend`/`FairWorker` use, call `beginClose()` to stop
admission, drain workers (including future schedules), await `waitForIdle()` on
all workers, then call `backend.close()`. `outstandingJobIds()` reports worker-owned
invocations; `pendingJobIds()` reports backend nonterminal records. A direct backend
`close()` cannot run handlers and rejects with `JobsShutdownError` and
`reason: 'pending_jobs'` if nonterminal records remain. Explicitly cancel/disposition
those records or finish processing them before retrying close. Backend-only close
cannot observe externally owned handler promises, so their owner must await them.

### BullMQ backend

Use `forBullMQ()` when:

- you need Redis-backed persistence and BullMQ workers
- FIFO delivery is acceptable for now

Important behavior:

- jobs are processed by BullMQ's standard `Worker`
- tenant fairness is not implemented in `0.3.0`
- fairness-only APIs such as `setTenantWeight()` and `scheduler()` throw on this backend
- pull-based backend methods such as `peekWaiting()` and `moveToActive()` are unsupported on this backend
- `namespace` must not contain `.`, while declared job types such as `email.send` may contain dots
- registered job types are opened during module creation, so status lookup and consumption survive app restarts
- Nest shutdown waits for active handlers and closes BullMQ workers and queues automatically

## Quickstart: In-memory

```ts
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { JobHandler, JobsModule } from '@nestarc/jobs';

@Injectable()
class ReportHandler {
  @JobHandler('sendReport')
  async handle(payload: { userId: string }, ctx: { tenantId?: string }): Promise<void> {
    console.log('tenant', ctx.tenantId, 'user', payload.userId);
  }
}

@Module({
  imports: [
    JobsModule.forInMemory({
      jobTypes: ['sendReport'],
      fairness: { defaultWeight: 1, minSharePct: 0.1 },
      concurrency: { tenantCap: 10 },
    }),
  ],
  providers: [ReportHandler],
})
export class AppModule {}
```

Then enqueue with `JobsService`:

```ts
await jobs.enqueue(
  'sendReport',
  { userId: 'u1' },
  {
    context: { tenantId: 'tenant-a' },
  },
);
```

## Quickstart: BullMQ

```ts
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { BullMQBackend, JobHandler, JobsModule } from '@nestarc/jobs';

@Injectable()
class ReportHandler {
  @JobHandler('sendReport')
  async handle(payload: { userId: string }): Promise<void> {
    console.log(payload.userId);
  }
}

const backend = new BullMQBackend({
  namespace: 'acme',
  connection: { host: '127.0.0.1', port: 6379 },
  workerConcurrency: 10,
});

@Module({
  imports: [
    JobsModule.forBullMQ({
      backend,
      jobTypes: ['sendReport'],
    }),
  ],
  providers: [ReportHandler],
})
export class AppModule {}
```

On BullMQ in `0.3.0`, jobs are delivered FIFO by BullMQ's worker. Context and metadata are persisted in Redis and restored after restart, but tenant fairness is not applied.

### Upgrading BullMQ deployments from 0.2

BullMQ deployments must not run `0.2.x` and `0.3.x` producers or workers against the same queues at the same time. Version 0.3 uses a new persisted envelope, generated idempotency IDs, and worker-side backoff strategy that version 0.2 does not understand.

Use a coordinated upgrade:

1. Stop all 0.2 producers and workers.
2. Deploy 0.3 to every producer and worker.
3. Resume production only after every process runs 0.3.

Version 0.3 rejects a dotted BullMQ namespace when the backend is constructed. If a 0.2 deployment uses one, drain or explicitly migrate its existing queues and switch to a dot-free namespace before starting 0.3; changing the namespace changes the BullMQ queue names and identity keyspace. Dots in job types remain supported.

Version 0.3 workers can consume jobs that were already queued by version 0.2, and they adopt an existing v0.2 raw idempotency job when it is present. If v0.2 used the same raw idempotency key in multiple job-type queues, each queue adopts its own job while a shared legacy claim continues to block a new explicit job from reusing that raw ID. Direct status lookup by that duplicated legacy raw ID remains inherently ambiguous and returns the first matching registered queue; queue processing and job-type-scoped idempotent enqueue remain independent. This backward-read support does not make mixed-version rolling operation safe.

## Typed job contracts

The optional TypeScript contract layer preserves existing string-based APIs. Job defaults are applied at runtime, with enqueue options taking precedence. Pass the definitions through the `jobs` option of `JobsModule.forInMemory()` or `JobsModule.forBullMQ()` to enable those runtime defaults.

```ts
import { Module } from '@nestjs/common';
import { defineJobs, InjectJobs, job, JobsModule, type TypedJobsService } from '@nestarc/jobs';

export const appJobs = defineJobs({
  'email.send': job<{ messageId: string }>()
    .context<{ tenantId: string }>()
    .result<void>()
    .defaults({ attempts: 3 }),
});

type AppJobs = typeof appJobs;

class Mailer {
  constructor(@InjectJobs() private readonly jobs: TypedJobsService<AppJobs>) {}

  send(): Promise<string> {
    return this.jobs.enqueue(
      'email.send',
      { messageId: 'msg_1' },
      {
        context: { tenantId: 'tenant_1' },
      },
    );
  }
}

@Module({
  imports: [
    JobsModule.forInMemory({
      jobs: appJobs,
      jobTypes: Object.keys(appJobs),
    }),
  ],
  providers: [Mailer],
})
export class MailJobsModule {}
```

## Context propagation

`JobsService.enqueue()` stores context under an internal reserved key and restores it before invoking the handler.

You can plug in your own context system:

```ts
JobsModule.forInMemory({
  jobTypes: ['sendReport'],
  events: {
    onEvent: (event) => logger.info(event, 'job lifecycle'),
  },
  contextExtractor: () => ({
    tenantId: tenancy.currentTenantId(),
    requestId: requestScope.currentRequestId(),
  }),
  contextRunner: (ctx, fn) => tenancy.run(ctx, fn),
});
```

Notes:

- payloads and contexts must be plain objects; primitives, arrays, functions, built-ins such as
  `Date`/`Map`, and class instances are rejected before enqueue
- use `Record<string, never>` for a typed job with an intentionally empty payload
- payloads must not contain the reserved keys `__nestarcCtx` or `__nestarcJob`
- if you do not provide a context extractor, the default context is `{}`
- the in-memory backend snapshots payload, context, metadata, and backoff inputs; later producer or
  handler mutation does not change the stored job record

## Handler discovery

`JobsModule` scans Nest providers for methods decorated with `@JobHandler(jobType)`.
Discovery runs during Nest application bootstrap, after provider construction and all
`onModuleInit()` hooks have completed. The in-memory polling loop and BullMQ consumers start only
after discovery finishes, so jobs queued before `app.init()` remain queued until handlers are
registered. In tests or standalone application contexts, call `app.init()`; `compile()` alone does
not start consumers.

```ts
import { Injectable } from '@nestjs/common';
import { JobHandler, type TypedJobHandler } from '@nestarc/jobs';

type AppJobs = typeof appJobs;

@Injectable()
export class EmailHandler implements TypedJobHandler<AppJobs, 'email.send'> {
  @JobHandler('email.send')
  async handle(payload: { messageId: string }, ctx: { tenantId: string }): Promise<void> {
    // do work
  }
}
```

Decorator handlers must be singleton providers with a static dependency tree. Request-scoped and
transient handlers (including singleton handlers that depend on a request-scoped tree) fail during
bootstrap with an actionable error. Use the public `HandlerRegistry.register()` API when handler
resolution must be managed dynamically.

If no handler is registered for a job type, the library throws `jobs_handler_not_found`.

## JobsService API

Primary service methods:

- `enqueue(jobType, payload, opts?)`
- `enqueueDetailed(jobType, payload, opts?)`
- `getJob(jobId)`
- `getJobHistory(jobId)`
- `capabilities()`
- `listDeadLetters(filter?)`
- `replayDeadLetter(jobId, opts?)`
- `discardDeadLetter(jobId, reason?)`
- `setTenantWeight(jobType, tenantId, weight)`
- `scheduler(jobType)`

`EnqueueOptions`:

- `jobId?: string`
- `context?: JobContext`
- `delay?: number`
- `delayMs?: number`
- `scheduledFor?: Date`
- `attempts?: number`
- `backoff?: { type: 'fixed'; delayMs: number; jitter?: number } | { type: 'exponential'; delayMs: number; maxDelayMs?: number; jitter?: number }`
- `timeoutMs?: number`
- `idempotencyKey?: string`
- `dedupe?: { key: string; scope?: 'global' | 'tenant'; ttlMs?: number; mode?: 'while_active' | 'until_completed' }`
- `metadata?: Record<string, unknown>`

Behavior notes:

- `jobType` must be declared in the module or service setup
- `setTenantWeight()` and `scheduler()` are only available on fairness-enabled backends
- `enqueue()` still returns `Promise<string>` for compatibility
- `enqueueDetailed()` returns whether a job was created or deduped
- retries are opt-in; default `attempts` is `1`
- negative or non-finite backoff values normalize to `0`; a finite `maxDelayMs` still caps exponential
  overflow, while a final non-finite exponential or jitter result normalizes to `0`
- handler timeout uses cooperative cancellation through `ctx.signal` on the in-memory backend
- BullMQ rejects `timeoutMs`, history, DLQ helpers, and manual drain with `jobs_capability_unsupported`
- lifecycle callbacks are observational; thrown errors and rejected promises do not alter enqueue or handler outcomes
- BullMQ producer and worker events can cross process boundaries; consumers that merge events from
  multiple processes should use timestamps and terminal-state precedence rather than arrival order

## Status, retry, idempotency, and DLQ

```ts
const jobId = await jobs.enqueue('deliverWebhook', payload, {
  context: { tenantId },
  attempts: 5,
  backoff: { type: 'exponential', delayMs: 1_000, maxDelayMs: 60_000 },
  idempotencyKey: deliveryId,
});

const record = await jobs.getJob(jobId);
const history = await jobs.getJobHistory(jobId);
```

When attempts are exhausted, the in-memory backend moves the job to `dead_letter` by default.

```ts
const failed = await jobs.listDeadLetters({ type: 'deliverWebhook' });
const replayedJobId = await jobs.replayDeadLetter(failed[0].id);

// Alternatively, discard the job instead of replaying it:
// await jobs.discardDeadLetter(failed[0].id, 'handled manually');
```

In-memory replay preserves and rebinds the original idempotency/dedupe identity to the replayed job. Attempts reset by default for a new replay ID; pass `{ resetAttempts: false }` to retain the recorded attempt count. With `{ preserveOriginalId: true }`, the lifetime attempt count never resets. By default a fresh retry budget is added to that count (`maxAttempts` becomes the cumulative ceiling), and backoff starts at the first attempt of the replay generation. `resetAttempts: false` retains the previous ceiling and backoff position. A successful discard emits `job.discarded`; repeated, missing, or non-dead-letter discard calls are no-ops and emit nothing.

Tenant-scoped dedupe requires a tenant id:

```ts
await jobs.enqueueDetailed('generateReport', payload, {
  context: { tenantId },
  dedupe: { key: `report:${reportId}`, scope: 'tenant' },
});
```

Identity and dedupe keys are scoped to a job type; `scope: 'global'` means across tenants of that type. `while_active` always releases at a terminal state, and `ttlMs` does not shorten that active window. For `until_completed`, `ttlMs` permits a new identity only after the retained job is terminal and the TTL has elapsed. The mode and TTL stored by the active identity remain authoritative until that identity is released, so a rolling configuration change cannot weaken an existing dedupe window. These are duplicate-enqueue controls, not exactly-once execution guarantees.

For BullMQ jobs carrying v0.3 dedupe metadata, terminal worker events make a best-effort attempt to delete `while_active` mappings and start the configured `until_completed` TTL at the terminal transition. Enqueue-time reconciliation remains the fallback if that cleanup cannot complete.

When one supplied identity matches a job and the other identity is unused, both identities are bound to that job. If the supplied identities already resolve to different jobs, enqueue fails with `jobs_identity_conflict`; the library does not silently replace an active mapping.

## Tenant fairness

The in-memory backend uses a shard-based scheduler with:

- per-tenant waiting queues
- weighted dispatch
- `minSharePct` starvation protection
- per-tenant inflight caps
- due-time promotion for delayed jobs and retries

Future work stays outside weighted dispatch and starvation accounting until it is due, so it does not block ready work from the same or another tenant. Scheduler snapshots still include deferred work in each tenant's `waiting` count. `defaultWeight` and `tenantCap` must be positive safe integers, `minSharePct` must be finite and within `[0, 1]`, and runtime tenant weights must be non-negative safe integers (`0` is allowed); invalid values throw `jobs_fairness_misconfig`.

You can adjust weights at runtime:

```ts
jobs.setTenantWeight('sendReport', 'enterprise-tenant', 3);
jobs.setTenantWeight('sendReport', 'free-tenant', 1);
```

For lower-level inspection:

```ts
const snapshot = jobs.scheduler('sendReport').snapshot();
```

## First-party outbox publisher

Use the publisher factory as the `@nestarc/outbox` transport. Publishing resolves only after Redis or in-memory enqueue succeeds, so mapping and enqueue failures remain retryable by the outbox poller.

```ts
import { OutboxModule } from '@nestarc/outbox';
import { createOutboxJobsPublisher } from '@nestarc/jobs';
import { PrismaService } from './prisma.service';

const JobsPublisher = createOutboxJobsPublisher({
  map: {
    'invoice.issued': { job: 'invoice.process' },
    'system.reindex_requested': {
      job: 'system.reindex',
      tenant: 'optional',
    },
  },
});

OutboxModule.forRoot({
  prisma: PrismaService,
  transport: JobsPublisher,
  delivery: { mode: 'publisher' },
});
```

The adapter sets both `jobId` and `idempotencyKey` to the outbox record ID. It preserves `tenantId`, `outboxEventId`, `correlationId` (falling back to the event ID), and optional `causationId` in context and metadata. Missing mappings, including inherited object property names, and missing required tenants fail closed by default. Delivery remains at-least-once; retain BullMQ terminal job records for at least the outbox retry and operator-recovery horizon.

For tenant-bearing events, mapping-level `dedupe: { key }` defaults to `scope: 'tenant'`
using the resolved tenant. Two tenants with the same key enqueue separate jobs. To intentionally
collapse work across tenants of a job type, set `dedupe: { key, scope: 'global' }` explicitly.
A `tenant: 'optional'` event without a tenant retains global dedupe; explicit tenant-scoped dedupe
without a tenant fails closed. The generic `JobsService` dedupe default remains global.

A successful `publish()` acknowledges enqueue or duplicate suppression. Outbox `SENT` does not
mean the Jobs handler succeeded. A suppressed event may have no separate job under its record ID;
the retained job keeps its original record ID as both `jobId` and `idempotencyKey`.

Context fields `tenantId`, `outboxEventId`, `correlationId`, and `causationId` are source-owned.
Metadata fields `source`, `outboxEventId`, `outboxEventType`, `tenantId`, `correlationId`,
`causationId`, `aggregateType`, `aggregateId`, `partitionKey`, `outboxIdempotencyKey`,
`outboxHeaders`, and `outboxOccurredAt` are also reserved. Mapping values for these fields are
removed before source lineage is applied, including when a source value is absent. Other custom
context and metadata fields are preserved. Only an explicit `target.tenant` function can remap
the tenant. Source identity and lineage (including headers and occurrence time) are snapshotted
before mapping callbacks run, so mutating a callback's record cannot replace canonical lineage.

## Legacy generic bridge

`JobsOutboxBridge` remains available for compatibility with generic sources that expose `onEvent()`; it is not the `@nestarc/outbox` publisher transport.

```ts
import { JobsOutboxBridge } from '@nestarc/jobs';

new JobsOutboxBridge({
  jobs,
  source: outboxSource,
  map: {
    'data_subject.erasure_requested': 'handleErasure',
    'webhook.delivery_due': 'deliverWebhook',
  },
});
```

The bridge forwards `event.tenantId` by default. You can override it:

```ts
new JobsOutboxBridge({
  jobs,
  source: outboxSource,
  map: { 'report.ready': 'sendReport' },
  tenantFrom: (event) => `tenant:${event.tenantId}`,
});
```

The bridge only uses own properties of `map`; inherited names such as `toString`, `constructor`, or `__proto__` are treated as unmapped and ignored.

## Testing

Use `FakeJobsService` when you want deterministic tests without Redis.

```ts
import { FakeJobsService } from '@nestarc/jobs';

it('processes a job', async () => {
  const fake = new FakeJobsService({
    jobTypes: ['sendReport'],
    tenantCap: 2,
    defaultWeight: 1,
    minSharePct: 0.1,
  });

  fake.registry.register('sendReport', async (payload, ctx) => {
    expect(ctx.tenantId).toBe('tenant-a');
    expect(payload).toEqual({ userId: 'u1' });
  });

  await fake.service.enqueue(
    'sendReport',
    { userId: 'u1' },
    {
      context: { tenantId: 'tenant-a' },
    },
  );

  await fake.drain();
});
```

For delayed jobs and retry tests, use `createFakeJobs()` with its deterministic clock:

```ts
import { createFakeJobs } from '@nestarc/jobs';

it('advances delayed work deterministically', async () => {
  const fake = createFakeJobs({
    jobTypes: ['webhook.deliver'],
    now: new Date('2026-06-20T00:00:00.000Z'),
  });

  fake.registry.register('webhook.deliver', async () => undefined);

  const jobId = await fake.service.enqueue(
    'webhook.deliver',
    { deliveryId: 'del_1' },
    {
      delayMs: 1_000,
    },
  );

  await fake.drainUntilIdle();
  fake.clock.advanceBy(1_000);
  await fake.drainUntilIdle();
  expect(await fake.service.getJob(jobId)).toMatchObject({ status: 'succeeded' });
});
```

When production uses typed runtime defaults, pass the same definitions as `jobs` so the fake applies identical attempts, backoff, and timeout values.

```ts
const fake = createFakeJobs({
  jobs: appJobs,
  jobTypes: Object.keys(appJobs),
});
```

## Low-level exports

The package also exports lower-level building blocks for custom composition:

- `JobsService`
- `HandlerRegistry`
- `Scheduler`
- `FairWorker`
- `InMemoryBackend`
- `BullMQBackend`
- `createOutboxJobsPublisher()`
- `JobsOutboxBridge`
- `attachContext()`
- `detachContext()`
- `CONTEXT_KEY`
- `INTERNAL_JOB_KEY`
- `JOBS_BACKEND`
- `JOBS_WORKERS`

## Error codes

The library exposes these error codes through `JobsError`:

- `jobs_reserved_payload_key`
- `jobs_handler_not_found`
- `jobs_queue_not_found`
- `jobs_fairness_misconfig`
- `jobs_capability_unsupported`
- `jobs_backend_closed`
- `jobs_identity_conflict`

## Limitations

- In-memory fairness is process-local and intended for single-process execution.
- BullMQ fairness is not implemented in `0.3.0`.
- BullMQ backend does not support pull-based fairness operations such as `peekWaiting()` or `moveToActive()`.
- Fairness control APIs are unavailable on BullMQ in this release.
- BullMQ durable history, timeout, and DLQ list/replay/discard are intentionally reported as unsupported.

## Development

Useful scripts:

```bash
npm run build
npm test
docker compose -f docker-compose.redis.yml up -d
REDIS_URL=redis://127.0.0.1:16379 npm run test:redis
REDIS_URL=redis://127.0.0.1:16379 npm run test:coverage
npm run lint
```

Release flow:

1. Update the package version and changelog, then run the local verification above with a clean worktree.
2. Push the release commit to `main` and wait for its CI run to pass.
3. Confirm the exact release commit is present on remote `main`.
4. Create and push a matching tag such as `v0.3.0` from that commit.
5. GitHub Actions runs the same Node/Nest/Redis/package verification used by pull requests, then publishes that verified tarball through trusted publishing and creates a GitHub release.

The npm trusted publisher is configured for:

- Publisher: GitHub Actions
- Repository: `nestarc/jobs`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

## Docs

- [Historical v0.1 PRD](docs/prd.md)
- [Historical v0.1 technical spec](docs/spec.md)
- [Historical v0.2.0 draft proposal](docs/spec-v0.2.md)
- [v0.3.0 stabilization contract](docs/spec-v0.3.md)

## License

MIT

### Custom backend activation contract (planned 0.4.0)

`FairWorker` requires `capabilities().activationFencing === true`. A custom backend
must generate a fresh, opaque `activationId` on every successful `moveToActive`,
return it on the envelope, and atomically validate it with the active state for
`ack(jobType, jobId, activationId)` and
`fail(jobType, jobId, reason, activationId)`. Direct in-memory `markFailed` takes
the token before its optional error summary. Do not infer the token from the latest
job state: carry the token from the invocation being completed. Legacy custom
backends must implement this contract before opting into the capability; the worker
fails at construction if the capability is absent. BullMQ keeps its own worker lock
contract and does not use these manual completion APIs.

| Current state | Operation | Result |
| --- | --- | --- |
| queued / due delayed | moveToActive | active, fresh token, attempt +1 |
| future delayed / active / terminal / missing | moveToActive | null; no mutation |
| active with matching token | ack | succeeded |
| active with matching token | fail / markFailed | retry scheduled, failed, or dead letter according to budget |
| missing / non-active / wrong type / stale or absent token | ack / fail / markFailed | `jobs_activation_conflict`; no history or budget mutation |
| queued / delayed / active | markCancelled | cancelled; late completions conflict |
| terminal | markCancelled | unchanged; no new history |
| dead_letter | explicit replay / discard | new replay generation / cancelled |

Duplicate and opposite terminal completions both conflict. Only explicit dead-letter
administration can leave a terminal state; a same-ID replay creates a new activation
and preserves monotonic attempt history. The public backend signature, lifecycle
event union, same-ID replay accounting, and shutdown defaults require a 0.4.0 minor
release. The package version is advanced by the separate release task.
