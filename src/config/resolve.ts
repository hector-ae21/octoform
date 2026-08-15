import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { parse } from 'yaml';
import { CONFIG } from './shape.js';
import { sourceDigest } from './digest.js';
import { findCredentialShapedValue } from './credential-scan.js';
import { ownerLoginProblem } from './identifier.js';
import type {
  AuditConfig,
  ClassifyConfig,
  Config,
  ConfigVersion,
  ExcludeConfig,
  Field,
  ObjectShape,
  OwnerBlock,
  OwnerScope,
  PolicySet,
  RepoState,
  ResolvedConfig,
  ValueShape,
} from '../types/index.js';

export class ConfigError extends Error {}

/** The only configuration contract version this release accepts. */
export const CONFIG_VERSION: ConfigVersion = 1;

/** The subset of a file that layers onto another file's copy of the same. */
type OwnerFields = Pick<Config, 'classify' | 'audit' | 'defaults' | 'types' | 'repos' | 'exclude'>;

/**
 * Load a configuration file and normalize it to one scope per owner.
 *
 * The file may be written in either accepted shape. Callers never see which:
 * a single-owner file resolves to exactly one scope whose meaning is unchanged
 * from earlier releases.
 */
export function loadConfig(path: string): ResolvedConfig {
  const draft = resolveFile(resolvePath(path), [], new Map());
  return normalize(draft, path);
}

/**
 * Load a configuration the same way {@link loadConfig} does, and also return
 * a digest of every file that contributed to it — the root file and every
 * import, recursively, keyed by absolute path.
 *
 * Exists for the saved-plan artifact, which has to prove later that none of
 * those files changed since the plan was made. An ordinary load has no use
 * for this and stays on the cheaper, simpler {@link loadConfig}.
 */
export function loadConfigWithSources(path: string): {
  config: ResolvedConfig;
  sourceDigests: Record<string, string>;
} {
  const sources = new Map<string, string>();
  const draft = resolveFile(resolvePath(path), [], sources);
  return { config: normalize(draft, path), sourceDigests: Object.fromEntries(sources) };
}

/** Read, parse, validate and fold in this file's own imports, most general first. */
function resolveFile(absolutePath: string, stack: string[], sources: Map<string, string>): Config {
  if (stack.includes(absolutePath)) {
    throw new ConfigError(
      `Circular import:\n  ${[...stack, absolutePath].join('\n  imports -> ')}`,
    );
  }
  const nextStack = [...stack, absolutePath];

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read configuration file: ${absolutePath}`);
  }
  sources.set(absolutePath, sourceDigest(raw));

  const parsed: unknown = parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${absolutePath} is empty or is not a YAML mapping`);
  }

  const credentialPath = findCredentialShapedValue(parsed);
  if (credentialPath) {
    throw new ConfigError(
      `${absolutePath}: "${credentialPath}" looks like a GitHub token and was rejected. ` +
        `Configuration files must never contain credential values — pass a token to octoform ` +
        `directly, or through GITHUB_TOKEN/GH_TOKEN, instead.`,
    );
  }

  validateObject(parsed, CONFIG, absolutePath, '');
  const file = parsed as Config;
  validateVersion(file, absolutePath);

  const { imports = [], ...ownContent } = file;
  absolutizeFileSources(ownContent, dirname(absolutePath));

  let merged: Config | undefined;
  for (const importPath of imports) {
    const importedAbsolute = resolvePath(dirname(absolutePath), importPath);
    const imported = resolveFile(importedAbsolute, nextStack, sources);
    merged = merged ? mergeConfig(merged, imported) : imported;
  }

  return merged ? mergeConfig(merged, ownContent) : ownContent;
}

function validateVersion(file: Config, path: string): void {
  if (file.version === undefined) return;
  if (file.version !== CONFIG_VERSION) {
    throw new ConfigError(
      `${path}: version is ${JSON.stringify(file.version)}, but this release of octoform ` +
        `only accepts version ${CONFIG_VERSION}. Upgrade octoform, or write the file ` +
        `against version ${CONFIG_VERSION}.`,
    );
  }
}

/**
 * Reject a key the schema does not declare, naming the file and the path that
 * declared it.
 *
 * Accepting an unrecognised key silently is the failure mode that costs the
 * most to diagnose: the file looks like it asks for something, the tool reports
 * no changes, and nothing says the two facts are related.
 */
function validateObject(value: unknown, shape: ObjectShape, file: string, path: string): void {
  if (!isMapping(value)) {
    throw new ConfigError(`${file}: ${describe(path)} must be a mapping`);
  }
  for (const [key, child] of Object.entries(value)) {
    const field: Field | undefined = shape.fields[key];
    if (!field) {
      throw new ConfigError(
        `${file}: unknown key "${key}" in ${describe(path)}.${suggestion(key, shape)}`,
      );
    }
    if (child === null || child === undefined) continue;
    validateValue(child, field.shape, file, path ? `${path}.${key}` : key);
  }
}

function validateValue(value: unknown, shape: ValueShape, file: string, path: string): void {
  switch (shape.kind) {
    case 'any':
      return;
    case 'scalar':
      if (isMapping(value) || Array.isArray(value)) {
        throw new ConfigError(
          `${file}: ${describe(path)} must be a single value, not a collection`,
        );
      }
      return;
    case 'scalar-list':
      requireList(value, file, path);
      for (const [index, item] of (value as unknown[]).entries()) {
        if (isMapping(item) || Array.isArray(item)) {
          throw new ConfigError(`${file}: ${describe(`${path}[${index}]`)} must be a single value`);
        }
      }
      return;
    case 'object':
      validateObject(value, shape.of(), file, path);
      return;
    case 'object-list':
      requireList(value, file, path);
      for (const [index, item] of (value as unknown[]).entries()) {
        validateObject(item, shape.of(), file, `${path}[${index}]`);
      }
      return;
    case 'map':
      if (!isMapping(value)) {
        throw new ConfigError(`${file}: ${describe(path)} must be a mapping`);
      }
      for (const [key, item] of Object.entries(value)) {
        if (item === null || item === undefined) continue;
        validateValue(item, shape.of(), file, `${path}.${key}`);
      }
      return;
  }
}

function requireList(value: unknown, file: string, path: string): void {
  if (!Array.isArray(value)) throw new ConfigError(`${file}: ${describe(path)} must be a list`);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(path: string): string {
  return path === '' ? 'the root of the file' : `"${path}"`;
}

/** Name the declared key a misspelling is closest to, when one is close enough. */
function suggestion(key: string, shape: ObjectShape): string {
  const candidates = Object.keys(shape.fields)
    .map((candidate) => ({ candidate, distance: editDistance(key, candidate) }))
    .filter(({ candidate, distance }) => distance <= Math.max(2, Math.floor(candidate.length / 4)))
    .sort((left, right) => left.distance - right.distance);
  const best = candidates[0];
  return best ? ` Did you mean "${best.candidate}"?` : '';
}

function editDistance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/**
 * Rewrite every `files[].from` to an absolute path, resolved against the file
 * that declared it.
 *
 * A shared preset that seeds `files/dependabot/npm.yml` means a path next to
 * itself, not next to whichever configuration happens to import it — the same
 * rule `imports` already follows. Resolving it here, once, is what lets a
 * preset be imported from anywhere without its file references breaking, and
 * means nothing downstream has to remember which file a policy came from.
 */
function absolutizeFileSources(draft: Config, dir: string): void {
  const blocks: OwnerFields[] = [draft, ...Object.values(draft.owners ?? {})];
  const sets: Array<PolicySet | undefined> = [
    ...Object.values(draft.policies ?? {}),
    ...blocks.flatMap((block) => [
      block.defaults,
      ...Object.values(block.types ?? {}),
      ...Object.values(block.repos ?? {}),
    ]),
  ];
  for (const set of sets) {
    for (const file of set?.files ?? []) {
      if (file?.from) file.from = resolvePath(dir, file.from);
    }
  }
}

/**
 * Fold `over` on top of `base`. `over` is the more specific layer: later
 * imports beat earlier ones, and a file's own content beats everything it
 * imports.
 */
function mergeConfig(base: Config, over: Config): Config {
  if (base.owner && over.owner && base.owner !== over.owner) {
    throw new ConfigError(
      `Conflicting "owner": "${base.owner}" vs "${over.owner}". A file meant to be shared across ` +
        `owners should not declare "owner" itself — only the file that is actually run should.`,
    );
  }

  return {
    ...mergeOwnerFields(base, over),
    ...((over.version ?? base.version) ? { version: over.version ?? base.version } : {}),
    ...((over.owner ?? base.owner) ? { owner: over.owner ?? base.owner } : {}),
    ...(base.owners || over.owners ? { owners: mergeOwners(base.owners, over.owners) } : {}),
    ...(base.policies || over.policies
      ? { policies: mergeNamedPolicies(base.policies, over.policies) }
      : {}),
  };
}

function mergeOwnerFields(base: OwnerFields, over: OwnerFields): OwnerFields {
  return {
    classify: mergeClassify(base.classify, over.classify),
    audit: mergeAudit(base.audit, over.audit),
    defaults:
      base.defaults || over.defaults
        ? mergeLayer(base.defaults ?? {}, over.defaults ?? {})
        : undefined,
    types: mergeNamedPolicies(base.types, over.types),
    repos: mergeNamedPolicies(base.repos, over.repos),
    exclude: mergeExclude(base.exclude, over.exclude),
  };
}

function mergeOwners(
  base: Record<string, OwnerBlock> | undefined,
  over: Record<string, OwnerBlock> | undefined,
): Record<string, OwnerBlock> {
  const out: Record<string, OwnerBlock> = { ...(base ?? {}) };
  for (const [login, block] of Object.entries(over ?? {})) {
    const existing = out[login];
    out[login] = existing ? mergeOwnerFields(existing, block) : block;
  }
  return out;
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

function mergeExclude(base?: ExcludeConfig, over?: ExcludeConfig): ExcludeConfig | undefined {
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
const LIST_KEYS = ['policies', 'ensure_branches', 'rulesets', 'environments', 'files'] as const;
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
 * Turn a merged file into the owner scopes every command runs against.
 *
 * The shared root layer is folded underneath each owner's own block, so an
 * owner states only what differs. A single-owner file has no owner block at
 * all and becomes that same shared layer, named.
 */
function normalize(draft: Config, path: string): ResolvedConfig {
  if (draft.owner && draft.owners) {
    throw new ConfigError(
      `${path} resolves to both "owner" ("${draft.owner}") and "owners" ` +
        `(${Object.keys(draft.owners).join(', ')}). Use one or the other: with both, there is no ` +
        `way to tell which account the root-level policy was written for.`,
    );
  }

  const shared: OwnerFields = {
    classify: draft.classify,
    audit: draft.audit,
    defaults: draft.defaults,
    types: draft.types,
    repos: draft.repos,
    exclude: draft.exclude,
  };

  if (draft.owners) {
    if (draft.version === undefined) {
      throw new ConfigError(
        `${path} declares "owners" but no "version". Add "version: ${CONFIG_VERSION}" at the ` +
          `root so the file states which configuration contract it is written against.`,
      );
    }
    if (draft.repos) {
      throw new ConfigError(
        `${path} declares "repos" at the root alongside "owners". A bare repository name does ` +
          `not identify anything once more than one account is in scope — move each entry under ` +
          `the "owners" entry it belongs to.`,
      );
    }
  } else if (!draft.owner) {
    throw new ConfigError(
      `${path} must declare an "owner" (a GitHub organisation or personal account) or an ` +
        `"owners" mapping, either directly or through one of its imports.`,
    );
  }

  const policies = resolveNamedPolicies(draft.policies ?? {}, path);
  const blocks: Array<[string, OwnerFields, string]> = draft.owners
    ? Object.entries(draft.owners).map(([login, block]) => [
        login,
        mergeOwnerFields(shared, block),
        `owners.${login}.`,
      ])
    : [[draft.owner ?? '', shared, '']];

  for (const [login, , prefix] of blocks) {
    const problem = ownerLoginProblem(login);
    if (problem) {
      throw new ConfigError(
        `${path}: ${prefix ? prefix.slice(0, -1) : '"owner"'} is not a GitHub account login — ` +
          `${problem}. Every declared owner is asked of the API by login, so one that cannot ` +
          `exist is a mistake worth catching here rather than as a 404 later.`,
      );
    }
  }

  return {
    version: draft.version ?? CONFIG_VERSION,
    owners: blocks.map(([login, fields, prefix]) =>
      expandScope(login, fields, policies, path, prefix),
    ),
  };
}

function expandScope(
  owner: string,
  fields: OwnerFields,
  policies: ReadonlyMap<string, PolicySet>,
  path: string,
  prefix: string,
): OwnerScope {
  const where = (suffix: string): string => `${path}: ${prefix}${suffix}`;
  const expand = <T extends PolicySet>(
    entries: Record<string, T>,
    group: string,
  ): Record<string, T> =>
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [
        key,
        applyPolicies(value, policies, where(`${group}.${key}`)),
      ]),
    );

  const scope: OwnerScope = {
    owner,
    classify: fields.classify,
    audit: fields.audit,
    exclude: fields.exclude,
    ...(fields.defaults
      ? { defaults: applyPolicies(fields.defaults, policies, where('defaults')) }
      : {}),
    ...(fields.types ? { types: expand(fields.types, 'types') } : {}),
    ...(fields.repos ? { repos: expand(fields.repos, 'repos') } : {}),
  };
  validateTypeReferences(scope, path);
  return scope;
}

/**
 * Resolve every named policy once, following references between them.
 *
 * A policy that references another is expanded depth first, so the order two
 * layers were written in is the order they are folded, whichever of them was
 * reached first.
 */
function resolveNamedPolicies(
  declared: Record<string, PolicySet>,
  path: string,
): ReadonlyMap<string, PolicySet> {
  const resolved = new Map<string, PolicySet>();

  const expand = (name: string, stack: string[], where: string): PolicySet => {
    const cached = resolved.get(name);
    if (cached) return cached;
    if (stack.includes(name)) {
      throw new ConfigError(
        `Circular policy reference:\n  ${[...stack, name].join('\n  policies -> ')}`,
      );
    }
    const declaration = declared[name];
    if (!declaration) throw unknownPolicy(name, Object.keys(declared), where);
    const { policies: references = [], ...own } = declaration;
    let out: PolicySet = {};
    for (const reference of references) {
      out = mergeLayer(out, expand(reference, [...stack, name], `${path}: policies.${name}`));
    }
    const expanded = mergeLayer(out, own as PolicySet);
    resolved.set(name, expanded);
    return expanded;
  };

  for (const name of Object.keys(declared)) expand(name, [], `${path}: policies`);
  return resolved;
}

/** Fold a layer's named policy references in underneath its own keys. */
function applyPolicies<T extends PolicySet>(
  layer: T,
  policies: ReadonlyMap<string, PolicySet>,
  where: string,
): T {
  const { policies: references, ...own } = layer;
  if (!references || references.length === 0) return own as T;
  let out: PolicySet = {};
  for (const reference of references) {
    const policy = policies.get(reference);
    if (!policy) throw unknownPolicy(reference, [...policies.keys()], where);
    out = mergeLayer(out, policy);
  }
  return mergeLayer(out, own as PolicySet) as T;
}

function unknownPolicy(name: string, known: string[], where: string): ConfigError {
  return new ConfigError(
    `${where} references the policy "${name}", which is not declared under "policies"` +
      (known.length > 0 ? ` (known: ${known.sort().join(', ')})` : '') +
      '.',
  );
}

function validateTypeReferences(scope: OwnerScope, path: string): void {
  const knownTypes = Object.keys(scope.types ?? {});
  for (const [name, entry] of Object.entries(scope.repos ?? {})) {
    if (entry?.type && knownTypes.length > 0 && !knownTypes.includes(entry.type)) {
      throw new ConfigError(
        `${path}: ${scope.owner}/${name} declares the type "${entry.type}", which is not declared ` +
          `under "types" for that owner (known: ${knownTypes.join(', ')})`,
      );
    }
  }
}

/**
 * Resolve the policy that applies to one repository.
 *
 * Precedence, widest to narrowest: `defaults`, `types.<type>`, then
 * `repos.<name>`.
 * A repository with no type simply skips that middle layer.
 */
export function resolvePolicy(scope: OwnerScope, repo: RepoState): PolicySet {
  let policy: PolicySet = scope.defaults ? mergeLayer({}, scope.defaults) : {};

  const type = repoType(scope, repo);
  if (type && scope.types?.[type]) {
    policy = mergeLayer(policy, scope.types[type]);
  }

  const entry = scope.repos?.[repo.name];
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
export function repoType(scope: OwnerScope, repo: RepoState): string | undefined {
  return scope.repos?.[repo.name]?.type ?? repo.type;
}

export function isExcluded(scope: OwnerScope, name: string): boolean {
  return (scope.exclude?.repos ?? []).includes(name);
}

/** True when a value is being managed, i.e. it is neither absent nor cancelled. */
export function isManaged<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}
