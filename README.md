# @nestarc/jobs

Tenant-fair background jobs for NestJS multi-tenant SaaS. ALS context propagation, `@JobHandler` discovery, and outbox bridge — working today on both in-memory and BullMQ backends.

## v0.1 scope (honest summary)

| Capability | In-memory backend | BullMQ backend (v0.1) | BullMQ backend (v0.2) |
|---|---|---|---|
| Tenant fairness (shard-based WRR) | ✅ full | ❌ FIFO | ✅ full (Lua scripts) |
| ALS context propagation | ✅ | ✅ | ✅ |
| `@JobHandler` discovery | ✅ | ✅ | ✅ |
| Outbox bridge | ✅ | ✅ | ✅ |
| `FakeJobsService` for tests | ✅ | — | — |

In-memory is production-suitable for single-process deployments and is the recommended test backend. BullMQ backend in v0.1 uses standard `Worker` (FIFO); v0.2 closes the gap with Lua scripts for Pro-Groups parity.

## Install

```bash
npm install @nestarc/jobs bullmq
```

## Quickstart — In-Memory (full fairness)

```typescript
import { Module } from '@nestjs/common';
import { JobsModule } from '@nestarc/jobs';

@Module({
  imports: [
    JobsModule.forInMemory({
      jobTypes: ['sendReport', 'deliverWebhook'],
      fairness: { minSharePct: 0.1, defaultWeight: 1 },
      concurrency: { tenantCap: 10 },
    }),
  ],
  providers: [ReportHandler],
})
export class AppModule {}
```

## Quickstart — BullMQ (FIFO in v0.1)

```typescript
import { Module } from '@nestjs/common';
import { JobsModule, BullMQBackend } from '@nestarc/jobs';

@Module({
  imports: [
    JobsModule.forBullMQ({
      backend: new BullMQBackend({
        namespace: 'acme',
        connection: { url: process.env.REDIS_URL! },
        workerConcurrency: 10,
      }),
      jobTypes: ['sendReport', 'deliverWebhook'],
    }),
  ],
  providers: [ReportHandler],
})
export class AppModule {}
```

> **Note**: BullMQ backend in v0.1 does NOT honor tenant fairness. Jobs are delivered FIFO. Tenant-fair BullMQ is planned for v0.2 via Redis Lua scripts. Use `forInMemory` today if fairness matters, or write tests with `FakeJobsService`.

### Write a handler

```typescript
import { Injectable } from '@nestjs/common';
import { JobHandler } from '@nestarc/jobs';

@Injectable()
export class ReportHandler {
  @JobHandler('sendReport')
  async handle(payload: { userId: string }, ctx: { tenantId?: string }) {
    // ctx.tenantId is restored from the ALS snapshot captured at enqueue time.
  }
}
```

### Enqueue

```typescript
await this.jobs.enqueue('sendReport', { userId: 'u1' });
```

### Outbox bridge

```typescript
new JobsOutboxBridge({
  jobs: this.jobs,
  source: outboxService,
  map: {
    'data_subject.erasure_requested': 'handleErasure',
    'webhook.delivery_due': 'deliverWebhook',
  },
});
```

## Docs

- [`docs/prd.md`](docs/prd.md) — Product requirements
- [`docs/spec.md`](docs/spec.md) — Technical spec

## License

MIT
