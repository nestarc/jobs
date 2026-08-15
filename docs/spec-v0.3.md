# @nestarc/jobs v0.3 stabilization contract

Status: Implemented

## Goal

v0.3 stabilizes the production BullMQ path and adds the first-party `@nestarc/outbox` publisher adapter. It does not add distributed tenant fairness.

## Backend capabilities

| Capability  | In-memory    | BullMQ |
| ----------- | ------------ | ------ |
| durable     | false        | true   |
| distributed | false        | true   |
| delayed     | true         | true   |
| retries     | true         | true   |
| backoff     | true         | true   |
| timeout     | true         | false  |
| statusQuery | true         | true   |
| history     | true         | false  |
| idempotency | true         | true   |
| deadLetter  | true         | false  |
| fairness    | local-tenant | none   |
| manualDrain | true         | false  |

Unsupported operations fail with `jobs_capability_unsupported`; they must not return empty or synthetic results.

## BullMQ behavior

- Queue discovery is limited to `jobTypes` registered by `JobsModule.forBullMQ()` or `registerJobTypes()`. Redis key scanning for undeclared queues is out of scope.
- `scheduledFor` takes precedence over `delayMs`, which takes precedence over `delay`. Past times run without delay.
- The public fixed/exponential backoff policy is evaluated by the worker, including `maxDelayMs` and symmetric bounded `jitter`.
- Context, user metadata, schedule, idempotency key, dedupe key, and backoff policy are stored in a versioned job envelope. v0.2 envelopes remain readable.
- Redis identity mappings scope `idempotencyKey` and dedupe keys to a job type. Generated idempotent IDs also include queue identity, so status IDs remain unique across registered queues. Explicit `jobId` values retain their public value without bypassing idempotency or `until_completed` dedupe.
- `while_active` dedupe releases only on a terminal state; `ttlMs` never permits a duplicate while the original job is queued, delayed, or active. `until_completed` may create a new identity only after `ttlMs` expires on a terminal record, with concurrent producers serialized by the identity mapping.
- Nest shutdown stops new consumption, waits for active handlers, and closes workers and queues. Calling close repeatedly is safe.
- Lifecycle observers are best-effort and cannot change enqueue results, handler outcomes, or persisted job state by throwing or returning a rejected promise.

## Outbox publisher

`createOutboxJobsPublisher()` returns a Nest provider compatible with the `@nestarc/outbox` `OutboxPublisher` transport contract.

- An event maps to one job in v0.3.
- `jobId` and `idempotencyKey` are always the outbox record ID and cannot be overridden by mapping options.
- Mapping-level `until_completed` dedupe remains effective even though the adapter supplies the outbox record ID as `jobId`.
- The source payload is unchanged unless an explicit payload mapper is configured.
- Tenant ID is required by default; system/global mappings must explicitly select `tenant: 'optional'`.
- Unmapped events fail by default. `unmapped: 'ignore'` is an explicit terminal acknowledgement choice.
- Context and metadata preserve `outboxEventId`, tenant ID, correlation ID (event ID fallback), optional causation ID, and available source envelope fields.
- Mapping and enqueue errors reject `publish()`, allowing the outbox poller to retry instead of marking the record sent.
- Delivery is at-least-once. Stable identity suppresses duplicate enqueue but does not guarantee exactly-once handler execution.

## Verification contract

- Unit/in-memory tests run on Node 20, 22, and 24.
- Consumer tarballs compile and bootstrap on Node 20/22/24 with NestJS 10 and 11, without BullMQ installed.
- Redis 7.2 integration runs on representative Node/Nest combinations and fails when `REDIS_URL` is missing.
- Coverage includes `bullmq-backend.ts`; global and BullMQ-specific thresholds are enforced.
- Pull requests and tag releases call the same reusable verification workflow. Release publishes the tarball produced by that workflow.

## Out of scope

- BullMQ distributed tenant fairness or Pro Groups
- durable transition history
- BullMQ cooperative timeout or forced cancellation
- BullMQ DLQ list/replay/discard and public manual drain
- cron, flows, rate limits, dashboards, or new backends
- multi-target outbox fan-out and exactly-once delivery
