import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRepo } from '../src/core/plan.js';
import { UNREADABLE } from '../src/config/types.js';
import type { PolicySet, RepoDetail } from '../src/config/types.js';

const OPTIONS = { rulesetsEnforcedOnPrivate: true };

const repo = (over: Partial<RepoDetail> = {}): RepoDetail => ({
  name: 'thing',
  visibility: 'public',
  archived: false,
  default_branch: 'main',
  description: null,
  homepage: null,
  topics: [],
  settings: {
    'features.issues': true,
    'features.wiki': true,
    'merge.delete_branch_on_merge': false,
    'repo.description': null,
    'repo.topics': [],
  },
  ...over,
});

test('a policy that matches produces no change', () => {
  const policy: PolicySet = { features: { issues: true } };
  assert.deepEqual(planRepo(repo(), policy, OPTIONS), []);
});

test('an unmanaged setting is never a change, however different', () => {
  // wiki is true on the repository and simply absent from the policy.
  const policy: PolicySet = { features: { issues: true } };
  const changes = planRepo(repo(), policy, OPTIONS);
  assert.equal(changes.find((c) => c.key === 'features.wiki'), undefined);
});

test('a cancelled setting is not a change either', () => {
  const policy: PolicySet = { features: { wiki: null } };
  assert.deepEqual(planRepo(repo(), policy, OPTIONS), []);
});

test('false is planned when the repository has it on', () => {
  const policy: PolicySet = { features: { wiki: false } };
  const changes = planRepo(repo(), policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.deepEqual(
    { key: changes[0]?.key, from: changes[0]?.from, to: changes[0]?.to },
    { key: 'features.wiki', from: true, to: false },
  );
});

test('manage: false suppresses everything', () => {
  const policy: PolicySet = { manage: false, features: { wiki: false } };
  assert.deepEqual(planRepo(repo(), policy, OPTIONS), []);
});

test('an archived repository is never planned against', () => {
  const policy: PolicySet = { features: { wiki: false } };
  assert.deepEqual(planRepo(repo({ archived: true }), policy, OPTIONS), []);
});

test('unset and empty string are the same absence', () => {
  const policy: PolicySet = { repo: { description: '' } };
  assert.deepEqual(planRepo(repo(), policy, OPTIONS), []);
});

test('topics compare as sets, not as ordered lists', () => {
  const state = repo({ settings: { ...repo().settings, 'repo.topics': ['b', 'a'] } });
  const policy: PolicySet = { repo: { topics: ['a', 'b'] } };
  assert.deepEqual(planRepo(state, policy, OPTIONS), []);
});

test('an unreadable current value is blocked, not silently applied', () => {
  const state = repo({ settings: { ...repo().settings, 'security.secret_scanning': UNREADABLE } });
  const policy: PolicySet = { security: { secret_scanning: true } };
  const changes = planRepo(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /could not be read/);
});

test('an unimplemented policy is blamed on the tool, not on the configuration', () => {
  const policy: PolicySet = { security: { automated_security_fixes: true } };
  const changes = planRepo(repo(), policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.blocked, 'not implemented yet');
});

test('rulesets on a private repository are blocked when the plan does not enforce them', () => {
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['main'] }],
  };
  const changes = planRepo(repo({ visibility: 'private' }), policy, {
    rulesetsEnforcedOnPrivate: false,
  });
  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /not enforced on private/);
});

test('the same rulesets are not blocked on a public repository', () => {
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['main'] }],
  };
  const changes = planRepo(repo(), policy, { rulesetsEnforcedOnPrivate: false });
  assert.deepEqual(changes, []);
});
