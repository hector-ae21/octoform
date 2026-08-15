import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNREADABLE } from '../src/config/sentinels.js';
import { ORGANIZATION_FIELDS, planOrganization } from '../src/core/organization.js';
import type { OrganizationPolicy, SettingValue } from '../src/types/index.js';

const current: Record<string, SettingValue> = {
  'organization.profile.name': 'Acme',
  'organization.profile.description': null,
  'organization.profile.website': 'https://acme.test',
  'organization.members.base_permission': 'write',
  'organization.members.create_repositories': true,
  'organization.members.fork_private_repositories': false,
};

const planned = (policy: OrganizationPolicy, held = current) =>
  planOrganization('acme', 'org', { settings: held }, policy);

test('a policy that matches produces no change', () => {
  assert.deepEqual(planned({ profile: { name: 'Acme' } }), []);
});

test('a setting nobody declared is never a change, however different', () => {
  const changes = planned({ profile: { name: 'Acme Inc' } });

  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.key, 'organization.profile.name');
});

test('a change belongs to the owner, so it names no repository', () => {
  const [change] = planned({ profile: { description: 'A company' } });

  assert.equal(change?.repo, undefined);
  assert.equal(change?.owner, 'acme');
  assert.equal(change?.id, 'acme#organization.profile.description');
});

test('unset and empty are the same absence here too', () => {
  assert.deepEqual(planned({ profile: { description: '' } }), []);
});

test('a setting that reaches every repository is sensitive; a profile field is not', () => {
  const [base] = planned({ members: { base_permission: 'read' } });
  const [name] = planned({ profile: { name: 'Acme Inc' } });

  assert.equal(base?.risk, 'sensitive');
  assert.equal(name?.risk, 'normal');
});

test('a personal account is told it has none of these, rather than being attempted', () => {
  const changes = planOrganization('someone', 'user', undefined, {
    members: { base_permission: 'read' },
  });

  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /personal account/u);
});

test('settings that could not be read block rather than being planned over', () => {
  const missing = planOrganization('acme', 'org', {}, { profile: { name: 'Acme Inc' } });
  assert.match(String(missing[0]?.blocked), /could not read the current organisation settings/u);

  const unreadable = planned(
    { profile: { location: 'Madrid' } },
    {
      ...current,
      'organization.profile.location': UNREADABLE,
    },
  );
  assert.match(String(unreadable[0]?.blocked), /could not be read/u);
});

test('a cancelled setting is not a change', () => {
  assert.deepEqual(planned({ profile: { name: null } }), []);
});

test('every key a policy can declare has a field to read and write it', () => {
  const declared: OrganizationPolicy = {
    profile: {
      name: 'n',
      description: 'd',
      company: 'c',
      website: 'w',
      location: 'l',
      email: 'e',
      twitter_username: 't',
    },
    members: {
      base_permission: 'read',
      create_repositories: true,
      create_public_repositories: true,
      create_private_repositories: true,
      create_internal_repositories: true,
      fork_private_repositories: true,
      create_pages: true,
      create_public_pages: true,
      create_private_pages: true,
      web_commit_signoff_required: true,
      deploy_keys_enabled: true,
      organization_projects: true,
      repository_projects: true,
    },
  };
  const keys = planOrganization('acme', 'org', { settings: {} }, declared).map(
    (change) => change.key,
  );

  assert.deepEqual(
    keys.filter((key) => ORGANIZATION_FIELDS[key] === undefined),
    [],
    'a declared key with no field behind it would be read as unset and never applied',
  );
  assert.equal(keys.length, Object.keys(ORGANIZATION_FIELDS).length);
});
