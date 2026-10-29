'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
function verifyRecoveryRun(run, jobs, tag, commit) {
  assert.equal(run.repository?.full_name, 'nestarc/jobs', 'unexpected artifact repository');
  assert.equal(run.path, '.github/workflows/release.yml', 'artifact must come from the release workflow');
  assert.equal(run.event, 'push', 'artifact must come from a release tag push');
  assert.equal(run.head_branch, tag, 'artifact release tag mismatch');
  assert.equal(run.head_sha, commit, 'artifact source commit mismatch');
  assert.equal(run.status, 'completed', 'original release must finish before recovery');
  for (const name of ['artifact-policy', 'publish']) {
    assert(jobs.some(job => job.name === name && job.conclusion === 'success'), `original ${name} must have succeeded`);
  }
  const verification = jobs.filter(job => job.name.startsWith('verify /'));
  assert(verification.length > 0 && verification.every(job => job.conclusion === 'success'), 'all original verification jobs must have succeeded');
}
function main() {
  const tag = process.env.RELEASE_TAG;
  const runId = process.env.ARTIFACT_RUN_ID;
  assert(/^v\d+\.\d+\.\d+$/.test(tag), 'exact stable release tag is required');
  assert(/^\d+$/.test(runId), 'numeric artifact run ID is required');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', `refs/tags/${tag}^{commit}`);
  assert(/^[a-f0-9]{40}$/.test(commit));
  git('merge-base', '--is-ancestor', commit, 'origin/main');
  const run = JSON.parse(execFileSync('gh', ['api', `repos/nestarc/jobs/actions/runs/${runId}`], { encoding: 'utf8' }));
  const jobs = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/nestarc/jobs/actions/runs/${runId}/jobs?per_page=100`], { encoding: 'utf8' })).flatMap(page => page.jobs);
  verifyRecoveryRun(run, jobs, tag, commit);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\ntag=${tag}\n`);
  console.log(`Verified original published artifact source: ${tag} at ${commit}, run ${runId}`);
}
if (require.main === module) main();
module.exports = { verifyRecoveryRun };
