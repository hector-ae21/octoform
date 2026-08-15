import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRepo } from '../src/core/plan.js';
import { UNREADABLE } from '../src/config/sentinels.js';
import { capability } from '../src/github/capabilities.js';
import type {
  Change,
  ExistingRuleset,
  PlanOptions,
  PolicySet,
  RepoDetail,
} from '../src/types/index.js';

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

/**
 * A ruleset as GitHub already has it. Every switch rule is read as explicitly
 * off unless it is there, which is how the reader reports them, so a fixture
 * that only lists what is on still compares correctly.
 */
const stored = (over: Partial<ExistingRuleset> = {}): ExistingRuleset => ({
  id: 7,
  name: 'protect',
  target: 'branch',
  enforcement: 'active',
  include: [],
  exclude: [],
  unmodelled: [],
  ...over,
  rules: {
    block_creation: false,
    block_deletion: false,
    block_force_push: false,
    require_linear_history: false,
    require_signatures: false,
    require_license_compliance_scanning: false,
    ...over.rules,
  },
});

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

test('an archived repository is not planned against, since it refuses every write', () => {
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

test('a setting only a mutation can change carries the node id that mutation needs', () => {
  const state = repo({
    nodeId: 'R_abc',
    settings: { ...repo().settings, 'features.discussions': false },
  });
  const policy: PolicySet = { features: { discussions: true } };
  const [change] = planned(state, policy, OPTIONS);

  assert.equal(change?.blocked, undefined);
  assert.deepEqual(change?.payload, { repositoryId: 'R_abc' });
});

test('without a node id there is nothing to address the mutation to, so it is blocked', () => {
  const state = repo({ settings: { ...repo().settings, 'features.discussions': false } });
  const policy: PolicySet = { features: { discussions: true } };
  const [change] = planned(state, policy, OPTIONS);

  assert.match(String(change?.blocked), /GraphQL identity/u);
});

test('a creation policy is compared like any other value', () => {
  const state = repo({
    nodeId: 'R_abc',
    settings: { ...repo().settings, 'repo.issue_creation': 'ALL' },
  });

  assert.deepEqual(planned(state, { repo: { issue_creation: 'ALL' } }, OPTIONS), []);
  const [change] = planned(state, { repo: { issue_creation: 'COLLABORATORS_ONLY' } }, OPTIONS);
  assert.deepEqual(
    { from: change?.from, to: change?.to },
    { from: 'ALL', to: 'COLLABORATORS_ONLY' },
  );
});

test('a GraphQL-only setting that could not be read blocks rather than being planned over', () => {
  const state = repo({
    nodeId: 'R_abc',
    settings: { ...repo().settings, 'features.sponsorships': UNREADABLE },
  });
  const policy: PolicySet = { features: { sponsorships: true } };

  assert.match(String(planned(state, policy, OPTIONS)[0]?.blocked), /could not be read/u);
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
        stored({
          include: ['v*.x'],
          rules: {
            require_pull_request: true,
            required_approvals: 1,
            required_checks: ['CI complete'],
            block_force_push: true,
            block_deletion: true,
          },
        }),
      ],
    },
  });
  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('a ruleset that differs is updated in place, carrying the id it already has', () => {
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['v*.x'], required_approvals: 2 }],
  };
  const existing = stored({
    include: ['v*.x'],
    rules: { require_pull_request: true, required_approvals: 1 },
  });
  const state = repo({ structure: { rulesets: [existing] } });
  const changes = planned(state, policy, OPTIONS);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.payload, { ruleset: policy.rulesets?.[0], id: 7, existing });
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
        stored({
          id: 1,
          include: ['main'],
          rules: { require_pull_request: true, required_approvals: 1, block_force_push: true },
        }),
      ],
    },
  });

  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('enabling the code scanning default setup warns about the workflow it would disable', () => {
  const state = repo({
    settings: { ...repo().settings, 'security.code_scanning_default_setup': false },
    structure: { workflowsUploadingCodeScanning: ['.github/workflows/security.yml'] },
  });
  const policy: PolicySet = { security: { code_scanning_default_setup: true } };
  const [change] = planned(state, policy, OPTIONS);

  assert.match(String(change?.warning), /security\.yml/u);
  assert.match(String(change?.warning), /refuses those uploads/u);
  assert.equal(change?.blocked, undefined, 'the change still happens; it is a consequence');
});

test('no warning when the repository has no workflow that uploads code scanning', () => {
  const state = repo({
    settings: { ...repo().settings, 'security.code_scanning_default_setup': false },
    structure: { workflowsUploadingCodeScanning: [] },
  });
  const policy: PolicySet = { security: { code_scanning_default_setup: true } };
  assert.equal(planned(state, policy, OPTIONS)[0]?.warning, undefined);
});

test('unreadable workflows are reported as unknown, not as none', () => {
  const state = repo({
    settings: { ...repo().settings, 'security.code_scanning_default_setup': false },
    structure: {},
  });
  const policy: PolicySet = { security: { code_scanning_default_setup: true } };
  assert.match(String(planned(state, policy, OPTIONS)[0]?.warning), /could not be read/u);
});

test('turning the default setup off cannot disable a workflow, so it carries no warning', () => {
  const state = repo({
    settings: { ...repo().settings, 'security.code_scanning_default_setup': true },
    structure: { workflowsUploadingCodeScanning: ['.github/workflows/security.yml'] },
  });
  const policy: PolicySet = { security: { code_scanning_default_setup: false } };
  assert.equal(planned(state, policy, OPTIONS)[0]?.warning, undefined);
});

const merging = (over: Record<string, unknown> = {}): RepoDetail =>
  repo({
    settings: {
      ...repo().settings,
      'merge.squash_title': 'PR_TITLE',
      'merge.squash_message': 'COMMIT_MESSAGES',
      'merge.merge_commit_title': 'MERGE_MESSAGE',
      'merge.merge_commit_message': 'PR_TITLE',
      ...over,
    },
  });

test('a merge message default is planned like any other setting', () => {
  const policy: PolicySet = { merge: { squash_title: 'COMMIT_OR_PR_TITLE' } };
  const [change] = planned(merging(), policy, OPTIONS);

  assert.deepEqual(
    { key: change?.key, from: change?.from, to: change?.to, blocked: change?.blocked },
    {
      key: 'merge.squash_title',
      from: 'PR_TITLE',
      to: 'COMMIT_OR_PR_TITLE',
      blocked: undefined,
    },
  );
});

test('a message default declared without its title is blocked, not sent', () => {
  const policy: PolicySet = { merge: { squash_message: 'BLANK' } };
  const [change] = planned(merging(), policy, OPTIONS);

  assert.match(String(change?.blocked), /merge\.squash_title/u);
});

test('a message default carries the declared title so GitHub accepts it', () => {
  const policy: PolicySet = { merge: { squash_message: 'BLANK', squash_title: 'PR_TITLE' } };
  const change = planned(merging(), policy, OPTIONS).find((c) => c.key === 'merge.squash_message');

  assert.deepEqual(change?.payload, { requires: { 'merge.squash_title': 'PR_TITLE' } });
});

test('the title it carries is the declared one even when the repository already has it', () => {
  // squash_title is unchanged, so it is planned as no change at all — and yet
  // the request still has to state it, or GitHub rejects the message.
  const policy: PolicySet = { merge: { squash_message: 'BLANK', squash_title: 'PR_TITLE' } };
  const changes = planned(merging(), policy, OPTIONS);

  assert.deepEqual(
    changes.map((c) => c.key),
    ['merge.squash_message'],
  );
});

test('the merge-commit pair is independent of the squash pair', () => {
  const policy: PolicySet = { merge: { merge_commit_message: 'BLANK' } };
  const [change] = planned(merging(), policy, OPTIONS);

  assert.match(String(change?.blocked), /merge\.merge_commit_title/u);
});

test('a message default that already matches is not blocked, because nothing is sent', () => {
  const policy: PolicySet = { merge: { squash_message: 'COMMIT_MESSAGES' } };
  assert.deepEqual(planned(merging(), policy, OPTIONS), []);
});

test('a setting the owner enforces is blocked with the reason, not attempted', () => {
  const state = repo({
    settings: { ...repo().settings, 'security.immutable_releases': true },
    enforced: { 'security.immutable_releases': 'account enforces immutable releases' },
  });
  const policy: PolicySet = { security: { immutable_releases: false } };
  const [change] = planned(state, policy, OPTIONS);

  assert.equal(change?.blocked, 'account enforces immutable releases');
});

test('enforcement only matters where the policy disagrees with it', () => {
  const state = repo({
    settings: { ...repo().settings, 'security.immutable_releases': true },
    enforced: { 'security.immutable_releases': 'account enforces immutable releases' },
  });
  const policy: PolicySet = { security: { immutable_releases: true } };

  assert.deepEqual(planned(state, policy, OPTIONS), []);
});

test('declaring the unarchive is what makes an archived repository plannable again', () => {
  const archived = repo({
    archived: true,
    settings: { ...repo().settings, 'repo.archived': true },
  });

  const keys = planned(
    archived,
    { repo: { archived: false }, features: { wiki: false } },
    OPTIONS,
  ).map((change) => change.key);
  assert.deepEqual(keys.sort(), ['features.wiki', 'repo.archived']);
});

test('everything planned beside an unarchive waits for it', () => {
  const archived = repo({
    archived: true,
    settings: { ...repo().settings, 'repo.archived': true },
  });
  const changes = planned(
    archived,
    { repo: { archived: false }, features: { wiki: false } },
    OPTIONS,
  );

  const unarchive = changes.find((c) => c.key === 'repo.archived');
  const other = changes.find((c) => c.key === 'features.wiki');
  assert.deepEqual(other?.prerequisites, [unarchive?.id]);
  assert.deepEqual(unarchive?.prerequisites, []);
});

test('archiving waits for everything else, so it cannot freeze a failed change', () => {
  const state = repo({ settings: { ...repo().settings, 'repo.archived': false } });
  const changes = planned(state, { repo: { archived: true }, features: { wiki: false } }, OPTIONS);

  const archive = changes.find((c) => c.key === 'repo.archived');
  const other = changes.find((c) => c.key === 'features.wiki');
  assert.deepEqual(archive?.prerequisites, [other?.id]);
  assert.deepEqual(other?.prerequisites, []);
});

test('a rename without rename_from is refused, whatever layer declared it', () => {
  const [change] = planned(repo(), { repo: { name: 'renamed' } }, OPTIONS);

  assert.match(String(change?.blocked), /must declare repo\.rename_from/u);
});

test('a rename fires only from a name it anticipated', () => {
  const policy: PolicySet = { repo: { name: 'renamed', rename_from: ['something-else'] } };
  const [change] = planned(repo(), policy, OPTIONS);

  assert.match(String(change?.blocked), /not in rename_from/u);
});

test('a rename warns that the entry which asked for it will stop matching', () => {
  const policy: PolicySet = { repo: { name: 'renamed', rename_from: ['thing'] } };
  const [change] = planned(repo(), policy, OPTIONS);

  assert.equal(change?.blocked, undefined);
  assert.equal(change?.risk, 'sensitive');
  assert.match(String(change?.warning), /stop matching/u);
});

test('rename_from is a guard, not a setting, so it is never planned on its own', () => {
  const policy: PolicySet = { repo: { rename_from: ['thing'] } };
  assert.deepEqual(planned(repo(), policy, OPTIONS), []);
});

test('leaving internal visibility warns that the configuration cannot restore it', () => {
  const state = repo({
    visibility: 'internal',
    settings: { ...repo().settings, 'repo.visibility': 'internal' },
  });
  const [change] = planned(state, { repo: { visibility: 'private' } }, OPTIONS);

  assert.equal(change?.blocked, undefined);
  assert.equal(change?.risk, 'sensitive');
  assert.match(String(change?.warning), /cannot be undone/u);
});

test('an ordinary visibility change carries no such warning', () => {
  const state = repo({ settings: { ...repo().settings, 'repo.visibility': 'public' } });
  const [change] = planned(state, { repo: { visibility: 'private' } }, OPTIONS);

  assert.equal(change?.warning, undefined);
});

test('a ruleset with no target names no refs, so it is refused rather than guessed', () => {
  const policy: PolicySet = { rulesets: [{ name: 'protect' }] };
  const [change] = planned(repo({ structure: { rulesets: [] } }), policy, OPTIONS);

  assert.match(String(change?.blocked), /exactly one of target_branches/u);
});

test('two targets disagree with each other, and are refused the same way', () => {
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['main'], target_tags: ['v*'] }],
  };
  const [change] = planned(repo({ structure: { rulesets: [] } }), policy, OPTIONS);

  assert.match(String(change?.blocked), /exactly one of target_branches/u);
});

test('an update carries the stored ruleset, so unmanaged rules can be put back', () => {
  const existing = stored({
    include: ['main'],
    unmodelled: [{ type: 'something_new' }],
  });
  const policy: PolicySet = {
    rulesets: [{ name: 'protect', target_branches: ['main'], block_deletion: true }],
  };
  const [change] = planned(repo({ structure: { rulesets: [existing] } }), policy, OPTIONS);

  assert.equal((change?.payload as { existing?: unknown })?.existing, existing);
});

test('an ensured branch is cut from the name the run will leave behind, not the old one', () => {
  const state = repo({
    default_branch: 'master',
    structure: { branches: { develop: false } },
  });
  const policy: PolicySet = {
    default_branch: { name: 'main', rename_from: ['master'] },
    ensure_branches: ['develop'],
  };
  const change = planned(state, policy, OPTIONS).find((c) => c.key === 'ensure_branches.develop');

  assert.deepEqual(change?.payload, { branch: 'develop', from: 'main' });
});

test('with no rename planned it is cut from the branch that is there', () => {
  const state = repo({ structure: { branches: { develop: false } } });
  const policy: PolicySet = { ensure_branches: ['develop'] };
  const change = planned(state, policy, OPTIONS).find((c) => c.key === 'ensure_branches.develop');

  assert.deepEqual(change?.payload, { branch: 'develop', from: 'main' });
});
