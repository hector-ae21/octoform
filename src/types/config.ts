/**
 * The configuration model: what an author may write in a YAML file, and what
 * `loadConfig` normalizes it into.
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

/** A tri-state Boolean policy value. */
export type Toggle = Managed<boolean>;

/** Desired state for repository feature switches. */
export interface FeaturePolicy {
  issues?: Toggle;
  wiki?: Toggle;
  projects?: Toggle;
  discussions?: Toggle;
  /** Whether the repository shows a sponsor button. */
  sponsorships?: Toggle;
  /**
   * Whether pull requests can be opened at all. Turning this off does not
   * remove the ones that already exist.
   */
  pull_requests?: Toggle;
}

/**
 * Who may open an issue or a pull request on the repository.
 *
 * `COLLABORATORS_ONLY` still leaves the feature enabled and its history
 * readable; it narrows who can add to it. Turning the feature off entirely is
 * a different setting.
 */
export type CreationPolicy = 'ALL' | 'COLLABORATORS_ONLY';

/**
 * Where the title of a squash merge commit comes from by default.
 *
 * `PR_TITLE` always uses the pull request's title; `COMMIT_OR_PR_TITLE` uses
 * the single commit's title when there is exactly one, and the pull request's
 * title otherwise.
 */
export type SquashCommitTitle = 'PR_TITLE' | 'COMMIT_OR_PR_TITLE';

/** Where the body of a squash merge commit comes from by default. */
export type SquashCommitMessage = 'PR_BODY' | 'COMMIT_MESSAGES' | 'BLANK';

/**
 * Where the title of a merge commit comes from by default. `MERGE_MESSAGE` is
 * GitHub's own "Merge pull request #123 from branch" wording.
 */
export type MergeCommitTitle = 'PR_TITLE' | 'MERGE_MESSAGE';

/** Where the body of a merge commit comes from by default. */
export type MergeCommitMessage = 'PR_BODY' | 'PR_TITLE' | 'BLANK';

/**
 * Desired state for pull-request merge behavior.
 *
 * Each message default is named after the `allow_` switch it belongs to, since
 * squash merges and merge commits carry their own independent pair. GitHub
 * refuses a request that sets a message default without also stating the
 * matching title, so declaring one without the other is reported rather than
 * sent — see `planScalars`.
 */
export interface MergePolicy {
  allow_squash?: Toggle;
  allow_merge_commit?: Toggle;
  allow_rebase?: Toggle;
  allow_auto_merge?: Toggle;
  allow_update_branch?: Toggle;
  delete_branch_on_merge?: Toggle;
  squash_title?: Managed<SquashCommitTitle>;
  squash_message?: Managed<SquashCommitMessage>;
  merge_commit_title?: Managed<MergeCommitTitle>;
  merge_commit_message?: Managed<MergeCommitMessage>;
}

/** Desired state for repository security features. */
export interface SecurityPolicy {
  vulnerability_alerts?: Toggle;
  automated_security_fixes?: Toggle;
  private_vulnerability_reporting?: Toggle;
  secret_scanning?: Toggle;
  secret_scanning_push_protection?: Toggle;
  code_scanning_default_setup?: Toggle;
  /**
   * Whether published releases and their assets become immutable. An owner can
   * enforce this across its repositories, in which case a repository cannot
   * turn it off and octoform reports that instead of attempting it.
   */
  immutable_releases?: Toggle;
}

/** Desired state for repository metadata and access settings. */
export interface RepoPolicy {
  description?: Managed<string>;
  homepage?: Managed<string>;
  topics?: Managed<string[]>;
  allow_forking?: Toggle;
  web_commit_signoff_required?: Toggle;
  issue_creation?: Managed<CreationPolicy>;
  pull_request_creation?: Managed<CreationPolicy>;
}

/** Desired default-branch name and guarded rename sources. */
export interface DefaultBranchPolicy {
  /** Desired name of the default branch. */
  name?: Managed<string>;
  /** Rename the default branch to `name` only when it currently has one of these. */
  rename_from?: Managed<string[]>;
}

/** Desired branch ruleset reduced to the fields Octoform manages. */
export interface RulesetPolicy {
  name: string;
  target_branches: string[];
  required_approvals?: number;
  required_checks?: string[];
  block_force_push?: boolean;
  block_deletion?: boolean;
}

/** Desired deployment environment and its user reviewers. */
export interface EnvironmentPolicy {
  name: string;
  /** GitHub logins that must approve a deployment to this environment. */
  reviewers?: string[];
}

/** Supported behavior when reconciling a declared repository file. */
export type FileMode = 'create-if-missing';

/** Desired create-if-missing repository file. */
export interface FilePolicy {
  path: string;
  /** Path to the local file to copy, relative to the configuration file. */
  from: string;
  mode: FileMode;
}

/** Everything that can be declared at any level of the precedence chain. */
export interface PolicySet {
  /**
   * Named entries of the root `policies` block to fold in before this layer's
   * own keys, in declaration order.
   *
   * A policy is a reusable fragment of ordinary policy, nothing more: it has no
   * meaning of its own and cannot express anything a layer could not express
   * inline. Referencing one never overrides a key the referencing layer states
   * itself, so reading a layer top to bottom still tells the whole story.
   */
  policies?: string[];
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

/** Classification rules and optional organization property storage. */
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

/** A repository entry: a policy layer plus the type it is classified as. */
export type RepoEntry = PolicySet & { type?: string };

/** Repositories dropped from every command, by name. */
export interface ExcludeConfig {
  repos?: string[];
}

/**
 * The configuration contract a file is written against.
 *
 * It is not the version of octoform. It changes only when the meaning of an
 * existing key changes, which is what lets a future release read an old file
 * correctly instead of guessing.
 */
export type ConfigVersion = 1;

/** Everything one GitHub owner can declare under `owners`. */
export interface OwnerBlock {
  classify?: ClassifyConfig;
  audit?: AuditConfig;
  defaults?: PolicySet;
  types?: Record<string, PolicySet>;
  repos?: Record<string, RepoEntry>;
  exclude?: ExcludeConfig;
}

/**
 * A configuration file as it is written, before normalization.
 *
 * Two shapes are accepted. A single-owner file names its account in `owner`
 * and declares policy at the root; a multi-owner file lists accounts under
 * `owners` and keeps the root for what they share. Declaring both is an error:
 * the two cannot be reconciled without deciding, on the author's behalf, which
 * account the root-level policy was meant for.
 */
export interface Config {
  /**
   * The configuration contract version. Optional for a single-owner file so
   * that files written before it existed keep loading; required as soon as
   * `owners` is used, because that shape has never existed without it.
   */
  version?: ConfigVersion;
  /**
   * A GitHub login: an organisation or a personal account. octoform tells
   * which one it is by asking the API, not by anything declared here — an
   * organisation and a user with the same login are indistinguishable in
   * configuration, and forcing the author to say which invites the file to
   * be wrong about it.
   */
  owner?: string;
  /**
   * Accounts to govern, keyed by GitHub login. Each entry may narrow or
   * override what the root declares for all of them.
   */
  owners?: Record<string, OwnerBlock>;
  /**
   * Other configuration files to merge before this one, most general first.
   * Paths are resolved relative to the file that lists them, so an imported
   * file can itself import further files. This is how a set of type
   * presets is shared across several owners without copying it around: put
   * `types` and `defaults` in a file with no `owner` of its own, and import
   * it from each real configuration.
   */
  imports?: string[];
  /**
   * Reusable policy fragments, keyed by a name of the author's choosing, that
   * any layer folds in through its own `policies` list. A policy may reference
   * other policies; a reference cycle is reported with the full chain.
   */
  policies?: Record<string, PolicySet>;
  classify?: ClassifyConfig;
  audit?: AuditConfig;
  defaults?: PolicySet;
  types?: Record<string, PolicySet>;
  /**
   * Per-repository overrides. Only valid in a single-owner file: a bare
   * repository name identifies nothing on its own once more than one account
   * is in scope, so a multi-owner file declares these under their owner.
   */
  repos?: Record<string, RepoEntry>;
  exclude?: ExcludeConfig;
}

/**
 * Everything that applies to exactly one GitHub owner, with imports folded in,
 * policy references expanded and the shared root layered underneath.
 *
 * This is what every command consumes. Neither shape of the authored file
 * survives into it, so nothing downstream has to know which one was written.
 */
export interface OwnerScope {
  owner: string;
  classify?: ClassifyConfig;
  audit?: AuditConfig;
  defaults?: PolicySet;
  types?: Record<string, PolicySet>;
  repos?: Record<string, RepoEntry>;
  exclude?: ExcludeConfig;
}

/** A loaded configuration, normalized to one scope per owner. */
export interface ResolvedConfig {
  version: ConfigVersion;
  /** In the order the owners were declared, which is the order they are run. */
  owners: OwnerScope[];
}
