import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalLevel,
  grantLevel,
  invitationLevel,
  isBuiltIn,
  readLevel,
  sameLevel,
} from '../src/core/access.js';

test('the two names GitHub has for the same level collapse to one', () => {
  assert.equal(canonicalLevel('pull'), 'read');
  assert.equal(canonicalLevel('push'), 'write');
  assert.equal(canonicalLevel('read'), 'read');
  assert.equal(canonicalLevel('write'), 'write');
  assert.equal(canonicalLevel('ADMIN'), 'admin', 'and case is not a difference either');
});

test('each endpoint is spoken to in the vocabulary it documents', () => {
  assert.equal(grantLevel('read'), 'pull', 'the grant endpoints say pull');
  assert.equal(grantLevel('write'), 'push');
  assert.equal(invitationLevel('pull'), 'read', 'invitations say read');
  assert.equal(invitationLevel('push'), 'write');
  assert.equal(grantLevel('maintain'), 'maintain', 'the other three agree with themselves');
});

test('a name GitHub does not build in is a custom role, and passes through', () => {
  assert.equal(isBuiltIn('write'), true);
  assert.equal(isBuiltIn('security-reviewer'), false);
  assert.equal(canonicalLevel('security-reviewer'), 'security-reviewer');
  assert.equal(grantLevel('security-reviewer'), 'security-reviewer');
});

test('a held level is read from the role name, and from the booleans when there is none', () => {
  assert.equal(readLevel('push', undefined), 'write');
  assert.equal(readLevel('custom-role', { pull: true, push: true }), 'custom-role');
  assert.equal(
    readLevel(undefined, { pull: true, triage: true, push: true, maintain: false, admin: false }),
    'write',
    'the strongest flag that is true wins',
  );
  assert.equal(readLevel(undefined, { pull: true }), 'read');
  assert.equal(readLevel(undefined, undefined), undefined, 'and nothing at all stays unknown');
});

test('holding nothing matches only an explicit revocation', () => {
  assert.equal(sameLevel(undefined, 'none'), true);
  assert.equal(sameLevel(undefined, 'read'), false);
  assert.equal(sameLevel('write', 'push'), true, 'however it was spelled');
  assert.equal(sameLevel('write', 'none'), false);
});
