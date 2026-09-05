# Security policy

The latest published 0.4 patch is the current maintenance line. Upgrade older 0.1/0.2/0.3 releases to 0.4 for the activation, shutdown, tenant isolation and input-validation fixes. See CHANGELOG for migration requirements. Fixes may require moving to the next pre-1.0 minor when preserving an unsafe behavior would prevent remediation.

Repository security owner: [@ksyq12](https://github.com/ksyq12). Use [GitHub private vulnerability reporting](https://github.com/nestarc/jobs/security/advisories/new) for sensitive reports. The channel was enabled and administrator inbox access verified on 2026-09-05; no reports were present, so delivery of an actual report has not yet been verified. Do not report vulnerability details, payloads, credentials, or exploits in public issues.

Jobs is an at-least-once execution transport. Producers must be trusted and separately authenticated: possession of Redis credentials or direct JobsService access permits work creation. Handler side effects must be idempotent. `getJob`, history, DLQ replay/discard, raw queues, and retention cleanup are privileged control-plane operations. Authorize tenant membership before using `getJobForTenant`; a tenant ID supplied by a request is not authorization. Jobs does not import an RBAC framework.

Use Redis TLS, a private network and dedicated ACL credentials scoped to the deployment's queue and identity keyspace. BullMQ requires Lua and multiple data structure commands; validate its ACL contract against the exact supported version. Never expose a Redis URL, password, or payload through logs. Separate namespaces isolate identity, but are not a replacement for Redis access control.

Payload/context/metadata have recursive validation and size/depth budgets. These are transport limits, not business schema validation or a protection against a hostile Redis writer. Minimize PII, tokenize secrets, and redact errors before passing them to lifecycle observers. Observers are best effort and are not a durable compliance audit.

Records and identities persist by default. Opt-in retention requires a recovery horizon covering Outbox retries plus operator recovery. Run cleanup only after stopping all producers and administrative writers; the backend pauses its registered BullMQ queues and refuses active workers. Continue batch cleanup until it returns zero, and restore producers only after successful completion. Configure cadence and monitor backlog/PII age. Native BullMQ auto-removal or manual key deletion bypasses identity safety and must not be enabled alongside Jobs.

The library's production audit and consumers' optional-peer audits are separate. The Nest 10 compatibility fixture currently has dev-only advisory exposure; use patched Nest 11 for new deployments. See [maintenance decisions](docs/adr/2026-09-05-maintenance-decisions.md) for the exact tested tuple and temporary exceptions.
