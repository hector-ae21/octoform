import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planOrganization } from '../src/core/organization.js';
import { describeHolders, holderProblems, readRole } from '../src/core/roles.js';
import type { ExistingRole, OrganizationPolicy, RoleHolders } from '../src/types/index.js';

const securityManager: ExistingRole = {
  ...(readRole({ id: 8, name: 'Security manager', source: 'Predefined' }) as ExistingRole),
  users: ['ana'],
  teams: ['security'],
};

const held: Record<string, ExistingRole> = { 'Security manager': securityManager };

/**
 * `unread` is a value rather than an omitted argument on purpose: passing
 * `undefined` would take the default, and the case being tested here is
 * precisely the one where nothing was read.
 */
const unread = Symbol('unread');

const planned = (
  roles: OrganizationPolicy['roles'],
  existing: Record<string, ExistingRole> | typeof unread = held,
  actor?: string,
  teams?: OrganizationPolicy['teams'],
) =>
  planOrganization(
    'acme',
    'org',
    { ...(existing === unread ? {} : { roles: existing }), teams: {} },
    { roles, ...(teams === undefined ? {} : { teams }) },
    actor,
  );

test('a role is read with the id the assignment endpoints take', () => {
  const role = readRole({ id: 8, name: 'Security manager', source: 'Predefined' });

  assert.equal(role?.id, 8);
  assert.equal(role?.source, 'Predefined');
  assert.equal(readRole({ name: 'No id' }), undefined);
});

test('an unrecognised source is treated as the organisation’s own', () => {
  assert.equal(readRole({ id: 1, name: 'Odd', source: null })?.source, 'Organization');
});

test('an authoritative role naming nobody is refused rather than revoked from all', () => {
  const problems = holderProblems({ authoritative: true });

  assert.match(problems.join('; '), /revoke it from everyone/u);
});

test('an authoritative role that would revoke the running account is refused', () => {
  const problems = holderProblems({ users: ['ana'], authoritative: true }, 'octoform-bot');

  assert.match(problems.join('; '), /the account this run is authenticated as/u);
  assert.deepEqual(holderProblems({ users: ['ana'], authoritative: true }, 'ana'), []);
});

test('an additive role is not guarded, since it revokes nothing', () => {
  assert.deepEqual(holderProblems({ users: ['ana'] }, 'octoform-bot'), []);
  assert.deepEqual(holderProblems({}), []);
});

test('holders already in place are not a change', () => {
  assert.deepEqual(planned({ 'Security manager': { users: ['ana'], teams: ['security'] } }), []);
});

test('granting a role is sensitive and belongs to the owner', () => {
  const [change] = planned({ 'Security manager': { users: ['luis'] } });

  assert.equal(change?.repo, undefined);
  assert.equal(change?.key, 'organization.roles.Security manager.users.luis');
  assert.equal(change?.operation, 'attach');
  assert.equal(change?.risk, 'sensitive');
  assert.deepEqual(change?.payload, { role: 8, kind: 'users', name: 'luis' });
});

test('a user and a team of the same name do not collide', () => {
  const changes = planned({ 'Security manager': { users: ['audit'], teams: ['audit'] } });

  assert.deepEqual(changes.map((change) => change.key).sort(), [
    'organization.roles.Security manager.teams.audit',
    'organization.roles.Security manager.users.audit',
  ]);
});

test('a role nobody defined is a name, not a request to define one', () => {
  const [change] = planned({ Invented: { users: ['ana'] } });

  assert.match(String(change?.blocked), /no organisation role called "Invented"/u);
  assert.match(String(change?.blocked), /no endpoint that creates one/u);
});

test('roles that could not be read block rather than being granted again', () => {
  const [change] = planned({ 'Security manager': { users: ['ana'] } }, unread);

  assert.match(String(change?.blocked), /could not read the organisation roles/u);
});

test('holders that could not be read block, distinct from a role that has none', () => {
  const [change] = planned(
    { 'Security manager': { users: ['ana'] } },
    {
      'Security manager': readRole({ id: 8, name: 'Security manager' }) as ExistingRole,
    },
  );

  assert.match(String(change?.blocked), /could not read who holds "Security manager"/u);
});

test('an additive block leaves holders it does not name alone', () => {
  assert.deepEqual(planned({ 'Security manager': { users: ['ana'] } }), []);
});

test('an authoritative block revokes the holders it does not name', () => {
  const changes = planned(
    { 'Security manager': { users: ['ana'], authoritative: true } },
    held,
    'ana',
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.key, 'organization.roles.Security manager.teams.security');
  assert.equal(changes[0]?.operation, 'detach');
  assert.equal(changes[0]?.risk, 'sensitive');
  assert.deepEqual(changes[0]?.payload, {
    role: 8,
    kind: 'teams',
    name: 'security',
    remove: true,
  });
});

test('a team granted a role waits for a team the same run is creating', () => {
  const changes = planned({ 'Security manager': { teams: ['audit'] } }, held, undefined, {
    audit: { name: 'Audit' },
  });
  /** Matched exactly: `organization.teams.audit`, the team's own creation, ends the same way. */
  const grant = changes.find(
    (change) => change.key === 'organization.roles.Security manager.teams.audit',
  );

  assert.deepEqual(grant?.prerequisites, ['acme#organization.teams.audit']);
});

test('a personal account is told it has no organisation roles', () => {
  const [change] = planOrganization('someone', 'user', undefined, {
    roles: { 'Security manager': { users: ['ana'] } },
  });

  assert.match(String(change?.blocked), /has no organisation roles/u);
});

test('a cancelled role is not a change', () => {
  assert.deepEqual(planned({ 'Security manager': null }), []);
});

test('holders read as a sentence in the report', () => {
  assert.equal(describeHolders({ users: ['ana'], teams: ['security'] }), 'ana; teams security');
  assert.equal(describeHolders({}), 'nobody');
});
