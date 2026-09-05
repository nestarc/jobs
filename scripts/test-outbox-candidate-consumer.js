'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { validateCandidate } = require('./lib/outbox-candidate');
const manifest = validateCandidate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
const result = spawnSync(process.execPath, [require.resolve('./test-modern-outbox-consumer')], {
  stdio: 'inherit', env: { ...process.env, OUTBOX_PACKAGE: manifest.package, OUTBOX_EXPECTED_VERSION: manifest.version, OUTBOX_EXPECTED_INTEGRITY: manifest.integrity },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
