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

/** Per-repository capability evidence, gathered on request. */
export interface InspectedRepository {
  name: string;
  visibility: string;
  /** Whether rulesets can be managed here, and what said so. */
  rulesets: CapabilityResult;
}
