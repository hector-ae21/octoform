/** The shape of a repository as octoform observes and reconciles it. */

import type { UNREADABLE } from '../config/sentinels.js';
import type {
  BranchProtectionSettings,
  PropertyEditors,
  PropertyValue,
  PropertyValueType,
  RuleSettings,
  RulesetEnforcement,
  RulesetRepositories,
  RulesetTarget,
  TeamRole,
} from './config.js';
import type { Resolution, StoredActor } from './identity.js';

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
 * manages, plus the parts it must carry back untouched: `plan` must not offer
 * to remove a rule it never knew how to describe.
 */
export interface ExistingRuleset {
  id: number;
  name: string;
  target: RulesetTarget;
  enforcement: RulesetEnforcement;
  include: string[];
  exclude: string[];
  /**
   * Which repositories the ruleset reaches, for an organisation's.
   *
   * Absent on a repository's own ruleset, which reaches the repository it is
   * on and has no condition saying so. Kept for the same reason the bypass
   * list is: an update replaces the conditions, so a policy that says nothing
   * about them must still send back what is there.
   */
  repositories?: RulesetRepositories;
  /**
   * Who GitHub currently lets past these rules, by id.
   *
   * Kept for the same reason `unmodelled` is: updating a ruleset replaces its
   * bypass list too, so a policy that says nothing about bypass would revoke
   * every exception if this were dropped.
   */
  bypass: StoredActor[];
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

/** A label as it exists on GitHub right now. */
export interface ExistingLabel {
  name: string;
  /** Six lower-case hex digits, without a leading `#`, as GitHub stores it. */
  color: string;
  description: string | null;
  /** Whether GitHub created it with the repository rather than a person. */
  default: boolean;
}

/** A milestone as it exists on GitHub right now. */
export interface ExistingMilestone {
  /** GitHub addresses a milestone by this, not by its title. */
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  /** The due date as a calendar day, with the time GitHub chose discarded. */
  due?: string;
}

/**
 * A custom property definition as the organisation holds it right now.
 *
 * Read in full even though a policy rarely states all of it, because the
 * endpoint that writes one replaces the whole definition: the fields nobody
 * declared are exactly the fields that need carrying forward.
 */
export interface ExistingProperty {
  name: string;
  value_type: PropertyValueType;
  description: string | null;
  required: boolean;
  default_value: PropertyValue | null;
  allowed_values: string[] | null;
  values_editable_by: PropertyEditors | null;
  require_explicit_values: boolean;
  /**
   * Where the definition comes from. An organisation can see the properties
   * its enterprise defines and cannot change them, and nothing else in the
   * payload distinguishes one of those from its own.
   */
  source_type: 'organization' | 'enterprise';
}

/**
 * A team as it exists on GitHub right now.
 *
 * `parent` is the parent's slug rather than its id: GitHub's team endpoints
 * accept a parent by slug, so nothing here has to be resolved to a number
 * before it can be sent — unlike a ruleset's bypass actors.
 */
export interface ExistingTeam {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  privacy: 'secret' | 'closed';
  /** Whether members are notified when the team is mentioned. */
  notifications: boolean;
  parent: string | null;
  /** Who is on it, gathered only when a policy asks about membership. */
  members?: TeamMembers;
}

/**
 * Who is on a team, with the people who have been asked kept apart from the
 * people who have answered.
 *
 * Adding someone who is not yet an organisation member sends them an email
 * invitation, and the membership stays `pending` until they accept. Reading
 * only the active side would see the same person missing on every run and
 * invite them again on every run.
 */
export interface TeamMembers {
  /** Role by login, for people who are on the team now. */
  active: Record<string, TeamRole>;
  /**
   * Role by login, for invitations sent and not yet accepted.
   *
   * The invitation listing cannot answer this on its own: the `role` it
   * carries is the organisation invitation role, not the team one, which is
   * why the team role is asked for per pending person instead of assumed.
   */
  pending: Record<string, TeamRole>;
}

/**
 * The organisation itself as it stands, gathered before anything is planned.
 *
 * Each field is absent when it could not be read, and an absent field blocks
 * rather than being treated as empty: writing an organisation setting over
 * settings nobody managed to read is the one thing worse than not writing it.
 */
export interface OrganizationState {
  /** Scalar settings, keyed the way a change names them. */
  settings?: Record<string, SettingValue>;
  /** Custom property definitions, by name. */
  properties?: Record<string, ExistingProperty>;
  /** Rulesets the organisation applies to its repositories. */
  rulesets?: ExistingRuleset[];
  /**
   * Teams, by slug.
   *
   * Only the teams the token can see. GitHub's listing is what is "visible to
   * the authenticated user", so a secret team a token cannot see is absent
   * rather than reported — which is why a create that collides with one is
   * reported as the failure it is instead of being retried.
   */
  teams?: Record<string, ExistingTeam>;
  /** The names a ruleset has to send as numbers, already looked up. */
  resolved?: Resolution;
}

/** A repository invitation that has been sent and not yet answered. */
export interface ExistingInvitation {
  id: number;
  /** The level the invitation offers, in octoform's canonical spelling. */
  level: string;
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
  /**
   * Classic protection by branch, for the branches a policy names. `null` is a
   * branch that exists with no protection on it, which is a different answer
   * from the whole map being absent because a read failed.
   */
  branchProtection?: Record<string, BranchProtectionSettings | null>;
  /**
   * Direct collaborators by login, with the level each one holds.
   *
   * Direct only. The unfiltered listing also returns everyone who reaches the
   * repository through a team or the organisation's base permission, and
   * reconciling against that would offer to revoke grants that were never made
   * here — GitHub would accept the request and nothing would change.
   */
  collaborators?: Record<string, string>;
  /**
   * Invitations still waiting to be accepted, by login.
   *
   * Adding a collaborator who is not one yet creates an invitation rather than
   * access. Without reading these, every run would see the same missing
   * collaborator and send the same invitation again.
   */
  invitations?: Record<string, ExistingInvitation>;
  /** Teams granted access to this repository, with the level each one holds. */
  teamAccess?: Record<string, string>;
  /** Every label the repository has, by name. */
  labels?: Record<string, ExistingLabel>;
  /**
   * Every milestone the repository has, by title, open and closed alike.
   *
   * The listing endpoint returns only open ones unless asked otherwise, and a
   * closed milestone read as missing would be created again on every run —
   * GitHub does not refuse a second milestone with the same title.
   */
  milestones?: Record<string, ExistingMilestone>;
  /**
   * Custom property values that are set on the repository, by property name.
   * A property the organisation defines but nobody has set is simply absent.
   */
  propertyValues?: Record<string, string | string[]>;
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
  /**
   * Every name a ruleset policy has to send as a number, looked up once.
   *
   * Resolved while reading rather than while applying, so a team nobody can
   * find is a blocked change in the plan instead of an exception halfway
   * through writing one.
   */
  resolved?: Resolution;
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
 * Granting and revoking access are `attach` and `detach`: the collaborator and
 * the team both exist either way, and what changes is whether they are linked
 * to this repository. `delete` is for a collection entry the policy asks to
 * stop existing, which no other change does.
 */
export type OperationKind = 'create' | 'update' | 'attach' | 'detach' | 'delete';

/**
 * How much scrutiny a change deserves before it is applied, matching the
 * confirmation levels in the security model: normal metadata, a setting that
 * affects access or merge safety, an irreversible removal, or one with a
 * billing consequence. Revoking a grant is the first `destructive` change
 * octoform produces; nothing it manages today has a `cost`.
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
  /**
   * The repository this change belongs to, absent when it belongs to the
   * owner itself. An organisation setting has no repository to name, and
   * inventing one would make it sort and group as though it did.
   */
  repo?: string;
  /** Dotted path of the setting, e.g. "merge.delete_branch_on_merge". */
  key: string;
  operation: OperationKind;
  risk: Risk;
  /**
   * Other operations' {@link Change.id} values this one cannot be applied
   * before, so that a change whose prerequisite failed is not attempted
   * against state its prerequisite was supposed to have produced.
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
