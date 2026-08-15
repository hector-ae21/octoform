import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNREADABLE } from '../src/config/sentinels.js';
import {
  bypassFor,
  bypassProblems,
  describeBypass,
  identityKey,
  namesToResolve,
  sameBypass,
  storedWorkflow,
  workflowProblems,
} from '../src/core/identity.js';
import { readRuleset, rulesetBody, sameRuleset } from '../src/core/rulesets.js';
import type { Resolution, RulesetPolicy, StoredActor } from '../src/types/index.js';

const resolution: Resolution = new Map<string, number | null | typeof UNREADABLE>([
  ['user:hector', 11],
  ['team:reviewers', 22],
  ['app:dependabot', 33],
  ['repository:account/octoform', 44],
  ['repository:account/shared', 55],
]);

const ruleset = (over: Partial<RulesetPolicy> = {}): RulesetPolicy => ({
  name: 'protect',
  target_branches: ['main'],
  ...over,
});

test('a name is keyed by its kind, so a team and a user may share one', () => {
  assert.notEqual(
    identityKey({ kind: 'team', name: 'octoform' }),
    identityKey({ kind: 'user', name: 'octoform' }),
  );
});

test('every name a policy uses is collected once, however many rulesets name it', () => {
  const names = namesToResolve(
    {
      rulesets: [
        ruleset({ bypass: [{ teams: ['reviewers'] }] }),
        ruleset({
          name: 'tags',
          bypass: [{ teams: ['reviewers'], users: ['hector'] }],
          required_workflows: [{ path: '.github/workflows/ci.yml' }],
        }),
      ],
    },
    'account/octoform',
  );

  assert.deepEqual(names.map(identityKey).sort(), [
    'repository:account/octoform',
    'team:reviewers',
    'user:hector',
  ]);
});

test('a workflow that already carries its repository id needs no lookup', () => {
  const names = namesToResolve(
    {
      rulesets: [ruleset({ required_workflows: [{ path: 'ci.yml', repository_id: 99 }] })],
    },
    'account/octoform',
  );

  assert.deepEqual(names, []);
  assert.equal(
    storedWorkflow({ path: 'ci.yml', repository_id: 99 }, resolution, 'account/octoform')[
      'repository_id'
    ],
    99,
    'and it is sent as written, not re-read as living here',
  );
});

test('each kind of actor becomes the id and type GitHub stores', () => {
  const actors = bypassFor(
    ruleset({
      bypass: [
        { users: ['hector'], teams: ['reviewers'], apps: ['dependabot'], roles: [5] },
        { mode: 'pull_request', deploy_keys: true, organization_admins: true },
      ],
    }),
    undefined,
    resolution,
  );

  assert.deepEqual(actors, [
    { actor_type: 'User', actor_id: 11, bypass_mode: 'always' },
    { actor_type: 'Team', actor_id: 22, bypass_mode: 'always' },
    { actor_type: 'Integration', actor_id: 33, bypass_mode: 'always' },
    { actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' },
    { actor_type: 'DeployKey', actor_id: null, bypass_mode: 'pull_request' },
    { actor_type: 'OrganizationAdmin', actor_id: null, bypass_mode: 'pull_request' },
  ]);
});

test('saying nothing about bypass keeps whoever is already allowed past', () => {
  const existing: StoredActor[] = [{ actor_type: 'Team', actor_id: 22, bypass_mode: 'always' }];

  assert.deepEqual(bypassFor(ruleset(), existing, resolution), existing);
  assert.deepEqual(
    bypassFor(ruleset({ bypass: [] }), existing, resolution),
    [],
    'an empty list is how a policy actually revokes them',
  );
});

test('an undeclared bypass matches anything, and a declared one matches by contents', () => {
  const current: StoredActor[] = [
    { actor_type: 'Team', actor_id: 22, bypass_mode: 'always' },
    { actor_type: 'User', actor_id: 11, bypass_mode: 'exempt' },
  ];

  assert.ok(sameBypass(current, ruleset(), resolution));
  assert.ok(
    sameBypass(
      current,
      ruleset({ bypass: [{ users: ['hector'], mode: 'exempt' }, { teams: ['reviewers'] }] }),
      resolution,
    ),
    'written in the other order, and still the same list',
  );
  assert.equal(
    sameBypass(current, ruleset({ bypass: [{ teams: ['reviewers'] }] }), resolution),
    false,
  );
});

test('the two actors with no meaningful id are compared without one', () => {
  /** GitHub documents OrganizationAdmin's id as ignored, and echoes back its own. */
  const current: StoredActor[] = [
    { actor_type: 'OrganizationAdmin', actor_id: 1, bypass_mode: 'always' },
  ];

  assert.ok(sameBypass(current, ruleset({ bypass: [{ organization_admins: true }] }), resolution));
});

test('a name nobody can find and a lookup that failed block for different reasons', () => {
  const partial: Resolution = new Map<string, number | null | typeof UNREADABLE>([
    ['team:ghosts', null],
    ['user:hector', UNREADABLE],
  ]);
  const problems = bypassProblems(
    ruleset({ bypass: [{ teams: ['ghosts'], users: ['hector'] }] }),
    partial,
    'org',
    'branch',
  );

  assert.deepEqual(problems, ['could not look up the user "hector"', 'no team called "ghosts"']);
});

test('a personal repository has no teams and no organisation owners to grant', () => {
  const problems = bypassProblems(
    ruleset({ bypass: [{ teams: ['reviewers'], organization_admins: true }] }),
    resolution,
    'user',
    'branch',
  );

  assert.equal(problems.length, 2);
  assert.match(String(problems[0]), /no teams on a personal repository/u);
  assert.match(String(problems[1]), /no organisation owners/u);
});

test('pull_request bypass is refused where GitHub does not accept it', () => {
  assert.match(
    String(
      bypassProblems(
        ruleset({ bypass: [{ mode: 'pull_request', deploy_keys: true }] }),
        resolution,
        'org',
        'branch',
      )[0],
    ),
    /deploy key cannot bypass on pull requests/u,
  );
  assert.match(
    String(
      bypassProblems(
        ruleset({ target_tags: ['v*'], bypass: [{ mode: 'pull_request', users: ['hector'] }] }),
        resolution,
        'org',
        'tag',
      )[0],
    ),
    /tag ruleset has no pull requests/u,
  );
  assert.deepEqual(
    bypassProblems(
      ruleset({ bypass: [{ mode: 'pull_request', users: ['hector'] }] }),
      resolution,
      'org',
      'branch',
    ),
    [],
    'which is the case it is for',
  );
});

test('a workflow names a repository and is sent as its id', () => {
  const policy = ruleset({
    required_workflows: [
      { path: '.github/workflows/ci.yml' },
      { path: 'release.yml', repository: 'account/shared', ref: 'refs/heads/main' },
    ],
  });

  assert.deepEqual(workflowProblems(policy, resolution, 'account/octoform'), []);
  const body = rulesetBody(policy, undefined, {
    resolution,
    repository: 'account/octoform',
  });
  const rule = (body.rules as Array<{ type: string; parameters?: Record<string, unknown> }>).find(
    (candidate) => candidate.type === 'workflows',
  );

  assert.deepEqual(rule?.parameters, {
    workflows: [
      { path: '.github/workflows/ci.yml', repository_id: 44 },
      { path: 'release.yml', repository_id: 55, ref: 'refs/heads/main' },
    ],
    do_not_enforce_on_create: false,
  });
});

test('a declared workflow and the stored one compare through the id, not the name', () => {
  const context = { resolution, repository: 'account/octoform' };
  const current = readRuleset({
    id: 7,
    name: 'protect',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      {
        type: 'workflows',
        parameters: {
          workflows: [{ path: 'ci.yml', repository_id: 55 }],
          do_not_enforce_on_create: false,
        },
      },
    ],
  });

  assert.ok(
    sameRuleset(
      current,
      ruleset({ required_workflows: [{ path: 'ci.yml', repository: 'account/shared' }] }),
      context,
    ),
  );
  assert.equal(
    sameRuleset(
      current,
      ruleset({ required_workflows: [{ path: 'ci.yml', repository: 'account/octoform' }] }),
      context,
    ),
    false,
    'the same path in a different repository is a different requirement',
  );
});

test('an update sends the stored bypass list back, since the write replaces it', () => {
  const current = readRuleset({
    id: 7,
    name: 'protect',
    bypass_actors: [{ actor_type: 'Team', actor_id: 22, bypass_mode: 'always' }],
    rules: [],
  });
  const body = rulesetBody(ruleset({ block_deletion: true }), current, {
    resolution,
    repository: 'account/octoform',
  });

  assert.deepEqual(body.bypass_actors, [
    { actor_type: 'Team', actor_id: 22, bypass_mode: 'always' },
  ]);
});

test('a bypass reads back as the names the policy used, and as ids for the rest', () => {
  const actors: StoredActor[] = [
    { actor_type: 'Team', actor_id: 22, bypass_mode: 'always' },
    { actor_type: 'User', actor_id: 999, bypass_mode: 'exempt' },
    { actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' },
  ];

  assert.equal(
    describeBypass(actors, resolution),
    'bypass: team:reviewers, User 999 (exempt), DeployKey',
  );
  assert.equal(describeBypass([]), 'nobody bypasses');
});
