import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPrivateRulesetCapability } from '../src/github/client.js';

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    status,
    response: { data: { message } },
  });
}

function fakeOctokit(result: 'ok' | Error) {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    octokit: {
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        if (result instanceof Error) throw result;
        return { data: {} };
      },
      // The tests intentionally provide only the Octokit surface this probe uses.
    } as any,
  };
}

test('an existing branch protection proves private rulesets are available', async () => {
  const { octokit, calls } = fakeOctokit('ok');

  assert.equal(await detectPrivateRulesetCapability(octokit, 'owner', 'repo', 'main'), true);
  assert.deepEqual(calls, [
    {
      route: 'GET /repos/{owner}/{repo}/branches/{branch}/protection',
      params: { owner: 'owner', repo: 'repo', branch: 'main' },
    },
  ]);
});

test('an explicitly unprotected branch still proves the capability is available', async () => {
  const { octokit } = fakeOctokit(apiError(404, 'Branch not protected'));

  assert.equal(await detectPrivateRulesetCapability(octokit, 'owner', 'repo', 'main'), true);
});

test('a forbidden protection endpoint means this owner and token cannot manage private rulesets', async () => {
  const { octokit } = fakeOctokit(apiError(403, 'Upgrade to GitHub Pro or make this repository public'));

  assert.equal(await detectPrivateRulesetCapability(octokit, 'owner', 'repo', 'main'), false);
});

test('an opaque not-found response is not mistaken for an available capability', async () => {
  const { octokit } = fakeOctokit(apiError(404, 'Not Found'));

  assert.equal(await detectPrivateRulesetCapability(octokit, 'owner', 'repo', 'main'), false);
});

test('a private repository with no default branch cannot be probed', async () => {
  const { octokit, calls } = fakeOctokit('ok');

  assert.equal(await detectPrivateRulesetCapability(octokit, 'owner', 'repo', ''), false);
  assert.deepEqual(calls, []);
});

test('unexpected API failures are surfaced instead of being guessed at', async () => {
  const failure = apiError(500, 'Internal Server Error');
  const { octokit } = fakeOctokit(failure);

  await assert.rejects(
    detectPrivateRulesetCapability(octokit, 'owner', 'repo', 'main'),
    failure,
  );
});
