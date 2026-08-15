import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MUTATION_FIELDS, applyRepoChanges } from '../src/github/apply.js';
import { CHANGED_BY_MUTATION } from '../src/core/plan.js';
import type { Change } from '../src/types/index.js';

/**
 * A minimal stand-in for Octokit: just enough of `.request` to record every
 * call and let a test script canned responses or failures, without a real
 * network call anywhere near this suite.
 */
function fakeOctokit(handler: (route: string, params: Record<string, unknown>) => void | never) {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    octokit: {
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        handler(route, params);
        return { data: {} };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/**
 * The identity fields the planner adds are irrelevant to applying a change,
 * but the type carries them, so every case here fills them in once.
 */
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

const change = (key: string, to: unknown): Change => planned({ key, to });

test('every patch-body change is bundled into a single request', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const changes = [
    change('features.issues', true),
    change('merge.delete_branch_on_merge', true),
    change('repo.description', 'hello'),
  ];

  const results = await applyRepoChanges(octokit, 'owner', 'thing', changes);

  assert.equal(calls.length, 1, 'one API call for three bundled settings');
  assert.equal(calls[0]?.route, 'PATCH /repos/{owner}/{repo}');
  assert.deepEqual(calls[0]?.params, {
    owner: 'owner',
    repo: 'thing',
    has_issues: true,
    delete_branch_on_merge: true,
    description: 'hello',
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.outcome === 'applied'));
});

test('the two security_and_analysis settings nest under one key in the same request', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const changes = [
    change('security.secret_scanning', true),
    change('security.secret_scanning_push_protection', false),
  ];

  await applyRepoChanges(octokit, 'owner', 'thing', changes);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params.security_and_analysis, {
    secret_scanning: { status: 'enabled' },
    secret_scanning_push_protection: { status: 'disabled' },
  });
});

test('topics, vulnerability alerts and code scanning each get their own call', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const changes = [
    change('repo.topics', ['a', 'b']),
    change('security.vulnerability_alerts', true),
    change('security.code_scanning_default_setup', false),
  ];

  const results = await applyRepoChanges(octokit, 'owner', 'thing', changes);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.route).sort(), [
    'PATCH /repos/{owner}/{repo}/code-scanning/default-setup',
    'PUT /repos/{owner}/{repo}/topics',
    'PUT /repos/{owner}/{repo}/vulnerability-alerts',
  ]);
  const codeScanningCall = calls.find((c) => c.route.includes('code-scanning'));
  assert.equal(codeScanningCall?.params.state, 'not-configured');
  const topicsCall = calls.find((c) => c.route.includes('topics'));
  assert.deepEqual(topicsCall?.params.names, ['a', 'b']);
  assert.ok(results.every((r) => r.outcome === 'applied'));
});

test('a failing bundled request marks every change it carried as failed, with the same reason', async () => {
  const { octokit } = fakeOctokit((route) => {
    if (route === 'PATCH /repos/{owner}/{repo}') {
      const err: Error & { status?: number } = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
  });
  const changes = [change('features.issues', true), change('features.wiki', false)];

  const results = await applyRepoChanges(octokit, 'owner', 'thing', changes);

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.outcome === 'failed'));
  assert.ok(results.every((r) => r.error === '403: Forbidden'));
});

test('a failure in one endpoint does not stop the others from being attempted', async () => {
  const { octokit } = fakeOctokit((route) => {
    if (route.includes('vulnerability-alerts')) throw new Error('boom');
  });
  const changes = [change('repo.topics', []), change('security.vulnerability_alerts', true)];

  const results = await applyRepoChanges(octokit, 'owner', 'thing', changes);

  const topics = results.find((r) => r.key === 'repo.topics');
  const alerts = results.find((r) => r.key === 'security.vulnerability_alerts');
  assert.equal(topics?.outcome, 'applied');
  assert.equal(alerts?.outcome, 'failed');
});

test('a change with no known target is simply not attempted', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const results = await applyRepoChanges(octokit, 'owner', 'thing', [
    change('nonsense.thing', 'x'),
  ]);

  assert.equal(calls.length, 0);
  assert.equal(results.length, 0);
});

test('the PUT/DELETE security toggles pick their verb from the value', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  await applyRepoChanges(octokit, 'owner', 'thing', [
    change('security.automated_security_fixes', true),
    change('security.private_vulnerability_reporting', false),
  ]);

  assert.deepEqual(calls.map((c) => c.route).sort(), [
    'DELETE /repos/{owner}/{repo}/private-vulnerability-reporting',
    'PUT /repos/{owner}/{repo}/automated-security-fixes',
  ]);
});

test('immutable releases is a PUT/DELETE toggle of its own', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  await applyRepoChanges(octokit, 'owner', 'thing', [change('security.immutable_releases', true)]);

  assert.deepEqual(
    calls.map((c) => c.route),
    ['PUT /repos/{owner}/{repo}/immutable-releases'],
  );
  assert.deepEqual(calls[0]?.params, { owner: 'owner', repo: 'thing' });
});

test('a message default sends the title GitHub requires alongside it', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const message = planned({
    key: 'merge.squash_message',
    to: 'BLANK',
    payload: { requires: { 'merge.squash_title': 'PR_TITLE' } },
  });

  await applyRepoChanges(octokit, 'owner', 'thing', [message]);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params, {
    owner: 'owner',
    repo: 'thing',
    squash_merge_commit_message: 'BLANK',
    squash_merge_commit_title: 'PR_TITLE',
  });
});

test('a required companion never overwrites a change that sets the same field', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const changes = [
    planned({
      key: 'merge.squash_message',
      to: 'BLANK',
      payload: { requires: { 'merge.squash_title': 'COMMIT_OR_PR_TITLE' } },
    }),
    change('merge.squash_title', 'COMMIT_OR_PR_TITLE'),
  ];

  await applyRepoChanges(octokit, 'owner', 'thing', changes);

  assert.equal(calls.length, 1, 'both belong to the same repository PATCH');
  assert.equal(calls[0]?.params.squash_merge_commit_title, 'COMMIT_OR_PR_TITLE');
});

test('renaming the default branch uses the name it is renaming from, not the target', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const rename = planned({
    key: 'default_branch.name',
    from: 'master',
    to: 'main',
    payload: { from: 'master', to: 'main' },
  });

  const results = await applyRepoChanges(octokit, 'owner', 'thing', [rename]);

  assert.equal(calls[0]?.route, 'POST /repos/{owner}/{repo}/branches/{branch}/rename');
  assert.equal(calls[0]?.params.branch, 'master');
  assert.equal(calls[0]?.params.new_name, 'main');
  assert.equal(results[0]?.outcome, 'applied');
});

test('a ruleset with no id is created, and one with an id is updated in place', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const ruleset = { name: 'protect', target_branches: ['v*.x'], block_deletion: true };

  await applyRepoChanges(octokit, 'owner', 'thing', [
    planned({ key: 'rulesets.protect', from: null, to: 'x', payload: { ruleset } }),
    planned({ key: 'rulesets.other', from: 'a', to: 'b', payload: { ruleset, id: 9 } }),
  ]);

  assert.equal(calls[0]?.route, 'POST /repos/{owner}/{repo}/rulesets');
  assert.equal(calls[1]?.route, 'PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}');
  assert.equal(calls[1]?.params.ruleset_id, 9);
});

test('branch names become refs, and the special ~ targets are left alone', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const ruleset = { name: 'protect', target_branches: ['v*.x', '~DEFAULT_BRANCH'] };

  await applyRepoChanges(octokit, 'owner', 'thing', [
    planned({ key: 'rulesets.protect', from: null, to: 'x', payload: { ruleset } }),
  ]);

  const conditions = calls[0]?.params.conditions as { ref_name: { include: string[] } };
  assert.deepEqual(conditions.ref_name.include, ['refs/heads/v*.x', '~DEFAULT_BRANCH']);
});

test('a declared rule becomes GitHub own shape, and an undeclared one is absent', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const ruleset = {
    name: 'protect',
    target_branches: ['main'],
    required_approvals: 2,
    block_force_push: true,
  };

  await applyRepoChanges(octokit, 'owner', 'thing', [
    planned({ key: 'rulesets.protect', from: null, to: 'x', payload: { ruleset } }),
  ]);

  const rules = calls[0]?.params.rules as Array<{
    type: string;
    parameters?: Record<string, unknown>;
  }>;
  const types = rules.map((r) => r.type).sort();
  assert.deepEqual(types, ['non_fast_forward', 'pull_request']);
  assert.equal(
    rules.find((r) => r.type === 'pull_request')?.parameters?.required_approving_review_count,
    2,
  );
  // block_deletion was not declared, so no deletion rule is invented for it.
  assert.equal(
    rules.find((r) => r.type === 'deletion'),
    undefined,
  );
});

test('seeding a file that cannot be read locally fails that change and no other', async () => {
  const { octokit } = fakeOctokit(() => {});
  const results = await applyRepoChanges(octokit, 'owner', 'thing', [
    change('features.issues', true),
    planned({
      key: 'files.LICENSE',
      from: null,
      to: 'x',
      payload: { file: { path: 'LICENSE', from: '/no/such/file', mode: 'create-if-missing' } },
    }),
  ]);

  assert.equal(results.find((r) => r.key === 'features.issues')?.outcome, 'applied');
  const file = results.find((r) => r.key === 'files.LICENSE');
  assert.equal(file?.outcome, 'failed');
  assert.match(String(file?.error), /cannot read local file/);
});

/**
 * A stand-in for the GraphQL half of Octokit, recording each call the same way
 * the REST fake does.
 */
function fakeGraphql(result?: Error) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  return {
    calls,
    octokit: {
      request: async () => ({ data: {} }),
      graphql: async (query: string, variables: Record<string, unknown>) => {
        calls.push({ query, variables });
        if (result) throw result;
        return { updateRepository: { repository: { id: 'R_abc' } } };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const mutated = (key: string, to: unknown): Change =>
  planned({ key, to, payload: { repositoryId: 'R_abc' } });

test('every GraphQL-only setting travels in a single mutation', async () => {
  const { octokit, calls } = fakeGraphql();
  const changes = [
    mutated('features.discussions', true),
    mutated('features.sponsorships', false),
    mutated('repo.issue_creation', 'COLLABORATORS_ONLY'),
  ];

  const results = await applyRepoChanges(octokit, 'owner', 'thing', changes);

  assert.equal(calls.length, 1, 'one mutation for three settings');
  assert.deepEqual(calls[0]?.variables, {
    input: {
      repositoryId: 'R_abc',
      hasDiscussionsEnabled: true,
      hasSponsorshipsEnabled: false,
      issueCreationPolicy: 'COLLABORATORS_ONLY',
    },
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.outcome === 'applied'));
});

test('a failed mutation marks every setting it carried as failed, with the same reason', async () => {
  const denied = Object.assign(new Error('nope'), {
    errors: [{ type: 'FORBIDDEN', message: 'denied', path: ['updateRepository'] }],
  });
  const { octokit } = fakeGraphql(denied);

  const results = await applyRepoChanges(octokit, 'owner', 'thing', [
    mutated('features.discussions', true),
    mutated('features.sponsorships', true),
  ]);

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.outcome === 'failed'));
  assert.ok(results.every((r) => r.error?.includes('forbidden')));
});

test('a mutation is never retried, because an ambiguous write is resolved by observing', async () => {
  const unavailable = Object.assign(new Error('down'), {
    errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'try later', path: ['updateRepository'] }],
  });
  const { octokit, calls } = fakeGraphql(unavailable);

  await applyRepoChanges(octokit, 'owner', 'thing', [mutated('features.discussions', true)]);

  assert.equal(calls.length, 1, 'a transient failure would be retried on a read, but not here');
});

/**
 * The planner blocks these keys when it has no node id, and the applier is
 * what actually sends them. Two lists that have to agree, held together here
 * rather than by whoever remembers to edit both.
 */
test('every setting the planner routes to a mutation has a field to send it in', () => {
  assert.deepEqual(new Set(Object.keys(MUTATION_FIELDS)), CHANGED_BY_MUTATION);
});

test('unarchiving is sent before anything else, in a request of its own', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const unarchive = planned({ key: 'repo.archived', to: false });
  const other = planned({
    key: 'features.wiki',
    to: true,
    prerequisites: [unarchive.id],
  });

  await applyRepoChanges(octokit, 'owner', 'thing', [other, unarchive]);

  assert.deepEqual(
    calls.map((c) => c.params),
    [
      { owner: 'owner', repo: 'thing', archived: false },
      { owner: 'owner', repo: 'thing', has_wiki: true },
    ],
  );
});

test('archiving is sent last, in a request of its own', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  const other = planned({ key: 'features.wiki', to: true });
  const archive = planned({ key: 'repo.archived', to: true, prerequisites: [other.id] });

  await applyRepoChanges(octokit, 'owner', 'thing', [archive, other]);

  assert.deepEqual(
    calls.map((c) => c.params),
    [
      { owner: 'owner', repo: 'thing', has_wiki: true },
      { owner: 'owner', repo: 'thing', archived: true },
    ],
  );
});

test('a failed change stops the archive that would have frozen it', async () => {
  const { octokit, calls } = fakeOctokit((_route, params) => {
    if (params.has_wiki !== undefined) throw new Error('boom');
  });
  const other = planned({ key: 'features.wiki', to: true });
  const archive = planned({ key: 'repo.archived', to: true, prerequisites: [other.id] });

  const results = await applyRepoChanges(octokit, 'owner', 'thing', [archive, other]);

  assert.equal(calls.length, 1, 'the archive was never sent');
  const stopped = results.find((r) => r.key === 'repo.archived');
  assert.equal(stopped?.outcome, 'blocked');
  assert.match(String(stopped?.error), /frozen/u);
});

test('a failed unarchive stops everything that would have been written after it', async () => {
  const { octokit } = fakeOctokit((_route, params) => {
    if (params.archived === false) throw new Error('boom');
  });
  const unarchive = planned({ key: 'repo.archived', to: false });
  const other = planned({ key: 'features.wiki', to: true, prerequisites: [unarchive.id] });

  const results = await applyRepoChanges(octokit, 'owner', 'thing', [other, unarchive]);

  const stopped = results.find((r) => r.key === 'features.wiki');
  assert.equal(stopped?.outcome, 'blocked');
  assert.match(String(stopped?.error), /refuses writes/u);
});

test('a repository rename travels in the bundled request like other metadata', async () => {
  const { octokit, calls } = fakeOctokit(() => {});
  await applyRepoChanges(octokit, 'owner', 'thing', [
    change('repo.name', 'renamed'),
    change('repo.visibility', 'private'),
    change('repo.template', true),
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params, {
    owner: 'owner',
    repo: 'thing',
    name: 'renamed',
    visibility: 'private',
    is_template: true,
  });
});
