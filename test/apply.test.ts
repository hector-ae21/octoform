import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRepoChanges } from '../src/github/apply.js';
import type { Change } from '../src/config/types.js';

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

const change = (key: string, to: unknown): Change => ({ repo: 'thing', key, from: null, to });

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
  assert.deepEqual(
    calls.map((c) => c.route).sort(),
    [
      'PATCH /repos/{owner}/{repo}/code-scanning/default-setup',
      'PUT /repos/{owner}/{repo}/topics',
      'PUT /repos/{owner}/{repo}/vulnerability-alerts',
    ],
  );
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
  const results = await applyRepoChanges(octokit, 'owner', 'thing', [change('rulesets.something', 'x')]);

  assert.equal(calls.length, 0);
  assert.equal(results.length, 0);
});
