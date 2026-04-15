# @nestarc/jobs

Tenant-aware background jobs for NestJS.

This package provides:

- `JobsModule.forInMemory()` for single-process apps and tests with weighted tenant fairness
- `JobsModule.forBullMQ()` for Redis-backed queues using BullMQ's standard `Worker`
- ALS-style context capture and restore through `contextExtractor` and `contextRunner`
- `@JobHandler()` discovery through Nest provider scanning
- `JobsOutboxBridge` for forwarding outbox events into jobs
- `FakeJobsService` for deterministic tests without Redis

## Status

Current package version: `0.1.0`

### Backend matrix

| Capability | In-memory backend | BullMQ backend |
| --- | --- | --- |
| Automatic worker startup in `JobsModule` | Yes | Yes |
| Tenant fairness | Yes | No |
| Per-tenant weight control | Yes | No |
| ALS/context propagation | Yes | Yes |
| `@JobHandler()` discovery | Yes | Yes |
| Outbox bridge | Yes | Yes |
| `FakeJobsService` support | Yes | N/A |

## Install

Core package:

```bash
npm install @nestarc/jobs
```

If you use the BullMQ backend, install BullMQ too:

```bash
npm install bullmq
```

Peer expectations:

- Node.js `>= 20`
- NestJS `^10`
- `reflect-metadata`
- `rxjs`

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

### BullMQ backend

Use `forBullMQ()` when:

- you need Redis-backed persistence and BullMQ workers
- FIFO delivery is acceptable for now

Important behavior:

- jobs are processed by BullMQ's standard `Worker`
- tenant fairness is not implemented in `0.1.0`
- fairness-only APIs such as `setTenantWeight()` and `scheduler()` throw on this backend
- pull-based backend methods such as `peekWaiting()` and `moveToActive()` are unsupported on this backend

## Quickstart: In-memory

```ts
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { JobHandler, JobsModule } from '@nestarc/jobs';

@Injectable()
class ReportHandler {
  @JobHandler('sendReport')
  async handle(
    payload: { userId: string },
    ctx: { tenantId?: string },
  ): Promise<void> {
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
await jobs.enqueue('sendReport', { userId: 'u1' }, {
  context: { tenantId: 'tenant-a' },
});
```

## Quickstart: BullMQ

```ts
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import {
  BullMQBackend,
  JobHandler,
  JobsModule,
} from '@nestarc/jobs';

@Injectable()
class ReportHandler {
  @JobHandler('sendReport')
  async handle(payload: { userId: string }): Promise<void> {
    console.log(payload.userId);
  }
}

const backend = new BullMQBackend({
  namespace: 'acme',
  connection: { url: process.env.REDIS_URL! },
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

On BullMQ in `0.1.0`, jobs are delivered FIFO by BullMQ's worker. This path does restore captured context, but it does not apply tenant fairness.

## Context propagation

`JobsService.enqueue()` stores context under an internal reserved key and restores it before invoking the handler.

You can plug in your own context system:

```ts
JobsModule.forInMemory({
  jobTypes: ['sendReport'],
  contextExtractor: () => ({
    tenantId: tenancy.currentTenantId(),
    requestId: requestScope.currentRequestId(),
  }),
  contextRunner: (ctx, fn) => tenancy.run(ctx, fn),
});
```

Notes:

- payloads must not contain the reserved key `__nestarcCtx`
- if you do not provide a context extractor, the default context is `{}`

## Handler discovery

`JobsModule` scans Nest providers for methods decorated with `@JobHandler(jobType)`.

```ts
import { Injectable } from '@nestjs/common';
import { JobHandler } from '@nestarc/jobs';

@Injectable()
export class WebhookHandler {
  @JobHandler('deliverWebhook')
  async handle(
    payload: { url: string },
    ctx: { tenantId?: string },
  ): Promise<void> {
    // do work
  }
}
```

If no handler is registered for a job type, the library throws `jobs_handler_not_found`.

## JobsService API

Primary service methods:

- `enqueue(jobType, payload, opts?)`
- `setTenantWeight(jobType, tenantId, weight)`
- `scheduler(jobType)`

`EnqueueOptions`:

- `jobId?: string`
- `context?: JobContext`
- `delay?: number`
- `attempts?: number`

Behavior notes:

- `jobType` must be declared in the module or service setup
- `setTenantWeight()` and `scheduler()` are only available on fairness-enabled backends
- BullMQ uses `jobId`, `delay`, and `attempts`
- the in-memory backend is focused on single-process execution and tests, so delay/retry behavior is not modeled like BullMQ

## Tenant fairness

The in-memory backend uses a shard-based scheduler with:

- per-tenant waiting queues
- weighted dispatch
- `minSharePct` starvation protection
- per-tenant inflight caps

You can adjust weights at runtime:

```ts
jobs.setTenantWeight('sendReport', 'enterprise-tenant', 3);
jobs.setTenantWeight('sendReport', 'free-tenant', 1);
```

For lower-level inspection:

```ts
const snapshot = jobs.scheduler('sendReport').snapshot();
```

## Outbox bridge

`JobsOutboxBridge` subscribes to an outbox-like source and enqueues mapped job types.

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

## Testing

Use `FakeJobsService` when you want deterministic tests without Redis.

```ts
import { FakeJobsService } from '@nestarc/jobs';

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

await fake.service.enqueue('sendReport', { userId: 'u1' }, {
  context: { tenantId: 'tenant-a' },
});

await fake.drain();
```

## Low-level exports

The package also exports lower-level building blocks for custom composition:

- `JobsService`
- `HandlerRegistry`
- `Scheduler`
- `FairWorker`
- `InMemoryBackend`
- `BullMQBackend`
- `JobsOutboxBridge`
- `attachContext()`
- `detachContext()`
- `CONTEXT_KEY`
- `JOBS_BACKEND`
- `JOBS_WORKERS`

## Error codes

The library exposes these error codes through `JobsError`:

- `jobs_reserved_payload_key`
- `jobs_handler_not_found`
- `jobs_queue_not_found`
- `jobs_fairness_misconfig`

## Limitations

- In-memory fairness is process-local and intended for single-process execution.
- BullMQ fairness is not implemented in `0.1.0`.
- BullMQ backend does not support pull-based fairness operations such as `peekWaiting()` or `moveToActive()`.
- Fairness control APIs are unavailable on BullMQ in this release.

## Development

Useful scripts:

```bash
npm run build
npm test
npm run lint
```

Release flow:

1. Update the package version and changelog.
2. Push the version commit.
3. Create and push a matching tag such as `v0.1.0`.
4. GitHub Actions will run the release workflow, validate the tag against `package.json`, publish to npm, and create a GitHub release.

## Docs

- [PRD](docs/prd.md)
- [Technical spec](docs/spec.md)

## License

MIT
