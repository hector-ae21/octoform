import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notInTheOrganization, peopleNamedBy, readInvitation } from '../src/core/members.js';
import type { OwnerScope } from '../src/types/index.js';

const scope: OwnerScope = {
  owner: 'acme',
  organization: {
    teams: {
      platform: { membership: { maintainers: ['ana'], members: ['luis'] } },
      design: { membership: { members: ['luis'] } },
      /** No membership block: names nobody, however many people are on it. */
      audit: { name: 'Audit' },
    },
    roles: { 'Security manager': { users: ['ana'], teams: ['platform'] } },
  },
  defaults: { access: { users: { nuria: 'read' } } },
  types: { 'npm-package': { access: { users: { marta: 'write' } } } },
  repos: {
    api: { access: { users: { luis: 'admin', gone: 'none', unmanaged: null } } },
  },
};

const now = new Date('2026-08-15T00:00:00Z');

test('every place a login is named is recorded, not just the first', () => {
  const named = peopleNamedBy(scope);

  assert.deepEqual(named.get('luis')?.sort(), [
    'organization.teams.design.membership.members',
    'organization.teams.platform.membership.members',
    'repos.api.access.users',
  ]);
  assert.deepEqual(named.get('ana')?.sort(), [
    'organization.roles.Security manager.users',
    'organization.teams.platform.membership.maintainers',
  ]);
});

test('every layer that can grant access is read, not only the repositories', () => {
  const named = peopleNamedBy(scope);

  assert.deepEqual(named.get('nuria'), ['defaults.access.users']);
  assert.deepEqual(named.get('marta'), ['types.npm-package.access.users']);
});

test('a team that names a role is not a person, and neither is a revocation', () => {
  const named = peopleNamedBy(scope);

  assert.equal(named.has('platform'), false);
  assert.equal(named.has('gone'), false);
  assert.equal(named.has('unmanaged'), false);
});

test('being an outside collaborator or already invited counts as known', () => {
  const named = peopleNamedBy(scope);
  const missing = notInTheOrganization(named, new Set(['ana', 'luis', 'nuria', 'marta']));

  assert.deepEqual(
    missing.map((person) => person.login),
    [],
  );
});

test('somebody the organisation has never heard of is reported with every path', () => {
  const named = peopleNamedBy(scope);
  const missing = notInTheOrganization(named, new Set(['ana', 'nuria', 'marta']));

  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.login, 'luis');
  assert.equal(missing[0]?.named.length, 3);
});

test('an invitation carries its age in whole days', () => {
  const invitation = readInvitation(
    { login: 'ana', role: 'direct_member', created_at: '2026-08-01T12:00:00Z' },
    now,
  );

  assert.equal(invitation.waitingDays, 13);
  assert.equal(invitation.login, 'ana');
  assert.equal(invitation.email, null);
});

test('an invitation to an email address has no login to match against', () => {
  const invitation = readInvitation(
    { login: null, email: 'someone@example.test', created_at: '2026-08-15T00:00:00Z' },
    now,
  );

  assert.equal(invitation.login, null);
  assert.equal(invitation.email, 'someone@example.test');
  assert.equal(invitation.waitingDays, 0);
});

test('an unparseable or missing date is nought days rather than nonsense', () => {
  assert.equal(readInvitation({ login: 'ana' }, now).waitingDays, 0);
  assert.equal(readInvitation({ login: 'ana', created_at: 'not a date' }, now).waitingDays, 0);
});

test('a failed invitation keeps the reason GitHub recorded', () => {
  const invitation = readInvitation(
    {
      login: 'ana',
      created_at: '2026-08-01T00:00:00Z',
      failed_at: '2026-08-02T00:00:00Z',
      failed_reason: 'the email address bounced',
    },
    now,
  );

  assert.equal(invitation.failedReason, 'the email address bounced');
  assert.equal(invitation.failedAt, '2026-08-02T00:00:00Z');
});

test('an invitation that has not failed carries neither failure field', () => {
  const invitation = readInvitation({ login: 'ana', created_at: '2026-08-01T00:00:00Z' }, now);

  assert.equal('failedAt' in invitation, false);
  assert.equal('failedReason' in invitation, false);
});

test('a configuration that names nobody reports nobody missing', () => {
  assert.deepEqual(notInTheOrganization(peopleNamedBy({ owner: 'acme' }), new Set()), []);
});
