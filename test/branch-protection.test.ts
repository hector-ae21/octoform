import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeProtection,
  protectionBody,
  readProtection,
  sameProtection,
} from '../src/core/branch-protection.js';
import { coversBranch } from '../src/core/rulesets.js';

const stored = readProtection({
  required_status_checks: { strict: true, contexts: ['CI'] },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: {
    required_approving_review_count: 2,
    dismiss_stale_reviews: true,
  },
  restrictions: { users: [{ login: 'hector' }], teams: [], apps: [] },
  required_linear_history: { enabled: true },
});

test('the wrapped shape GitHub returns is read flat', () => {
  assert.equal(stored.required_checks?.[0], 'CI');
  assert.equal(stored.strict_required_checks, true);
  assert.equal(stored.enforce_admins, true);
  assert.equal(stored.require_pull_request, true);
  assert.equal(stored.required_approvals, 2);
  assert.deepEqual(stored.restrict_pushes, { users: ['hector'], teams: [], apps: [] });
  assert.equal(stored.require_linear_history, true);
  assert.equal(stored.allow_force_pushes, false, 'an absent block is off, not unknown');
});

test('only declared keys are compared, so unmentioned protection is not a difference', () => {
  assert.ok(sameProtection(stored, { branch: 'main' }));
  assert.ok(sameProtection(stored, { branch: 'main', required_approvals: 2 }));
  assert.equal(sameProtection(stored, { branch: 'main', required_approvals: 1 }), false);
});

test('an unprotected branch never matches a declared protection', () => {
  assert.equal(sameProtection(null, { branch: 'main' }), false);
});

test('an update keeps what the policy does not mention', () => {
  const body = protectionBody({ branch: 'main', enforce_admins: false }, stored);

  assert.equal(body.enforce_admins, false, 'the declared key changes');
  assert.deepEqual(body.required_status_checks, { strict: true, contexts: ['CI'] });
  assert.equal(
    (body.required_pull_request_reviews as { required_approving_review_count: number })
      .required_approving_review_count,
    2,
  );
  assert.deepEqual(body.restrictions, { users: ['hector'], teams: [], apps: [] });
  assert.equal(body.required_linear_history, true);
});

test('the four members GitHub demands are always present, even when empty', () => {
  const body = protectionBody({ branch: 'main', enforce_admins: true });

  for (const key of [
    'required_status_checks',
    'enforce_admins',
    'required_pull_request_reviews',
    'restrictions',
  ]) {
    assert.ok(key in body, `${key} must be sent, since an omitted one reads as a removal`);
  }
  assert.equal(body.required_status_checks, null);
  assert.equal(body.required_pull_request_reviews, null);
  assert.equal(body.restrictions, null);
});

test('switching pull requests off removes the review block rather than emptying it', () => {
  const body = protectionBody({ branch: 'main', require_pull_request: false }, stored);
  assert.equal(body.required_pull_request_reviews, null);
});

test('a restriction compares by contents, not by the order it was written in', () => {
  const current = readProtection({
    restrictions: { users: [{ login: 'a' }, { login: 'b' }], teams: [], apps: [] },
  });

  assert.ok(
    sameProtection(current, {
      branch: 'main',
      restrict_pushes: { users: ['b', 'a'], teams: [], apps: [] },
    }),
  );
});

test('protection describes itself by what it enforces', () => {
  assert.match(describeProtection(stored), /2 approval/u);
  assert.match(describeProtection(stored), /checks: CI/u);
  assert.equal(describeProtection({}), 'protected, with nothing octoform manages set');
});

test('a ruleset pattern is matched against the branch it would also govern', () => {
  assert.ok(coversBranch(['~ALL'], 'anything', 'main'));
  assert.ok(coversBranch(['~DEFAULT_BRANCH'], 'main', 'main'));
  assert.equal(coversBranch(['~DEFAULT_BRANCH'], 'develop', 'main'), false);
  assert.ok(coversBranch(['refs/heads/main'], 'main', 'main'));
  assert.ok(coversBranch(['release/*'], 'release/1.0', 'main'));
  assert.equal(coversBranch(['release/*'], 'main', 'main'), false);
  assert.ok(coversBranch(['v*.x'], 'v1.x', 'main'));
  assert.equal(coversBranch(['v*.x'], 'main', 'main'), false);
});
