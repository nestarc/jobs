'use strict';

process.env.OUTBOX_INTEGRATION = 'true';
process.env.OUTBOX_REQUIRE_STOP ??= 'true';
process.env.OUTBOX_PACKAGE ??= '@nestarc/outbox@0.4.1';
process.env.OUTBOX_EXPECTED_VERSION ??= '0.4.1';
for (const name of ['JOBS_OUTBOX_DATABASE_URL', 'JOBS_OUTBOX_REDIS_URL']) {
  if (!process.env[name]) throw new Error(`${name} is required for the disposable integration fixture`);
}
require('./test-modern-outbox-consumer');
