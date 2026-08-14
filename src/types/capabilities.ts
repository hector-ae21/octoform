/** Types for evidence-based capability decisions and owner discovery. */

import type { OwnerKind } from './repository.js';

/**
 * What octoform decided about one capability, never a bare boolean.
 *
 * `unknown` and `forbidden` are deliberately distinct from `unsupported`: a
 * planner that cannot tell "GitHub says no" from "I could not find out" would
 * report the same blocked change for two situations an operator needs to
 * react to differently.
 */
export type CapabilityStatus =
  /** The capability is available and can be planned. */
  | 'supported'
  /** GitHub does not offer this capability at all for this resource. */
  | 'unsupported'
  /** The token or account is not permitted to use it. */
  | 'forbidden'
  /** The evidence gathered does not prove either answer. */
  | 'unknown'
  /** The capability has no meaning for this kind of owner. */
  | 'not-applicable'
  /** Evidence suggests the capability exists but is not usable right now. */
  | 'temporarily-unavailable';

/** Where the evidence for a capability decision came from. */
export type CapabilitySource = 'endpoint' | 'permission' | 'owner-kind' | 'resource-state';

/** A capability decision, with the evidence a human would need to act on it. */
export interface CapabilityResult {
  status: CapabilityStatus;
  /** A sentence explaining the status, meant to be printed as-is. */
  reason: string;
  source: CapabilitySource;
  /** When the evidence was gathered, so a cached answer can be told apart from a fresh one. */
  observedAt: string;
}

/** The authenticated token's own identity, when the token type exposes one. */
export interface Actor {
  login: string;
}

/** What discovery resolved about one configured owner. */
export interface OwnerDiscovery {
  login: string;
  kind: OwnerKind;
  /** GitHub's numeric identity for this owner, stable across renames. */
  id: number;
}

/**
 * The core REST rate-limit budget, read from a response's own headers rather
 * than a dedicated request — every authenticated response already carries it.
 */
export interface RateLimitStatus {
  remaining?: number;
  limit?: number;
  /** Unix timestamp (seconds) of the next reset. */
  reset?: number;
}
