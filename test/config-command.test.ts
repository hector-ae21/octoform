import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrateConfig, validateConfig } from '../src/commands/config.js';
import { ConfigError } from '../src/config/resolve.js';

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

test('migrateConfig refuses when an import would be stranded at the root', () => {
  write('stranded-import.yml', 'repos:\n  svc:\n    merge:\n      allow_squash: true\n');
  const path = write('stranded.yml', 'owner: my-account\nimports:\n  - stranded-import.yml\n');
  const before = readFileSync(path, 'utf8');

  assert.throws(
    () => silently(() => migrateConfig(path, { write: true })),
    (error: unknown) =>
      error instanceof ConfigError &&
      /stranded-import\.yml/.test(error.message) &&
      /cannot be migrated automatically/.test(error.message),
  );
  assert.equal(readFileSync(path, 'utf8'), before, 'nothing may be written when it refuses');
});

test('migrateConfig still migrates when imports keep repositories out of their root', () => {
  write('scoped-import.yml', 'types:\n  lib:\n    merge:\n      allow_squash: true\n');
  const path = write('scoped.yml', 'owner: my-account\nimports:\n  - scoped-import.yml\n');

  assert.equal(
    silently(() => migrateConfig(path)),
    0,
  );
});
