const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { digest, verifyIntegrity, registryManifest, verifyProvenance } = require('../lib/release-artifact');
test('registry rerun requires identical bytes and rejects transport/auth failures', () => {
  const candidate = Buffer.from('candidate');
  assert.doesNotThrow(() => verifyIntegrity(candidate, { dist: { integrity: digest(candidate) } }));
  assert.throws(() => verifyIntegrity(candidate, { dist: { integrity: digest(Buffer.from('other')) } }));
  assert.equal(registryManifest('x', () => ({ status: 1, stdout: '{"error":{"code":"E404"}}' })), null);
  for (const code of ['E401', 'E403', 'ETIMEDOUT']) assert.throws(() => registryManifest('x', () => ({ status: 1, stdout: JSON.stringify({ error: { code } }) })));
});
test('verification has no write/OIDC; publishing and GitHub release have separate grants', () => {
  const release = yaml.load(fs.readFileSync('.github/workflows/release.yml', 'utf8'));
  const verify = yaml.load(fs.readFileSync('.github/workflows/verify.yml', 'utf8'));
  assert.deepEqual(release.permissions, { contents: 'read' });
  assert.deepEqual(verify.permissions, { contents: 'read' });
  assert.deepEqual(release.jobs.verify.permissions, { contents: 'read' });
  assert.deepEqual(release.jobs.publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(release.jobs.release.permissions, { contents: 'write' });
  for (const workflow of [release, verify]) for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  }
});

test('provenance requires the exact subject digest and immutable source commit', () => {
  const bytes = Buffer.from('candidate');
  const statement = { subject: [{name:'pkg:npm/%40nestarc/jobs@0.4.0',digest:{sha512:require('node:crypto').createHash('sha512').update(bytes).digest('hex')}}], predicate: { buildDefinition: { externalParameters:{ workflow:{ref:'refs/tags/v0.4.0',repository:'https://github.com/nestarc/jobs',path:'.github/workflows/release.yml'}}, resolvedDependencies:[{uri:'git+https://github.com/nestarc/jobs@refs/tags/v0.4.0',digest:{gitCommit:'abc'}}]}}};
  const attestations = {attestations:[{predicateType:'https://slsa.dev/provenance/v1',bundle:{dsseEnvelope:{payload:Buffer.from(JSON.stringify(statement)).toString('base64')}}}]};
  assert.doesNotThrow(() => verifyProvenance(bytes, attestations, '0.4.0', 'abc'));
  assert.throws(() => verifyProvenance(bytes, attestations, '0.4.0', 'other'));
  assert.throws(() => verifyProvenance(Buffer.from('other'), attestations, '0.4.0', 'abc'));
  assert.throws(() => verifyProvenance(bytes, {}, '0.4.0', 'abc'));
});

test('release policy fails closed on unprotected refs and unrestricted environment refs', () => {
  const { verifyRepositoryPolicy } = require('../verify-repository-policy');
  const tags = [{ target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, bypass_actors: [], rules: [{ type: 'update' }, { type: 'deletion' }] }];
  const env = { protection_rules: [], deployment_branch_policy: { custom_branch_policies: true } };
  assert.doesNotThrow(() => verifyRepositoryPolicy({ protected: true }, tags, env));
  assert.throws(() => verifyRepositoryPolicy({ protected: false }, tags, env));
  assert.throws(() => verifyRepositoryPolicy({ protected: true }, [], env));
  assert.throws(() => verifyRepositoryPolicy({ protected: true }, tags, {}));
  assert.throws(() => verifyRepositoryPolicy({ protected: true }, [{ ...tags[0], bypass_actors: [{ actor_id: 1 }] }], env));
});

test('coverage builds the separate Redis producer fixture before running it', () => {
  const verify = yaml.load(fs.readFileSync('.github/workflows/verify.yml', 'utf8'));
  const steps = verify.jobs.coverage.steps.map((step) => step.run);
  assert(steps.indexOf('npm run build') >= 0);
  assert(steps.indexOf('npm run build') < steps.indexOf('npm run test:coverage'));
});
