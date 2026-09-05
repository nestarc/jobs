const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyRepositoryPolicy } = require('../verify-repository-policy');
const requiredChecks = require('../lib/required-checks.json');
const tags = { id: 2, target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, bypass_actors: [], rules: [{ type: 'update' }, { type: 'deletion' }] };
const main = { id: 1, target: 'branch', enforcement: 'active', bypass_actors: [] };
const environment = { deployment_branch_policy: { custom_branch_policies: true } };
const rules = [
  { type: 'pull_request' }, { type: 'non_fast_forward' }, { type: 'deletion' },
  { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: requiredChecks.map(context => ({ context, integration_id: 15368 })) } },
].map(rule => ({ ...rule, ruleset_id: main.id }));
const verify = (effective = rules, details = [main, tags]) => verifyRepositoryPolicy({ protected: true }, details, environment, effective);

test('complete effective main rules permit a release without requiring a second reviewer', () => {
  assert.doesNotThrow(() => verify());
});
test('original partial protection and a protected flag alone do not authorize release', () => {
  for (const branch of [{ protected: true }, { protected: true, protection: { required_pull_request_reviews: null, required_status_checks: null, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } } }]) {
    assert.throws(() => verifyRepositoryPolicy(branch, [tags], environment), /main/);
  }
});
test('every mandatory main rule and exact required CI check must be enforced', () => {
  for (const type of ['pull_request', 'non_fast_forward', 'deletion', 'required_status_checks']) assert.throws(() => verify(rules.filter(rule => rule.type !== type)));
  for (const context of requiredChecks) {
    const incomplete = structuredClone(rules);
    incomplete[3].parameters.required_status_checks = incomplete[3].parameters.required_status_checks.filter(check => check.context !== context);
    assert.throws(() => verify(incomplete), /required CI check/);
  }
  for (const change of [
    rule => { rule.parameters.strict_required_status_checks_policy = false; },
    rule => { rule.parameters.required_status_checks[0].integration_id = null; },
  ]) {
    const incomplete = structuredClone(rules); change(incomplete[3]); assert.throws(() => verify(incomplete));
  }
});
test('disabled, unrelated, bypassable and hidden main rules cannot supply protection', () => {
  for (const replacement of [
    { ...main, enforcement: 'disabled' }, { ...main, id: 99 },
    { ...main, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] },
    { ...main, bypass_actors: undefined },
  ]) assert.throws(() => verify(rules, [replacement, tags]));
  assert.throws(() => verify([], [{ ...main, rules }, tags]));
});
test('immutable tag protection must include explicit no-bypass evidence', () => {
  for (const change of [
    { bypass_actors: undefined }, { bypass_actors: [{ actor_id: 5 }] },
    { enforcement: 'evaluate' }, { rules: [{ type: 'update' }] },
    { conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v0.*'] } } },
  ]) assert.throws(() => verify(rules, [main, { ...tags, ...change }]), /immutable/);
});

test('read-only REST omissions require complete GraphQL evidence, never an assumed empty list', () => {
  const { withBypassEvidence } = require('../verify-repository-policy');
  const rule = { node_id: 'ruleset-1' };
  const response = (count, nodes) => ({ data: { node: { id: rule.node_id, bypassActors: { totalCount: count, nodes } } } });
  assert.deepEqual(withBypassEvidence(rule, () => response(0, [])).bypass_actors, []);
  assert.equal(withBypassEvidence(rule, () => response(2, [{ id: 'bypass' }])).bypass_actors.length, 1);
  for (const invalid of [{}, { errors: [{ message: 'denied' }] }, response(null, []), response(1, []), response(0, [{ id: 'bypass' }]), { data: { node: { id: 'other', bypassActors: { totalCount: 0, nodes: [] } } } }]) {
    assert.throws(() => withBypassEvidence(rule, () => invalid));
  }
  assert.throws(() => withBypassEvidence(rule, () => { throw new Error('API unavailable'); }));
});
