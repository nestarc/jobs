# Changelog

All notable changes to this project will be documented in this file.

This project is currently pre-release. The changelog below starts from the current documented package state and does not attempt to reconstruct every earlier intermediate commit.

## [Unreleased]

## [0.3.0] - 2026-08-15

### Added

- Added a first-party `createOutboxJobsPublisher()` adapter compatible with the `@nestarc/outbox` publisher transport. It preserves event, tenant, correlation, and causation lineage and uses the outbox record ID for stable job identity.
- Added Redis integration tests for scheduling, fixed backoff and retries, restart discovery, metadata/context persistence, concurrent idempotency, tenant/global dedupe, and graceful shutdown.
- Added Node 20/22/24 and NestJS 10/11 consumer compatibility matrices, Redis 7.2 CI, package tarball smoke tests, and global/BullMQ coverage gates.
- Added `jobs_capability_unsupported` for operations and enqueue options unavailable on the selected backend.

### Changed

- Corrected the BullMQ capability matrix to report durable history, timeout, DLQ helpers, and manual drain as unsupported.
- Persisted BullMQ context, metadata, scheduling, idempotency, and dedupe lineage in a versioned Redis job envelope with backward reads for v0.2 jobs.
- Added `scheduledFor` precedence and translated package backoff policies, including capped exponential delay and jitter, through a BullMQ worker strategy.
- Registered BullMQ queues from declared job types so status lookup and work consumption survive application/backend restart.
- Added Redis-backed idempotency and global/tenant dedupe with atomic created-vs-deduped results.
- Made Nest application shutdown wait for active BullMQ work and close workers and queues idempotently.
- Applied typed job defaults at runtime and made explicit enqueue options take precedence.
- Fixed in-memory deduped enqueue scheduler accounting and DLQ replay context/scheduler restoration.
- Updated peer support to NestJS 10/11, Node 20/22/24, and BullMQ 5.74.1 or newer within major 5.

### Compatibility notes

- BullMQ `timeoutMs`, durable `getJobHistory()`, DLQ list/replay/discard, and manual pull/drain now fail explicitly instead of being silently ignored or represented by synthetic state.
- `BullMQBackend.getRawQueue()` now defaults to the optional-peer-safe `BullMQRawQueue` surface. Callers using additional BullMQ methods should request the full type explicitly with `getRawQueue<import('bullmq').Queue>(jobType)`.
- BullMQ distributed tenant fairness, durable transition history, cooperative timeout, and DLQ administration remain outside the 0.3 scope.
- Outbox-to-jobs delivery is at-least-once with duplicate enqueue suppression; it is not an exactly-once execution guarantee.

### Documentation

- Rewrote `README.md` so the published documentation matches the current codebase and backend limitations.

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
