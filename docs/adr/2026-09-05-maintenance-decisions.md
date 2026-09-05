# Maintenance decisions — 2026-09-05

Status: local implementation candidate; public main, administrator settings and release are separate gates.

## Runtime and semver

The accumulated activation/shutdown/serialization/concurrency changes and new role options belong to **0.4.0**. Node 22 and 24 are supported. Node 20 reached EOL on 2026-04-30 and is removed in this pre-1.0 minor. Node 26 remains a research candidate until its scheduled 2026-10-28 LTS date and explicit proof. Source: [Node release schedule](https://github.com/nodejs/Release#release-schedule).

Nest 10 and 11 remain the declared peers. Nest 12 must pass strict installation, lifecycle, Redis and packed consumers before a separate support expansion; do not force-install it or broaden peers to make a spike green. The exact 0.2.1 Outbox / 11.2.1 Nest / 7.10.0 Prisma consumer remains the historical anchor.

## BullMQ floor and toolchain

The BullMQ v5 floor is 5.76.2, the first version above the audited affected 5.66.1–5.76.1 range; it removes the affected uuid dependency. The exact current v5 comparison is 5.81.4. BullMQ 6 is out of scope. Both versions must pass the Redis contract. Optional peer consumers must upgrade their own lockfile: a production audit of this library alone does not prove their peer graph safe. Source: [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

Compatible lock refresh removed all observed high vulnerabilities before the major tool migrations. Jest 30.5.1 + ts-jest 29.4.12 and ESLint 10.10.0 + @eslint/js 10.0.1 + typescript-eslint 8.69.0 are independent migration waves. TypeScript stays on v5. No force audit fix or runtime peer removal was used.

Temporary development-fixture exception: Nest 10.4.22/@nestjs/testing plus file-type carry the remaining moderate advisory paths. Owner: @ksyq12. Review/expiry: 2026-10-05. Reason: retaining the declared Nest 10 compatibility lane; this is not approval to deploy vulnerable peers. New consumers should use verified patched Nest 11. Full audit evidence is recorded in the maintenance handoff; production audit remains a separate zero gate.

## Roles and dynamic handlers

BullMQ `role` is `producer`, `worker`, or `both` (default). Producer skips discovery and never creates Workers; it still closes owned resources. Worker/both require every intended job type to have a handler at bootstrap. `dynamicRegistration: true` is the explicit compatibility escape for intentionally deferred registration; the caller must arrange registration before work arrives. Worker mode rejects JobsService enqueue, so handlers that publish follow-up jobs must use `both`. Direct backend/raw queue access remains a trusted administrative escape.

## Retention

Retention is opt-in and operator-driven, with `{terminalAgeMs, recoveryHorizonMs, batchSize?}`. The age may not be shorter than the retry plus operator recovery horizon. Default batch size is 1000. Run `pruneTerminal({producersStopped:true})` after stopping all producers and retry/replay administrators. The boolean is an operator assertion; a single client cannot prove other processes have stopped. BullMQ pauses registered queues, refuses active work, and restores each prior pause state. All deployment job types must be registered before cleanup.

Only expired terminal records and their still-matching identity mappings are deleted. A replay that rebound an identity to a queued/active job keeps that mapping. Cleanup never touches active/waiting/delayed jobs and never evicts young records to satisfy a count target. During a failure, rerun cleanup before restarting writers. Ambiguous pre-release plain-string or shared cross-type reservations require explicit migration and are preserved. Retained size is bounded by input rate × recovery horizon plus cleanup cadence/backlog; this is not a hard memory cap under unlimited ingress. After the retention horizon, resubmitting an old identity may intentionally create work again. Archive necessary audit evidence outside Jobs before deletion. BullMQ's [native removal semantics](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs) do not preserve Jobs' independent identity mappings.

## Worker faults

FairWorker owns an activation token before calling moveToActive. InMemoryBackend repeats that same acquisition idempotently without incrementing attempts. It retains a settled handler outcome across ack/fail transport errors and retries the same operation after 50ms; it never turns an uncertain ack into fail. A fenced conflict is reconciled with getJob. Unknown ownership stays pending and is reported on shutdown. An `onWorkerError` observer sees transient faults without terminating the module loop.

Custom fenced backends should accept and honor the optional third activation ID argument to moveToActive. If an old custom backend commits an activation but loses its response and cannot recover the caller token, Jobs reports uncertainty rather than executing a possibly overlapping handler. This recovery limitation must be resolved by the backend adapter. Signals remain cooperative; no forced cancellation or exactly-once guarantee is added.

## Package surface

Repository consumer inventory uses the root package plus package.json; internal source tests use relative imports. There is no repository evidence of supported external deep imports. Defer restrictive `exports` until a separately announced minor/major migration with external consumer inventory. This release retains CommonJS `main`, root declarations and existing deep-import resolution. The packed core fixture records the incidental `dist/backend/in-memory-backend` import as a compatibility baseline, not a newly recommended API. BullMQ internals are split into codec, identity lock, lifecycle observer and owned-resource helpers without adding root exports.


## Current Outbox candidate

During execution, npm latest had advanced to **@nestarc/outbox 0.3.0** (SRI `sha512-rbPiDgQCNVtQifVf01we+vREYDDwccpezc5cSlaoa8VeIW3NxmGWrMe8ccwQRex/pF2MxlFW4K645SDbN27evQ==`). The first strict install failed against Jobs' old ^0.2.0 peer. The candidate range is ^0.2.1 || ^0.3.0; the first strict compile then exposed required `nextAttemptAt` in the newer OutboxRecord. Adding that transport field to the shared fixture preserves 0.2.1 compatibility. Strict install/typecheck/runtime with Outbox 0.3.0, Nest 11.2.1 and Prisma 7.10.0 passed. The historical 0.2.1 anchor remains independently verified from the same final Jobs tarball.

The published 0.3.0 Outbox poller still stops in onApplicationShutdown and its stop hook returns after a timeout with a warning if callbacks remain. A publisher rejection increments retry_count and may set FAILED. Therefore that hook alone cannot prove quiescence before Jobs onModuleDestroy. Jobs' late-publish rejection is tested; completing the upstream stop/drain API and cross-package shutdown proof remains external. Do not interpret source-version compatibility as that missing lifecycle guarantee.

The 5.81.4 spike initially failed to compile because BullMQ now declares queue.client as IRedisClient, whose public types differ from ioredis varargs. Jobs keeps a structural internal ioredis boundary (including scan), and the newer default ioredis compatibility proxy was verified with all 48 Redis tests. Node-redis/Bun connection adapters are not newly supported by this change.

Node 22.23.2 and Node 24.11.1 were exercised locally. The exact Nest 12.0.1 packed spike failed strict resolution with Jobs' declared Nest 10/11 peer range; module/Redis execution on Nest 12 was therefore not performed or claimed. Peer widening remains a separate future decision.

The flat-config migration first passed ESLint 9.39.5, but npm reported that major as unsupported during the final reproducibility install. The final toolchain uses the current compatible ESLint 10.10.0 instead; typescript-eslint 8.69.0 explicitly supports ESLint 10 and TypeScript remains 5.9.3.
