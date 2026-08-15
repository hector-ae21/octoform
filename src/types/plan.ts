/** Types describing what `plan` needs and what it returns. */

import type { CapabilityResult } from './capabilities.js';
import type { Change } from './repository.js';

/** Capability evidence required to plan one repository safely. */
export interface PlanOptions {
  /** Whether rulesets can be managed on this repository, and why. */
  rulesetCapability: CapabilityResult;
}

/** A repository whose plan could not even be computed. */
export interface PlanError {
  repo: string;
  message: string;
}

/** Repository selection and concurrency controls for {@link plan}. */
export interface PlanSelector {
  repo?: string;
  type?: string;
  /** Repositories planned at once. Defaults to the documented concurrency default. */
  concurrency?: number;
}

/** Mutable and blocked operations produced by a read-only plan. */
export interface PlanResult {
  changes: Change[];
  blocked: Change[];
  /**
   * Repositories that raised instead of producing a plan. Never treated as
   * "no changes": a repository this run could not even examine says nothing
   * about whether it matches its policy.
   */
  errors: PlanError[];
  /** Repositories the selection matched, before any of them were examined. */
  scanned: number;
}

/** Stable, machine-readable counts for one owner's plan, or a run's total. */
export interface PlanSummary {
  /** Repositories the selection matched, before any of them were examined. */
  scanned: number;
  /** Repositories with at least one unblocked change. */
  changed: number;
  /** Repositories with at least one blocked change and no unblocked one. */
  blocked: number;
  /**
   * Repositories with at least one blocked change, whether or not they also
   * have unblocked ones. Always at least `blocked`, and the honest answer to
   * "how much of this plan cannot be applied": the exclusive buckets sum to
   * `scanned`, which necessarily files a repository that both changed and was
   * blocked under `changed` alone.
   */
  blockedRepositories: number;
  /** Repositories whose plan could not be computed at all. */
  failed: number;
  /** Repositories that matched their policy exactly. */
  unchanged: number;
}
