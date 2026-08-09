import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Config, PolicySet, RepoState } from './types.js';

export class ConfigError extends Error {}

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read configuration file: ${path}`);
  }

  const parsed = parse(raw) as Config | null;
  if (parsed === null || typeof parsed !== 'object') {
    throw new ConfigError(`${path} is empty or is not a YAML mapping`);
  }
  if (!parsed.org) {
    throw new ConfigError(`${path} must declare an "org"`);
  }

  const knownTypes = Object.keys(parsed.types ?? {});
  for (const [name, entry] of Object.entries(parsed.repos ?? {})) {
    if (entry?.type && knownTypes.length > 0 && !knownTypes.includes(entry.type)) {
      throw new ConfigError(
        `repos.${name}.type is "${entry.type}", which is not declared under "types" ` +
          `(known: ${knownTypes.join(', ')})`,
      );
    }
  }

  return parsed;
}

const GROUPS = [
  'features',
  'merge',
  'security',
  'repo',
  'default_branch',
] as const;

/**
 * Merge one policy layer on top of another, key by key.
 *
 * `null` is preserved rather than dropped: it is how a narrower layer says
 * "stop managing this", and it has to survive the merge in order to override
 * a `true`/`false` inherited from a wider one. Callers strip it at the end via
 * `isManaged`.
 */
function mergeLayer(base: PolicySet, over: PolicySet): PolicySet {
  const out: PolicySet = { ...base };

  if (over.manage !== undefined) out.manage = over.manage;

  for (const group of GROUPS) {
    const overGroup = over[group] as Record<string, unknown> | undefined;
    if (overGroup === undefined) continue;
    const baseGroup = (base[group] as Record<string, unknown> | undefined) ?? {};
    (out as Record<string, unknown>)[group] = { ...baseGroup, ...overGroup };
  }

  // List-valued policies replace rather than merge. Concatenating them would
  // make it impossible for a repository to opt out of a ruleset its type
  // declares, which is exactly the escape hatch the precedence chain is for.
  if (over.ensure_branches !== undefined) out.ensure_branches = over.ensure_branches;
  if (over.rulesets !== undefined) out.rulesets = over.rulesets;
  if (over.environments !== undefined) out.environments = over.environments;
  if (over.files !== undefined) out.files = over.files;

  return out;
}

/**
 * Resolve the policy that applies to one repository.
 *
 * Precedence, widest to narrowest: defaults -> types.<type> -> repos.<name>.
 * A repository with no type simply skips that middle layer.
 */
export function resolvePolicy(config: Config, repo: RepoState): PolicySet {
  let policy: PolicySet = config.defaults ? mergeLayer({}, config.defaults) : {};

  const type = repoType(config, repo);
  if (type && config.types?.[type]) {
    policy = mergeLayer(policy, config.types[type]);
  }

  const entry = config.repos?.[repo.name];
  if (entry) {
    const { type: _declaredType, ...rest } = entry;
    policy = mergeLayer(policy, rest);
  }

  return policy;
}

/**
 * The type recorded for a repository. The custom property is the usual source,
 * but a type declared in the configuration file wins: it lets the tool work on
 * an organisation whose plan does not offer custom properties at all.
 */
export function repoType(config: Config, repo: RepoState): string | undefined {
  return config.repos?.[repo.name]?.type ?? repo.type;
}

export function isExcluded(config: Config, name: string): boolean {
  return (config.exclude?.repos ?? []).includes(name);
}

/** True when a value is being managed, i.e. it is neither absent nor cancelled. */
export function isManaged<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}
