/**
 * The authored configuration shape, declared once as data.
 *
 * Two things need to agree about that shape and used to be written twice: the
 * loader, which has to reject a misspelled key and say where it was, and the
 * documentation, which has to state whether a narrower layer adds to a
 * collection or replaces it. Declaring it here makes the loader and the
 * generated reference read from the same description, and a test holds this
 * description to the published JSON Schema so neither can drift.
 */

/** How a field combines when one layer is folded onto the layer beneath it. */
export type MergeSemantics =
  /** The more specific layer's value wins outright. */
  | 'scalar'
  /** Keys combine; a key present in both layers has its value merged. */
  | 'merge-by-key'
  /** The more specific layer's collection replaces the inherited one whole. */
  | 'replace'
  /** Entries from both layers, in order, with duplicates removed. */
  | 'union'
  /** Entries from both layers, most specific first, where order decides. */
  | 'ordered-append'
  /** Belongs to the file that declares it and is never inherited. */
  | 'not-layered';

/** What kind of value a field holds. */
export type ValueShape =
  | { readonly kind: 'scalar' }
  | { readonly kind: 'any' }
  | { readonly kind: 'scalar-list' }
  | { readonly kind: 'object'; readonly of: () => ObjectShape }
  | { readonly kind: 'object-list'; readonly of: () => ObjectShape }
  | { readonly kind: 'map'; readonly of: () => ValueShape };

/** One declared field of one object. */
export interface Field {
  readonly shape: ValueShape;
  readonly merge: MergeSemantics;
}

/** A named object with a closed set of keys. */
export interface ObjectShape {
  readonly name: string;
  readonly fields: Readonly<Record<string, Field>>;
}

const scalar: Field = { shape: { kind: 'scalar' }, merge: 'scalar' };
const scalarList: Field = { shape: { kind: 'scalar-list' }, merge: 'replace' };
const freeMap: Field = {
  shape: { kind: 'map', of: () => ({ kind: 'any' }) },
  merge: 'merge-by-key',
};

function object(of: () => ObjectShape, merge: MergeSemantics = 'merge-by-key'): Field {
  return { shape: { kind: 'object', of }, merge };
}

function objectList(of: () => ObjectShape, merge: MergeSemantics = 'replace'): Field {
  return { shape: { kind: 'object-list', of }, merge };
}

function mapOfObjects(of: () => ObjectShape): Field {
  return { shape: { kind: 'map', of: () => ({ kind: 'object', of }) }, merge: 'merge-by-key' };
}

const FEATURE_POLICY: ObjectShape = {
  name: 'FeaturePolicy',
  fields: { issues: scalar, wiki: scalar, projects: scalar, discussions: scalar },
};

const MERGE_POLICY: ObjectShape = {
  name: 'MergePolicy',
  fields: {
    allow_squash: scalar,
    allow_merge_commit: scalar,
    allow_rebase: scalar,
    allow_auto_merge: scalar,
    allow_update_branch: scalar,
    delete_branch_on_merge: scalar,
  },
};

const SECURITY_POLICY: ObjectShape = {
  name: 'SecurityPolicy',
  fields: {
    vulnerability_alerts: scalar,
    automated_security_fixes: scalar,
    private_vulnerability_reporting: scalar,
    secret_scanning: scalar,
    secret_scanning_push_protection: scalar,
    code_scanning_default_setup: scalar,
  },
};

const REPO_POLICY: ObjectShape = {
  name: 'RepoPolicy',
  fields: {
    description: scalar,
    homepage: scalar,
    topics: scalarList,
    allow_forking: scalar,
    web_commit_signoff_required: scalar,
  },
};

const DEFAULT_BRANCH_POLICY: ObjectShape = {
  name: 'DefaultBranchPolicy',
  fields: { name: scalar, rename_from: scalarList },
};

const RULESET_POLICY: ObjectShape = {
  name: 'RulesetPolicy',
  fields: {
    name: scalar,
    target_branches: scalarList,
    required_approvals: scalar,
    required_checks: scalarList,
    block_force_push: scalar,
    block_deletion: scalar,
  },
};

const ENVIRONMENT_POLICY: ObjectShape = {
  name: 'EnvironmentPolicy',
  fields: { name: scalar, reviewers: scalarList },
};

const FILE_POLICY: ObjectShape = {
  name: 'FilePolicy',
  fields: { path: scalar, from: scalar, mode: scalar },
};

const POLICY_SET: ObjectShape = {
  name: 'PolicySet',
  fields: {
    policies: scalarList,
    manage: scalar,
    features: object(() => FEATURE_POLICY),
    merge: object(() => MERGE_POLICY),
    security: object(() => SECURITY_POLICY),
    repo: object(() => REPO_POLICY),
    default_branch: object(() => DEFAULT_BRANCH_POLICY),
    ensure_branches: scalarList,
    rulesets: objectList(() => RULESET_POLICY),
    environments: objectList(() => ENVIRONMENT_POLICY),
    files: objectList(() => FILE_POLICY),
  },
};

const REPO_ENTRY: ObjectShape = {
  name: 'RepoEntry',
  fields: { ...POLICY_SET.fields, type: scalar },
};

const CLASSIFY_RULE_CONDITION: ObjectShape = {
  name: 'ClassifyRuleCondition',
  fields: { file_exists: scalar, json: freeMap, visibility: scalar },
};

const CLASSIFY_RULE: ObjectShape = {
  name: 'ClassifyRule',
  fields: { when: object(() => CLASSIFY_RULE_CONDITION), type: scalar },
};

const CLASSIFY_CONFIG: ObjectShape = {
  name: 'ClassifyConfig',
  fields: {
    property: scalar,
    rules: objectList(() => CLASSIFY_RULE, 'ordered-append'),
  },
};

const VISIBILITY_RULE: ObjectShape = {
  name: 'VisibilityRule',
  fields: { visibility: scalar },
};

const AUDIT_CONFIG: ObjectShape = {
  name: 'AuditConfig',
  fields: {
    require_description: object(() => VISIBILITY_RULE, 'replace'),
    require_topics: object(() => VISIBILITY_RULE, 'replace'),
    max_topics: scalar,
    require_type: scalar,
  },
};

const EXCLUDE_CONFIG: ObjectShape = {
  name: 'ExcludeConfig',
  fields: { repos: { shape: { kind: 'scalar-list' }, merge: 'union' } },
};

/** The fields an owner may declare, at the root or under `owners.<login>`. */
const OWNER_FIELDS: Readonly<Record<string, Field>> = {
  classify: object(() => CLASSIFY_CONFIG),
  audit: object(() => AUDIT_CONFIG),
  defaults: object(() => POLICY_SET),
  types: mapOfObjects(() => POLICY_SET),
  repos: mapOfObjects(() => REPO_ENTRY),
  exclude: object(() => EXCLUDE_CONFIG),
};

/** What one entry under `owners` may declare. */
export const OWNER_BLOCK: ObjectShape = { name: 'OwnerBlock', fields: OWNER_FIELDS };

/** What a configuration file may declare at its root. */
export const CONFIG: ObjectShape = {
  name: 'Config',
  fields: {
    version: scalar,
    owner: scalar,
    owners: mapOfObjects(() => OWNER_BLOCK),
    imports: { shape: { kind: 'scalar-list' }, merge: 'not-layered' },
    policies: mapOfObjects(() => POLICY_SET),
    ...OWNER_FIELDS,
  },
};

/**
 * The precedence chain, widest first, as it is published.
 *
 * Every entry is resolved key by key against the one before it, so a narrower
 * layer that says nothing about a setting leaves the wider layer's answer
 * standing.
 */
export const PRECEDENCE: readonly string[] = [
  'imported files, in declaration order',
  'root policies referenced by the layer being resolved',
  'root defaults',
  'owner defaults',
  'types.<type>',
  'repos.<name>',
];

/** One published statement of how a field combines across layers. */
export interface SemanticsEntry {
  /** The named object the field belongs to, such as `PolicySet`. */
  shape: string;
  field: string;
  merge: MergeSemantics;
}

/**
 * Every field whose combining rule is worth stating, once per declaring
 * object.
 *
 * Stated per object rather than per path on purpose: a policy set reached
 * through `defaults`, through `types.<type>` or through an owner is the same
 * policy set, and repeating its rules at each of those addresses would suggest
 * they could differ. Plain scalars are omitted, because "the narrower value
 * wins" is the rule nobody needs told.
 */
export function collectionSemantics(): SemanticsEntry[] {
  const entries: SemanticsEntry[] = [];
  const visited = new Set<string>();

  const visit = (shape: ObjectShape): void => {
    if (visited.has(shape.name)) return;
    visited.add(shape.name);
    for (const [field, declared] of Object.entries(shape.fields)) {
      if (declared.merge !== 'scalar') {
        entries.push({ shape: shape.name, field, merge: declared.merge });
      }
      if (declared.shape.kind === 'object' || declared.shape.kind === 'object-list') {
        visit(declared.shape.of());
      }
      if (declared.shape.kind === 'map') {
        const value = declared.shape.of();
        if (value.kind === 'object') visit(value.of());
      }
    }
  };

  visit(CONFIG);
  return entries.sort(
    (left, right) => left.shape.localeCompare(right.shape) || left.field.localeCompare(right.field),
  );
}

/** The published description of the configuration contract. */
export function configModel(): {
  schemaVersion: number;
  contractVersion: number;
  precedence: readonly string[];
  semantics: SemanticsEntry[];
} {
  return {
    schemaVersion: 1,
    contractVersion: 1,
    precedence: PRECEDENCE,
    semantics: collectionSemantics(),
  };
}
