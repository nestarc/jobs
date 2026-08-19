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

- Queue names retain the `<namespace>.<jobType>` form. Namespace values containing `.` are rejected
  to keep that split unambiguous; dots remain valid inside registered job types.
- Queue discovery is limited to `jobTypes` registered by `JobsModule.forBullMQ()` or `registerJobTypes()`. Redis key scanning for undeclared queues is out of scope.
- `scheduledFor` takes precedence over `delayMs`, which takes precedence over `delay`. Past times run without delay.
- The public fixed/exponential backoff policy is evaluated by the worker, including `maxDelayMs` and symmetric bounded `jitter`. Invalid negative/non-finite inputs and final non-finite results normalize to zero, while a finite `maxDelayMs` still caps exponential overflow. Coordinated upgrades also translate queued v0.2 `{ type, delayMs }` backoff options before a retry is scheduled.
- Context, user metadata, schedule, idempotency key, dedupe key, and backoff policy are stored in a versioned job envelope. v0.2 envelopes remain readable.
- Redis identity mappings scope `idempotencyKey` and dedupe keys to a job type. A namespace-wide job-ID claim prevents new public IDs from belonging to different job-type queues and distinguishes generated idempotency IDs from explicit IDs. Generated idempotent IDs also include queue identity, so status IDs remain unique across registered queues. Explicit `jobId` values retain their public value without bypassing idempotency or `until_completed` dedupe. After a coordinated upgrade, a pre-existing v0.2 job whose raw ID equals the idempotency key is adopted into the mapping instead of duplicated. Legacy jobs that already use the same raw idempotency ID in multiple job-type queues share a legacy-only global claim so every queue can adopt its own job while explicit reuse of that ID remains blocked; direct ID-only status lookup for such pre-existing duplicates is necessarily ambiguous.
- Both dedupe modes use the same Redis identity namespace and lock. The mode and TTL stored by the current identity remain authoritative until release, even if a later producer supplies different options. `while_active` releases only on a terminal state; `ttlMs` never permits a duplicate while the original job is queued, delayed, or active. `until_completed` may create a new identity only after its stored `ttlMs` expires on a terminal record, with concurrent producers serialized by the identity mapping. For v0.3 mappings with policy metadata, terminal worker events make a best-effort deletion of `while_active` mappings or start the configured `until_completed` expiry; enqueue-time reconciliation remains the correctness fallback.
- When any supplied identity matches an existing job, unused idempotency/dedupe identities are bound to that same job and retained through in-memory DLQ replay. Explicit job IDs participate in the same conflict resolution without becoming aliases for a different reserved ID. If supplied identities already resolve to different jobs, enqueue fails with `jobs_identity_conflict` instead of replacing either active mapping. Composite Redis mappings use one namespace hash tag and are validated and written by one atomic script, so process termination cannot leave a partial reservation and Redis Cluster keeps the keys in one slot. Tenant-scoped identity components use unambiguous structured encoding.
- If a BullMQ add response is lost after Redis commits the job, enqueue reconciles the reserved job and token before changing identity state. An indeterminate reconciliation keeps the reservation for a later producer to verify instead of risking duplicate work.
- A delayed retry reports its Redis due time as both `scheduledFor` and `nextAttemptAt`; the original requested schedule is restored after the job reaches a terminal state.
- Nest 10 and 11 shutdown stop new consumption, wait for active handlers (including their follow-up enqueue calls) before feature providers are destroyed, and close workers and queues. Calling close repeatedly is safe.
- Lifecycle observers are best-effort and receive snapshots; throwing, rejecting, or mutating callback inputs cannot change enqueue results, handler outcomes, or persisted job state. Function and accessor properties in snapshots are non-executable, while Error causes and non-enumerable diagnostics are copied as isolated values. BullMQ success/failure events are emitted from the matching post-transition worker event, after result serialization and the Redis state change. In-memory `job.discarded` is emitted only after a dead-letter discard commits; no-op discard calls emit nothing.

## In-memory scheduling and snapshots

- Future scheduled jobs and delayed retries remain in due-time order outside ready weighted dispatch
  until promoted. Equal due times preserve enqueue order, and future work does not consume weight or
  starvation accounting while ready work continues. Per-tenant `waiting` snapshots still count both
  ready and deferred work.
- Sustained ready work honors the configured minimum-share protection. Zero-weight work may use idle
  capacity when minimum-share protection is enabled, and reducing a weight removes stale credits.
- `defaultWeight` and `tenantCap` must be positive safe integers, `minSharePct` must be finite and
  within `[0, 1]`, and runtime weights must be non-negative safe integers (`0` is allowed). Invalid
  values fail with `jobs_fairness_misconfig`.
- Enqueue snapshots payload, context, metadata, backoff, and schedule values. Backend reads return
  snapshots, so producer or handler mutation cannot change the stored record.

## Typed handler contract

- Job payload and context definitions must be plain object types. Runtime validation rejects
  primitives, arrays, functions, built-ins such as `Date`/`Map`, and class instances before
  envelope creation. `__nestarcCtx` and `__nestarcJob` are reserved payload keys.
- `TypedJobHandler<TJobs, TType>.handle(payload, context)` matches the arguments delivered by `@JobHandler()` discovery on both backends.
- `JobInstance` remains available as a record type for status- and adapter-oriented code; decorated handlers are not invoked with a `JobInstance` wrapper.

## Upgrade compatibility

- v0.3 workers read jobs that were persisted by v0.2.
- A v0.2 deployment with a dotted BullMQ namespace must drain or explicitly migrate its queues and
  choose a dot-free namespace before starting v0.3. Changing the namespace changes queue names and
  the identity keyspace; the v0.3 backend rejects the old configuration at construction.
- When v0.2 queues reused one raw idempotency ID across job types, each queue remains independently adoptable. ID-only status lookup cannot distinguish those already duplicated raw IDs; applications that need unambiguous lookup should drain or rename them before cutover.
- In-memory idempotency and dedupe identities are now scoped per job type and honor terminal mode/TTL release. Enqueues that were globally suppressed by a different job type in v0.2 may therefore create work after upgrading.
- Mixed v0.2/v0.3 producers or workers on the same queues are unsupported. The v0.3 envelope, generated identity IDs, and custom backoff strategy are not understood by v0.2 workers and cannot coordinate atomically with v0.2 producers.
- Upgrades must stop all v0.2 producers and workers before starting v0.3 processes. Backward reads preserve already queued v0.2 work after that coordinated cutover; they do not provide zero-downtime rolling compatibility.

## Outbox publisher

`createOutboxJobsPublisher()` returns a Nest provider compatible with the `@nestarc/outbox` `OutboxPublisher` transport contract.

- An event maps to one job in v0.3.
- `jobId` and `idempotencyKey` are always the outbox record ID and cannot be overridden by mapping options.
- Mapping-level `until_completed` dedupe remains effective even though the adapter supplies the outbox record ID as `jobId`.
- The source payload is unchanged unless an explicit payload mapper is configured.
- Tenant ID is required by default; system/global mappings must explicitly select `tenant: 'optional'`.
- Outbox maps use own properties only. Inherited names are treated as unmapped: the first-party
  publisher applies its configured error/ignore policy, while the legacy bridge ignores them.
- Unmapped events fail by default. `unmapped: 'ignore'` is an explicit terminal acknowledgement choice.
- Context and metadata preserve `outboxEventId`, tenant ID, correlation ID (event ID fallback), optional causation ID, and available source envelope fields.
- Mapping and enqueue errors reject `publish()`, allowing the outbox poller to retry instead of marking the record sent.
- Delivery is at-least-once. Stable identity suppresses duplicate enqueue but does not guarantee exactly-once handler execution.

## Verification contract

- Unit/in-memory tests run on Node 20, 22, and 24.
- Consumer tarballs compile and bootstrap on Node 20/22/24 with NestJS 10 and 11, without BullMQ installed.
- Redis 7.2 integration runs on every supported Node 20/22/24 × NestJS 10/11 combination and fails
  when `REDIS_URL` is missing.
- Coverage includes `bullmq-backend.ts`; global and BullMQ-specific thresholds are enforced.
- Pull requests and tag releases call the same reusable verification workflow. Release publishes the tarball produced by that workflow.

## Out of scope

- BullMQ distributed tenant fairness or Pro Groups
- durable transition history
- BullMQ cooperative timeout or forced cancellation
- BullMQ DLQ list/replay/discard and public manual drain
- cron, flows, rate limits, dashboards, or new backends
- multi-target outbox fan-out and exactly-once delivery
