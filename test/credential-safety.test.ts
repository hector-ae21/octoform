/**
 * Proof that a credential never reaches an output surface.
 *
 * No field octoform manages today carries a secret, so there is no redaction
 * layer to exercise: what these cases prove is the boundary that keeps
 * credentials out in the first place — the authentication token, and any
 * credential-shaped value written into a configuration file.
 *
 * Every value used here is synthetic and was never issued by GitHub.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { buildPlanArtifact } from '../src/config/plan-artifact.js';
import { findCredentialShapedValue } from '../src/config/credential-scan.js';
import { ConfigError, loadConfig } from '../src/config/resolve.js';
import { formatChange } from '../src/report/format.js';
import { planRepo } from '../src/core/plan.js';
import { capability } from '../src/github/capabilities.js';
import type { Octokit } from '@octokit/rest';
import type { OwnerScope, PlanResult, RepoDetail } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-credentials-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS = {
  rulesetCapability: capability('supported', 'assumed in this suite', 'permission'),
};

/** Synthetic values with the shape of a real token and none of the access. */
const SYNTHETIC = {
  classic: `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`,
  oauth: `gho_${'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'}`,
  fineGrained: `github_pat_${'11ABCDEFG0abcdefghijklmnop'}`,
};

let counter = 0;

function write(name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function config(content: string): string {
  return write(`case-${counter++}.yml`, content);
}

/** Assert the failure names where the value is and never what it is. */
function assertRejected(path: string, token: string, expectedPath: RegExp): void {
  assert.throws(
    () => loadConfig(path),
    (error: Error) => {
      assert.ok(error instanceof ConfigError, 'a credential must be a configuration error');
      assert.equal(
        error.message.includes(token),
        false,
        'the error repeated the credential it was rejecting',
      );
      assert.match(error.message, /looks like a GitHub token/);
      assert.match(error.message, expectedPath);
      return true;
    },
  );
}

const FIELDS: ReadonlyArray<[string, string, RegExp]> = [
  ['a repository description', 'defaults:\n  repo:\n    description: TOKEN\n', /defaults\.repo\.description/],
  ['a repository homepage', 'defaults:\n  repo:\n    homepage: TOKEN\n', /defaults\.repo\.homepage/],
  ['a topic', 'defaults:\n  repo:\n    topics: [TOKEN]\n', /defaults\.repo\.topics\[0\]/],
  ['a default-branch name', 'defaults:\n  default_branch:\n    name: TOKEN\n', /defaults\.default_branch\.name/],
  ['an ensured branch', 'defaults:\n  ensure_branches: [TOKEN]\n', /defaults\.ensure_branches\[0\]/],
  ['a ruleset name', 'defaults:\n  rulesets:\n    - name: TOKEN\n      target_branches: [main]\n', /defaults\.rulesets\[0\]\.name/],
  ['an environment name', 'defaults:\n  environments:\n    - name: TOKEN\n', /defaults\.environments\[0\]\.name/],
  ['a classify property', 'classify:\n  property: TOKEN\n', /classify\.property/],
];

for (const [what, fragment, expectedPath] of FIELDS) {
  test(`a credential in ${what} is rejected without echoing it`, () => {
    const path = config(`version: 1\nowner: account\n${fragment.replace('TOKEN', SYNTHETIC.classic)}`);
    assertRejected(path, SYNTHETIC.classic, expectedPath);
  });
}

test('a credential used as a repository name is rejected without echoing it', () => {
  const path = config(
    `version: 1\nowner: account\nrepos:\n  ${SYNTHETIC.oauth}: { features: { issues: true } }\n`,
  );
  assertRejected(path, SYNTHETIC.oauth, /repos \(one of its keys\)/);
});

test('a credential used as an owner login is rejected without echoing it', () => {
  const path = config(`version: 1\nowners:\n  ${SYNTHETIC.fineGrained}: {}\n`);
  assertRejected(path, SYNTHETIC.fineGrained, /owners \(one of its keys\)/);
});

test('a credential inside an imported file names that file, not the entry point', () => {
  const imported = write(
    'imported-secret.yml',
    `version: 1\nowner: account\ndefaults:\n  repo:\n    description: ${SYNTHETIC.classic}\n`,
  );
  const path = config('version: 1\nimports: [imported-secret.yml]\n');

  assert.throws(
    () => loadConfig(path),
    (error: Error) => {
      assert.equal(error.message.includes(SYNTHETIC.classic), false);
      assert.ok(error.message.includes(imported), 'the error must name the file that holds it');
      return true;
    },
  );
});

test('every token shape the scanner knows is found wherever it is nested', () => {
  for (const token of Object.values(SYNTHETIC)) {
    assert.equal(findCredentialShapedValue({ a: { b: [{ c: token }] } }), 'a.b[0].c');
  }
});

test('an ordinary configuration value is never mistaken for a credential', () => {
  const innocent = {
    description: 'A repository about ghp_ prefixes and github_pat_ naming',
    topics: ['ghp', 'github-pat', 'gho_short'],
    branch: 'release/gh-pages',
  };
  assert.equal(findCredentialShapedValue(innocent), undefined);
});

test('a token in the environment never reaches a saved plan', async () => {
  const scope: OwnerScope = { owner: 'account' };
  const observed: RepoDetail = {
    name: 'thing',
    visibility: 'public',
    archived: false,
    default_branch: 'main',
    description: null,
    homepage: null,
    topics: [],
    settings: { 'features.issues': false },
  };
  const changes = planRepo('account', observed, { features: { issues: true } }, OPTIONS);
  const results = new Map<string, PlanResult>([
    ['account', { changes, blocked: [], errors: [], scanned: 1 }],
  ]);

  const octokit = {
    users: { getAuthenticated: async () => ({ data: { login: 'an-actor' } }) },
  } as unknown as Octokit;

  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = SYNTHETIC.classic;
  try {
    const artifact = await buildPlanArtifact(
      octokit,
      'octoform.yml',
      { 'octoform.yml': 'a-digest' },
      [scope],
      results,
      new Map([['account', 1]]),
      '0.0.0-test',
    );
    const serialized = JSON.stringify(artifact);
    assert.equal(serialized.includes(SYNTHETIC.classic), false, 'the plan carried the token');
    assert.equal(serialized.includes('ghp_'), false, 'the plan carried something token-shaped');
    for (const change of changes) {
      assert.equal(formatChange(change).includes(SYNTHETIC.classic), false);
    }
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});
