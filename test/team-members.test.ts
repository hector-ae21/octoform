import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planOrganization } from '../src/core/organization.js';
import { declaredMembership, membershipProblems } from '../src/core/teams.js';
import type { Change, ExistingTeam, TeamMembership } from '../src/types/index.js';

const team = (members?: ExistingTeam['members']): ExistingTeam => ({
  id: 1,
  slug: 'platform',
  name: 'Platform',
  description: null,
  privacy: 'closed',
  notifications: true,
  parent: null,
  ...(members === undefined ? {} : { members }),
});

const held = team({ active: { ana: 'maintainer', luis: 'member' }, pending: { marta: 'member' } });

const planned = (membership: TeamMembership, existing: ExistingTeam = held, actor?: string) =>
  planOrganization(
    'acme',
    'org',
    { teams: { platform: existing } },
    { teams: { platform: { membership } } },
    actor,
  );

const forLogin = (changes: Change[], login: string) =>
  changes.find((change) => change.key === `organization.membership.platform.${login}`);

test('the two lists become one answer per person', () => {
  const declared = declaredMembership({ maintainers: ['ana'], members: ['luis'] });

  assert.equal(declared.get('ana'), 'maintainer');
  assert.equal(declared.get('luis'), 'member');
  assert.equal(declared.size, 2);
});

test('a login in both lists is a contradiction, not a precedence question', () => {
  const problems = membershipProblems({ maintainers: ['ana'], members: ['ana'] });

  assert.match(problems.join('; '), /both a maintainer and a member/u);
});

test('an authoritative block naming nobody is refused rather than emptying the team', () => {
  const problems = membershipProblems({ authoritative: true });

  assert.match(problems.join('; '), /would empty the team/u);
  assert.deepEqual(membershipProblems({ authoritative: true, members: ['ana'] }, undefined), []);
});

test('an authoritative block that would remove the running account is refused', () => {
  const problems = membershipProblems({ members: ['ana'], authoritative: true }, 'octoform-bot');

  assert.match(problems.join('; '), /the account this run is authenticated as/u);
  assert.deepEqual(
    membershipProblems({ members: ['ana', 'octoform-bot'], authoritative: true }, 'octoform-bot'),
    [],
  );
});

test('an additive block never removes the running account, so it is not guarded', () => {
  assert.deepEqual(membershipProblems({ members: ['ana'] }, 'octoform-bot'), []);
});

test('somebody already on the team at the declared role is not a change', () => {
  assert.deepEqual(planned({ maintainers: ['ana'], members: ['luis'] }), []);
});

test('somebody nobody has is added, and belongs to the owner', () => {
  const [change] = planned({ members: ['nuria'] });

  assert.equal(change?.repo, undefined);
  assert.equal(change?.key, 'organization.membership.platform.nuria');
  assert.equal(change?.operation, 'attach');
  assert.deepEqual(change?.payload, { team: 'platform', login: 'nuria', role: 'member' });
});

test('a pending invitation counts as somebody already asked', () => {
  assert.deepEqual(planned({ members: ['marta'] }), []);
});

test('a pending invitation at the wrong role is corrected rather than resent', () => {
  const [change] = planned({ maintainers: ['marta'] });

  assert.equal(change?.operation, 'update');
  assert.match(String(change?.from), /invited/u);
  assert.equal(change?.risk, 'sensitive');
});

test('promoting somebody to maintainer is sensitive; adding a member is not', () => {
  const promoting = forLogin(planned({ maintainers: ['luis'] }), 'luis');
  const adding = forLogin(planned({ members: ['nuria'] }), 'nuria');

  assert.equal(promoting?.risk, 'sensitive');
  assert.equal(adding?.risk, 'normal');
});

test('demoting a maintainer is an ordinary update', () => {
  const [change] = planned({ members: ['ana'] });

  assert.equal(change?.operation, 'update');
  assert.equal(change?.risk, 'normal');
});

test('an additive block leaves everyone it does not name alone', () => {
  assert.deepEqual(planned({ maintainers: ['ana'] }), []);
});

test('an authoritative block removes the people it does not name', () => {
  const changes = planned({ maintainers: ['ana'], authoritative: true }, held, 'ana');

  assert.deepEqual(changes.map((change) => change.key.split('.').pop()).sort(), ['luis', 'marta']);
  for (const change of changes) {
    assert.equal(change.operation, 'detach');
    assert.equal(change.risk, 'destructive');
  }
});

test('an authoritative block withdraws a pending invitation too', () => {
  const changes = planned({ maintainers: ['ana'], authoritative: true }, held, 'ana');
  const marta = forLogin(changes, 'marta');

  assert.deepEqual(marta?.payload, { team: 'platform', login: 'marta', remove: true });
});

test('everyone on a team being created waits for the team', () => {
  const changes = planOrganization(
    'acme',
    'org',
    { teams: {} },
    { teams: { design: { membership: { members: ['ana'] } } } },
  );
  const person = changes.find((change) => change.key === 'organization.membership.design.ana');

  assert.deepEqual(person?.prerequisites, ['acme#organization.teams.design']);
  assert.equal(person?.operation, 'attach');
});

test('a membership that could not be read blocks rather than being added again', () => {
  const [change] = planned({ members: ['ana'] }, team());

  assert.match(String(change?.blocked), /could not read who is on "platform"/u);
});

test('a refused block blocks every person in it, not just the awkward one', () => {
  const changes = planned({ maintainers: ['ana'], members: ['ana', 'luis'] });

  assert.equal(changes.length, 2);
  for (const change of changes) assert.match(String(change.blocked), /both a maintainer/u);
});
