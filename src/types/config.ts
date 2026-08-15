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

/**
 * A visibility a repository can be set to.
 *
 * `internal` is deliberately absent. GitHub reports it on a repository but its
 * update endpoint does not accept it, so octoform can observe an internal
 * repository and never restore one — a policy that could name it would be
 * offering a door that only opens one way.
 */
export type RepositoryVisibility = 'public' | 'private';

/** Desired state for repository metadata and access settings. */
export interface RepoPolicy {
  description?: Managed<string>;
  homepage?: Managed<string>;
  topics?: Managed<string[]>;
  allow_forking?: Toggle;
  web_commit_signoff_required?: Toggle;
  issue_creation?: Managed<CreationPolicy>;
  pull_request_creation?: Managed<CreationPolicy>;
  visibility?: Managed<RepositoryVisibility>;
  /**
   * Whether the repository is archived. Archiving is reversible, but while it
   * lasts GitHub refuses every write, so it is applied after everything else
   * and only when everything else succeeded.
   */
  archived?: Toggle;
  /** Whether the repository can be used as a template for new ones. */
  template?: Toggle;
  /**
   * Desired name of the repository, renamed only from one of
   * {@link RepoPolicy.rename_from}.
   *
   * Repositories are declared under `repos.<name>`, so a rename outlives the
   * entry that asked for it: once it happens, that entry no longer matches
   * anything. The plan says so before it happens rather than leaving it to be
   * discovered on the next run.
   */
  name?: Managed<string>;
  /** Rename to `name` only when the repository currently has one of these. */
  rename_from?: Managed<string[]>;
}

/** Desired default-branch name and guarded rename sources. */
export interface DefaultBranchPolicy {
  /** Desired name of the default branch. */
  name?: Managed<string>;
  /** Rename the default branch to `name` only when it currently has one of these. */
  rename_from?: Managed<string[]>;
}

/**
 * How strictly a ruleset is applied. `evaluate` reports what would have been
 * blocked without blocking it, and GitHub offers it only on some plans.
 */
export type RulesetEnforcement = 'active' | 'evaluate' | 'disabled';

/** Which refs a ruleset governs. */
export type RulesetTarget = 'branch' | 'tag' | 'push';

/** How a pattern rule compares the text it is given. */
export type PatternOperator = 'starts_with' | 'ends_with' | 'contains' | 'regex';

/** A rule matching some piece of commit or ref text against a pattern. */
export interface PatternRule {
  operator: PatternOperator;
  pattern: string;
  /** Match everything the pattern does not, instead of what it does. */
  negate?: boolean;
  /** Shown by GitHub when the rule rejects a push. */
  name?: string;
}

/** How much of a code scanning tool's output blocks a merge. */
export interface CodeScanningRule {
  tool: string;
  alerts_threshold: 'none' | 'errors' | 'errors_and_warnings' | 'all';
  security_alerts_threshold: 'none' | 'critical' | 'high_or_higher' | 'medium_or_higher' | 'all';
}

/** Desired merge queue behaviour, when a ruleset requires one. */
export interface MergeQueueRule {
  merge_method?: 'MERGE' | 'SQUASH' | 'REBASE';
  grouping_strategy?: 'ALLGREEN' | 'HEADGREEN';
  max_entries_to_build?: number;
  max_entries_to_merge?: number;
  min_entries_to_merge?: number;
  min_entries_to_merge_wait_minutes?: number;
  check_response_timeout_minutes?: number;
}

/**
 * Every rule a repository ruleset can carry, flattened.
 *
 * GitHub models these as a list of tagged objects, several of which exist only
 * to hold one value. Flattening them is what lets a ruleset be read top to
 * bottom, and what lets a policy say `block_force_push: false` — GitHub has no
 * "off" for a rule, only its absence, so the two spellings have to be
 * translated somewhere and this is the boundary that does it.
 *
 * Every key is optional and only a declared one is compared or sent. A rule
 * octoform never modelled, or one the policy simply did not mention, survives
 * an update untouched.
 */
export interface RuleSettings {
  /** Require a pull request. The keys below configure it and imply it. */
  require_pull_request?: boolean;
  required_approvals?: number;
  dismiss_stale_reviews?: boolean;
  require_code_owner_review?: boolean;
  require_last_push_approval?: boolean;
  require_thread_resolution?: boolean;
  allowed_merge_methods?: Array<'merge' | 'squash' | 'rebase'>;

  required_checks?: string[];
  strict_required_checks?: boolean;
  /** Let a branch be created without the required checks having run. */
  checks_not_enforced_on_create?: boolean;

  required_deployments?: string[];

  /** Refuse creating a matching ref. */
  block_creation?: boolean;
  /** Refuse updating a matching ref. */
  block_update?: boolean;
  /** Allow an otherwise blocked update when it is a fetch and merge. */
  allow_fetch_and_merge?: boolean;
  block_deletion?: boolean;
  block_force_push?: boolean;
  require_linear_history?: boolean;
  require_signatures?: boolean;

  merge_queue?: MergeQueueRule;
  required_code_scanning?: CodeScanningRule[];
  require_license_compliance_scanning?: boolean;
  copilot_code_review?: { review_draft_pull_requests?: boolean; review_on_push?: boolean };

  commit_message_pattern?: PatternRule;
  commit_author_email_pattern?: PatternRule;
  committer_email_pattern?: PatternRule;
  branch_name_pattern?: PatternRule;
  tag_name_pattern?: PatternRule;

  restricted_file_paths?: string[];
  restricted_file_extensions?: string[];
  max_file_size?: number;
  max_file_path_length?: number;

  required_workflows?: WorkflowRequirement[];
  /** Let a branch be created without the required workflows having run. */
  workflows_not_enforced_on_create?: boolean;
}

/**
 * A workflow that has to pass before a change reaches a targeted ref.
 *
 * GitHub identifies the workflow's repository by numeric id, not by name, so
 * `repository` is resolved before the rule can be sent, and `repository_id` is
 * the form the rule comes back in. A policy normally writes the name; writing
 * the number instead is allowed and skips the lookup, which is the only way to
 * name a repository the token cannot read.
 */
export interface WorkflowRequirement {
  /** Path to the workflow file from the root of its repository. */
  path: string;
  /** `owner/name` of the repository holding it. Defaults to this repository. */
  repository?: string;
  /** The id of {@link WorkflowRequirement.repository}, resolved or written. */
  repository_id?: number;
  /** Branch or tag to take the file from. */
  ref?: string;
  /** Commit to take the file from. */
  sha?: string;
}

/**
 * When an actor may bypass a ruleset.
 *
 * `pull_request` only lets the actor past on a pull request, and GitHub
 * accepts it on branch rulesets only. `exempt` skips the rules entirely and
 * writes no bypass entry to the audit log, so it is the one mode that leaves
 * no trace of having been used.
 */
export type BypassMode = 'always' | 'pull_request' | 'exempt';

/**
 * Actors that may bypass a ruleset, grouped by the mode they bypass in.
 *
 * Grouping by mode rather than listing each actor with its own is what keeps
 * the common case — one exception, granted to several people at once — from
 * repeating the mode on every line. A policy that needs two modes writes two
 * groups.
 *
 * Everything here is named except `roles`. GitHub's ruleset endpoints take a
 * repository role as a numeric id, and its REST surface has no route that maps
 * a repository-role name to one: only *organisation* roles can be listed. So
 * the number is what a policy writes, rather than a name octoform would have
 * to translate through a table it cannot verify.
 */
export interface RulesetBypass {
  /** Defaults to `always`. */
  mode?: BypassMode;
  /** GitHub logins. */
  users?: string[];
  /** Team slugs. Organisation repositories only. */
  teams?: string[];
  /** GitHub App slugs. */
  apps?: string[];
  /** Repository role ids. */
  roles?: number[];
  /** Every deploy key on the repository, which GitHub grants as one actor. */
  deploy_keys?: boolean;
  /** Organisation owners. Organisation repositories only. */
  organization_admins?: boolean;
}

/**
 * A desired ruleset.
 *
 * Exactly one of the three target keys says what the ruleset governs, and the
 * key names which. A single `target` field plus a shared list of patterns
 * would let a file say `target: tag` beside `target_branches`, which is a
 * disagreement nothing could resolve.
 */
export interface RulesetPolicy extends RuleSettings {
  name: string;
  /** Branch names or patterns, including `~DEFAULT_BRANCH` and `~ALL`. */
  target_branches?: string[];
  /** Tag names or patterns. */
  target_tags?: string[];
  /** A push ruleset, which governs the whole repository and matches no refs. */
  target_pushes?: boolean;
  /** Refs matching any of these are exempt, whatever the target matched. */
  exclude?: string[];
  enforcement?: RulesetEnforcement;
  /**
   * Who may bypass these rules. Omitting this keeps whoever GitHub already
   * lets past; an empty list is what removes them.
   */
  bypass?: RulesetBypass[];
}

/**
 * Who a branch-protection restriction names.
 *
 * Users are logins, teams are slugs and apps are slugs — GitHub's protection
 * endpoint takes them by name rather than by id, unlike its ruleset bypass
 * actors, so nothing here has to be resolved before it can be sent.
 */
export interface BranchRestrictions {
  users?: string[];
  teams?: string[];
  apps?: string[];
}

/**
 * Everything classic branch protection can enforce on one branch.
 *
 * GitHub's own model spells several of these as permissions rather than
 * restrictions — `allow_force_pushes` rather than `block_force_push`, which is
 * how the ruleset model spells the same idea. Both spellings are kept as their
 * own API uses them: a file that governs a branch through protection and a
 * file that governs it through a ruleset are talking to different features,
 * and making them look identical would hide which one is in force.
 */
export interface BranchProtectionSettings {
  required_checks?: string[];
  strict_required_checks?: boolean;
  /** Apply every rule here to administrators too. */
  enforce_admins?: boolean;
  /** Require a pull request. The review keys below configure it and imply it. */
  require_pull_request?: boolean;
  required_approvals?: number;
  dismiss_stale_reviews?: boolean;
  require_code_owner_review?: boolean;
  require_last_push_approval?: boolean;
  /** Who may dismiss a review. */
  dismissal_restrictions?: BranchRestrictions;
  /** Who may merge without the required reviews. */
  bypass_pull_request_allowances?: BranchRestrictions;
  /** Who may push at all. Organisation repositories only. */
  restrict_pushes?: BranchRestrictions;
  require_linear_history?: boolean;
  allow_force_pushes?: boolean;
  allow_deletions?: boolean;
  block_creations?: boolean;
  require_conversation_resolution?: boolean;
  /** Make the branch read-only, for everyone. */
  lock_branch?: boolean;
  allow_fork_syncing?: boolean;
  require_signatures?: boolean;
}

/** Classic branch protection for one branch, named. */
export interface BranchProtectionPolicy extends BranchProtectionSettings {
  branch: string;
}

/**
 * A permission level on a repository.
 *
 * The five built-in levels are `read`, `triage`, `write`, `maintain` and
 * `admin`. GitHub's own endpoints disagree about two of their names — the
 * grant endpoints take `pull` and `push`, invitations take `read` and `write`,
 * and a collaborator reads back as whichever the API of the day prefers — so
 * both spellings are accepted here and translated at the boundary.
 *
 * The set is open because an organisation can define custom repository roles,
 * which are granted by name. Anything octoform does not recognise as built-in
 * is passed through as one of those.
 *
 * `none` is octoform's own word, not GitHub's: it revokes the grant. It has to
 * be written, because a login simply left out of the policy is left alone.
 */
export type AccessLevel = string;

/**
 * Who may work on a repository, and at what level.
 *
 * Only the logins and slugs named here are managed. Somebody who was given
 * access by hand and never written down is not a difference to correct — this
 * is not the place to discover them — which is why revoking has to be spelled
 * `none` rather than expressed by deletion from the file.
 */
export interface AccessPolicy {
  /** GitHub logins, each with the level to grant them directly. */
  users?: Record<string, Managed<AccessLevel>>;
  /** Team slugs, each with the level to grant them. Organisations only. */
  teams?: Record<string, Managed<AccessLevel>>;
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
  branch_protection?: BranchProtectionPolicy[];
  rulesets?: RulesetPolicy[];
  access?: AccessPolicy;
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
