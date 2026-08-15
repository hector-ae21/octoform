/**
 * Deterministic input generation for the property tests.
 *
 * There is no property-testing library here on purpose. The properties worth
 * checking are about *valid* octoform configurations, and a general-purpose
 * generator would have to be taught the whole schema before it produced one.
 * A seeded generator costs less and keeps the part that actually matters when
 * a property fails in CI: the seed is printed with the failure, and replaying
 * it reproduces the exact input.
 */

import { stringify } from 'yaml';
import { UNREADABLE } from '../src/config/sentinels.js';
import type { RepoDetail, SettingValue } from '../src/types/index.js';

/** A reproducible source of choices, seeded once per generated case. */
export interface Random {
  /** The seed this source was built from, printed with any failure. */
  readonly seed: number;
  int(bound: number): number;
  bool(): boolean;
  pick<T>(values: readonly T[]): T;
  /** An arbitrary subset, in the order the input declared. */
  subset<T>(values: readonly T[]): T[];
}

/** Build a `Random` from a seed, using mulberry32. */
export function randomFor(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => Math.floor(next() * bound);
  return {
    seed,
    int,
    bool: () => next() < 0.5,
    pick: <T>(values: readonly T[]): T => values[int(values.length)] as T,
    subset: <T>(values: readonly T[]): T[] => values.filter(() => next() < 0.5),
  };
}

const FEATURE_KEYS = ['issues', 'wiki', 'projects', 'discussions'] as const;
const MERGE_KEYS = [
  'allow_squash',
  'allow_merge_commit',
  'allow_rebase',
  'allow_auto_merge',
  'delete_branch_on_merge',
] as const;
const SECURITY_KEYS = [
  'vulnerability_alerts',
  'automated_security_fixes',
  'secret_scanning',
] as const;
const TOPICS = ['alpha', 'beta', 'gamma', 'delta'] as const;

/** Every settings key the generated policies can possibly ask about. */
export const OBSERVABLE_KEYS: readonly string[] = [
  ...FEATURE_KEYS.map((key) => `features.${key}`),
  ...MERGE_KEYS.map((key) => `merge.${key}`),
  ...SECURITY_KEYS.map((key) => `security.${key}`),
  'repo.description',
  'repo.topics',
];

/** One level of the precedence chain, as an author would write it. */
export interface GeneratedLayer {
  manage?: boolean;
  policies?: string[];
  features?: Record<string, boolean | null>;
  merge?: Record<string, boolean | null>;
  security?: Record<string, boolean | null>;
  repo?: { description?: string | null; topics?: string[] };
}

/** A repository entry, which is a layer that may also name its type. */
export type GeneratedRepoEntry = GeneratedLayer & { type?: string };

/** One owner block of a generated configuration. */
export interface GeneratedOwner {
  owner: string;
  defaults?: GeneratedLayer;
  types?: Record<string, GeneratedLayer>;
  repos?: Record<string, GeneratedRepoEntry>;
  exclude?: { repos: string[] };
}

/** A whole generated configuration, before it is rendered to YAML. */
export interface GeneratedConfig {
  policies: Record<string, GeneratedLayer>;
  owners: GeneratedOwner[];
  /**
   * Repository names shared by every owner, so that generated cases routinely
   * contain the same name under two accounts — the confusion this release has
   * to be safe against.
   */
  repoNames: string[];
  types: string[];
}

/** Generate a configuration whose every part is a valid octoform document. */
export function generateConfig(random: Random): GeneratedConfig {
  const policyNames = ['baseline', 'strict', 'relaxed'].slice(0, random.int(4));
  const policies: Record<string, GeneratedLayer> = {};
  for (const name of policyNames) policies[name] = generateLayer(random, []);

  const types = ['lib', 'service'].slice(0, random.int(3));
  const repoNames = ['one', 'two', 'three'].slice(0, 1 + random.int(3));
  const owners: GeneratedOwner[] = [];

  for (let index = 0; index < 1 + random.int(3); index += 1) {
    const owner: GeneratedOwner = { owner: `account-${index}` };
    if (random.int(4) > 0) owner.defaults = generateLayer(random, policyNames);
    if (types.length > 0 && random.bool()) {
      owner.types = Object.fromEntries(
        types.map((type) => [type, generateLayer(random, policyNames)]),
      );
    }
    const entries = random.subset(repoNames);
    if (entries.length > 0) {
      owner.repos = Object.fromEntries(
        entries.map((name) => {
          const entry: GeneratedRepoEntry = generateLayer(random, policyNames);
          if (types.length > 0 && random.bool()) entry.type = random.pick(types);
          return [name, entry];
        }),
      );
    }
    const excluded = random.subset(repoNames).slice(0, 1);
    if (excluded.length > 0) owner.exclude = { repos: excluded };
    owners.push(owner);
  }

  return { policies, owners, repoNames, types };
}

function generateLayer(random: Random, policyNames: readonly string[]): GeneratedLayer {
  const layer: GeneratedLayer = {};

  if (policyNames.length > 0 && random.int(3) === 0) {
    const referenced = random.subset(policyNames);
    if (referenced.length > 0) layer.policies = referenced;
  }
  if (random.int(8) === 0) layer.manage = false;

  const features = generateToggles(random, FEATURE_KEYS);
  if (features) layer.features = features;
  const merge = generateToggles(random, MERGE_KEYS);
  if (merge) layer.merge = merge;
  const security = generateToggles(random, SECURITY_KEYS);
  if (security) layer.security = security;

  const repo: GeneratedLayer['repo'] = {};
  if (random.int(3) === 0)
    repo.description = random.int(6) === 0 ? null : `described ${random.int(3)}`;
  if (random.int(4) === 0) repo.topics = random.subset(TOPICS);
  if (Object.keys(repo).length > 0) layer.repo = repo;

  return layer;
}

function generateToggles(
  random: Random,
  keys: readonly string[],
): Record<string, boolean | null> | undefined {
  const chosen = random.subset(keys);
  if (chosen.length === 0) return undefined;
  return Object.fromEntries(chosen.map((key) => [key, random.int(6) === 0 ? null : random.bool()]));
}

/** Render a generated configuration as the YAML an author would have written. */
export function renderConfig(config: GeneratedConfig, owners = config.owners): string {
  const document: Record<string, unknown> = { version: 1 };
  if (Object.keys(config.policies).length > 0) document.policies = config.policies;
  document.owners = Object.fromEntries(owners.map(({ owner, ...block }) => [owner, block]));
  return stringify(document);
}

/**
 * Observed state for one repository.
 *
 * A settings map is not uniformly populated: a key can be absent, or read back
 * as `UNREADABLE`. Both are states the planner has to keep distinct from a
 * real value, so the generator produces them rather than only the happy case.
 */
export function generateRepo(random: Random, name: string, types: readonly string[]): RepoDetail {
  const settings: Record<string, SettingValue> = {};
  for (const key of OBSERVABLE_KEYS) {
    const roll = random.int(12);
    if (roll === 0) continue;
    if (roll === 1) {
      settings[key] = UNREADABLE;
      continue;
    }
    if (key === 'repo.description') settings[key] = random.bool() ? 'described 0' : null;
    else if (key === 'repo.topics') settings[key] = random.subset(TOPICS);
    else settings[key] = random.bool();
  }

  const repo: RepoDetail = {
    name,
    visibility: random.pick(['public', 'private'] as const),
    archived: random.int(8) === 0,
    default_branch: 'main',
    description: (settings['repo.description'] as string | null | undefined) ?? null,
    homepage: null,
    topics: (settings['repo.topics'] as string[] | undefined) ?? [],
    // Occasionally missing, so a setting that needs it is generated blocked too.
    ...(random.int(12) === 0 ? {} : { nodeId: `R_${name}` }),
    settings,
  };
  if (types.length > 0 && random.bool()) repo.type = random.pick(types);
  return repo;
}
