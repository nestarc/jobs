'use strict';
const path = require('node:path');
function validateCandidate(value) {
  if (!value || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)) throw new Error('exact expected Outbox version required');
  if (typeof value.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity)) throw new Error('expected SHA-512 integrity required');
  const spec = value.package;
  if (typeof spec !== 'string' || !(spec === `@nestarc/outbox@${value.version}` || (path.isAbsolute(spec) && spec.endsWith('.tgz')) || /^https:\/\/[^\s]+\.tgz$/.test(spec))) throw new Error('exact package spec or tarball required; floating specs are forbidden');
  return value;
}
module.exports = { validateCandidate };
