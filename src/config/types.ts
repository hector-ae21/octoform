/**
 * The configuration model.
 *
 * Everything specific to a particular organisation lives in a YAML file, never
 * here. This module knows that a policy exists and how it is resolved; it does
 * not know that "moodle-plugin" or "npm-package" mean anything.
 */

/**
 * A managed setting is tri-state:
 *
 *   true       enforce it on
 *   false      enforce it off
 *   undefined  not managed at all, leave whatever the repository has
 *
 * `null` is accepted as an explicit "stop managing this", which is how a
 * repository-level entry cancels a policy it would otherwise inherit from its
 * type or from the defaults. Both collapse to `undefined` once resolved.
 */
export type Managed<T> = T | null | undefined;

export type Toggle = Managed<boolean>;

export interface FeaturePolicy {
  issues?: Toggle;
  wiki?: Toggle;
  projects?: Toggle;
  discussions?: Toggle;
}

export interface MergePolicy {
  allow_squash?: Toggle;
  allow_merge_commit?: Toggle;
  allow_rebase?: Toggle;
  allow_auto_merge?: Toggle;
  allow_update_branch?: Toggle;
  delete_branch_on_merge?: Toggle;
}

export interface SecurityPolicy {
  vulnerability_alerts?: Toggle;
  automated_security_fixes?: Toggle;
  private_vulnerability_reporting?: Toggle;
  secret_scanning?: Toggle;
  secret_scanning_push_protection?: Toggle;
  code_scanning_default_setup?: Toggle;
}

export interface RepoPolicy {
  description?: Managed<string>;
  homepage?: Managed<string>;
  topics?: Managed<string[]>;
  allow_forking?: Toggle;
  web_commit_signoff_required?: Toggle;
}

export interface DefaultBranchPolicy {
  /** Desired name of the default branch. */
  name?: Managed<string>;
  /** Rename the default branch to `name` only when it currently has one of these. */
  rename_from?: Managed<string[]>;
}

export interface RulesetPolicy {
  name: string;
  target_branches: string[];
  required_approvals?: number;
  required_checks?: string[];
  block_force_push?: boolean;
  block_deletion?: boolean;
}

export interface EnvironmentPolicy {
  name: string;
  /** GitHub logins that must approve a deployment to this environment. */
  reviewers?: string[];
}

export type FileMode = 'create-if-missing';

export interface FilePolicy {
  path: string;
  /** Path to the local file to copy, relative to the configuration file. */
  from: string;
  mode: FileMode;
}

/** Everything that can be declared at any level of the precedence chain. */
export interface PolicySet {
  /**
   * When false, the repository is still inventoried and audited but no policy
   * is applied to it. Distinct from `exclude`, which drops it entirely.
   */
  manage?: boolean;
  features?: FeaturePolicy;
  merge?: MergePolicy;
  security?: SecurityPolicy;
  repo?: RepoPolicy;
  default_branch?: DefaultBranchPolicy;
  ensure_branches?: string[];
  rulesets?: RulesetPolicy[];
  environments?: EnvironmentPolicy[];
  files?: FilePolicy[];
}

/** A condition used to infer a repository's type when it has none recorded. */
export interface ClassifyRule {
  when: {
    file_exists?: string;
    /** Shallow key/value match against the JSON file named by `file_exists`. */
    json?: Record<string, unknown>;
    visibility?: 'public' | 'private';
  };
  type: string;
}

export interface ClassifyConfig {
  /** Name of the GitHub custom property holding the type. */
  property?: string;
  rules?: ClassifyRule[];
}

/**
 * Audit-only expectations. These never mutate anything; they exist so that
 * "every public repository must have a description" is a line of configuration
 * rather than a branch in the code.
 */
export interface AuditConfig {
  require_description?: { visibility?: 'public' | 'private' };
  require_topics?: { visibility?: 'public' | 'private' };
  max_topics?: number;
  require_type?: boolean;
}

export interface Config {
  /**
   * A GitHub login: an organisation or a personal account. octoform tells
   * which one it is by asking the API, not by anything declared here — an
   * organisation and a user with the same login are indistinguishable in
   * configuration, and forcing the author to say which invites the file to
   * be wrong about it.
   */
  owner: string;
  /**
   * Other configuration files to merge before this one, most general first.
   * Paths are resolved relative to the file that lists them, so an imported
   * file can itself import further files. This is how a set of type
   * presets is shared across several owners without copying it around: put
   * `types` and `defaults` in a file with no `owner` of its own, and import
   * it from each real configuration.
   */
  imports?: string[];
  classify?: ClassifyConfig;
  audit?: AuditConfig;
  defaults?: PolicySet;
  types?: Record<string, PolicySet>;
  repos?: Record<string, PolicySet & { type?: string }>;
  exclude?: { repos?: string[] };
}

/**
 * Whether `owner` turned out to be an organisation or a personal account.
 * Several features are organisation-only (custom properties, organisation
 * rulesets), so this changes what gets probed and how findings are worded —
 * never what the configuration is allowed to say.
 */
export type OwnerKind = 'org' | 'user';

/** A repository as octoform sees it, before any policy is applied. */
export interface RepoState {
  name: string;
  visibility: 'public' | 'private' | 'internal';
  archived: boolean;
  default_branch: string;
  description: string | null;
  homepage: string | null;
  topics: string[];
  /** Resolved type, from the custom property or from `repos.<name>.type`. */
  type?: string;
}

/**
 * Everything `plan` needs to compare against a policy. Some of it comes from
 * the repository object and some from endpoints of its own, so it is gathered
 * separately from the cheap inventory `audit` runs on.
 */
/**
 * The answer could not be read at all: an endpoint this plan does not expose,
 * or a field GitHub omitted. Distinct from `null`, which is a real value for
 * a description or a homepage and means "set to nothing". Conflating the two
 * makes the planner offer to fill in a field it cannot even see.
 */
export const UNREADABLE = Symbol('unreadable');

export type SettingValue = boolean | string | string[] | null | typeof UNREADABLE;

/**
 * A ruleset as it exists on GitHub right now, reduced to the parts octoform
 * manages. Everything else GitHub stores on a ruleset — bypass actors, rules
 * octoform does not model — is deliberately absent: `plan` must not offer to
 * remove a rule it never knew how to describe.
 */
export interface ExistingRuleset {
  id: number;
  name: string;
  target_branches: string[];
  required_approvals?: number;
  required_checks?: string[];
  block_force_push: boolean;
  block_deletion: boolean;
}

/**
 * State that costs an extra request each, so it is only gathered when a policy
 * actually asks about it.
 *
 * Every field distinguishes "not gathered, or could not be read" (undefined)
 * from "gathered, and there is nothing" (an empty array or map). Collapsing
 * the two would make `plan` offer to create things it simply failed to look at.
 */
export interface RepoStructure {
  /** Names of the environments that exist. */
  environments?: string[];
  rulesets?: ExistingRuleset[];
  /** Path -> whether it exists, for the paths a `files` policy named. */
  files?: Record<string, boolean>;
  /** Branch -> whether it exists, for the branches `ensure_branches` named. */
  branches?: Record<string, boolean>;
  /**
   * Workflow files that mention the current default branch by name. Renaming
   * the branch does not rewrite these, so they are the collateral damage of a
   * rename and have to be named before it happens, not discovered after.
   */
  workflowsNamingDefaultBranch?: string[];
}

export interface RepoDetail extends RepoState {
  settings: Record<string, SettingValue>;
  structure?: RepoStructure;
}

/** One difference between what is declared and what the repository has. */
export interface Change {
  repo: string;
  /** Dotted path of the setting, e.g. "merge.delete_branch_on_merge". */
  key: string;
  from: unknown;
  to: unknown;
  /** Set when the change cannot be applied; explains why, in plain words. */
  blocked?: string;
  /**
   * Set when the change will be applied but has a consequence the operator
   * should know about first. Distinct from `blocked`: this one still happens.
   */
  warning?: string;
  /**
   * What `apply` needs to carry the change out, for the changes whose `to` is
   * a sentence meant for a human rather than a value an endpoint accepts. A
   * ruleset reads as "v*.x, 1 approval" in the report; the API wants the
   * policy object it came from.
   */
  payload?: unknown;
}
