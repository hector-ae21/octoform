/** Types for the read-only `inspect` commands. */

import type { OwnerScope } from './config.js';
import type { CapabilityResult, OwnerDiscovery } from './capabilities.js';

/** The envelope every `--format json` output is wrapped in. */
export interface OutputEnvelope<T> {
  schemaVersion: 1;
  command: string;
  data: T;
}

/** What `inspect config` reports for one owner: its fully resolved scope. */
export interface InspectedOwner {
  owner: string;
  resolved: OwnerScope;
}

/** What `inspect capabilities` reports for one owner. */
export interface InspectedCapabilities {
  discovery: OwnerDiscovery;
  /** Account plan name as GitHub reports it, when visible. Descriptive only. */
  plan?: string;
  /** Whether organisation-wide rulesets are available. Always false for a personal account. */
  organizationRulesets: boolean;
  /** Declarations in this owner's configuration that do not apply to its kind. */
  notApplicable: Array<{ path: string; reason: string }>;
  /**
   * Evidence for one named repository, when one was asked about.
   *
   * Rulesets on a private repository are the case this exists for. Whether
   * they can be managed there depends on the account's plan and on the token,
   * and neither is something octoform is willing to assume — so the answer is
   * an observation, reported with the evidence behind it, that anybody can
   * reproduce against their own repository before trusting a plan.
   */
  repository?: InspectedRepository;
}

/**
 * What `inspect members` reports for one organisation.
 *
 * Four listings and one answer. The listings are things GitHub will tell
 * anybody who asks; the answer is the part a configuration file makes
 * possible — which of the people it names are not in the organisation at all,
 * and would therefore be invited rather than granted anything.
 */
export interface InspectedMembers {
  owner: string;
  /** Logins with owner rights over the whole organisation. */
  admins: string[];
  /** Logins that are members without being owners. */
  members: string[];
  /** Logins with access to repositories without being members. */
  outsideCollaborators: string[];
  /**
   * Logins without two-factor authentication.
   *
   * Absent, rather than empty, when the question could not be asked: GitHub
   * only answers it for an organisation owner, and "nobody" and "I was not
   * allowed to look" are not the same finding.
   */
  withoutTwoFactor?: string[];
  pendingInvitations: InspectedInvitation[];
  /** Invitations GitHub gave up on, with the reason it recorded. */
  failedInvitations: InspectedInvitation[];
  /** People the configuration names who are not in the organisation. */
  notInTheOrganization: InspectedPerson[];
}

/**
 * An invitation exactly as GitHub's listings return it.
 *
 * Every field is optional because two different listings produce this shape
 * and only one of them fills in the failure fields.
 */
export interface RawInvitation {
  login?: string | null;
  email?: string | null;
  role?: string;
  created_at?: string;
  failed_at?: string | null;
  failed_reason?: string | null;
}

/**
 * Everyone the organisation knows, in whatever capacity it knows them,
 * gathered before any of it is compared against a configuration.
 */
export interface OrganizationPeople {
  admins: string[];
  members: string[];
  outsideCollaborators: string[];
  /** Absent when the token was not allowed to ask, which is not the same as nobody. */
  withoutTwoFactor?: string[];
  pending: RawInvitation[];
  failed: RawInvitation[];
}

/** One invitation, sent and unanswered or given up on. */
export interface InspectedInvitation {
  /** Null when the invitation went to an email address rather than an account. */
  login: string | null;
  email: string | null;
  /** The organisation role offered, in GitHub's spelling. */
  role: string;
  createdAt: string;
  /** Whole days since it was sent, which is what makes a stale one visible. */
  waitingDays: number;
  failedAt?: string;
  failedReason?: string;
}

/** Somebody the configuration names, and every place it names them. */
export interface InspectedPerson {
  login: string;
  named: string[];
}

/** Per-repository capability evidence, gathered on request. */
export interface InspectedRepository {
  name: string;
  visibility: string;
  /** Whether rulesets can be managed here, and what said so. */
  rulesets: CapabilityResult;
}
