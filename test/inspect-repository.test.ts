/**
 * `inspect capabilities --repo` exists so the one capability octoform refuses
 * to assume can be checked before it matters.
 *
 * Whether rulesets can be managed on a private repository depends on the
 * account's plan and on the token, and the only honest answer is an
 * observation. These cases hold the shape of that observation: that it is
 * taken where it is needed, not taken where the answer is already known, and
 * reported with the evidence rather than as a bare yes or no.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Octokit } from '@octokit/rest';
import { inspectCapabilities } from '../src/commands/inspect.js';
import type { OwnerScope } from '../src/types/index.js';

const scope: OwnerScope = { owner: 'account' };

interface Answer {
  data?: unknown;
  error?: { status: number; message: string };
}

function fakeOctokit(answers: Record<string, Answer>): { octokit: Octokit; routes: string[] } {
  const routes: string[] = [];
  return {
    routes,
    octokit: {
      request: async (route: string) => {
        routes.push(route);
        const answer = answers[route] ?? { data: {} };
        if (answer.error) {
          const error = Object.assign(new Error(answer.error.message), {
            status: answer.error.status,
            response: { data: { message: answer.error.message } },
          });
          throw error;
        }
        return { data: answer.data ?? {} };
      },
      // Only the surface these commands reach is provided.
    } as unknown as Octokit,
  };
}

const OWNER = { data: { id: 1, login: 'account' } };

test('a private repository is probed, and the evidence travels with the answer', async () => {
  const { octokit, routes } = fakeOctokit({
    'GET /orgs/{org}': { error: { status: 404, message: 'Not Found' } },
    'GET /users/{username}': OWNER,
    'GET /repos/{owner}/{repo}': { data: { visibility: 'private', default_branch: 'main' } },
    'GET /repos/{owner}/{repo}/branches/{branch}/protection': {
      error: { status: 404, message: 'Branch not protected' },
    },
  });

  const report = await inspectCapabilities(octokit, scope, 'thing');

  assert.equal(report.repository?.visibility, 'private');
  assert.equal(report.repository?.rulesets.status, 'supported');
  assert.equal(report.repository?.rulesets.source, 'endpoint');
  assert.ok(
    report.repository?.rulesets.reason,
    'a status with no reason behind it is the thing this command exists to avoid',
  );
  assert.ok(routes.includes('GET /repos/{owner}/{repo}/branches/{branch}/protection'));
});

test('an account and token that cannot manage them says so, rather than staying silent', async () => {
  const { octokit } = fakeOctokit({
    'GET /orgs/{org}': { error: { status: 404, message: 'Not Found' } },
    'GET /users/{username}': OWNER,
    'GET /repos/{owner}/{repo}': { data: { visibility: 'private', default_branch: 'main' } },
    'GET /repos/{owner}/{repo}/branches/{branch}/protection': {
      error: { status: 403, message: 'Upgrade to GitHub Pro or make this repository public' },
    },
  });

  const report = await inspectCapabilities(octokit, scope, 'thing');

  assert.equal(report.repository?.rulesets.status, 'forbidden');
  assert.equal(report.repository?.rulesets.source, 'permission');
});

test('a public repository is not probed, since the answer is known in advance', async () => {
  const { octokit, routes } = fakeOctokit({
    'GET /orgs/{org}': { error: { status: 404, message: 'Not Found' } },
    'GET /users/{username}': OWNER,
    'GET /repos/{owner}/{repo}': { data: { visibility: 'public', default_branch: 'main' } },
  });

  const report = await inspectCapabilities(octokit, scope, 'thing');

  assert.equal(report.repository?.rulesets.status, 'supported');
  assert.equal(report.repository?.rulesets.source, 'resource-state');
  assert.equal(
    routes.includes('GET /repos/{owner}/{repo}/branches/{branch}/protection'),
    false,
    'a probe whose result is known in advance is a request spent proving nothing',
  );
});

test('no repository is named, so none is looked at', async () => {
  const { octokit, routes } = fakeOctokit({
    'GET /orgs/{org}': { error: { status: 404, message: 'Not Found' } },
    'GET /users/{username}': OWNER,
  });

  const report = await inspectCapabilities(octokit, scope);

  assert.equal(report.repository, undefined);
  assert.equal(routes.includes('GET /repos/{owner}/{repo}'), false);
});
