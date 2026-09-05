const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCandidate } = require('../lib/outbox-candidate');
const { digest } = require('../lib/release-artifact');
test('candidate input binds exact version/spec and digest while refusing floating inputs', () => {
  const input = { package: '@nestarc/outbox@0.2.1', version: '0.2.1', integrity: digest(Buffer.from('x')) };
  assert.equal(validateCandidate(input), input);
  for (const spec of ['@nestarc/outbox@latest', '@nestarc/outbox@^0.2.1', '@nestarc/outbox@0.2.2']) assert.throws(() => validateCandidate({ ...input, package: spec }));
  assert.throws(() => validateCandidate({ ...input, integrity: undefined }));
});
