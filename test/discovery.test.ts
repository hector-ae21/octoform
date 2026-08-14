import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectOwnerKind,
  discoverOwner,
  rateLimitWarning,
  requireScopes,
} from '../src/github/client.js';

function apiError(status: number): Error {
  return Object.assign(new Error('error'), { status });
}

function fakeOctokit(handlers: Record<string, () => unknown>) {
  const calls: string[] = [];
  return {
    calls,
    octokit: {
      request: async (route: string) => {
        calls.push(route);
        const handler = handlers[route];
        if (!handler) throw apiError(404);
        const result = handler();
        if (result instanceof Error) throw result;
        return { data: result };
      },
    } as any,
  };
}

test('discoverOwner resolves an organisation with its numeric id', async () => {
  const { octokit } = fakeOctokit({ 'GET /orgs/{org}': () => ({ id: 42 }) });
  assert.deepEqual(await discoverOwner(octokit, 'an-org'), {
    login: 'an-org',
    kind: 'org',
    id: 42,
  });
});

test('discoverOwner falls back to the user endpoint for a personal account', async () => {
  const { octokit } = fakeOctokit({
    'GET /orgs/{org}': () => apiError(404),
    'GET /users/{username}': () => ({ id: 7 }),
  });
  assert.deepEqual(await discoverOwner(octokit, 'a-user'), {
    login: 'a-user',
    kind: 'user',
    id: 7,
  });
});

test('discoverOwner rejects a login that is neither an organisation nor a user', async () => {
  const { octokit } = fakeOctokit({ 'GET /orgs/{org}': () => apiError(404) });
  await assert.rejects(discoverOwner(octokit, 'nobody'));
});

test('discoverOwner and detectOwnerKind share one cached request per owner', async () => {
  const { octokit, calls } = fakeOctokit({ 'GET /orgs/{org}': () => ({ id: 1 }) });

  await discoverOwner(octokit, 'an-org');
  await detectOwnerKind(octokit, 'an-org');
  await discoverOwner(octokit, 'an-org');

  assert.deepEqual(calls, ['GET /orgs/{org}']);
});

test('rateLimitWarning is silent when the budget is healthy', () => {
  assert.equal(rateLimitWarning({ remaining: 4000, limit: 5000, reset: 0 }), undefined);
});

test('rateLimitWarning is silent when there is nothing to compare against', () => {
  assert.equal(rateLimitWarning({}), undefined);
  assert.equal(rateLimitWarning({ remaining: 3, limit: 0 }), undefined);
});

test('rateLimitWarning warns once the remaining budget drops below ten percent', () => {
  const warning = rateLimitWarning({ remaining: 42, limit: 5000, reset: 0 });
  assert.match(warning ?? '', /42\/5000/);
});

test('requireScopes reads the rate-limit budget from the same response it already made', async () => {
  const octokit = {
    request: async () => ({
      headers: {
        'x-oauth-scopes': 'repo',
        'x-ratelimit-remaining': '17',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1700000000',
      },
    }),
  } as any;

  const status = await requireScopes(octokit, ['repo']);
  assert.deepEqual(status, { remaining: 17, limit: 5000, reset: 1700000000 });
});
