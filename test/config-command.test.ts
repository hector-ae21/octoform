import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrateConfig, validateConfig } from '../src/commands/config.js';
import { ConfigError, loadConfig } from '../src/config/resolve.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-config-command-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function silently<T>(run: () => T): T {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('validateConfig succeeds for a well-formed file and touches nothing on disk', () => {
  const path = write('valid.yml', 'owner: my-account\ndefaults: {}\n');
  assert.equal(
    silently(() => validateConfig(path)),
    0,
  );
});

test('validateConfig surfaces the same errors loadConfig would raise', () => {
  const path = write('invalid.yml', 'defaults: {}\n');
  assert.throws(() => silently(() => validateConfig(path)), ConfigError);
});

test('migrateConfig without --write leaves the file untouched', () => {
  const path = write('preview.yml', 'owner: my-account\ndefaults: {}\n');
  const before = readFileSync(path, 'utf8');

  assert.equal(
    silently(() => migrateConfig(path)),
    0,
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('migrateConfig --write rewrites the file in place', () => {
  const path = write('write-me.yml', 'owner: my-account\ndefaults: {}\n');

  assert.equal(
    silently(() => migrateConfig(path, { write: true })),
    0,
  );
  const after = readFileSync(path, 'utf8');
  assert.match(after, /version: 1/);
  assert.match(after, /owners:\n\s+my-account:/);
});

test('migrateConfig rejects a file that is already migrated', () => {
  const path = write('already.yml', 'version: 1\nowners:\n  a: {}\n');
  assert.throws(() => silently(() => migrateConfig(path)), /already declares "owners"/);
});

test('migrateConfig moves an import that would otherwise be stranded', () => {
  const importPath = write(
    'stranded-import.yml',
    '# Overrides.\nrepos:\n  svc:\n    merge:\n      allow_squash: true\n',
  );
  const path = write('stranded.yml', 'owner: my-account\nimports:\n  - stranded-import.yml\n');

  assert.equal(
    silently(() => migrateConfig(path, { write: true })),
    0,
  );

  const converted = readFileSync(importPath, 'utf8');
  assert.match(converted, /owners:\n\s+my-account:/u, 'the account comes from the root file');
  assert.match(converted, /repos:/u);
  assert.match(converted, /# Overrides\./u, 'comments survive the move');
  assert.doesNotMatch(converted, /^repos:/mu, 'nothing is left binding a bare repository name');
});

test('the configuration a multi-file migration produces still loads', () => {
  write('roundtrip-import.yml', 'repos:\n  svc:\n    merge:\n      allow_squash: true\n');
  const path = write('roundtrip.yml', 'owner: my-account\nimports:\n  - roundtrip-import.yml\n');

  silently(() => migrateConfig(path, { write: true }));

  const config = loadConfig(path);
  assert.equal(config.owners.length, 1);
  assert.deepEqual(config.owners[0]?.repos?.svc, { merge: { allow_squash: true } });
});

test('migrateConfig still migrates when imports keep repositories out of their root', () => {
  write('scoped-import.yml', 'types:\n  lib:\n    merge:\n      allow_squash: true\n');
  const path = write('scoped.yml', 'owner: my-account\nimports:\n  - scoped-import.yml\n');

  assert.equal(
    silently(() => migrateConfig(path)),
    0,
  );
});

test('a dirty file anywhere in the set stops the whole migration', () => {
  const repo = mkdtempSync(join(tmpdir(), 'octoform-migrate-git-'));
  after(() => rmSync(repo, { recursive: true, force: true }));
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
  };
  run('init');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');

  const root = join(repo, 'octoform.yml');
  const imported = join(repo, 'overrides.yml');
  writeFileSync(root, 'owner: my-account\nimports:\n  - overrides.yml\n', 'utf8');
  writeFileSync(imported, 'repos:\n  svc:\n    merge:\n      allow_squash: true\n', 'utf8');
  run('add', '.');
  run('commit', '-m', 'initial');

  // Only the import is dirty. The root is clean and would have been written.
  writeFileSync(imported, 'repos:\n  svc:\n    merge:\n      allow_squash: false\n', 'utf8');
  const rootBefore = readFileSync(root, 'utf8');

  assert.throws(
    () => silently(() => migrateConfig(root, { write: true })),
    (error: unknown) => error instanceof ConfigError && /Nothing was written/.test(error.message),
  );
  assert.equal(
    readFileSync(root, 'utf8'),
    rootBefore,
    'the clean root must not be converted while an import cannot be',
  );
});
