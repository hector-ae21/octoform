import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrateToMultiOwner, moveRepositoriesUnderOwner } from '../src/config/migrate.js';
import { ConfigError, loadConfig, resolvePolicy } from '../src/config/resolve.js';
import type { RepoState } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-migrate-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

const repo = (over: Partial<RepoState> = {}): RepoState => ({
  name: 'thing',
  visibility: 'public',
  archived: false,
  default_branch: 'main',
  description: null,
  homepage: null,
  topics: [],
  ...over,
});

test('migrating moves the owner-scoped keys under owners and adds version', () => {
  const raw = `owner: my-account\ndefaults:\n  features: { issues: true }\n`;
  const migrated = migrateToMultiOwner(raw, 'octoform.yml');

  assert.equal(migrated.owner, 'my-account');
  assert.match(migrated.yaml, /version: 1/);
  assert.match(migrated.yaml, /owners:\n\s+my-account:/);
  assert.doesNotMatch(migrated.yaml, /^owner:/m);
});

test('a migrated file produces the same resolved policy as the original', () => {
  const raw = `
owner: my-account
defaults:
  merge: { delete_branch_on_merge: true }
types:
  lib: { features: { issues: false } }
repos:
  thing: { type: lib }
`;
  const originalPath = write('original.yml', raw);
  const migratedPath = write('migrated.yml', migrateToMultiOwner(raw, 'octoform.yml').yaml);

  const originalScope = loadConfig(originalPath).owners[0];
  const migratedScope = loadConfig(migratedPath).owners[0];
  assert.ok(originalScope);
  assert.ok(migratedScope);

  assert.deepEqual(resolvePolicy(migratedScope, repo()), resolvePolicy(originalScope, repo()));
});

test('imports and policies at the root are left where they are', () => {
  write('preset.yml', `types:\n  lib: {}\n`);
  const raw = `owner: my-account\nimports: [preset.yml]\ndefaults: {}\n`;
  const migrated = migrateToMultiOwner(raw, 'octoform.yml');

  assert.match(migrated.yaml, /imports:.*preset\.yml/);
  const loaded = loadConfig(write('with-import.yml', migrated.yaml));
  assert.equal(loaded.owners[0]?.types?.lib !== undefined, true);
});

test('comments attached to a moved key travel with it', () => {
  const raw = `owner: my-account\n\n# keep this\ndefaults:\n  features: { issues: true }\n`;
  const migrated = migrateToMultiOwner(raw, 'octoform.yml');
  assert.match(migrated.yaml, /# keep this\n\s*defaults:/);
});

test('a comment written above "owner" is rescued rather than deleted with the key', () => {
  const raw = `# why this file exists\n# second line\nowner: my-account\ndefaults: {}\n`;
  const migrated = migrateToMultiOwner(raw, 'octoform.yml');
  assert.match(migrated.yaml, /^# why this file exists\n# second line\nversion: 1/);
});

test('a file with no root owner has nothing to migrate', () => {
  assert.throws(
    () => migrateToMultiOwner('owners:\n  a: {}\n', 'octoform.yml'),
    /already declares "owners"/,
  );
  assert.throws(() => migrateToMultiOwner('defaults: {}\n', 'octoform.yml'), /has no root "owner"/);
});

test('an already-migrated file is rejected rather than silently accepted', () => {
  assert.throws(
    () => migrateToMultiOwner('owner: a\nowners:\n  b: {}\n', 'octoform.yml'),
    ConfigError,
  );
});

test('an imported file has its root repositories moved under the account', () => {
  const { yaml } = moveRepositoriesUnderOwner(
    '# Overrides.\nrepos:\n  svc:\n    merge:\n      allow_squash: true\n',
    'my-account',
    'overrides.yml',
  );

  assert.match(yaml, /^owners:\n  my-account:\n/u);
  assert.match(yaml, /# Overrides\./u);
});

test('an imported file with nothing to move says so instead of rewriting it', () => {
  assert.throws(
    () => moveRepositoriesUnderOwner('types:\n  lib: {}\n', 'my-account', 'preset.yml'),
    /has no root "repos"/u,
  );
});

test('an imported file already naming accounts is left for a human', () => {
  assert.throws(
    () =>
      moveRepositoriesUnderOwner(
        'owners:\n  other: {}\nrepos:\n  svc: {}\n',
        'my-account',
        'mixed.yml',
      ),
    /cannot tell which account those repositories belong to/u,
  );
});
