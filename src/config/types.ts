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
  reviewers?: string[];
}

export type FileMode = 'create-if-missing';

export interface FilePolicy {
  path: string;
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
  org: string;
  classify?: ClassifyConfig;
  audit?: AuditConfig;
  defaults?: PolicySet;
  types?: Record<string, PolicySet>;
  repos?: Record<string, PolicySet & { type?: string }>;
  exclude?: { repos?: string[] };
}

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

export interface RepoDetail extends RepoState {
  settings: Record<string, SettingValue>;
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
}
