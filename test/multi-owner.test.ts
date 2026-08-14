import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { ConfigError, loadConfig, isExcluded, resolvePolicy } from '../src/config/resolve.js';
import type { OwnerScope, RepoState } from '../src/config/types.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-owners-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;

/** Write a configuration under a fresh name so tests cannot collide. */
function config(content: string, name = `main-${counter++}.yml`): string {
  return write(name, content);
}

function write(name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
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

function scopeFor(config: { owners: OwnerScope[] }, owner: string): OwnerScope {
  const found = config.owners.find((scope) => scope.owner === owner);
  assert.ok(found, `no scope for ${owner}`);
  return found;
}

test('a legacy single-owner file resolves to exactly one scope', () => {
  const path = config(`
owner: my-account
defaults:
  features: { issues: true }
types:
  lib: { merge: { allow_squash: true } }
repos:
  thing: { type: lib }
`);

  const resolved = loadConfig(path);
  assert.equal(resolved.version, 1);
  assert.equal(resolved.owners.length, 1);

  const scope = resolved.owners[0] as OwnerScope;
  assert.equal(scope.owner, 'my-account');
  const policy = resolvePolicy(scope, repo());
  assert.equal(policy.features?.issues, true);
  assert.equal(policy.merge?.allow_squash, true);
});

test('owners are resolved in the order they are declared', () => {
  const path = config(`
version: 1
owners:
  first: {}
  second: {}
  third: {}
`);

  assert.deepEqual(
    loadConfig(path).owners.map((scope) => scope.owner),
    ['first', 'second', 'third'],
  );
});

test('the shared root layers underneath each owner, and the owner wins', () => {
  const path = config(`
version: 1
defaults:
  features: { issues: true, wiki: true }
owners:
  keeps-the-default: {}
  overrides-it:
    defaults:
      features: { wiki: false }
`);

  const resolved = loadConfig(path);
  const shared = resolvePolicy(scopeFor(resolved, 'keeps-the-default'), repo());
  const narrowed = resolvePolicy(scopeFor(resolved, 'overrides-it'), repo());

  assert.equal(shared.features?.wiki, true);
  assert.equal(narrowed.features?.wiki, false);
  assert.equal(narrowed.features?.issues, true, 'the untouched key still comes from the root');
});

test('one owner cannot see another owner repositories or exclusions', () => {
  const path = config(`
version: 1
owners:
  one:
    repos:
      thing: { features: { issues: true } }
    exclude: { repos: [skipped] }
  two: {}
`);

  const resolved = loadConfig(path);
  assert.equal(resolvePolicy(scopeFor(resolved, 'one'), repo()).features?.issues, true);
  assert.deepEqual(resolvePolicy(scopeFor(resolved, 'two'), repo()), {});
  assert.equal(isExcluded(scopeFor(resolved, 'one'), 'skipped'), true);
  assert.equal(isExcluded(scopeFor(resolved, 'two'), 'skipped'), false);
});

test('a named policy is folded in underneath the layer that references it', () => {
  const path = config(`
version: 1
policies:
  baseline:
    merge: { allow_squash: true, allow_rebase: true }
owners:
  account:
    defaults:
      policies: [baseline]
      merge: { allow_rebase: false }
`);

  const policy = resolvePolicy(scopeFor(loadConfig(path), 'account'), repo());
  assert.equal(policy.merge?.allow_squash, true, 'the policy contributes what the layer omits');
  assert.equal(policy.merge?.allow_rebase, false, 'the referencing layer still wins');
});

test('policies referenced in a list are folded in declaration order', () => {
  const path = config(`
version: 1
policies:
  first: { features: { issues: true, wiki: true } }
  second: { features: { wiki: false } }
owners:
  account:
    defaults:
      policies: [first, second]
`);

  const policy = resolvePolicy(scopeFor(loadConfig(path), 'account'), repo());
  assert.equal(policy.features?.issues, true);
  assert.equal(policy.features?.wiki, false, 'the later reference wins');
});

test('a policy may reference another policy', () => {
  const path = config(`
version: 1
policies:
  base: { features: { issues: true } }
  derived:
    policies: [base]
    features: { wiki: false }
owners:
  account:
    defaults:
      policies: [derived]
`);

  const policy = resolvePolicy(scopeFor(loadConfig(path), 'account'), repo());
  assert.equal(policy.features?.issues, true);
  assert.equal(policy.features?.wiki, false);
});

test('a policy reference cycle is reported with the chain, not a stack overflow', () => {
  const path = config(`
version: 1
owner: account
policies:
  a: { policies: [b] }
  b: { policies: [a] }
`);

  assert.throws(() => loadConfig(path), /Circular policy reference[\s\S]*a[\s\S]*b/);
});

test('a reference to a policy that was never declared names the known ones', () => {
  const path = config(`
version: 1
owner: account
policies:
  declared: {}
defaults:
  policies: [missing]
`);

  assert.throws(() => loadConfig(path), /"missing".*not declared.*known: declared/s);
});

test('the resolved scope never carries policy references onward', () => {
  const path = config(`
version: 1
policies:
  baseline: { features: { issues: true } }
owners:
  account:
    defaults:
      policies: [baseline]
`);

  const scope = scopeFor(loadConfig(path), 'account');
  assert.equal('policies' in (scope.defaults ?? {}), false);
});

test('declaring both owner and owners is rejected', () => {
  const path = config(`
version: 1
owner: one
owners:
  two: {}
`);

  assert.throws(() => loadConfig(path), /both "owner".*and "owners"/s);
});

test('owners without a version is rejected, because the shape is new', () => {
  const path = config(`
owners:
  account: {}
`);

  assert.throws(() => loadConfig(path), /declares "owners" but no "version"/);
});

test('root repos alongside owners is rejected as ambiguous', () => {
  const path = config(`
version: 1
owners:
  account: {}
repos:
  thing: { features: { issues: true } }
`);

  assert.throws(() => loadConfig(path), /"repos" at the root alongside "owners"/);
});

test('an unsupported version names the version that is supported', () => {
  const path = config(`
version: 2
owner: account
`);

  assert.throws(() => loadConfig(path), /only accepts version 1/);
});

test('a version 1 single-owner file is accepted unchanged', () => {
  const path = config(`
version: 1
owner: account
defaults:
  features: { issues: true }
`);

  const resolved = loadConfig(path);
  assert.equal(resolved.owners.length, 1);
  assert.equal(resolvePolicy(resolved.owners[0] as OwnerScope, repo()).features?.issues, true);
});

test('an unknown key is rejected with the file, the path and a suggestion', () => {
  const path = config(`
owner: account
defaults:
  feature: { issues: true }
`);

  assert.throws(
    () => loadConfig(path),
    (error: Error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /unknown key "feature" in "defaults"/);
      assert.match(error.message, /Did you mean "features"\?/);
      assert.match(error.message, new RegExp(escapeRegExp(path)));
      return true;
    },
  );
});

test('an unknown key inside an owner block names that owner path', () => {
  const path = config(`
version: 1
owners:
  account:
    defaults:
      merge: { allow_squashh: true }
`);

  assert.throws(
    () => loadConfig(path),
    /unknown key "allow_squashh" in "owners.account.defaults.merge"/,
  );
});

test('an unknown key at the root is reported against the root', () => {
  const path = config(`
owner: account
typos: {}
`);

  assert.throws(() => loadConfig(path), /unknown key "typos" in the root of the file/);
});

test('a value of the wrong kind is rejected with its path', () => {
  const path = config(`
owner: account
defaults:
  ensure_branches: main
`);

  assert.throws(() => loadConfig(path), /"defaults.ensure_branches" must be a list/);
});

test('an import may declare owners for a file that declares none', () => {
  const preset = 'owners-preset.yml';
  write(
    preset,
    `
version: 1
owners:
  from-the-import:
    defaults:
      features: { issues: true }
`,
  );
  const path = config(`imports: [${preset}]\n`);

  const resolved = loadConfig(path);
  assert.deepEqual(
    resolved.owners.map((scope) => scope.owner),
    ['from-the-import'],
  );
});

test('an owner declared in two files has its blocks merged, not replaced', () => {
  const preset = 'owner-base.yml';
  write(
    preset,
    `
version: 1
owners:
  account:
    defaults:
      features: { issues: true, wiki: true }
`,
  );
  const path = config(`
version: 1
imports: [${preset}]
owners:
  account:
    defaults:
      features: { wiki: false }
`);

  const policy = resolvePolicy(scopeFor(loadConfig(path), 'account'), repo());
  assert.equal(policy.features?.issues, true);
  assert.equal(policy.features?.wiki, false);
});

test('a repository type must be declared for the owner that uses it', () => {
  const path = config(`
version: 1
owners:
  one:
    types: { lib: {} }
  two:
    types: { service: {} }
    repos:
      thing: { type: lib }
`);

  assert.throws(() => loadConfig(path), /two\/thing declares the type "lib"/);
});

test('an empty configuration for every owner still plans nothing', () => {
  const path = config(`
version: 1
owners:
  one: {}
  two: {}
`);

  for (const scope of loadConfig(path).owners) {
    assert.deepEqual(resolvePolicy(scope, repo()), {});
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
