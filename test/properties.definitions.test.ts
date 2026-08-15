import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asBody,
  batchPropertyValues,
  definitionBody,
  definitionProblems,
  describeDefinition,
  readDefinition,
  sameDefinition,
  separateValues,
} from '../src/core/properties.js';
import { planOrganization } from '../src/core/organization.js';
import type { Change, ExistingProperty, PropertyDefinition } from '../src/types/index.js';

const tier = readDefinition({
  property_name: 'tier',
  value_type: 'single_select',
  description: 'How closely this repository is watched',
  required: true,
  default_value: 'bronze',
  allowed_values: ['bronze', 'silver', 'gold'],
  values_editable_by: 'org_actors',
  source_type: 'organization',
}) as ExistingProperty;

const definitionOf = (name: string, declared: PropertyDefinition, held = tier) =>
  planOrganization(
    'acme',
    'org',
    { properties: { tier: held } },
    { properties: { [name]: declared } },
  );

test('a definition is read into the fields a write takes', () => {
  assert.equal(tier.name, 'tier');
  assert.equal(tier.required, true);
  assert.deepEqual(tier.allowed_values, ['bronze', 'silver', 'gold']);
  assert.equal(tier.source_type, 'organization');
});

test('a definition with no name or type is not a definition', () => {
  assert.equal(readDefinition({ value_type: 'string' }), undefined);
  assert.equal(readDefinition({ property_name: 'tier' }), undefined);
});

test('a field the policy does not state keeps what the organisation has', () => {
  const body = definitionBody(
    { value_type: 'single_select', description: 'Watched how closely' },
    tier,
  );

  assert.equal(body.description, 'Watched how closely');
  assert.equal(body.values_editable_by, 'org_actors');
  assert.deepEqual(body.allowed_values, ['bronze', 'silver', 'gold']);
  assert.equal(body.required, true);
});

test('the same field on a property that does not exist yet is simply left out', () => {
  const body = definitionBody({ value_type: 'string' }, undefined);

  assert.deepEqual(body, { value_type: 'string' });
});

test('an empty value is left out, which is how a replacing endpoint clears one', () => {
  const body = definitionBody({ value_type: 'single_select', description: '' }, tier);

  assert.equal('description' in body, false);
});

test('a definition that already says what the policy asks for is not a change', () => {
  assert.equal(sameDefinition(tier, { value_type: 'single_select' }), true);
  assert.equal(
    sameDefinition(tier, { value_type: 'single_select', description: 'Something else' }),
    false,
  );
});

test('both sides of the comparison are built by the same code', () => {
  assert.deepEqual(
    asBody(tier),
    definitionBody(asBody(tier) as unknown as PropertyDefinition, undefined),
  );
});

test('a default outside the allowed values is a contradiction in the file itself', () => {
  const problems = definitionProblems({
    value_type: 'single_select',
    allowed_values: ['bronze', 'gold'],
    default_value: 'silver',
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /not one of its allowed values/u);
});

test('more allowed values than GitHub stores is refused before it is sent', () => {
  const problems = definitionProblems({
    value_type: 'single_select',
    allowed_values: Array.from({ length: 201 }, (_unused, index) => `v${index}`),
  });

  assert.match(problems[0] ?? '', /at most 200/u);
});

test('a definition is described by what it will be, not by what was typed', () => {
  assert.match(describeDefinition(asBody(tier)), /single_select/u);
  assert.match(describeDefinition(asBody(tier)), /allowed_values=bronze\|silver\|gold/u);
});

test('a declared definition that matches is not planned', () => {
  assert.deepEqual(definitionOf('tier', { value_type: 'single_select' }), []);
});

test('a definition nobody has yet is created', () => {
  const [change] = definitionOf('owner_team', { value_type: 'string' });

  assert.equal(change?.operation, 'create');
  assert.equal(change?.from, null);
  assert.equal(change?.repo, undefined);
  assert.equal(change?.key, 'organization.properties.owner_team');
});

test('what the write would produce is what the plan shows', () => {
  const [change] = definitionOf('tier', { value_type: 'single_select', description: 'Changed' });

  assert.match(String(change?.to), /Changed/u);
  assert.match(String(change?.to), /allowed_values=bronze\|silver\|gold/u);
});

test('demanding a value of every repository is sensitive; describing one is not', () => {
  const [demanding] = definitionOf('owner_team', { value_type: 'string', required: true });
  const [describing] = definitionOf('owner_team', { value_type: 'string', description: 'A team' });

  assert.equal(demanding?.risk, 'sensitive');
  assert.equal(describing?.risk, 'normal');
});

test('dropping an allowed value is sensitive, since repositories hold it today', () => {
  const [narrowing] = definitionOf('tier', {
    value_type: 'single_select',
    allowed_values: ['bronze', 'silver'],
    required: false,
    default_value: 'bronze',
  });
  const [widening] = definitionOf('tier', {
    value_type: 'single_select',
    allowed_values: ['bronze', 'silver', 'gold', 'platinum'],
    required: false,
  });

  assert.equal(narrowing?.risk, 'sensitive');
  assert.equal(widening?.risk, 'normal');
});

test('removing a definition is destructive and has to be asked for by name', () => {
  const [removing] = definitionOf('tier', { value_type: 'single_select', mode: 'absent' });

  assert.equal(removing?.operation, 'delete');
  assert.equal(removing?.risk, 'destructive');
  assert.deepEqual(removing?.payload, { property: 'tier', remove: true });
  assert.deepEqual(definitionOf('gone', { value_type: 'string', mode: 'absent' }), []);
});

test('definitions that could not be read block every one of them', () => {
  const changes = planOrganization(
    'acme',
    'org',
    { settings: {} },
    { properties: { tier: { value_type: 'string' } } },
  );

  assert.match(String(changes[0]?.blocked), /replaces every field of it/u);
});

test('a property the enterprise defines is not the organisation to change', () => {
  const [change] = definitionOf(
    'tier',
    { value_type: 'string' },
    { ...tier, source_type: 'enterprise' },
  );

  assert.match(String(change?.blocked), /defined by the enterprise/u);
});

test('a personal account is told custom properties are not its feature', () => {
  const [change] = planOrganization('someone', 'user', undefined, {
    properties: { tier: { value_type: 'string' } },
  });

  assert.match(String(change?.blocked), /personal account has none/u);
});

const valueChange = (repo: string, property: string, value: string): Change => ({
  id: `acme/${repo}#properties.${property}`,
  owner: 'acme',
  repo,
  key: `properties.${property}`,
  operation: 'update',
  risk: 'sensitive',
  prerequisites: [],
  from: null,
  to: value,
  payload: { property, value },
});

test('repositories asking for the same values travel in one request', () => {
  const batches = batchPropertyValues([
    valueChange('a', 'tier', 'gold'),
    valueChange('b', 'tier', 'gold'),
    valueChange('c', 'tier', 'bronze'),
  ]);

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0]?.repositories, ['a', 'b']);
  assert.deepEqual(batches[1]?.repositories, ['c']);
});

test('a repository asking for two values keeps both in the same request', () => {
  const [batch, ...rest] = batchPropertyValues([
    valueChange('a', 'tier', 'gold'),
    valueChange('a', 'owner_team', 'core'),
  ]);

  assert.equal(rest.length, 0);
  assert.deepEqual(
    batch?.properties.map((entry) => entry.property_name),
    ['owner_team', 'tier'],
  );
});

test('no request carries more repositories than the endpoint takes', () => {
  const changes = Array.from({ length: 71 }, (_unused, index) =>
    valueChange(`repo-${index}`, 'tier', 'gold'),
  );
  const batches = batchPropertyValues(changes);

  assert.deepEqual(
    batches.map((batch) => batch.repositories.length),
    [30, 30, 11],
  );
  assert.equal(
    batches.reduce((total, batch) => total + batch.changes.length, 0),
    71,
  );
});

test('a batch carries exactly the changes of the repositories in it', () => {
  const batches = batchPropertyValues(
    Array.from({ length: 31 }, (_unused, index) => valueChange(`repo-${index}`, 'tier', 'gold')),
    30,
  );

  for (const batch of batches) {
    assert.deepEqual(
      batch.changes.map((change) => change.repo),
      batch.repositories,
    );
  }
});

test('a value waiting on something in its repository stays in that repository', () => {
  const waiting: Change = {
    ...valueChange('a', 'tier', 'gold'),
    prerequisites: ['acme/a#repo.archived'],
  };
  const free = valueChange('b', 'tier', 'gold');

  const { shared, sequential } = separateValues([waiting, free]);

  assert.deepEqual(
    shared.map((change) => change.repo),
    ['b'],
  );
  assert.deepEqual(
    sequential.map((change) => change.repo),
    ['a'],
  );
});

test('a value something else waits for stays where the waiting happens', () => {
  const value = valueChange('a', 'tier', 'gold');
  const archive: Change = {
    id: 'acme/a#repo.archived',
    owner: 'acme',
    repo: 'a',
    key: 'repo.archived',
    operation: 'update',
    risk: 'destructive',
    prerequisites: [value.id],
    from: false,
    to: true,
  };

  const { shared, sequential } = separateValues([value, archive]);

  assert.deepEqual(shared, []);
  assert.equal(sequential.length, 2);
});
