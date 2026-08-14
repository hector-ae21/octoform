import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isManaged, resolvePolicy } from '../src/config/resolve.js';
import type { OwnerScope, RepoState } from '../src/types/index.js';

const repo = (over: Partial<RepoState> = {}): RepoState => ({
  name: 'thing',
  visibility: 'public',
  archived: false,
  default_branch: 'main',
  description: null,
  homepage: null,
  topics: [],
  ...over,
});

test('an empty configuration manages nothing', () => {
  const policy = resolvePolicy({ owner: 'o' }, repo());
  assert.deepEqual(policy, {});
});

test('types layer over defaults, key by key', () => {
  const scope: OwnerScope = {
    owner: 'o',
    defaults: { features: { issues: true, wiki: false } },
    types: { lib: { features: { wiki: true } } },
  };
  const policy = resolvePolicy(scope, repo({ type: 'lib' }));

  assert.equal(policy.features?.issues, true, 'untouched key survives from defaults');
  assert.equal(policy.features?.wiki, true, 'the narrower layer wins');
});

test('a repository entry overrides its type', () => {
  const scope: OwnerScope = {
    owner: 'o',
    types: { lib: { features: { issues: false } } },
    repos: { thing: { features: { issues: true } } },
  };
  const policy = resolvePolicy(scope, repo({ type: 'lib' }));
  assert.equal(policy.features?.issues, true);
});

test('null cancels an inherited policy without cancelling its neighbours', () => {
  const scope: OwnerScope = {
    owner: 'o',
    defaults: { merge: { delete_branch_on_merge: true, allow_squash: true } },
    repos: { thing: { merge: { delete_branch_on_merge: null } } },
  };
  const policy = resolvePolicy(scope, repo());

  assert.equal(isManaged(policy.merge?.delete_branch_on_merge), false, 'cancelled');
  assert.equal(policy.merge?.allow_squash, true, 'sibling key is unaffected');
});

test('false is a policy, not an absence', () => {
  const scope: OwnerScope = { owner: 'o', defaults: { features: { wiki: false } } };
  const policy = resolvePolicy(scope, repo());

  assert.equal(policy.features?.wiki, false);
  assert.equal(isManaged(policy.features?.wiki), true, 'false is still managed');
});

test('a type declared in the config wins over the recorded property', () => {
  const scope: OwnerScope = {
    owner: 'o',
    types: {
      fromProperty: { features: { issues: false } },
      fromConfig: { features: { issues: true } },
    },
    repos: { thing: { type: 'fromConfig' } },
  };
  const policy = resolvePolicy(scope, repo({ type: 'fromProperty' }));
  assert.equal(policy.features?.issues, true);
});

test('list policies replace rather than accumulate', () => {
  const scope: OwnerScope = {
    owner: 'o',
    types: { lib: { rulesets: [{ name: 'a', target_branches: ['main'] }] } },
    repos: { thing: { rulesets: [] } },
  };
  const policy = resolvePolicy(scope, repo({ type: 'lib' }));
  assert.deepEqual(policy.rulesets, [], 'a repository can opt out of its type rulesets');
});

test('an unknown type simply skips that layer', () => {
  const scope: OwnerScope = {
    owner: 'o',
    defaults: { features: { issues: true } },
    types: { lib: { features: { issues: false } } },
  };
  const policy = resolvePolicy(scope, repo({ type: 'not-declared' }));
  assert.equal(policy.features?.issues, true);
});
