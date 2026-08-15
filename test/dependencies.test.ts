import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockedByPrerequisite,
  orderByDependency,
  withPrerequisites,
} from '../src/core/dependencies.js';
import { applyRepoChanges } from '../src/github/apply.js';
import type { Change } from '../src/types/index.js';

function planned(over: Partial<Change> & Pick<Change, 'key'>): Change {
  return {
    id: `owner/thing#${over.key}`,
    owner: 'owner',
    repo: 'thing',
    operation: 'update',
    risk: 'normal',
    prerequisites: [],
    from: null,
    to: null,
    ...over,
  };
}

const RENAME = 'owner/thing#default_branch.name';

test('a ruleset depends on a rename that is actually planned', () => {
  const changes = withPrerequisites([
    planned({ key: 'rulesets.protect' }),
    planned({ key: 'default_branch.name' }),
  ]);

  assert.deepEqual(changes[0]?.prerequisites, [RENAME]);
});

test('a ruleset depends on nothing when no rename is planned', () => {
  const changes = withPrerequisites([planned({ key: 'rulesets.protect' })]);
  assert.deepEqual(changes[0]?.prerequisites, []);
});

test('the rename does not depend on itself', () => {
  const changes = withPrerequisites([planned({ key: 'default_branch.name' })]);
  assert.deepEqual(changes[0]?.prerequisites, []);
});

test('a setting with no branch in it takes no dependency', () => {
  const changes = withPrerequisites([
    planned({ key: 'merge.allow_squash' }),
    planned({ key: 'default_branch.name' }),
  ]);
  assert.deepEqual(changes[0]?.prerequisites, []);
});

test('ordering puts a prerequisite before what needs it, whatever order it was planned in', () => {
  const ordered = orderByDependency(
    withPrerequisites([
      planned({ key: 'rulesets.protect' }),
      planned({ key: 'files.readme' }),
      planned({ key: 'default_branch.name' }),
    ]),
  );

  assert.equal(ordered[0]?.key, 'default_branch.name');
  assert.deepEqual(
    ordered.slice(1).map((change) => change.key),
    ['rulesets.protect', 'files.readme'],
    'everything else keeps the deterministic order planning gave it',
  );
});

test('ordering never drops a change, even if the edges were somehow circular', () => {
  const a = planned({ key: 'rulesets.a', prerequisites: ['owner/thing#rulesets.b'] });
  const b = planned({ key: 'rulesets.b', prerequisites: ['owner/thing#rulesets.a'] });

  assert.equal(orderByDependency([a, b]).length, 2);
});

test('a change is stopped when something it depends on failed', () => {
  const [ruleset] = withPrerequisites([
    planned({ key: 'rulesets.protect' }),
    planned({ key: 'default_branch.name' }),
  ]);

  const reason = blockedByPrerequisite(ruleset as Change, new Set([RENAME]));
  assert.match(String(reason), /targets branches by name and the default branch was not renamed/u);
});

test('a change is not stopped when its prerequisite succeeded', () => {
  const [ruleset] = withPrerequisites([
    planned({ key: 'rulesets.protect' }),
    planned({ key: 'default_branch.name' }),
  ]);

  assert.equal(blockedByPrerequisite(ruleset as Change, new Set()), undefined);
});

test('a failed rename stops the ruleset that was going to name the new branch', async () => {
  const routes: string[] = [];
  const octokit = {
    request: async (route: string) => {
      routes.push(route);
      if (route.includes('/rename')) throw new Error('branch is protected');
      return { data: {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const changes = withPrerequisites([
    planned({
      key: 'default_branch.name',
      payload: { from: 'master', to: 'main' },
    }),
    planned({
      key: 'rulesets.protect',
      payload: { ruleset: { name: 'protect', target_branches: ['main'] } },
    }),
  ]);

  const results = await applyRepoChanges(octokit, 'owner', 'thing', changes);

  const ruleset = results.find((result) => result.key === 'rulesets.protect');
  assert.equal(ruleset?.outcome, 'blocked');
  assert.match(String(ruleset?.error), /not attempted/u);
  assert.ok(
    !routes.some((route) => route.includes('rulesets')),
    'nothing about the ruleset may reach the API once the rename failed',
  );
});

test('a successful rename lets the ruleset through', async () => {
  const routes: string[] = [];
  const octokit = {
    request: async (route: string) => {
      routes.push(route);
      return { data: {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const changes = withPrerequisites([
    planned({ key: 'default_branch.name', payload: { from: 'master', to: 'main' } }),
    planned({
      key: 'rulesets.protect',
      payload: { ruleset: { name: 'protect', target_branches: ['main'] } },
    }),
  ]);

  const results = await applyRepoChanges(octokit, 'owner', 'thing', changes);

  assert.deepEqual(
    results.map((result) => result.outcome),
    ['applied', 'applied'],
  );
  assert.ok(routes.some((route) => route.includes('rulesets')));
});
