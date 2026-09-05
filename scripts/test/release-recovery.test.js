const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { verifyRecoveryRun } = require('../prepare-release-recovery');
test('recovery only accepts the original verified successful tag publication', () => {
  const run = { repository: { full_name: 'nestarc/jobs' }, path: '.github/workflows/release.yml', event: 'push', head_branch: 'v0.4.0', head_sha: 'abc', status: 'completed' };
  const jobs = ['artifact-policy', 'publish', 'verify / quality'].map(name => ({ name, conclusion: 'success' }));
  assert.doesNotThrow(() => verifyRecoveryRun(run, jobs, 'v0.4.0', 'abc'));
  for (const change of [{ repository: { full_name: 'other/jobs' } }, { path: 'other.yml' }, { event: 'workflow_dispatch' }, { head_branch: 'v0.4.1' }, { head_sha: 'other' }, { status: 'in_progress' }]) assert.throws(() => verifyRecoveryRun({ ...run, ...change }, jobs, 'v0.4.0', 'abc'));
  for (let i = 0; i < jobs.length; i++) {
    assert.throws(() => verifyRecoveryRun(run, jobs.filter((_, index) => index !== i), 'v0.4.0', 'abc'));
    assert.throws(() => verifyRecoveryRun(run, jobs.map((job, index) => index === i ? { ...job, conclusion: 'skipped' } : job), 'v0.4.0', 'abc'));
  }
});
test('signature consumers pin supported peers and recovery cannot republish or grant OIDC', () => {
  const release = yaml.load(fs.readFileSync('.github/workflows/release.yml', 'utf8'));
  const recovery = yaml.load(fs.readFileSync('.github/workflows/release-recovery.yml', 'utf8'));
  for (const steps of [release.jobs.release.steps, recovery.jobs['verify-published'].steps]) {
    const command = steps.find(step => step.run?.includes('npm audit signatures')).run;
    assert(command.includes('@nestjs/common@11.2.1 @nestjs/core@11.2.1'));
    assert(command.includes('--strict-peer-deps --legacy-peer-deps=false --force=false'));
  }
  assert.deepEqual(recovery.permissions, { contents: 'read' });
  assert.deepEqual(recovery.jobs['verify-published'].permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(recovery.jobs.release.permissions, { contents: 'write' });
  assert.equal(recovery.jobs.release.needs, 'verify-published');
  for (const job of Object.values(recovery.jobs)) for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    assert(!step.run?.includes('npm publish'));
  }
});
