/**
 * Properties that either hold for every input or are not properties.
 *
 * Each case runs over generated configurations and generated observed state.
 * A failure prints the seed it was generated from; re-running the same seed
 * reproduces the exact input.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isExcluded, loadConfig, resolvePolicy } from '../src/config/resolve.js';
import { selectOwners } from '../src/config/selectors.js';
import { capability } from '../src/github/capabilities.js';
import { planRepo } from '../src/core/plan.js';
import {
  generateConfig,
  generateRepo,
  randomFor,
  renderConfig,
  type GeneratedConfig,
  type Random,
} from './generators.js';
import type {
  Change,
  OwnerScope,
  RepoDetail,
  ResolvedConfig,
  SettingValue,
} from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'octoform-properties-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS = {
  rulesetCapability: capability('supported', 'assumed in this suite', 'permission'),
  ownerKind: 'org' as const,
};

/** How many generated cases each property runs over. */
const CASES = 60;

let counter = 0;

function writeConfig(yaml: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `generated-${counter++}.yml`);
  writeFileSync(path, yaml, 'utf8');
  return path;
}

/** Run `body` over generated cases, reporting the seed that reproduces a failure. */
function forEachCase(body: (random: Random) => void): void {
  for (let seed = 1; seed <= CASES; seed += 1) {
    try {
      body(randomFor(seed));
    } catch (error) {
      (error as Error).message = `seed ${seed}: ${(error as Error).message}`;
      throw error;
    }
  }
}

/** Observed repositories per owner, so no two owners share one object. */
type States = ReadonlyMap<string, RepoDetail[]>;

/** A generated configuration, loaded, plus the state it is planned against. */
interface Case {
  generated: GeneratedConfig;
  config: ResolvedConfig;
  states: States;
  path: string;
}

function generateCase(random: Random): Case {
  const generated = generateConfig(random);
  const path = writeConfig(renderConfig(generated));
  return { generated, config: loadConfig(path), states: generateStates(random, generated), path };
}

function generateStates(random: Random, generated: GeneratedConfig): States {
  return new Map(
    generated.owners.map((owner) => [
      owner.owner,
      generated.repoNames.map((name) => generateRepo(random, name, generated.types)),
    ]),
  );
}

function planAll(config: ResolvedConfig, states: States): Change[] {
  const changes: Change[] = [];
  for (const scope of config.owners) {
    for (const repo of states.get(scope.owner) ?? []) {
      if (isExcluded(scope, repo.name)) continue;
      changes.push(...planRepo(scope.owner, repo, resolvePolicy(scope, repo), OPTIONS));
    }
  }
  return changes;
}

test('resolution and planning are deterministic for the same inputs', () => {
  forEachCase((random) => {
    const { config, states, path } = generateCase(random);
    assert.deepEqual(loadConfig(path), config, 'the same file resolved differently twice');
    assert.deepEqual(
      planAll(config, states),
      planAll(config, states),
      'the same inputs planned differently twice',
    );
  });
});

test('planning is ordered, not merely repeatable as a set', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    assert.deepEqual(
      planAll(config, states).map((change) => change.id),
      planAll(config, states).map((change) => change.id),
    );
  });
});

test('regrouping imports without reordering them does not change the result', () => {
  forEachCase((random) => {
    const generated = generateConfig(random);
    const first = writeConfig(renderConfig(generated, generated.owners.slice(0, 1)));
    const second = writeConfig(renderConfig(generated, generated.owners.slice(1)));

    const direct = writeConfig(`version: 1\nimports: ["${base(first)}", "${base(second)}"]\n`);
    const bundle = writeConfig(`version: 1\nimports: ["${base(first)}", "${base(second)}"]\n`);
    const throughBundle = writeConfig(`version: 1\nimports: ["${base(bundle)}"]\n`);

    assert.deepEqual(loadConfig(throughBundle).owners, loadConfig(direct).owners);
  });
});

test('a policy that only groups other policies equals referencing them directly', () => {
  const path = writeConfig(`
version: 1
policies:
  first: { features: { issues: true, wiki: true } }
  second: { features: { wiki: false } }
  both: { policies: [first, second] }
owners:
  direct:
    defaults:
      policies: [first, second]
  grouped:
    defaults:
      policies: [both]
`);

  const config = loadConfig(path);
  const repo = generateRepo(randomFor(1), 'thing', []);
  assert.deepEqual(
    resolvePolicy(scopeFor(config, 'direct'), repo),
    resolvePolicy(scopeFor(config, 'grouped'), repo),
  );
});

test('an owner selector only ever narrows the operations a run produces', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    const everything = new Set(planAll(config, states).map((change) => change.id));

    const requested = random.subset(config.owners.map((owner) => owner.owner));
    const narrowed = planAll({ ...config, owners: selectOwners(config, requested) }, states);

    for (const change of narrowed) {
      assert.ok(everything.has(change.id), `${change.id} appeared only under a selector`);
    }
    assert.ok(narrowed.length <= everything.size);
  });
});

test('an owner selector never reaches an owner it did not name', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    const requested = random.subset(config.owners.map((owner) => owner.owner));
    if (requested.length === 0) return;

    const selected = new Set(requested);
    for (const change of planAll({ ...config, owners: selectOwners(config, requested) }, states)) {
      assert.ok(selected.has(change.owner), `${change.owner} was planned but never selected`);
    }
  });
});

test('an empty configuration plans nothing, whatever the observed state is', () => {
  forEachCase((random) => {
    const generated = generateConfig(random);
    const empty = writeConfig(
      renderConfig(
        { ...generated, policies: {} },
        generated.owners.map(({ owner }) => ({ owner })),
      ),
    );
    assert.deepEqual(planAll(loadConfig(empty), generateStates(random, generated)), []);
  });
});

test('re-planning after applying every change leaves only the blocked ones', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    const applied = new Map(
      [...states].map(([owner, repos]) => [
        owner,
        repos.map((repo) => ({ ...repo, settings: { ...repo.settings } })),
      ]),
    );

    const changes = planAll(config, applied);
    for (const change of changes) {
      if (change.blocked) continue;
      const target = applied.get(change.owner)?.find((repo) => repo.name === change.repo);
      if (target) target.settings[change.key] = change.to as SettingValue;
    }

    assert.deepEqual(
      planAll(config, applied).map((change) => change.id),
      changes.filter((change) => change.blocked).map((change) => change.id),
      'a settled repository still had unblocked work to do',
    );
  });
});

test('removing one owner never changes what another owner plans', () => {
  forEachCase((random) => {
    const { generated, config, states } = generateCase(random);
    if (config.owners.length < 2) return;

    const dropped = random.pick(config.owners).owner;
    const kept = writeConfig(
      renderConfig(
        generated,
        generated.owners.filter((owner) => owner.owner !== dropped),
      ),
    );

    assert.deepEqual(
      planAll(loadConfig(kept), states),
      planAll(config, states).filter((change) => change.owner !== dropped),
      `dropping ${dropped} changed another owner's plan`,
    );
  });
});

test('an owner that fails to observe leaves every other owner untouched', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    if (config.owners.length < 2) return;

    const unreadable = random.pick(config.owners).owner;
    const partial = new Map([...states].map(([owner, repos]) => [owner, repos]));
    partial.set(unreadable, []);

    assert.deepEqual(
      planAll(config, partial),
      planAll(config, states).filter((change) => change.owner !== unreadable),
      `an unreadable ${unreadable} influenced another owner`,
    );
  });
});

test('two owners sharing a repository name each plan against their own policy', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    if (config.owners.length < 2) return;

    for (const change of planAll(config, states)) {
      const scope = scopeFor(config, change.owner);
      const repo = states.get(change.owner)?.find((candidate) => candidate.name === change.repo);
      assert.ok(repo, `${change.repo} was never observed for ${change.owner}`);
      const own = planRepo(scope.owner, repo, resolvePolicy(scope, repo), OPTIONS);
      assert.ok(
        own.some((candidate) => candidate.id === change.id),
        `${change.id} does not follow from ${change.owner}'s own policy`,
      );
    }
  });
});

test('every operation identifier is unique within a run and names its owner', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    const seen = new Set<string>();
    for (const change of planAll(config, states)) {
      assert.equal(seen.has(change.id), false, `${change.id} was planned twice`);
      seen.add(change.id);
      assert.ok(change.id.startsWith(`${change.owner}/`), `${change.id} does not name its owner`);
    }
  });
});

test('an excluded repository produces no operation for the owner that excluded it', () => {
  forEachCase((random) => {
    const { config, states } = generateCase(random);
    for (const change of planAll(config, states)) {
      assert.equal(
        isExcluded(scopeFor(config, change.owner), change.repo ?? ''),
        false,
        `${change.repo} is excluded for ${change.owner} but was planned anyway`,
      );
    }
  });
});

function base(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() as string;
}

function scopeFor(config: ResolvedConfig, owner: string): OwnerScope {
  const found = config.owners.find((candidate) => candidate.owner === owner);
  assert.ok(found, `no scope for ${owner}`);
  return found;
}
