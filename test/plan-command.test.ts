import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan, summarizePlan } from '../src/commands/plan.js';
import type { OwnerScope } from '../src/types/index.js';

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    status,
    response: { data: { message } },
  });
}

test('a personal owner can plan rulesets for a private repository when the capability probe succeeds', async () => {
  const routes: string[] = [];
  const privateRepo = {
    name: 'private-repo',
    visibility: 'private',
    private: true,
    archived: false,
    default_branch: 'main',
    description: null,
    homepage: null,
    topics: [],
  };
  const octokit = {
    request: async (route: string) => {
      routes.push(route);
      if (route === 'GET /orgs/{org}') throw apiError(404, 'Not Found');
      if (route === 'GET /users/{username}') return { data: { id: 1 } };
      if (route === 'GET /repos/{owner}/{repo}/branches/{branch}/protection') {
        throw apiError(404, 'Branch not protected');
      }
      if (route === 'GET /repos/{owner}/{repo}/rulesets') return { data: [] };
      if (route === 'GET /repos/{owner}/{repo}/automated-security-fixes') {
        return { data: { enabled: false } };
      }
      if (route === 'GET /repos/{owner}/{repo}/private-vulnerability-reporting') {
        return { data: { enabled: false } };
      }
      throw apiError(404, 'Not Found');
    },
    paginate: async () => [privateRepo],
    users: {
      getAuthenticated: async () => ({ data: { login: 'personal-owner' } }),
    },
    repos: {
      listForAuthenticatedUser: async () => ({ data: [] }),
      listForUser: async () => ({ data: [] }),
      get: async () => ({ data: privateRepo }),
    },
  } as any;
  const scope: OwnerScope = {
    owner: 'personal-owner',
    defaults: {
      rulesets: [{ name: 'protect', target_branches: ['main'] }],
    },
  };

  const result = await plan(octokit, scope, undefined, { quiet: true });

  assert.equal(result.blocked.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]?.key, 'rulesets.protect');
  assert.ok(routes.includes('GET /repos/{owner}/{repo}/branches/{branch}/protection'));
});

test('the summary reports repositories carrying blocked work, not only those blocked outright', () => {
  const change = (repo: string, key: string) => ({ repo, key, from: false, to: true }) as never;
  const summary = summarizePlan({
    changes: [change('both', 'merge.allow_squash'), change('only-changed', 'merge.allow_squash')],
    blocked: [
      change('both', 'security.secret_scanning'),
      change('only-blocked', 'security.secret_scanning'),
    ],
    errors: [],
    scanned: 4,
  });

  assert.equal(summary.changed, 2);
  assert.equal(summary.blocked, 1, 'exclusive buckets must still sum to what was scanned');
  assert.equal(
    summary.blockedRepositories,
    2,
    'a repository that also changed still carries blocked work',
  );
  assert.equal(summary.unchanged, 1);
  assert.equal(
    summary.changed + summary.blocked + summary.failed + summary.unchanged,
    summary.scanned,
  );
});
