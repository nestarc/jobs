'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const requiredChecks = require('./lib/required-checks.json');

function verifyRepositoryPolicy(branch, rulesets, environment, effectiveRules = []) {
  assert.equal(branch.protected, true, 'main must be protected before release');
  // GitHub resolves matching patterns and inherited rules; never infer effective
  // main protection from the branch summary or an unrelated ruleset's contents.
  const mainRules = effectiveRules.filter((entry) => rulesets.some((rule) =>
    rule.id === entry.ruleset_id && rule.target === 'branch' && rule.enforcement === 'active' &&
    Array.isArray(rule.bypass_actors) && rule.bypass_actors.length === 0));
  for (const type of ['pull_request', 'non_fast_forward', 'deletion']) {
    assert(mainRules.some((entry) => entry.type === type), `main requires an enforced ${type} rule without bypass`);
  }
  const checks = mainRules.filter((entry) => entry.type === 'required_status_checks' &&
    entry.parameters?.strict_required_status_checks_policy === true)
    .flatMap((entry) => entry.parameters.required_status_checks ?? []);
  assert(requiredChecks.length > 0, 'required CI check inventory must not be empty');
  for (const context of requiredChecks) {
    assert(checks.some((check) => check.context === context && check.integration_id === 15368),
      `main is missing required CI check from GitHub Actions: ${context}`);
  }
  assert(rulesets.some((rule) => rule.target === 'tag' && rule.enforcement === 'active' &&
    (rule.conditions?.ref_name?.include ?? []).some((ref) => ref === 'refs/tags/v*' || ref === '~ALL') &&
    (rule.conditions?.ref_name?.exclude ?? []).length === 0 &&
    Array.isArray(rule.bypass_actors) && rule.bypass_actors.length === 0 &&
    rule.rules?.some((entry) => entry.type === 'update') && rule.rules?.some((entry) => entry.type === 'deletion')), 'immutable v* tag ruleset with no bypass is required');
  assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true, 'npm environment must restrict deployment refs');
}
// REST hides bypass actors from read-only tokens. GraphQL exposes the exact
// connection count without granting repository administration to verification.
function withBypassEvidence(rule, graphql) {
  if (Array.isArray(rule.bypass_actors)) return rule;
  assert.equal(typeof rule.node_id, 'string', 'ruleset node identity is required');
  const response = graphql(rule.node_id);
  assert(!response.errors?.length, 'ruleset bypass query failed');
  const node = response.data?.node;
  const actors = node?.bypassActors;
  assert.equal(node?.id, rule.node_id, 'ruleset bypass evidence identity mismatch');
  assert(Number.isInteger(actors?.totalCount) && actors.totalCount >= 0, 'ruleset bypass count is unavailable');
  assert(Array.isArray(actors.nodes) && actors.nodes.length === Math.min(actors.totalCount, 1), 'incomplete ruleset bypass evidence');
  return { ...rule, bypass_actors: actors.nodes };
}
function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, 'nestarc/jobs', 'unexpected release repository');
  const api = (route) => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${route}`], { encoding: 'utf8' }));
  const pages = (route) => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/${route}`], { encoding: 'utf8' })).flat();
  const summaries = pages('rulesets?per_page=100');
  const graphql = (id) => JSON.parse(execFileSync('gh', ['api', 'graphql', '-f',
    'query=query($id:ID!) { node(id:$id) { ... on RepositoryRuleset { id bypassActors(first:1) { totalCount nodes { id } } } } }',
    '-f', `id=${id}`], { encoding: 'utf8' }));
  const rulesets = summaries.map((rule) => withBypassEvidence(api(`rulesets/${rule.id}`), graphql));
  verifyRepositoryPolicy(api('branches/main'), rulesets, api('environments/npm'), pages('rules/branches/main?per_page=100'));
  const policies = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/environments/npm/deployment-branch-policies?per_page=100`], { encoding: 'utf8' })).flatMap((page) => page.branch_policies ?? []);
  assert(policies.some((rule) => rule.type === 'tag' && rule.name === 'v*'), 'npm environment must permit only reviewed release tag patterns');
  assert(policies.every((rule) => rule.type === 'tag' && rule.name === 'v*'), 'unexpected npm deployment ref bypass');
  console.log('Effective main PR/CI/force-push/deletion rules, immutable release tags and restricted npm environment verified');
}
if (require.main === module) main();
module.exports = { verifyRepositoryPolicy, withBypassEvidence };
