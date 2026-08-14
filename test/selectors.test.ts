import assert from 'node:assert/strict';
import { test } from 'node:test';
import { narrowToQualifiedRepo, parseRepoSelector, selectOwners } from '../src/config/selectors.js';
import { ConfigError } from '../src/config/resolve.js';
import type { OwnerScope, ResolvedConfig } from '../src/types/index.js';

const scope = (owner: string): OwnerScope => ({ owner });

const config = (...owners: string[]): ResolvedConfig => ({
  version: 1,
  owners: owners.map(scope),
});

test('parseRepoSelector accepts a bare name', () => {
  assert.deepEqual(parseRepoSelector('thing'), { name: 'thing' });
});

test('parseRepoSelector splits an owner/name pair', () => {
  assert.deepEqual(parseRepoSelector('account/thing'), { owner: 'account', name: 'thing' });
});

test('parseRepoSelector rejects a value with an empty half', () => {
  assert.throws(() => parseRepoSelector('/thing'), ConfigError);
  assert.throws(() => parseRepoSelector('account/'), ConfigError);
});

test('selectOwners with no logins returns every declared owner, in order', () => {
  const selected = selectOwners(config('a', 'b', 'c'), []);
  assert.deepEqual(
    selected.map((s) => s.owner),
    ['a', 'b', 'c'],
  );
});

test('selectOwners narrows to the requested logins, preserving declaration order', () => {
  const selected = selectOwners(config('a', 'b', 'c'), ['c', 'a']);
  assert.deepEqual(
    selected.map((s) => s.owner),
    ['a', 'c'],
  );
});

test('selectOwners rejects a login the configuration does not declare', () => {
  assert.throws(() => selectOwners(config('a', 'b'), ['nope']), /not declared.*known: a, b/s);
});

test('narrowToQualifiedRepo keeps only the named owner', () => {
  const cfg = config('a', 'b');
  const narrowed = narrowToQualifiedRepo(cfg, cfg.owners, { owner: 'b', name: 'thing' }, false);
  assert.deepEqual(
    narrowed.map((s) => s.owner),
    ['b'],
  );
});

test('narrowToQualifiedRepo rejects an owner the configuration does not declare', () => {
  const cfg = config('a');
  assert.throws(
    () => narrowToQualifiedRepo(cfg, cfg.owners, { owner: 'nope', name: 'thing' }, false),
    /not declared/,
  );
});

test('narrowToQualifiedRepo rejects disagreeing with an explicit --owner', () => {
  const cfg = config('a', 'b');
  const explicitlySelectedA = selectOwners(cfg, ['a']);
  assert.throws(
    () => narrowToQualifiedRepo(cfg, explicitlySelectedA, { owner: 'b', name: 'thing' }, true),
    /disagree/,
  );
});
