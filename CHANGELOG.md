# Changelog

All notable changes to this project will be documented in this file.

This project is currently pre-release. The changelog below starts from the current documented package state and does not attempt to reconstruct every earlier intermediate commit.

## [Unreleased]

### Changed

- Rewrote `README.md` so the published documentation matches the current codebase and backend limitations.
- Strengthened tests around scheduler weighting, module cleanup, failure callbacks, and outbox tenant propagation.

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
