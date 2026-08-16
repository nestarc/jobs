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

Unsupported timeout, history, dead-letter, and manual-drain operations fail with `jobs_capability_unsupported`; they must not return empty or synthetic results. Fairness controls on a backend without a scheduler continue to fail with `jobs_fairness_misconfig`.

## BullMQ behavior

- Queue discovery is limited to `jobTypes` registered by `JobsModule.forBullMQ()` or `registerJobTypes()`. Redis key scanning for undeclared queues is out of scope.
- `scheduledFor` takes precedence over `delayMs`, which takes precedence over `delay`. Past times run without delay.
- The public fixed/exponential backoff policy is evaluated by the worker, including `maxDelayMs` and symmetric bounded `jitter`.
- Context, user metadata, schedule, idempotency key, dedupe key, and backoff policy are stored in a versioned job envelope. v0.2 envelopes remain readable.
- Redis identity mappings scope `idempotencyKey` and dedupe keys to a job type. Generated idempotent IDs also include queue identity, so status IDs remain unique across registered queues. Explicit `jobId` values retain their public value without bypassing idempotency or `until_completed` dedupe. During an in-place upgrade, a v0.2 job whose raw ID equals the idempotency key is adopted into the mapping instead of duplicated.
- Both dedupe modes use the same Redis identity namespace and lock. The mode and TTL stored by the current identity remain authoritative until release, even if a later producer supplies different options. `while_active` releases only on a terminal state; `ttlMs` never permits a duplicate while the original job is queued, delayed, or active. `until_completed` may create a new identity only after its stored `ttlMs` expires on a terminal record, with concurrent producers serialized by the identity mapping.
- When any supplied identity matches an existing job, unused idempotency/dedupe identities are bound to that same job and retained through in-memory DLQ replay. If supplied identities already resolve to different jobs, enqueue fails with `jobs_identity_conflict` instead of replacing either active mapping. Tenant-scoped identity components use unambiguous structured encoding.
- If a BullMQ add response is lost after Redis commits the job, enqueue reconciles the reserved job and token before changing identity state. An indeterminate reconciliation keeps the reservation for a later producer to verify instead of risking duplicate work.
- A delayed retry reports its Redis due time as both `scheduledFor` and `nextAttemptAt`; the original requested schedule is restored after the job reaches a terminal state.
- Nest 10 and 11 shutdown stop new consumption, wait for active handlers (including their follow-up enqueue calls) before feature providers are destroyed, and close workers and queues. Calling close repeatedly is safe.
- Lifecycle observers are best-effort and receive snapshots; throwing, rejecting, or mutating callback inputs cannot change enqueue results, handler outcomes, or persisted job state. BullMQ success/failure events are emitted from the matching post-transition worker event, after result serialization and the Redis state change.

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
