/**
 * Every way a saved plan can be refused, and the one way it is accepted.
 *
 * Verification takes the identities it checks against as data rather than a
 * client, so all of this runs offline: each rejection path is a real assertion
 * instead of something only a live run would ever reach.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  DEFAULT_PLAN_EXPIRY_MINUTES,
  buildPlanArtifact,
  readPlanArtifact,
  verifyPlanArtifact,
} from '../src/config/plan-artifact.js';
import { ConfigError, loadConfigWithSources } from '../src/config/resolve.js';
import { planRepo } from '../src/core/plan.js';
import { capability } from '../src/github/capabilities.js';
import type { PlanArtifact, PlanIdentity, PlanResult, RepoDetail } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-plan-artifact-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS = {
  rulesetCapability: capability('supported', 'assumed in this suite', 'permission'),
};

const ACTOR = 'an-actor';
const CONFIG = `
version: 1
owners:
  account:
    defaults:
      features: { issues: true }
`;

let counter = 0;

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

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

/** A saved plan for one owner, and the identities that make it valid. */
function saved(content = CONFIG): {
  artifact: PlanArtifact;
  identity: PlanIdentity;
  path: string;
} {
  const path = write(`config-${counter++}.yml`, content);
  const { config, sourceDigests } = loadConfigWithSources(path);
  const changes = planRepo('account', observed, { features: { issues: true } }, OPTIONS);
  const results = new Map<string, PlanResult>([
    ['account', { changes, blocked: [], errors: [], scanned: 1 }],
  ]);

  const artifact = buildPlanArtifact(
    ACTOR,
    path,
    sourceDigests,
    config.owners,
    results,
    new Map([['account', 7]]),
    '0.0.0-test',
  );
  return { artifact, identity: { actor: ACTOR, ownerIds: new Map([['account', 7]]) }, path };
}

test('a plan built and checked against the same world is accepted', () => {
  const { artifact, identity } = saved();
  assert.deepEqual(verifyPlanArtifact(artifact, identity), { valid: true });
  assert.equal(artifact.actor, ACTOR);
  assert.equal(artifact.owners[0]?.id, 7);
  assert.equal(artifact.owners[0]?.changes.length, 1);
});

test('a plan expires, and the default window is the documented one', () => {
  const { artifact, identity } = saved();
  const window = Date.parse(artifact.expiresAt) - Date.parse(artifact.observedAt);
  assert.equal(window, DEFAULT_PLAN_EXPIRY_MINUTES * 60_000);

  const expired = { ...artifact, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.deepEqual(verifyPlanArtifact(expired, identity), {
    valid: false,
    reason: 'expired',
    detail: `the plan expired at ${expired.expiresAt}`,
  });
});

test('a plan written against another schema version is refused', () => {
  const { artifact, identity } = saved();
  const fromTheFuture = { ...artifact, schemaVersion: 2 } as unknown as PlanArtifact;
  const result = verifyPlanArtifact(fromTheFuture, identity);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'unsupported-schema-version');
});

test('a plan produced by another actor is refused, naming both identities', () => {
  const { artifact, identity } = saved();
  const result = verifyPlanArtifact(artifact, { ...identity, actor: 'somebody-else' });
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'actor-mismatch');
  assert.match(String(result.valid === false && result.detail), /an-actor[\s\S]*somebody-else/);
});

test('a token that exposes no login is refused rather than treated as a match', () => {
  const { artifact, identity } = saved();
  const result = verifyPlanArtifact(artifact, { ...identity, actor: undefined });
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'actor-mismatch');
});

test('an owner that now resolves to a different account is refused', () => {
  const { artifact, identity } = saved();
  const result = verifyPlanArtifact(artifact, {
    ...identity,
    ownerIds: new Map([['account', 99]]),
  });
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'owner-identity-mismatch');
});

test('an owner that cannot be resolved at all is refused, not skipped', () => {
  const { artifact, identity } = saved();
  const result = verifyPlanArtifact(artifact, { ...identity, ownerIds: new Map() });
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'owner-identity-mismatch');
});

test('a source file edited since the plan was made is refused, naming the file', () => {
  const { artifact, identity, path } = saved();
  writeFileSync(path, `${CONFIG}\n# a comment is still a change to the file\n`, 'utf8');

  const result = verifyPlanArtifact(artifact, identity);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'source-digest-mismatch');
  assert.ok(String(result.valid === false && result.detail).includes(path));
});

test('a configuration that no longer resolves the same way is refused', () => {
  const { artifact, identity } = saved();
  const tampered = { ...artifact, configDigest: 'not-the-digest-this-configuration-produces' };

  const result = verifyPlanArtifact(tampered, identity);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'config-digest-mismatch');
});

test('a configuration that has since become unreadable is refused, not ignored', () => {
  const { artifact, identity, path } = saved();
  rmSync(path);

  const result = verifyPlanArtifact(artifact, identity);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'source-digest-mismatch');
});

test('building a plan without an authenticated actor fails rather than recording none', () => {
  assert.throws(
    () => buildPlanArtifact(undefined, 'octoform.yml', {}, [], new Map(), new Map(), '0.0.0-test'),
    ConfigError,
  );
});

test('a plan file that is missing or is not JSON fails with the path', () => {
  assert.throws(() => readPlanArtifact(join(dir, 'no-such-plan.json')), /Cannot read plan file/);
  const notJson = write('not-a-plan.json', 'this is not JSON\n');
  assert.throws(() => readPlanArtifact(notJson), /is not valid JSON/);
});
