import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planOrganization } from '../src/core/organization.js';
import {
  describeRepositories,
  organizationRulesetProblems,
  repositoryConditions,
  sameRepositories,
  unnamedWorkflows,
} from '../src/core/organization-rulesets.js';
import { readRuleset } from '../src/core/rulesets.js';
import type {
  ExistingRuleset,
  OrganizationRulesetPolicy,
  OrganizationState,
} from '../src/types/index.js';

const declared = (over: Partial<OrganizationRulesetPolicy> = {}): OrganizationRulesetPolicy => ({
  name: 'Protected mainlines',
  target_branches: ['~DEFAULT_BRANCH'],
  repositories: { include: ['~ALL'] },
  require_pull_request: true,
  ...over,
});

const stored = (raw: Record<string, unknown> = {}): ExistingRuleset =>
  readRuleset({
    id: 7,
    name: 'Protected mainlines',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
      repository_name: { include: ['~ALL'], exclude: [] },
    },
    rules: [{ type: 'pull_request', parameters: {} }],
    ...raw,
  } as Parameters<typeof readRuleset>[0]);

const planned = (
  policy: OrganizationRulesetPolicy,
  observed: OrganizationState = { rulesets: [] },
) => planOrganization('acme', 'org', observed, { rulesets: [policy] });

test('names and properties build the two conditions GitHub takes', () => {
  assert.deepEqual(repositoryConditions({ include: ['~ALL'], exclude: ['sandbox-*'] }), {
    repository_name: { include: ['~ALL'], exclude: ['sandbox-*'] },
  });

  assert.deepEqual(repositoryConditions({ properties: [{ name: 'tier', values: ['gold'] }] }), {
    repository_property: {
      include: [{ name: 'tier', property_values: ['gold'], source: 'custom' }],
      exclude: [],
    },
  });
});

test('protected is sent only when it is asked for, since leaving it out clears it', () => {
  const on = repositoryConditions({ include: ['a'], protected: true });
  const off = repositoryConditions({ include: ['a'], protected: false });

  assert.equal((on.repository_name as Record<string, unknown>).protected, true);
  assert.equal('protected' in (off.repository_name as Record<string, unknown>), false);
});

test('a selection is compared as the condition it becomes', () => {
  assert.equal(sameRepositories({ include: ['~ALL'], exclude: [] }, { include: ['~ALL'] }), true);
  assert.equal(sameRepositories({ include: ['~ALL'] }, { include: ['a'] }), false);
  assert.equal(sameRepositories(undefined, { include: ['~ALL'] }), false);
});

test('a stored ruleset carries the repositories it reaches back with it', () => {
  const current = stored();

  assert.deepEqual(current.repositories, { include: ['~ALL'], exclude: [] });
});

test("a repository's own ruleset has no repository condition, and that is not empty", () => {
  const current = stored({ conditions: { ref_name: { include: ['~ALL'], exclude: [] } } });

  assert.equal(current.repositories, undefined);
});

test('a ruleset that says nothing about repositories is refused', () => {
  const problems = organizationRulesetProblems(declared({ repositories: {} }));

  assert.match(problems[0] ?? '', /not a guess/u);
});

test('a ruleset that selects by name and by property at once is refused', () => {
  const problems = organizationRulesetProblems(
    declared({
      repositories: { include: ['a'], properties: [{ name: 'tier', values: ['gold'] }] },
    }),
  );

  assert.match(problems.join('; '), /not both/u);
});

test('protected cannot be asked for alongside property targeting', () => {
  const problems = organizationRulesetProblems(
    declared({
      repositories: { properties: [{ name: 'tier', values: ['gold'] }], protected: true },
    }),
  );

  assert.match(problems.join('; '), /part of the name condition/u);
});

test('a property targeted with no values matches nothing and is refused', () => {
  const problems = organizationRulesetProblems(
    declared({ repositories: { properties: [{ name: 'tier', values: [] }] } }),
  );

  assert.match(problems.join('; '), /matches nothing/u);
});

test('a merge queue rule is refused, since GitHub does not offer it at this level', () => {
  const problems = organizationRulesetProblems(
    declared({ merge_queue: { merge_method: 'SQUASH' } }),
  );

  assert.match(problems.join('; '), /not among the rules an organisation ruleset can carry/u);
});

test('a required workflow must name the repository it comes from', () => {
  const policy = declared({ required_workflows: [{ path: '.github/workflows/ci.yml' }] });

  assert.equal(unnamedWorkflows(policy).length, 1);
  assert.match(organizationRulesetProblems(policy).join('; '), /must name the repository/u);
  assert.equal(
    unnamedWorkflows(declared({ required_workflows: [{ path: 'ci.yml', repository: 'acme/ci' }] }))
      .length,
    0,
  );
});

test('a matching ruleset is not planned', () => {
  assert.deepEqual(planned(declared(), { rulesets: [stored()] }), []);
});

test('a ruleset that reaches other repositories is a change, even with the same rules', () => {
  const [change] = planned(declared({ repositories: { include: ['api-*'] } }), {
    rulesets: [stored()],
  });

  assert.equal(change?.operation, 'update');
  assert.match(String(change?.to), /repositories api-\*/u);
  assert.match(String(change?.from), /repositories ~ALL/u);
});

test('every organisation ruleset is sensitive, whatever it enforces', () => {
  const [change] = planned(declared({ name: 'New one' }), { rulesets: [] });

  assert.equal(change?.risk, 'sensitive');
  assert.equal(change?.repo, undefined);
  assert.equal(change?.key, 'organization.rulesets.New one');
  assert.equal(change?.operation, 'create');
});

test('rulesets that could not be read block rather than being created again', () => {
  const [change] = planned(declared(), {});

  assert.match(String(change?.blocked), /could not read the existing organisation rulesets/u);
});

test('a personal account is told it has no rulesets of its own to aim', () => {
  const [change] = planOrganization('someone', 'user', undefined, { rulesets: [declared()] });

  assert.match(String(change?.blocked), /no rulesets of its own/u);
});

test('a ruleset naming no target is refused before its repositories are considered', () => {
  const [change] = planned(declared({ target_branches: undefined }));

  assert.match(String(change?.blocked), /exactly one of target_branches/u);
});

test('the selection reads as a sentence in the report', () => {
  assert.equal(
    describeRepositories({ include: ['~ALL'], exclude: ['sandbox-*'], protected: true }),
    'repositories ~ALL, except sandbox-*, which cannot be renamed',
  );
  assert.equal(
    describeRepositories({ properties: [{ name: 'tier', values: ['gold', 'silver'] }] }),
    'repositories where tier is gold or silver',
  );
});
