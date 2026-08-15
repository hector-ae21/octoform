/** Types describing what `apply` accepts and what it produces. */

import type { Change } from './repository.js';

/** Repository selection and confirmation controls for {@link apply}. */
export interface ApplyOptions {
  repo?: string;
  type?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Repositories applied to at once. Defaults to the documented concurrency default. */
  concurrency?: number;
}

/** The outcome of carrying out one change against the GitHub API. */
export interface AppliedChange extends Change {
  /**
   * `blocked` means the change was never attempted, because an operation it
   * depends on failed in this same run. Kept distinct from `failed`: nothing
   * was sent, so nothing is half-done, and the run reports the blocked class
   * rather than the failed one.
   */
  outcome: 'applied' | 'failed' | 'blocked';
  /** The failure, or the reason nothing was attempted. */
  error?: string;
}

/** Stable, machine-readable counts for one owner's apply, or a run's total. */
export interface ApplySummary {
  applied: number;
  failed: number;
  /** Carried over from planning; never attempted. */
  blocked: number;
}

/** What {@link apply} reports for one owner. */
export interface ApplyRunResult {
  status: number;
  summary: ApplySummary;
}
