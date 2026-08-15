import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RULE_KEYS,
  describeRuleset,
  readRuleset,
  rulesFor,
  rulesetBody,
  sameRuleset,
  targetOf,
} from '../src/core/rulesets.js';
import type { RulesetPolicy } from '../src/types/index.js';

const raw = (rules: Array<{ type: string; parameters?: Record<string, unknown> }>) => ({
  id: 7,
  name: 'protect',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  rules,
});

test('a ruleset must declare exactly one target', () => {
  assert.equal(targetOf({ name: 'x' }), null, 'none names no refs');
  assert.equal(targetOf({ name: 'x', target_branches: ['main'], target_tags: ['v*'] }), null);
  assert.deepEqual(targetOf({ name: 'x', target_branches: ['main'] }), {
    target: 'branch',
    include: ['main'],
  });
  assert.deepEqual(targetOf({ name: 'x', target_pushes: true }), {
    target: 'push',
    include: [],
  });
});

test('a tag ruleset names tag refs, not branch refs', () => {
  const body = rulesetBody({ name: 'tags', target_tags: ['v*'], block_deletion: true });
  assert.equal(body.target, 'tag');
  assert.deepEqual(body.conditions, {
    ref_name: { include: ['refs/tags/v*'], exclude: [] },
  });
});

test('a push ruleset matches no refs at all', () => {
  const body = rulesetBody({ name: 'pushes', target_pushes: true, max_file_size: 100 });
  assert.equal(body.target, 'push');
  assert.deepEqual(body.conditions, {});
  assert.deepEqual(body.rules, [{ type: 'max_file_size', parameters: { max_file_size: 100 } }]);
});

test('every rule reads back into the keys that wrote it', () => {
  const policy: RulesetPolicy = {
    name: 'protect',
    target_branches: ['main'],
    require_pull_request: true,
    required_approvals: 2,
    dismiss_stale_reviews: true,
    require_code_owner_review: true,
    require_last_push_approval: true,
    require_thread_resolution: true,
    allowed_merge_methods: ['squash'],
    required_checks: ['CI'],
    strict_required_checks: true,
    checks_not_enforced_on_create: true,
    required_deployments: ['production'],
    block_creation: true,
    block_update: true,
    allow_fetch_and_merge: true,
    block_deletion: true,
    block_force_push: true,
    require_linear_history: true,
    require_signatures: true,
    require_license_compliance_scanning: true,
    merge_queue: { merge_method: 'SQUASH', grouping_strategy: 'ALLGREEN' },
    required_code_scanning: [
      { tool: 'CodeQL', alerts_threshold: 'errors', security_alerts_threshold: 'high_or_higher' },
    ],
    copilot_code_review: { review_on_push: true },
    commit_message_pattern: { operator: 'starts_with', pattern: 'feat' },
    commit_author_email_pattern: { operator: 'ends_with', pattern: '@example.com' },
    committer_email_pattern: { operator: 'contains', pattern: 'example' },
    branch_name_pattern: { operator: 'regex', pattern: '^feat/' },
    tag_name_pattern: { operator: 'starts_with', pattern: 'v' },
    restricted_file_paths: ['secrets/**'],
    restricted_file_extensions: ['.pem'],
    max_file_size: 100,
    max_file_path_length: 255,
  };

  const stored = readRuleset({ ...raw(rulesFor(policy)), id: 7, name: 'protect' });

  assert.deepEqual(stored.unmodelled, [], 'the fixture declares only modelled rules');
  assert.ok(sameRuleset(stored, policy), 'what was written compares equal to what was read');
  for (const key of RULE_KEYS) {
    if (policy[key] === undefined) continue;
    assert.notEqual(stored.rules[key], undefined, `${key} did not survive the round trip`);
  }
});

test('a rule octoform does not model survives an update untouched', () => {
  const stored = readRuleset(
    raw([{ type: 'non_fast_forward' }, { type: 'something_new', parameters: { a: 1 } }]),
  );

  assert.deepEqual(stored.unmodelled, [{ type: 'something_new', parameters: { a: 1 } }]);
  const rules = rulesFor(
    { name: 'protect', target_branches: ['main'], block_deletion: true },
    stored,
  );
  assert.ok(
    rules.some((rule) => rule.type === 'something_new'),
    'an update would otherwise delete it, because it replaces the whole list',
  );
});

test('a rule the policy never mentions keeps whatever it had', () => {
  const stored = readRuleset(raw([{ type: 'required_signatures' }]));
  const rules = rulesFor(
    { name: 'protect', target_branches: ['main'], block_deletion: true },
    stored,
  );

  assert.ok(rules.some((rule) => rule.type === 'required_signatures'));
  assert.ok(rules.some((rule) => rule.type === 'deletion'));
});

test('switching a rule off is the one removal a policy can ask for', () => {
  const stored = readRuleset(raw([{ type: 'non_fast_forward' }]));
  const rules = rulesFor(
    { name: 'protect', target_branches: ['main'], block_force_push: false },
    stored,
  );

  assert.equal(
    rules.some((rule) => rule.type === 'non_fast_forward'),
    false,
  );
});

test('only declared keys are compared, so a hand-configured rule is not a difference', () => {
  const stored = readRuleset(raw([{ type: 'required_signatures' }, { type: 'deletion' }]));
  assert.ok(sameRuleset(stored, { name: 'protect', target_branches: ['main'] }));
  assert.ok(
    sameRuleset(stored, { name: 'protect', target_branches: ['main'], block_deletion: true }),
  );
  assert.equal(
    sameRuleset(stored, { name: 'protect', target_branches: ['main'], block_deletion: false }),
    false,
  );
});

test('enforcement and exclusions are compared only when declared', () => {
  const stored = readRuleset({ ...raw([]), enforcement: 'evaluate' });

  assert.ok(sameRuleset(stored, { name: 'protect', target_branches: ['main'] }));
  assert.equal(
    sameRuleset(stored, { name: 'protect', target_branches: ['main'], enforcement: 'active' }),
    false,
  );
});

test('a ruleset describes itself by what it governs', () => {
  assert.match(
    describeRuleset({ name: 'x', target_tags: ['v*'], block_deletion: true }),
    /tag: v\*/u,
  );
  assert.match(describeRuleset({ name: 'x', target_pushes: true }), /every push/u);
});
