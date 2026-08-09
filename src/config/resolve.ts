import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { parse } from 'yaml';
import type { AuditConfig, ClassifyConfig, Config, PolicySet, RepoState } from './types.js';

export class ConfigError extends Error {}

/**
 * A configuration file before it is known to be complete. Only the file the
 * caller actually asked for has to declare `owner`; a file meant to be
 * imported — a shared library of `types` and `defaults` — usually does not,
 * and is only ever valid once merged into something that does.
 */
type Draft = Omit<Config, 'owner'> & { owner?: string };

export function loadConfig(path: string): Config {
  const draft = resolveFile(resolvePath(path), []);
  if (!draft.owner) {
    throw new ConfigError(
      `${path} must declare an "owner" (a GitHub organisation or personal account), ` +
        `either directly or through one of its imports.`,
    );
  }

  const config = draft as Config;
  validateTypeReferences(config, path);
  return config;
}

/** Read, parse and fold in this file's own imports, most general first. */
function resolveFile(absolutePath: string, stack: string[]): Draft {
  if (stack.includes(absolutePath)) {
    throw new ConfigError(`Circular import:\n  ${[...stack, absolutePath].join('\n  imports -> ')}`);
  }
  const nextStack = [...stack, absolutePath];

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read configuration file: ${absolutePath}`);
  }

  const parsed = parse(raw) as Draft | null;
  if (parsed === null || typeof parsed !== 'object') {
    throw new ConfigError(`${absolutePath} is empty or is not a YAML mapping`);
  }

  const { imports = [], ...ownContent } = parsed;

  let merged: Draft | undefined;
  for (const importPath of imports) {
    const importedAbsolute = resolvePath(dirname(absolutePath), importPath);
    const imported = resolveFile(importedAbsolute, nextStack);
    merged = merged ? mergeConfig(merged, imported) : imported;
  }

  return merged ? mergeConfig(merged, ownContent) : ownContent;
}

function validateTypeReferences(config: Config, path: string): void {
  const knownTypes = Object.keys(config.types ?? {});
  for (const [name, entry] of Object.entries(config.repos ?? {})) {
    if (entry?.type && knownTypes.length > 0 && !knownTypes.includes(entry.type)) {
      throw new ConfigError(
        `repos.${name}.type is "${entry.type}", which is not declared under "types" in ${path} ` +
          `or its imports (known: ${knownTypes.join(', ')})`,
      );
    }
  }
}

/**
 * Fold `over` on top of `base`. `over` is the more specific layer: later
 * imports beat earlier ones, and a file's own content beats everything it
 * imports.
 */
function mergeConfig(base: Draft, over: Draft): Draft {
  if (base.owner && over.owner && base.owner !== over.owner) {
    throw new ConfigError(
      `Conflicting "owner": "${base.owner}" vs "${over.owner}". A file meant to be shared across ` +
        `owners should not declare "owner" itself — only the file that is actually run should.`,
    );
  }

  return {
    owner: over.owner ?? base.owner,
    classify: mergeClassify(base.classify, over.classify),
    audit: mergeAudit(base.audit, over.audit),
    defaults: base.defaults || over.defaults ? mergeLayer(base.defaults ?? {}, over.defaults ?? {}) : undefined,
    types: mergeNamedPolicies(base.types, over.types),
    repos: mergeNamedPolicies(base.repos, over.repos),
    exclude: mergeExclude(base.exclude, over.exclude),
  };
}

function mergeClassify(base?: ClassifyConfig, over?: ClassifyConfig): ClassifyConfig | undefined {
  if (!base && !over) return undefined;
  const rules = [...(over?.rules ?? []), ...(base?.rules ?? [])];
  return {
    property: over?.property ?? base?.property,
    ...(rules.length > 0 ? { rules } : {}),
  };
}

/**
 * Shallow: a key present in `over` replaces base's whole value for that key,
 * it is not merged one level deeper. `require_description: { visibility: ... }`
 * is small enough that "the narrower file means all of it" is the simpler and
 * more predictable rule.
 */
function mergeAudit(base?: AuditConfig, over?: AuditConfig): AuditConfig | undefined {
  if (!base && !over) return undefined;
  return { ...base, ...over };
}

function mergeExclude(
  base?: { repos?: string[] },
  over?: { repos?: string[] },
): { repos?: string[] } | undefined {
  if (!base && !over) return undefined;
  const repos: string[] = [];
  const seen = new Set<string>();
  for (const name of [...(base?.repos ?? []), ...(over?.repos ?? [])]) {
    if (seen.has(name)) continue;
    seen.add(name);
    repos.push(name);
  }
  return { repos };
}

function mergeNamedPolicies<T extends PolicySet>(
  base: Record<string, T> | undefined,
  over: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!base && !over) return undefined;
  const out: Record<string, T> = { ...(base ?? {}) };
  for (const [name, value] of Object.entries(over ?? {})) {
    const existing = out[name];
    out[name] = existing ? mergeLayer(existing, value) : value;
  }
  return out;
}

const GROUPS = ['features', 'merge', 'security', 'repo', 'default_branch'] as const;
const LIST_KEYS = ['ensure_branches', 'rulesets', 'environments', 'files'] as const;
const HANDLED = new Set<string>(['manage', ...GROUPS, ...LIST_KEYS]);

/**
 * Merge one policy layer on top of another, key by key.
 *
 * `null` is preserved rather than dropped: it is how a narrower layer says
 * "stop managing this", and it has to survive the merge in order to override
 * a `true`/`false` inherited from a wider one. Callers strip it at the end via
 * `isManaged`.
 *
 * Doubles as the merge step for `repos.<name>` and `types.<name>` entries
 * when folding imports together, which is why anything not otherwise handled
 * — the `type` field on a `repos.<name>` entry, for instance — is copied over
 * as a plain scalar rather than ignored.
 */
function mergeLayer<T extends PolicySet>(base: T, over: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  const overRecord = over as Record<string, unknown>;

  if (overRecord.manage !== undefined) out.manage = overRecord.manage;

  for (const group of GROUPS) {
    const overGroup = overRecord[group] as Record<string, unknown> | undefined;
    if (overGroup === undefined) continue;
    const baseGroup = (out[group] as Record<string, unknown> | undefined) ?? {};
    out[group] = { ...baseGroup, ...overGroup };
  }

  for (const key of LIST_KEYS) {
    if (overRecord[key] !== undefined) out[key] = overRecord[key];
  }

  for (const [key, value] of Object.entries(overRecord)) {
    if (HANDLED.has(key) || value === undefined) continue;
    out[key] = value;
  }

  return out as T;
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
 * an organisation whose plan does not offer custom properties at all, and is
 * the only source available on a personal account, which has no custom
 * properties API to read from.
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
