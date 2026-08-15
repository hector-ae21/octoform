/**
 * Inputs chosen to break something, each asserting a safe and explained
 * outcome rather than an accident that happened to work.
 *
 * Most of these are not hypothetical: repository names, descriptions, topics
 * and custom-property values are writable by anyone with access to the account
 * being audited, and that is not always the person running octoform.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { ConfigError, isExcluded, loadConfig, resolvePolicy } from '../src/config/resolve.js';
import { narrowToQualifiedRepo, parseRepoSelector, selectOwners } from '../src/config/selectors.js';
import { UNREADABLE } from '../src/config/sentinels.js';
import { capability } from '../src/github/capabilities.js';
import { planRepo } from '../src/core/plan.js';
import { formatChange, printable } from '../src/report/format.js';
import type { OwnerScope, RepoDetail, ResolvedConfig } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-adversarial-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS = {
  rulesetCapability: capability('supported', 'assumed in this suite', 'permission'),
};

const ESCAPE = String.fromCharCode(0x1b);

let counter = 0;

function config(content: string): string {
  return write(`case-${counter++}.yml`, content);
}

function write(name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function repo(name: string, over: Partial<RepoDetail> = {}): RepoDetail {
  return {
    name,
    visibility: 'public',
    archived: false,
    default_branch: 'main',
    description: null,
    homepage: null,
    topics: [],
    settings: { 'features.issues': false, 'repo.description': null, 'repo.topics': [] },
    ...over,
  };
}

function scopeFor(resolved: ResolvedConfig, owner: string): OwnerScope {
  const found = resolved.owners.find((scope) => scope.owner === owner);
  assert.ok(found, `no scope for ${owner}`);
  return found;
}

test('two owners with a repository of the same name never share a policy', () => {
  const path = config(`
version: 1
owners:
  first:
    repos:
      shared: { features: { issues: true } }
  second:
    repos:
      shared: { features: { issues: false } }
`);

  const resolved = loadConfig(path);
  const observed = repo('shared');
  const first = scopeFor(resolved, 'first');
  const second = scopeFor(resolved, 'second');

  assert.deepEqual(
    planRepo('first', observed, resolvePolicy(first, observed), OPTIONS).map((change) => [
      change.id,
      change.to,
    ]),
    [['first/shared#features.issues', true]],
  );
  assert.deepEqual(
    planRepo('second', observed, resolvePolicy(second, observed), OPTIONS),
    [],
    'the observed value already matches what the second owner declared',
  );
});

test('two logins differing only in case stay two separate accounts', () => {
  const path = config(`
version: 1
owners:
  Account:
    repos:
      thing: { features: { issues: true } }
  account: {}
`);

  const resolved = loadConfig(path);
  assert.deepEqual(
    resolved.owners.map((scope) => scope.owner),
    ['Account', 'account'],
  );
  assert.deepEqual(
    selectOwners(resolved, ['account']).map((scope) => scope.owner),
    ['account'],
    'a lowercase selector must not fold into the differently-cased login',
  );
  assert.deepEqual(resolvePolicy(scopeFor(resolved, 'account'), repo('thing')), {});
});

test('a login that is only visually confusable is rejected, not quietly accepted', () => {
  const cyrillic = 'аccount';
  assert.notEqual(cyrillic, 'account', 'the fixture must actually differ from the ASCII login');
  const path = config(`
version: 1
owners:
  account: {}
  ${cyrillic}: {}
`);

  assert.throws(
    () => loadConfig(path),
    (error: Error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /is not a GitHub account login/);
      assert.match(error.message, /letters, digits and single hyphens/);
      return true;
    },
  );
});

test('a login shaped like something else entirely is rejected with the reason', () => {
  const cases: ReadonlyArray<[string, RegExp]> = [
    ['owner/repo', /probably an "owner\/repo" by mistake/],
    ['-leading', /cannot start or end with "-"/],
    ['trailing-', /cannot start or end with "-"/],
    ['double--hyphen', /two hyphens in a row/],
    ['a'.repeat(40), /40 characters long/],
  ];

  for (const [login, reason] of cases) {
    const path = config(`version: 1\nowners:\n  "${login}": {}\n`);
    assert.throws(() => loadConfig(path), reason, `"${login}" was accepted`);
  }
});

test('a selector for an owner the configuration does not declare is rejected', () => {
  const path = config(`
version: 1
owners:
  account: {}
  other-account: {}
`);

  const resolved = loadConfig(path);
  assert.equal(resolved.owners.length, 2);
  assert.throws(() => selectOwners(resolved, ['account-typo']), ConfigError);
});

test('a repository name containing a path separator matches only itself', () => {
  const path = config(`
version: 1
owners:
  account:
    repos:
      "../escaped": { features: { issues: true } }
    exclude: { repos: ["../escaped"] }
`);

  const scope = scopeFor(loadConfig(path), 'account');
  assert.equal(isExcluded(scope, '../escaped'), true);
  assert.equal(isExcluded(scope, 'escaped'), false);
  assert.deepEqual(resolvePolicy(scope, repo('escaped')), {}, 'a sibling name must not inherit it');
});

test('a repository name carrying terminal escapes is printed escaped, never executed', () => {
  const hostile = `thing${ESCAPE}[2K\rdeleted everything`;
  const [change] = planRepo('account', repo(hostile), { features: { issues: true } }, OPTIONS);
  assert.ok(change);

  const rendered = printable(change.repo);
  assert.equal(rendered.includes(ESCAPE), false, 'an escape sequence survived into the report');
  assert.equal(rendered.includes('\r'), false, 'a carriage return survived into the report');
  assert.match(rendered, /^thing\\x1b\[2K\\x0ddeleted everything$/);
});

test('a description carrying a newline cannot forge a second report line', () => {
  const hostile = 'harmless\n  merge.allow_squash: false -> true';
  const [change] = planRepo('account', repo('thing'), { repo: { description: hostile } }, OPTIONS);
  assert.ok(change);

  const line = formatChange(change);
  assert.equal(line.split('\n').length, 1, 'the report gained a line the planner never wrote');
  assert.match(line, /\\x0a/);
});

test('a topic carrying terminal escapes is escaped in the report too', () => {
  const observed = repo('thing', { settings: { 'repo.topics': [] } });
  const [change] = planRepo(
    'account',
    observed,
    { repo: { topics: [`alpha${ESCAPE}[31m`] } },
    OPTIONS,
  );
  assert.ok(change);
  assert.equal(formatChange(change).includes(ESCAPE), false);
});

test('a very long repository name is reported in full rather than truncated silently', () => {
  const long = 'r'.repeat(4096);
  const [change] = planRepo('account', repo(long), { features: { issues: true } }, OPTIONS);
  assert.ok(change);
  assert.equal(change.repo, long);
  assert.equal(change.id, `account/${long}#features.issues`);
});

test('a setting the observation never returned blocks instead of being invented', () => {
  const observed = repo('thing', { settings: {} });
  assert.deepEqual(planRepo('account', observed, { features: { issues: true } }, OPTIONS), [
    {
      id: 'account/thing#features.issues',
      owner: 'account',
      repo: 'thing',
      key: 'features.issues',
      operation: 'create',
      risk: 'normal',
      prerequisites: [],
      from: undefined,
      to: true,
      blocked: 'not a setting octoform knows about',
    },
  ]);
});

test('an unreadable setting blocks rather than being read as absent', () => {
  const observed = repo('thing', { settings: { 'features.issues': UNREADABLE } });
  const [change] = planRepo('account', observed, { features: { issues: true } }, OPTIONS);
  assert.ok(change?.blocked, 'an unreadable value must never be planned over');
});

test('an import of a file that does not exist names the file it tried to read', () => {
  const path = config('version: 1\nimports: [missing.yml]\n');
  assert.throws(() => loadConfig(path), /Cannot read configuration file:[\s\S]*missing\.yml/);
});

test('an import path is resolved against its own file, not the process directory', () => {
  write(join('outside', 'shared.yml'), 'version: 1\nowners:\n  account: {}\n');
  const path = write(
    join('nested', 'main.yml'),
    'version: 1\nimports: ["../outside/shared.yml"]\n',
  );

  assert.deepEqual(
    loadConfig(path).owners.map((scope) => scope.owner),
    ['account'],
  );
});

test('an import cycle is reported as a chain rather than exhausting the stack', () => {
  write('cycle-a.yml', 'version: 1\nimports: [cycle-b.yml]\n');
  write('cycle-b.yml', 'version: 1\nimports: [cycle-a.yml]\n');
  const path = config('version: 1\nimports: [cycle-a.yml]\n');

  assert.throws(() => loadConfig(path), /Circular import[\s\S]*cycle-a\.yml[\s\S]*cycle-b\.yml/);
});

test('a deeply nested import chain resolves without exhausting the stack', () => {
  const depth = 60;
  for (let level = depth; level >= 1; level -= 1) {
    const next = level === depth ? '' : `imports: [deep-${level + 1}.yml]\n`;
    const owners = level === depth ? 'owners:\n  account: {}\n' : '';
    write(`deep-${level}.yml`, `version: 1\n${next}${owners}`);
  }
  const path = config('version: 1\nimports: [deep-1.yml]\n');

  assert.deepEqual(
    loadConfig(path).owners.map((scope) => scope.owner),
    ['account'],
  );
});

test('a self-referencing policy is reported as a chain rather than exhausting the stack', () => {
  const path = config(`
version: 1
owner: account
policies:
  loops: { policies: [loops] }
defaults:
  policies: [loops]
`);

  assert.throws(() => loadConfig(path), /Circular policy reference[\s\S]*loops/);
});

test('a repository selector naming an undeclared owner is rejected, not silently widened', () => {
  const path = config(`
version: 1
owners:
  first: {}
  second: {}
`);

  const resolved = loadConfig(path);
  const selector = parseRepoSelector('third/thing') as { owner: string; name: string };
  assert.throws(
    () => narrowToQualifiedRepo(resolved, resolved.owners, selector, false),
    /not declared in this configuration/,
  );
});

test('a repository selector that contradicts an owner selector is rejected', () => {
  const path = config(`
version: 1
owners:
  first: {}
  second: {}
`);

  const resolved = loadConfig(path);
  const selected = selectOwners(resolved, ['first']);
  const selector = parseRepoSelector('second/thing') as { owner: string; name: string };
  assert.throws(() => narrowToQualifiedRepo(resolved, selected, selector, true), /disagree/);
});

test('an empty side of a qualified repository selector is rejected', () => {
  assert.throws(() => parseRepoSelector('/thing'), ConfigError);
  assert.throws(() => parseRepoSelector('owner/'), ConfigError);
});

test('an archived repository is never planned, whatever the policy asks for', () => {
  const observed = repo('thing', { archived: true });
  assert.deepEqual(planRepo('account', observed, { features: { issues: true } }, OPTIONS), []);
});
