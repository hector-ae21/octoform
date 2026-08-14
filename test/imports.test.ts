import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { ConfigError, loadConfig, resolvePolicy } from '../src/config/resolve.js';
import type { OwnerScope, ResolvedConfig } from '../src/config/types.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-imports-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The one scope a single-owner configuration resolves to. */
function only(config: ResolvedConfig): OwnerScope {
  assert.equal(config.owners.length, 1);
  return config.owners[0] as OwnerScope;
}

function write(name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

test('an import with no owner contributes types and defaults', () => {
  write(
    'preset.yml',
    `
defaults:
  features: { issues: true }
types:
  npm-package:
    merge: { allow_squash: true }
`,
  );
  const path = write(
    'main.yml',
    `
owner: my-account
imports: [preset.yml]
`,
  );

  const config = only(loadConfig(path));
  assert.equal(config.owner, 'my-account');
  assert.equal(config.defaults?.features?.issues, true);
  assert.equal(config.types?.['npm-package']?.merge?.allow_squash, true);
});

test('the importing file overrides a key its import declared', () => {
  write('preset.yml', `defaults:\n  features: { issues: true, wiki: true }\n`);
  const path = write(
    'main.yml',
    `
owner: my-account
imports: [preset.yml]
defaults:
  features: { wiki: false }
`,
  );

  const config = only(loadConfig(path));
  assert.equal(config.defaults?.features?.issues, true, 'untouched key survives the import');
  assert.equal(config.defaults?.features?.wiki, false, 'the importing file wins');
});

test('later imports override earlier ones, most general first', () => {
  write('a.yml', `defaults:\n  features: { issues: true, wiki: true }\n`);
  write('b.yml', `defaults:\n  features: { wiki: false }\n`);
  const path = write('main.yml', `owner: my-account\nimports: [a.yml, b.yml]\n`);

  const config = only(loadConfig(path));
  assert.equal(config.defaults?.features?.issues, true);
  assert.equal(config.defaults?.features?.wiki, false, 'b.yml is listed after a.yml, so it wins');
});

test('imports resolve relative to the importing file, nested arbitrarily deep', () => {
  write('lib/base.yml', `defaults:\n  features: { projects: false }\n`);
  write(
    'lib/preset.yml',
    `imports: [base.yml]\ntypes:\n  service: { merge: { allow_rebase: false } }\n`,
  );
  const path = write('main.yml', `owner: my-account\nimports: [lib/preset.yml]\n`);

  const config = only(loadConfig(path));
  assert.equal(config.defaults?.features?.projects, false);
  assert.equal(config.types?.service?.merge?.allow_rebase, false);
});

test('a repo entry can still use a type declared only in an import', () => {
  write('preset.yml', `types:\n  npm-package: { merge: { allow_squash: true } }\n`);
  const path = write(
    'main.yml',
    `
owner: my-account
imports: [preset.yml]
repos:
  some-lib: { type: npm-package }
`,
  );

  const config = only(loadConfig(path));
  const policy = resolvePolicy(config, {
    name: 'some-lib',
    visibility: 'public',
    archived: false,
    default_branch: 'main',
    description: null,
    homepage: null,
    topics: [],
  });
  assert.equal(policy.merge?.allow_squash, true);
});

test('a direct import cycle is rejected', () => {
  write('a.yml', `imports: [b.yml]\n`);
  const path = write('b.yml', `imports: [a.yml]\nowner: my-account\n`);
  assert.throws(() => loadConfig(path), ConfigError);
});

test('a conflicting owner between a file and its import is rejected', () => {
  write('other.yml', `owner: someone-else\n`);
  const path = write('main.yml', `owner: my-account\nimports: [other.yml]\n`);
  assert.throws(() => loadConfig(path), /Conflicting "owner"/);
});

test('no owner anywhere in the chain is a clear error, not a crash', () => {
  const path = write('main.yml', `defaults:\n  features: { issues: true }\n`);
  assert.throws(() => loadConfig(path), /must declare an "owner"/);
});
