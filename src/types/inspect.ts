/** Types for the read-only `inspect` commands. */

import type { OwnerScope } from './config.js';
import type { OwnerDiscovery } from './capabilities.js';

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
}
