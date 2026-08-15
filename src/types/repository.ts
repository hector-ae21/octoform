/** The shape of a repository as octoform observes and reconciles it. */

import type { UNREADABLE } from '../config/sentinels.js';
import type { RuleSettings, RulesetEnforcement, RulesetTarget } from './config.js';

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

/** An observed scalar setting or explicit unreadable sentinel. */
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
  target: RulesetTarget;
  enforcement: RulesetEnforcement;
  include: string[];
  exclude: string[];
  /** The rules octoform models, in the same flat shape a policy declares. */
  rules: RuleSettings;
  /**
   * Rules octoform does not model, kept exactly as GitHub returned them.
   *
   * Updating a ruleset replaces its whole rule list, so anything not sent back
   * is deleted. Carrying these through is the difference between "octoform
   * does not manage that rule" and "octoform silently removed it".
   */
  unmodelled: unknown[];
}

/**
 * An environment as it exists on GitHub right now, reduced to what octoform
 * compares.
 *
 * `reviewers` is `UNREADABLE` rather than an empty list when the
 * environment's required-reviewers rule includes a team: octoform only ever
 * resolves a declared reviewer to a *user* id (see `resolveReviewers` in
 * github/apply.ts), so it has no way to represent a team's protection — and
 * must not silently overwrite it. Reading it as "no reviewers" would make
 * `plan` propose what looks like a pure addition but would actually replace
 * the team when applied.
 */
export interface ExistingEnvironment {
  name: string;
  reviewers: string[] | typeof UNREADABLE;
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
  /** Environments that exist, each with its current required reviewers. */
  environments?: ExistingEnvironment[];
  rulesets?: ExistingRuleset[];
  /** Existence state by path for the paths named by a `files` policy. */
  files?: Record<string, boolean>;
  /** Existence state by branch for the branches named by `ensure_branches`. */
  branches?: Record<string, boolean>;
  /**
   * Workflow files that mention the current default branch by name. Renaming
   * the branch does not rewrite these, so they are the collateral damage of a
   * rename and have to be named before it happens, not discovered after.
   */
  workflowsNamingDefaultBranch?: string[];
  /**
   * Workflow files that upload code scanning results themselves. GitHub
   * refuses those uploads while the code scanning default setup is
   * configured, so enabling it disables them — silently, from the
   * repository's point of view.
   *
   * Read only when a policy would turn the default setup on, and `undefined`
   * when the workflows could not be read at all, which is not the same as
   * none existing.
   */
  workflowsUploadingCodeScanning?: string[];
}

/**
 * Everything `plan` needs to compare against a policy. Some of it comes from
 * the repository object and some from endpoints of its own, so it is gathered
 * separately from the cheap inventory `audit` runs on.
 */
export interface RepoDetail extends RepoState {
  settings: Record<string, SettingValue>;
  /**
   * GitHub's node identity for the repository, which its GraphQL mutations
   * address it by instead of by owner and name.
   *
   * Read only when a policy manages a setting that has to be changed that way,
   * and absent when that read failed — in which case the change is blocked
   * rather than sent against an identity octoform does not have.
   */
  nodeId?: string;
  /**
   * Settings the owner enforces across its repositories, keyed the same way as
   * {@link RepoDetail.settings}, with the reason a repository cannot override
   * them.
   *
   * Readable but not writable, which is why this is not `UNREADABLE`: the
   * current value is known, it simply cannot be changed from here. Knowing that
   * up front is what turns a failed request into a reported one.
   */
  enforced?: Record<string, string>;
  structure?: RepoStructure;
}

/**
 * What kind of operation a change represents against GitHub's own model.
 * `attach`/`detach`/`delete` have no producer yet — nothing octoform manages
 * today removes or unlinks a resource — but the type states them so a future
 * resource family does not have to widen a type every consumer already reads.
 */
export type OperationKind = 'create' | 'update' | 'attach' | 'detach' | 'delete';

/**
 * How much scrutiny a change deserves before it is applied, matching the
 * confirmation levels in the security model: normal metadata, a setting that
 * affects access or merge safety, an irreversible removal, or one with a
 * billing consequence. Nothing octoform manages today is `destructive` or
 * `cost` — those arrive with resource families that can actually produce them.
 */
export type Risk = 'normal' | 'sensitive' | 'destructive' | 'cost';

/** One difference between what is declared and what the repository has. */
export interface Change {
  /**
   * Stable across two runs that plan the same change, so a result can be
   * correlated with the operation that produced it across output formats and
   * across the gap between `plan` and a later `apply`. Never used as API
   * identity — it addresses a change in octoform's own model, not a GitHub
   * object.
   */
  id: string;
  /** The GitHub login this change belongs to. */
  owner: string;
  repo: string;
  /** Dotted path of the setting, e.g. "merge.delete_branch_on_merge". */
  key: string;
  operation: OperationKind;
  risk: Risk;
  /**
   * Other operations' {@link Change.id} values this one cannot be applied
   * before. Empty today: within one repository's settings nothing octoform
   * plans depends on anything else it plans. Real prerequisites arrive with
   * the cross-resource dependency graph, once a second resource family gives
   * them something to point at.
   */
  prerequisites: string[];
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
