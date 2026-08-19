# Changelog

All notable changes to this project will be documented in this file.

This project is currently pre-release. The changelog below starts from the current documented package state and does not attempt to reconstruct every earlier intermediate commit.

## [Unreleased]

## [0.3.0] - 2026-08-19

### Added

- Added a first-party `createOutboxJobsPublisher()` adapter compatible with the `@nestarc/outbox` publisher transport. It preserves event, tenant, correlation, and causation lineage and uses the outbox record ID for stable job identity.
- Added Redis integration tests for scheduling, fixed backoff and retries, restart discovery, metadata/context persistence, concurrent idempotency, tenant/global dedupe, and graceful shutdown.
- Added Node 20/22/24 and NestJS 10/11 consumer compatibility matrices, Redis 7.2 CI, package tarball smoke tests, and global/BullMQ coverage gates.
- Added `jobs_capability_unsupported` for operations and enqueue options unavailable on the selected backend, and `jobs_identity_conflict` for composite identities that already point to different jobs.

### Changed

- Corrected the BullMQ capability matrix to report durable history, timeout, DLQ helpers, and manual drain as unsupported.
- Persisted BullMQ context, metadata, scheduling, idempotency, and dedupe lineage in a versioned Redis job envelope with backward reads for v0.2 jobs.
- Added `scheduledFor` precedence and translated package backoff policies, including capped exponential delay and jitter, through a BullMQ worker strategy.
- Registered BullMQ queues from declared job types so status lookup and work consumption survive application/backend restart.
- Added Redis-backed, job-type-scoped idempotency and global/tenant dedupe with serialized created-vs-deduped results, including terminal release and TTL start from BullMQ worker events with enqueue-time reconciliation as a fallback.
- Preserved queued v0.2 idempotency state across a coordinated upgrade, including producers that supplied an explicit `jobId`, by adopting existing v0.2 jobs whose raw BullMQ ID is the producer idempotency key.
- Backfilled every unused supplied identity after a deduped enqueue, retained the complete identity lineage through in-memory DLQ replay, and rejected conflicting pre-existing mappings.
- Unified BullMQ dedupe modes under one persisted identity policy so mode or TTL changes cannot weaken an active dedupe window.
- Encoded tenant dedupe identities as structured tuples so tenant IDs and keys containing delimiters cannot collide.
- Reconciled ambiguous BullMQ add failures against the reserved job before clearing identity state, preventing response-loss retries from creating duplicate work.
- Made Nest 10 and 11 application shutdown drain active BullMQ work before feature-provider teardown, permit follow-up enqueue from those active handlers, and close workers and queues idempotently.
- Applied typed job defaults at runtime and in `FakeJobsService`, with explicit enqueue options taking precedence.
- Fixed in-memory deduped enqueue scheduler accounting and DLQ replay context/scheduler/identity restoration, including `resetAttempts` handling.
- Kept delayed jobs and retries outside ready weighted dispatch until their due time, preventing future work from blocking ready tenants or accruing starvation credit, and preserved due-time/enqueue ordering.
- Corrected long-run minimum-share scheduling, zero-weight idle-capacity use, stale credits after weight changes, and empty-tenant inflight release; weights and tenant caps now require safe integers while invalid shares fail explicitly.
- Emitted BullMQ success/failure lifecycle events only after BullMQ commits the matching terminal transition, and reported the actual delayed retry time through `scheduledFor` and `nextAttemptAt`.
- Preserved outbox tenant lineage in both job context and metadata.
- Isolated lifecycle observer failures so telemetry callbacks cannot reject committed enqueue operations or corrupt handler state.
- Snapshot lifecycle callback inputs and in-memory queue inputs/returned envelopes, and restored terminal scheduling fields so producers, handlers, observers, and exhausted retries cannot mutate or misrepresent persisted state.
- Normalized invalid negative/non-finite backoff delays and final non-finite exponential/jitter results while preserving a finite `maxDelayMs` cap, and limited strict capability validation to registered job types.
- Normalized arbitrary non-`Error` handler rejections without leaving in-memory work active or stopping the worker loop.
- Updated peer support to NestJS 10/11, Node 20/22/24, and BullMQ 5.74.1 or newer within major 5.
- Aligned `TypedJobHandler` with the decorated runtime signature `handle(payload, context)` and restricted typed job payloads to non-null objects.
- Accepted ordinary interface-typed payload, context, and metadata values through both `JobsService` and `TypedJobsService`, made the concrete service structurally compatible with the typed facade, and exported `EmptyJobPayload` plus the public backend `EnqueueCommitObserver` type.
- Made explicit job IDs participate in composite identity conflict checks on both backends, and added namespace-wide BullMQ job-ID claims so IDs cannot silently collide across queues or with generated idempotency IDs.
- Bound composite BullMQ identity reservations in one atomic Redis script and namespace hash slot, preventing process termination or lock lease loss from leaving partial mappings while remaining Redis Cluster compatible.
- Prevented dead-letter replay from converging on terminal work or registering phantom scheduler entries.
- Emitted `job.discarded` only after a dead-letter discard commits; repeated, missing, and non-dead-letter discard calls remain event-free no-ops.
- Preserved Buffer, typed-array, function-property, and custom-prototype isolation in lifecycle snapshots.
- Translated queued v0.2 BullMQ `{ type, delayMs }` backoff options to the v0.3 worker strategy before retry scheduling.
- Rejected empty explicit job IDs before backend or scheduler state changes.
- Started BullMQ `until_completed` TTL retention at the terminal timestamp even when completion races
  with identity lookup, and claimed adopted v0.2 job IDs across the full namespace.
- Drained producer enqueue operations before BullMQ queue connections close and ordered same-process
  enqueue lifecycle callbacks before worker start callbacks.
- Isolated in-memory replay payload, context, and metadata from the cancelled source record.
- Preserved the current terminal dedupe policy when DLQ replay replaces its mapping, so replay cannot shorten an unexpired `until_completed` window.
- Allowed every job-type queue to adopt a pre-existing v0.2 job that shares the same raw idempotency ID, while retaining a legacy-only global claim against explicit ID reuse.
- Revalidated legacy BullMQ jobs after identity lock acquisition and prevented reserved dedupe IDs from turning unrelated explicit IDs into permanent aliases.
- Made lifecycle function/accessor snapshots non-executable and preserved isolated `Error.cause` and non-enumerable diagnostics.
- Rejected mixed plain/non-plain payload and context unions at compile time, and treated inherited object property names as unmapped in both first-party and legacy outbox adapters.

### Compatibility notes

- BullMQ `timeoutMs`, durable `getJobHistory()`, DLQ list/replay/discard, and manual pull/drain now fail explicitly instead of being silently ignored or represented by synthetic state.
- BullMQ failed jobs now report `status: "failed"` rather than the previous synthetic `dead_letter` status; `failedAt` and `completedAt` are populated only for their matching terminal state.
- Generated BullMQ IDs for `idempotencyKey` values now use a queue-scoped `id-<sha256>` form instead of exposing the original key. Explicit `jobId` values are unchanged.
- The supported runtime range is Node 20/22/24, and BullMQ consumers must use 5.74.1 or newer within major 5.
- Direct calls to BullMQ manual-drain methods may still omit their legacy arguments, but every call now fails with `jobs_capability_unsupported`.
- `BullMQBackend.getRawQueue()` now defaults to the optional-peer-safe `BullMQRawQueue` surface. Callers using additional BullMQ methods should request the full type explicitly with `getRawQueue<import('bullmq').Queue>(jobType)`.
- BullMQ distributed tenant fairness, durable transition history, cooperative timeout, and DLQ administration remain outside the 0.3 scope.
- BullMQ upgrades from v0.2 require a coordinated stop-and-restart cutover; mixed v0.2/v0.3 producers or workers on the same queues are unsupported.
- BullMQ namespace values may no longer contain `.`. Dotted job types remain supported, while
  rejecting dotted namespaces keeps the v0.2-compatible `<namespace>.<jobType>` queue name unambiguous. Existing dotted-namespace deployments must drain or migrate their queues and choose a dot-free namespace before starting 0.3 because changing the namespace changes queue names and the identity keyspace.
- In-memory idempotency and dedupe keys are now scoped per job type and honor terminal mode/TTL release. Calls suppressed globally in v0.2 may create distinct work after upgrading.
- Decorated typed handlers now use `handle(payload, context)`, matching the runtime invocation used by existing untyped handlers. Implementations written against the previous `handle(job)` declaration must update their method signature.
- Typed payloads and contexts must be plain objects. Arrays, functions, built-ins such as `Date` or
  `Map`, and class instances are rejected; JavaScript or `any` callers that previously supplied them
  must migrate to serializable object records.
- `__nestarcJob` is reserved by the v0.3 BullMQ persistence envelope in addition to
  `__nestarcCtx`; both keys are rejected consistently before backend selection.
- Outbox-to-jobs delivery is at-least-once with duplicate enqueue suppression; it is not an exactly-once execution guarantee.

### Documentation

- Rewrote `README.md` so the published documentation matches the current codebase and backend limitations, and included the linked versioned specs in the npm tarball.

## [0.2.0]

### Added

- Added typed job contracts with `defineJobs()`, `job()`, `TypedJobsService`, `TypedJobHandler`, `JobInstance`, and `InjectJobs()`.
- Added backend capability reporting through `JobsService.capabilities()`.
- Added status and history APIs with normalized `JobRecord` and `JobHistoryEntry` models.
- Added retry/backoff/timeout support to the in-memory worker path, including cooperative cancellation via `ctx.signal`.
- Added `enqueueDetailed()` for created-vs-deduped enqueue results while preserving `enqueue(): Promise<string>`.
- Added in-memory idempotency keys, tenant/global dedupe, dead-letter listing, replay, and discard helpers.
- Added lifecycle event hooks through module `events.onEvent`.
- Added `createFakeJobs()` and `FakeClock` for deterministic delayed-job tests.
- Added `docs/spec-v0.2.md` and an implementation plan under `docs/superpowers/plans/`.

### Changed

- Extended the in-memory backend from legacy waiting/active/done state to the v0.2 lifecycle model.
- Kept BullMQ on standard FIFO workers and exposed its v0.2 capability matrix as `fairness: "none"`.
- Preserved v0.1 module APIs, handler decorators, and string-based `JobsService.enqueue()` usage.

### Limitations

- BullMQ distributed tenant fairness remains out of scope.
- BullMQ DLQ service helpers are not yet implemented beyond normalized status/history lookup.
- Timeout is cooperative and cannot forcibly stop synchronous CPU-bound handler code.

## [0.1.0]

### Added

- `JobsModule.forInMemory()` with automatic worker startup, `@JobHandler()` discovery, context propagation, and weighted tenant fairness.
- `JobsModule.forBullMQ()` with BullMQ `Queue` and standard `Worker` integration.
- `JobsService` with `enqueue()`, `setTenantWeight()`, and scheduler access for fairness-enabled backends.
- `Scheduler`, `FairWorker`, `HandlerRegistry`, `InMemoryBackend`, and `BullMQBackend` exports for lower-level composition.
- `FakeJobsService` for deterministic tests without Redis.
- `JobsOutboxBridge` with optional `tenantFrom` override support.
- Context helpers: `attachContext()`, `detachContext()`, and `CONTEXT_KEY`.
- Explicit `JobsError` codes for queue lookup, handler lookup, reserved payload keys, and fairness misconfiguration.

### Changed

- In-memory module usage now starts workers automatically when the Nest module initializes.
- BullMQ-backed services no longer keep unused fairness scheduler state.
- Fairness-only controls now fail explicitly on unsupported backends instead of silently behaving as no-ops.

### Limitations

- BullMQ in `0.1.0` delivers FIFO through BullMQ's standard `Worker`; tenant fairness is not implemented.
- In-memory fairness is process-local and intended for single-process execution.
- Pull-based backend methods such as `peekWaiting()`, `moveToActive()`, `ack()`, and `fail()` are unsupported on BullMQ in this release.
