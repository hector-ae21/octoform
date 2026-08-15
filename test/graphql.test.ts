import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNREADABLE } from '../src/config/sentinels.js';
import {
  graphqlRequest,
  normalizeFailures,
  requireComplete,
  valueOrUnreadable,
} from '../src/github/graphql.js';
import type { GraphqlOutcome, GraphqlRetryPolicy } from '../src/types/index.js';
import type { Octokit } from '@octokit/rest';

/** An Octokit whose `graphql` returns, or throws, whatever each attempt supplies. */
function fakeOctokit(attempts: Array<() => unknown>): { octokit: Octokit; calls: () => number } {
  let call = 0;
  const octokit = {
    graphql: async () => {
      const next = attempts[Math.min(call, attempts.length - 1)];
      call += 1;
      const result = next?.();
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Octokit;
  return { octokit, calls: () => call };
}

/** A GraphQL response error, shaped the way Octokit throws one. */
function responseError(errors: unknown[], data?: unknown): Error {
  return Object.assign(new Error('GraphQL error'), { errors, data });
}

const noWait: GraphqlRetryPolicy = { attempts: 2, wait: async () => {} };
const never: GraphqlRetryPolicy = { attempts: 0, wait: async () => {} };

test('a recognized error type maps to the vocabulary the planner already speaks', () => {
  const failures = normalizeFailures([
    { type: 'NOT_FOUND', message: 'missing', path: ['repository', 'discussion'] },
    { type: 'FORBIDDEN', message: 'denied' },
    { type: 'RATE_LIMITED', message: 'slow down' },
  ]);

  assert.deepEqual(
    failures.map((failure) => [failure.kind, failure.path]),
    [
      ['not-found', 'repository.discussion'],
      ['forbidden', ''],
      ['rate-limited', ''],
    ],
  );
});

test('an unrecognized error type never degrades into a confident answer', () => {
  const [failure] = normalizeFailures([{ type: 'SOMETHING_NEW', message: 'who knows' }]);
  assert.equal(failure?.kind, 'unavailable');
});

test('an error with no type at all is still unavailable, not absent', () => {
  const [failure] = normalizeFailures([{ message: 'no type field' }]);
  assert.equal(failure?.kind, 'unavailable');
  assert.equal(failure?.message, 'no type field');
});

test('a clean response returns its data and reports nothing failed', async () => {
  const { octokit } = fakeOctokit([() => ({ viewer: { login: 'someone' } })]);
  const outcome = await graphqlRequest<{ viewer: { login: string } }>(octokit, 'query {}');

  assert.deepEqual(outcome.data, { viewer: { login: 'someone' } });
  assert.deepEqual(outcome.failures, []);
});

test('a partial response surfaces both halves instead of passing as success', async () => {
  const { octokit, calls } = fakeOctokit([
    () =>
      responseError([{ type: 'FORBIDDEN', message: 'no', path: ['repository', 'secret'] }], {
        repository: { name: 'thing', secret: null },
      }),
  ]);
  const outcome = await graphqlRequest<{ repository: unknown }>(octokit, 'query {}', {}, noWait);

  assert.ok(outcome.data, 'the part that arrived is not discarded');
  assert.equal(outcome.failures.length, 1);
  assert.equal(calls(), 1, 'a response that carried data is not requested again');
});

test('a transient failure with nothing to show for it is retried', async () => {
  const { octokit, calls } = fakeOctokit([
    () => responseError([{ type: 'RATE_LIMITED', message: 'slow down' }]),
    () => responseError([{ type: 'RATE_LIMITED', message: 'slow down' }]),
    () => ({ viewer: { login: 'someone' } }),
  ]);
  const outcome = await graphqlRequest<{ viewer: unknown }>(octokit, 'query {}', {}, noWait);

  assert.equal(calls(), 3);
  assert.deepEqual(outcome.failures, []);
});

test('a settled failure is not retried, because trying again cannot change it', async () => {
  const { octokit, calls } = fakeOctokit([
    () => responseError([{ type: 'NOT_FOUND', message: 'gone' }]),
  ]);
  await graphqlRequest(octokit, 'query {}', {}, noWait);

  assert.equal(calls(), 1);
});

test('a mutation is never retried, however transient the failure looks', async () => {
  const { octokit, calls } = fakeOctokit([
    () => responseError([{ type: 'SERVICE_UNAVAILABLE', message: 'later' }]),
  ]);
  await graphqlRequest(octokit, 'mutation {}', {}, never);

  assert.equal(calls(), 1, 'an ambiguous write is resolved by observing, not by trying again');
});

test('a transport failure with no GraphQL error array is still classified', async () => {
  const { octokit } = fakeOctokit([
    () => Object.assign(new Error('Bad credentials'), { status: 401 }),
  ]);
  const outcome = await graphqlRequest(octokit, 'query {}', {}, never);

  assert.equal(outcome.failures[0]?.kind, 'forbidden');
  assert.equal(outcome.data, undefined);
});

test('requireComplete returns the data when nothing failed', () => {
  const outcome: GraphqlOutcome<{ ok: boolean }> = { data: { ok: true }, failures: [] };
  assert.deepEqual(requireComplete(outcome, 'discussions'), { ok: true });
});

test('requireComplete refuses a partial answer and names what failed', () => {
  const outcome: GraphqlOutcome<{ ok: boolean }> = {
    data: { ok: true },
    failures: [{ path: 'repository.discussions', kind: 'forbidden', message: 'denied' }],
  };
  assert.throws(
    () => requireComplete(outcome, 'discussions'),
    /repository\.discussions: forbidden — denied/u,
  );
});

test('a failed field reads as unreadable, exactly as it would over REST', () => {
  const outcome: GraphqlOutcome<{ repository: { hasDiscussions: boolean } }> = {
    data: { repository: { hasDiscussions: true } },
    failures: [{ path: 'repository.hasDiscussions', kind: 'forbidden', message: 'denied' }],
  };
  assert.equal(
    valueOrUnreadable(
      outcome,
      'repository.hasDiscussions',
      (data) => data.repository.hasDiscussions,
    ),
    UNREADABLE,
  );
});

test('a failure on an ancestor makes everything beneath it unreadable, not absent', () => {
  const outcome: GraphqlOutcome<{ repository: { hasDiscussions: boolean } }> = {
    data: { repository: { hasDiscussions: true } },
    failures: [{ path: 'repository', kind: 'not-found', message: 'gone' }],
  };
  assert.equal(
    valueOrUnreadable(
      outcome,
      'repository.hasDiscussions',
      (data) => data.repository.hasDiscussions,
    ),
    UNREADABLE,
  );
});

test('a failure elsewhere leaves an unrelated field readable', () => {
  const outcome: GraphqlOutcome<{ repository: { hasDiscussions: boolean } }> = {
    data: { repository: { hasDiscussions: true } },
    failures: [{ path: 'repository.sponsorsListing', kind: 'forbidden', message: 'denied' }],
  };
  assert.equal(
    valueOrUnreadable(
      outcome,
      'repository.hasDiscussions',
      (data) => data.repository.hasDiscussions,
    ),
    true,
  );
});

test('a whole-request failure makes every field unreadable', () => {
  const outcome: GraphqlOutcome<{ repository: { hasDiscussions: boolean } }> = {
    data: undefined,
    failures: [{ path: '', kind: 'unavailable', message: 'down' }],
  };
  assert.equal(
    valueOrUnreadable(
      outcome,
      'repository.hasDiscussions',
      (data) => data.repository.hasDiscussions,
    ),
    UNREADABLE,
  );
});
