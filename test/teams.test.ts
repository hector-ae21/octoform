import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planOrganization } from '../src/core/organization.js';
import { describeTeam, readTeam, sameTeam, teamBody, teamProblems } from '../src/core/teams.js';
import type { ExistingTeam, OrganizationPolicy, TeamPolicy } from '../src/types/index.js';

const platform = readTeam({
  id: 1,
  slug: 'platform',
  name: 'Platform',
  description: 'Runs the platform',
  privacy: 'closed',
  notification_setting: 'notifications_enabled',
  parent: null,
}) as ExistingTeam;

const oncall = readTeam({
  id: 2,
  slug: 'platform-oncall',
  name: 'Platform On-call',
  privacy: 'closed',
  notification_setting: 'notifications_disabled',
  parent: { slug: 'platform' },
}) as ExistingTeam;

const held: Record<string, ExistingTeam> = { platform, 'platform-oncall': oncall };

const planned = (teams: OrganizationPolicy['teams'], existing = held) =>
  planOrganization('acme', 'org', { teams: existing }, { teams });

const map = (entries: Record<string, TeamPolicy>) => new Map(Object.entries(entries));

test('a team is read into the fields a policy declares', () => {
  assert.equal(platform.slug, 'platform');
  assert.equal(platform.notifications, true);
  assert.equal(oncall.notifications, false);
  assert.equal(oncall.parent, 'platform');
  assert.equal(platform.parent, null);
});

test('the notification setting is a boolean wearing two long strings', () => {
  assert.equal(
    teamBody('a', { notifications: false }, false).notification_setting,
    'notifications_disabled',
  );
  assert.equal(
    teamBody('a', { notifications: true }, false).notification_setting,
    'notifications_enabled',
  );
});

test('a team with no name is called by the slug it is declared under', () => {
  assert.equal(teamBody('platform', {}, true).name, 'platform');
  assert.equal(teamBody('platform', { name: 'Platform' }, true).name, 'Platform');
});

test('only the declared fields are sent, since this endpoint patches', () => {
  assert.deepEqual(teamBody('platform', { description: 'New' }, false), { description: 'New' });
});

test('an empty parent detaches, since null already means stop managing', () => {
  assert.equal(teamBody('a', { parent: '' }, false).parent_team_slug, null);
  assert.equal(teamBody('a', { parent: 'platform' }, false).parent_team_slug, 'platform');
});

test('a team that already says what the policy declares is not a change', () => {
  assert.equal(sameTeam(platform, 'platform', { privacy: 'closed' }), true);
  assert.equal(sameTeam(platform, 'platform', { privacy: 'secret' }), false);
  assert.equal(sameTeam(oncall, 'platform-oncall', { parent: 'platform' }), true);
  assert.equal(sameTeam(platform, 'platform', { parent: 'platform' }), false);
});

test('a parent that is neither declared nor existing is refused', () => {
  const problems = teamProblems(map({ child: { parent: 'nobody' } }), held);

  assert.match((problems.get('child') ?? []).join('; '), /neither declared nor an existing team/u);
});

test('a nested team cannot be secret, and neither can one with children', () => {
  const nested = teamProblems(map({ child: { parent: 'platform', privacy: 'secret' } }), held);
  const withChildren = teamProblems(
    map({ platform: { privacy: 'secret' }, child: { parent: 'platform' } }),
    held,
  );

  assert.match((nested.get('child') ?? []).join('; '), /with a parent cannot be secret/u);
  assert.match((withChildren.get('platform') ?? []).join('; '), /with children cannot be secret/u);
});

test('deleting a parent whose children the file declares is refused', () => {
  const problems = teamProblems(
    map({ platform: { mode: 'absent' }, 'platform-oncall': { parent: 'platform' } }),
    held,
  );

  assert.match(
    (problems.get('platform') ?? []).join('; '),
    /would delete platform-oncall with it/u,
  );
});

test('a team declared under a parent that is itself being deleted is refused', () => {
  const problems = teamProblems(
    map({ platform: { mode: 'absent' }, child: { parent: 'platform', mode: 'absent' } }),
    held,
  );

  assert.match((problems.get('child') ?? []).join('; '), /declared absent/u);
});

test('parents that lead back round are refused rather than waited on forever', () => {
  const problems = teamProblems(map({ a: { parent: 'b' }, b: { parent: 'a' } }), {});

  assert.match((problems.get('a') ?? []).join('; '), /lead back to itself/u);
  assert.match((problems.get('b') ?? []).join('; '), /lead back to itself/u);
});

test('a matching team is not planned', () => {
  assert.deepEqual(planned({ platform: { name: 'Platform', privacy: 'closed' } }), []);
});

test('a team belongs to the owner, so it names no repository', () => {
  const [change] = planned({ design: { name: 'Design' } });

  assert.equal(change?.repo, undefined);
  assert.equal(change?.key, 'organization.teams.design');
  assert.equal(change?.operation, 'create');
  assert.deepEqual(change?.payload, { team: 'design', body: { name: 'Design' } });
});

test('a child waits for a parent the same run is creating, and only then', () => {
  const creatingBoth = planned({ design: {}, 'design-oncall': { parent: 'design' } }, {});
  const child = creatingBoth.find((change) => change.key.endsWith('design-oncall'));
  const existingParent = planned({ 'platform-new': { parent: 'platform' } });

  assert.deepEqual(child?.prerequisites, ['acme#organization.teams.design']);
  assert.deepEqual(existingParent[0]?.prerequisites, []);
});

test('a renamed team is renamed rather than created a second time', () => {
  const [change] = planned({ core: { name: 'Core', rename_from: ['platform'] } });

  assert.equal(change?.operation, 'update');
  assert.equal((change?.payload as { team: string }).team, 'platform');
  assert.equal((change?.payload as { body: { name: string } }).body.name, 'Core');
});

test('showing a secret team to the whole organisation is sensitive', () => {
  const secret: ExistingTeam = { ...platform, privacy: 'secret' };
  const [widening] = planned({ platform: { privacy: 'closed' } }, { platform: secret });
  const [describing] = planned({ platform: { description: 'Something else' } });

  assert.equal(widening?.risk, 'sensitive');
  assert.equal(describing?.risk, 'normal');
});

test('deleting a team is destructive, because its children go with it', () => {
  const [change] = planned({ 'platform-oncall': { mode: 'absent' } });

  assert.equal(change?.operation, 'delete');
  assert.equal(change?.risk, 'destructive');
  assert.deepEqual(change?.payload, { team: 'platform-oncall', remove: true });
});

test('a team nobody has and nobody declared absent is nothing to do', () => {
  assert.deepEqual(planned({ gone: { mode: 'absent' } }), []);
});

test('teams that could not be read block rather than being created again', () => {
  const [change] = planOrganization('acme', 'org', {}, { teams: { design: {} } });

  assert.match(String(change?.blocked), /could not read the organisation teams/u);
});

test('a personal account is told it has no teams', () => {
  const [change] = planOrganization('someone', 'user', undefined, { teams: { design: {} } });

  assert.match(String(change?.blocked), /has no teams/u);
});

test('a cancelled team is not a change', () => {
  assert.deepEqual(planned({ design: null }), []);
});

test('a team reads as a sentence in the report', () => {
  assert.equal(
    describeTeam('platform-oncall', oncall),
    'platform-oncall (Platform On-call); closed; notifications off; under platform',
  );
  assert.equal(describeTeam('design', { privacy: 'secret' }), 'design; secret');
});
