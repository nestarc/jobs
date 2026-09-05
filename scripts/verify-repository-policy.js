'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
function verifyRepositoryPolicy(branch, rulesets, environment) {
  assert.equal(branch.protected, true, 'main must be protected before release');
  assert(rulesets.some((rule) => rule.target === 'tag' && rule.enforcement === 'active' &&
    (rule.conditions?.ref_name?.include ?? []).some((ref) => ref === 'refs/tags/v*' || ref === '~ALL') &&
    (rule.conditions?.ref_name?.exclude ?? []).length === 0 &&
    (rule.bypass_actors ?? []).length === 0 &&
    rule.rules?.some((entry) => entry.type === 'update') && rule.rules?.some((entry) => entry.type === 'deletion')), 'immutable v* tag ruleset with no bypass is required');
  assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true, 'npm environment must restrict deployment refs');
}
function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, 'nestarc/jobs', 'unexpected release repository');
  const api = (route) => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${route}`], { encoding: 'utf8' }));
  const summaries = api('rulesets');
  const rulesets = summaries.map((rule) => api(`rulesets/${rule.id}`));
  verifyRepositoryPolicy(api('branches/main'), rulesets, api('environments/npm'));
  const policies = api('environments/npm/deployment-branch-policies');
  assert(policies.branch_policies?.some((rule) => rule.type === 'tag' && rule.name === 'v*'), 'npm environment must permit only reviewed release tag patterns');
  assert(policies.branch_policies.every((rule) => rule.type === 'tag' && rule.name === 'v*'), 'unexpected npm deployment ref bypass');
  console.log('Protected main, immutable release tags and restricted npm environment verified');
}
if (require.main === module) main();
module.exports = { verifyRepositoryPolicy };
