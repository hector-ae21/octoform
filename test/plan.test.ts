import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRepo } from '../src/core/plan.js';
import { UNREADABLE } from '../src/config/sentinels.js';
import { capability } from '../src/github/capabilities.js';
import type { Change, PlanOptions, PolicySet, RepoDetail } from '../src/types/index.js';

const SUPPORTED = capability('supported', 'available in this fixture', 'resource-state');
const FORBIDDEN = capability('forbidden', 'not available in this fixture', 'permission');
const OPTIONS = { rulesetCapability: SUPPORTED };

/**
 * Every case here is about one repository under one policy, so the owner is
 * fixed. Owner threading and operation identity are covered by the property
 * suite instead.
 */
const planned = (repo: RepoDetail, policy: PolicySet, options: PlanOptions = OPTIONS): Change[] =>
  planRepo('account', repo, policy, options);

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
  assert.deepEqual(planned(repo(), policy, OPTIONS), []);
});

test('an unmanaged setting is never a change, however different', () => {
  // wiki is true on the repository and simply absent from the policy.
  const policy: PolicySet = { features: { issues: true } };
  const changes = planned(repo(), policy, OPTIONS);
  assert.equal(
    changes.find((c) => c.key === 'features.wiki'),
    undefined,
  );
});

test('a cancelled setting is not a change either', () => {
  const policy: PolicySet = { features: { wiki: null } };
  assert.deepEqual(planned(repo(), policy, OPTIONS), []);
});

test('false is planned when the repository has it on', () => {
  const policy: PolicySet = { features: { wiki: false } };
  const changes = planned(repo(), policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.deepEqual(
    { key: changes[0]?.key, from: changes[0]?.from, to: changes[0]?.to },
    { key: 'features.wiki', from: true, to: false },
  );
});

test('manage: false suppresses everything', () => {
  const policy: PolicySet = { manage: false, features: { wiki: false } };
  assert.deepEqual(planned(repo(), policy, OPTIONS), []);
});

test('an archived repository is never planned against', () => {
  const policy: PolicySet = { features: { wiki: false } };
  assert.deepEqual(planned(repo({ archived: true }), policy, OPTIONS), []);
});

test('unset and empty string are the same absence', () => {
  const policy: PolicySet = { repo: { description: '' } };
  assert.deepEqual(planned(repo(), policy, OPTIONS), []);
});

test('topics compare as sets, not as ordered lists', () => {
  const state = repo({ settings: { ...repo().settings, 'repo.topics': ['b', 'a'] } });
  const policy: PolicySet = { repo: { topics: ['a', 'b'] } };
  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('an unreadable current value is blocked, not silently applied', () => {
  const state = repo({ settings: { ...repo().settings, 'security.secret_scanning': UNREADABLE } });
  const policy: PolicySet = { security: { secret_scanning: true } };
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /could not be read/);
});

test('an unreadable scanning setting is explained by visibility, never by a guessed plan', () => {
  const state = repo({
    settings: { ...repo().settings, 'security.secret_scanning': UNREADABLE },
    visibility: 'private',
  });
  const policy: PolicySet = { security: { secret_scanning: true } };
  const reason = String(planned(state, policy, OPTIONS)[0]?.blocked);
  assert.match(reason, /private repository without Advanced Security/);
  assert.doesNotMatch(reason, /plan/i);
});

test('an unreadable value visibility cannot explain says only what is known', () => {
  const state = repo({ settings: { ...repo().settings, 'merge.allow_squash': UNREADABLE } });
  const policy: PolicySet = { merge: { allow_squash: true } };
  const reason = String(planned(state, policy, OPTIONS)[0]?.blocked);
  assert.match(reason, /could not be read/);
  assert.doesNotMatch(reason, /plan|Advanced Security/i);
});

test('a policy with no REST endpoint at all is blamed on the API, not on the configuration', () => {
  const state = repo({ settings: { ...repo().settings, 'features.discussions': false } });
  const policy: PolicySet = { features: { discussions: true } };
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.blocked, 'not applicable over the REST API');
});

test('rulesets on a private repository are blocked when the owner and token cannot manage them', () => {
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['main'] }],
  };
  const changes = planned(repo({ visibility: 'private' }), policy, {
    rulesetCapability: FORBIDDEN,
  });
  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /not available in this fixture/);
});

test('a public repository is not blocked for that reason, and a missing ruleset is created', () => {
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['main'] }],
  };
  const changes = planned(repo({ structure: { rulesets: [] } }), policy, {
    rulesetCapability: FORBIDDEN,
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.key, 'rulesets.protect');
  assert.equal(changes[0]?.blocked, undefined);
  assert.equal(changes[0]?.from, null);
});

test('a ruleset that already matches is not planned again', () => {
  const policy: PolicySet = {
    rulesets: [
      {
        name: 'protect',
        target_branches: ['v*.x'],
        required_approvals: 1,
        required_checks: ['CI complete'],
        block_force_push: true,
        block_deletion: true,
      },
    ],
  };
  const state = repo({
    structure: {
      rulesets: [
        {
          id: 7,
          name: 'protect',
          target_branches: ['v*.x'],
          required_approvals: 1,
          required_checks: ['CI complete'],
          block_force_push: true,
          block_deletion: true,
        },
      ],
    },
  });
  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('a ruleset that differs is updated in place, carrying the id it already has', () => {
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['v*.x'], required_approvals: 2 }],
  };
  const state = repo({
    structure: {
      rulesets: [
        {
          id: 7,
          name: 'protect',
          target_branches: ['v*.x'],
          required_approvals: 1,
          block_force_push: false,
          block_deletion: false,
        },
      ],
    },
  });
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.payload, { ruleset: policy.rulesets?.[0], id: 7 });
});

test('rulesets that could not be read are blocked rather than assumed missing', () => {
  const policy: PolicySet = { rulesets: [{ name: 'protect', target_branches: ['main'] }] };
  const changes = planned(repo({ structure: {} }), policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /could not read/);
});

test('the default branch is renamed only from a name the configuration anticipated', () => {
  const policy: PolicySet = { default_branch: { name: 'v0.x', rename_from: ['master'] } };
  const changes = planned(repo({ default_branch: 'trunk' }), policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /not in rename_from/);
});

test('a rename that was anticipated goes ahead and names the workflows it will break', () => {
  const policy: PolicySet = { default_branch: { name: 'main', rename_from: ['master'] } };
  const state = repo({
    default_branch: 'master',
    structure: { workflowsNamingDefaultBranch: ['.github/workflows/ci.yml'] },
  });
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.blocked, undefined);
  assert.match(String(changes[0]?.warning), /ci\.yml/);
  assert.deepEqual(changes[0]?.payload, { from: 'master', to: 'main' });
});

test('a default branch that already has the wanted name is not a change', () => {
  const policy: PolicySet = { default_branch: { name: 'main' } };
  assert.deepEqual(planned(repo(), policy, OPTIONS), []);
});

test('ensure_branches creates what is missing and leaves what is there alone', () => {
  const policy: PolicySet = { ensure_branches: ['main', 'develop'] };
  const state = repo({ structure: { branches: { main: true, develop: false } } });
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.key, 'ensure_branches.develop');
  assert.deepEqual(changes[0]?.payload, { branch: 'develop', from: 'main' });
});

test('an environment that exists with the same reviewers is not touched', () => {
  const policy: PolicySet = { environments: [{ name: 'npm', reviewers: ['alice'] }] };
  const state = repo({ structure: { environments: [{ name: 'npm', reviewers: ['alice'] }] } });
  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('reviewer order does not count as drift, same as topics', () => {
  const policy: PolicySet = { environments: [{ name: 'npm', reviewers: ['alice', 'bob'] }] };
  const state = repo({
    structure: { environments: [{ name: 'npm', reviewers: ['bob', 'alice'] }] },
  });
  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('a missing environment is planned with its reviewers', () => {
  const policy: PolicySet = { environments: [{ name: 'npm', reviewers: ['someone'] }] };
  const state = repo({ structure: { environments: [] } });
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.key, 'environments.npm');
  assert.equal(changes[0]?.from, null);
  assert.match(String(changes[0]?.to), /someone/);
});

test('an existing environment with different reviewers is corrected, not skipped', () => {
  const policy: PolicySet = { environments: [{ name: 'npm', reviewers: ['alice'] }] };
  const state = repo({ structure: { environments: [{ name: 'npm', reviewers: ['bob'] }] } });
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.key, 'environments.npm');
  assert.match(String(changes[0]?.from), /bob/);
  assert.match(String(changes[0]?.to), /alice/);
  assert.deepEqual(changes[0]?.payload, { environment: policy.environments?.[0] });
});

test('an environment guarded by a team is blocked, never read as having no reviewers', () => {
  const policy: PolicySet = { environments: [{ name: 'npm', reviewers: ['alice'] }] };
  const state = repo({ structure: { environments: [{ name: 'npm', reviewers: UNREADABLE }] } });
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /team/);
});

test('a file that is already there is never re-seeded', () => {
  const policy: PolicySet = {
    files: [
      {
        path: '.github/dependabot.yml',
        from: '/presets/dependabot.yml',
        mode: 'create-if-missing',
      },
    ],
  };
  const state = repo({ structure: { files: { '.github/dependabot.yml': true } } });
  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('a missing file is planned, carrying the local source to copy', () => {
  const file = {
    path: '.github/dependabot.yml',
    from: '/presets/dependabot.yml',
    mode: 'create-if-missing' as const,
  };
  const state = repo({ structure: { files: { '.github/dependabot.yml': false } } });
  const changes = planned(state, { files: [file] }, OPTIONS);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.payload, { file });
});

/**
 * The guarantee `apply` rests on: a repository that already matches every part
 * of its policy produces no changes at all, so a second `apply` has nothing to
 * do. Covers all the structured policies at once, since each of them compares
 * differently and any one of them reporting a phantom difference would make
 * every run mutate something.
 */
test('a repository that already matches its whole policy plans nothing', () => {
  const policy: PolicySet = {
    features: { issues: true, wiki: true },
    merge: { delete_branch_on_merge: false },
    repo: { topics: ['a'] },
    default_branch: { name: 'main' },
    ensure_branches: ['main'],
    environments: [{ name: 'npm' }],
    files: [{ path: 'LICENSE', from: '/presets/LICENSE', mode: 'create-if-missing' }],
    rulesets: [
      { name: 'protect', target_branches: ['main'], required_approvals: 1, block_force_push: true },
    ],
  };
  const state = repo({
    settings: { ...repo().settings, 'repo.topics': ['a'] },
    structure: {
      branches: { main: true },
      environments: [{ name: 'npm', reviewers: [] }],
      files: { LICENSE: true },
      rulesets: [
        {
          id: 1,
          name: 'protect',
          target_branches: ['main'],
          required_approvals: 1,
          block_force_push: true,
          block_deletion: false,
        },
      ],
    },
  });

  assert.deepEqual(planned(state, policy, OPTIONS), []);
});
