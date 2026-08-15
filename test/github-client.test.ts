import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRulesetCapability, getRepoDetail } from '../src/github/client.js';
import { UNREADABLE } from '../src/config/sentinels.js';

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

  const result = await detectRulesetCapability(octokit, 'owner', 'repo', 'main');
  assert.equal(result.status, 'supported');
  assert.equal(result.source, 'endpoint');
  assert.deepEqual(calls, [
    {
      route: 'GET /repos/{owner}/{repo}/branches/{branch}/protection',
      params: { owner: 'owner', repo: 'repo', branch: 'main' },
    },
  ]);
});

test('an explicitly unprotected branch still proves the capability is available', async () => {
  const { octokit } = fakeOctokit(apiError(404, 'Branch not protected'));

  const result = await detectRulesetCapability(octokit, 'owner', 'repo', 'main');
  assert.equal(result.status, 'supported');
});

test('a forbidden protection endpoint means this owner and token cannot manage private rulesets', async () => {
  const { octokit } = fakeOctokit(
    apiError(403, 'Upgrade to GitHub Pro or make this repository public'),
  );

  const result = await detectRulesetCapability(octokit, 'owner', 'repo', 'main');
  assert.equal(result.status, 'forbidden');
  assert.equal(result.source, 'permission');
});

test('an opaque not-found response is reported as unknown, not guessed as unavailable', async () => {
  const { octokit } = fakeOctokit(apiError(404, 'Not Found'));

  const result = await detectRulesetCapability(octokit, 'owner', 'repo', 'main');
  assert.equal(result.status, 'unknown');
});

test('a private repository with no default branch cannot be probed', async () => {
  const { octokit, calls } = fakeOctokit('ok');

  const result = await detectRulesetCapability(octokit, 'owner', 'repo', '');
  assert.equal(result.status, 'unknown');
  assert.equal(result.source, 'resource-state');
  assert.deepEqual(calls, []);
});

test('unexpected API failures are surfaced instead of being guessed at', async () => {
  const failure = apiError(500, 'Internal Server Error');
  const { octokit } = fakeOctokit(failure);

  await assert.rejects(detectRulesetCapability(octokit, 'owner', 'repo', 'main'), failure);
});

test('every capability result carries an ISO observation timestamp', async () => {
  const { octokit } = fakeOctokit('ok');
  const result = await detectRulesetCapability(octokit, 'owner', 'repo', 'main');
  assert.ok(!Number.isNaN(Date.parse(result.observedAt)));
});

/**
 * A repository detail read with only the routes these cases care about
 * answered; everything else is a 404, which the reader already treats as
 * "not available here".
 */
async function detailWith(answers: Record<string, unknown>) {
  const octokit = {
    request: async (route: string) => {
      if (route in answers) return { data: answers[route] };
      throw apiError(404, 'Not Found');
    },
    repos: { get: async () => ({ data: { name: 'thing' } }) },
    // The tests intentionally provide only the Octokit surface this reader uses.
  } as any;
  return await getRepoDetail(octokit, 'account', {
    name: 'thing',
    visibility: 'public',
    archived: false,
    default_branch: 'main',
    description: null,
    homepage: null,
    topics: [],
  });
}

test('immutable releases is read as an ordinary setting', async () => {
  const detail = await detailWith({
    'GET /repos/{owner}/{repo}/immutable-releases': { enabled: true, enforced_by_owner: false },
  });

  assert.equal(detail.settings['security.immutable_releases'], true);
  assert.equal(detail.enforced, undefined, 'nothing is enforced, so nothing is recorded');
});

test('an owner enforcing immutable releases is recorded alongside the value', async () => {
  const detail = await detailWith({
    'GET /repos/{owner}/{repo}/immutable-releases': { enabled: true, enforced_by_owner: true },
  });

  assert.equal(detail.settings['security.immutable_releases'], true);
  assert.match(String(detail.enforced?.['security.immutable_releases']), /account/u);
});

test('an unreachable immutable-releases endpoint is unreadable, not disabled', async () => {
  const detail = await detailWith({});

  assert.equal(detail.settings['security.immutable_releases'], UNREADABLE);
  assert.equal(detail.enforced, undefined);
});
