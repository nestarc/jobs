'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');

function digest(bytes) { return `sha512-${createHash('sha512').update(bytes).digest('base64')}`; }
function verifyIntegrity(bytes, published) {
  assert.equal(published.dist?.integrity, digest(bytes), 'same version has different artifact bytes');
}
function registryManifest(spec, run = spawnSync) {
  const result = run('npm', ['view', spec, '--json', '--registry=https://registry.npmjs.org'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout);
  let response;
  try { response = JSON.parse(result.stdout); } catch { /* Fail closed below. */ }
  if (response?.error?.code === 'E404') return null;
  throw new Error(`registry lookup failed: ${result.stderr || result.stdout}`);
}
function validateArtifact(file, sourceManifest, changelog, tag) {
  const bytes = fs.readFileSync(file);
  assert(bytes.length > 0 && bytes.length <= 1024 * 1024, 'tarball exceeds 1 MiB package budget');
  const entries = execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const allowed = /^(package\/(package\.json|README\.md|CHANGELOG\.md|SECURITY\.md|LICENSE|docs\/(prd|spec|spec-v0\.[23])\.md)|package\/dist\/[a-zA-Z0-9_./-]+\.(js|d\.ts))$/;
  for (const entry of entries) assert(allowed.test(entry) && !entry.includes('..'), `unexpected packed path: ${entry}`);
  const details = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert(details.every((entry) => entry.startsWith('-')), 'only regular files are allowed in the artifact');
  for (const required of ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'docs/prd.md', 'docs/spec.md', 'docs/spec-v0.2.md', 'docs/spec-v0.3.md']) assert(entries.includes(`package/${required}`), `missing packed file: ${required}`);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(manifest.name, '@nestarc/jobs');
  assert.deepEqual(manifest, sourceManifest, 'packed/source manifest mismatch');
  assert.equal(tag, `v${manifest.version}`, 'tag/manifest mismatch');
  assert(changelog.includes(`## [${manifest.version}]`), 'CHANGELOG release heading missing');
  assert(entries.includes('package/dist/index.js') && entries.includes('package/dist/index.d.ts'));
  return { version: manifest.version, integrity: digest(bytes), bytes };
}
function verifyProvenance(bytes, attestations, version, commit) {
  const bundle = attestations.attestations?.find((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1');
  assert(bundle?.bundle?.dsseEnvelope?.payload, 'npm provenance is required');
  const statement = JSON.parse(Buffer.from(bundle.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const expectedDigest = createHash('sha512').update(bytes).digest('hex');
  assert(statement.subject?.some((subject) => subject.name === `pkg:npm/%40nestarc/jobs@${version}` && subject.digest?.sha512 === expectedDigest), 'attestation subject differs from candidate');
  const build = statement.predicate?.buildDefinition;
  assert.deepEqual(build?.externalParameters?.workflow, { ref: `refs/tags/v${version}`, repository: 'https://github.com/nestarc/jobs', path: '.github/workflows/release.yml' });
  assert(build?.resolvedDependencies?.some((dependency) => dependency.uri === `git+https://github.com/nestarc/jobs@refs/tags/v${version}` && dependency.digest?.gitCommit === commit), 'attested source commit differs from release commit');
  // Cryptographic signature and transparency verification is a separate npm audit signatures gate.
}
module.exports = { digest, verifyIntegrity, registryManifest, validateArtifact, verifyProvenance };
