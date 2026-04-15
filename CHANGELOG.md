# Changelog

All notable changes to this project will be documented in this file.

This project is currently pre-release. The changelog below starts from the current documented package state and does not attempt to reconstruct every earlier intermediate commit.

## [Unreleased]

### Changed

- Rewrote `README.md` so the published documentation matches the current codebase and backend limitations.
- Strengthened tests around scheduler weighting, module cleanup, failure callbacks, and outbox tenant propagation.

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
