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
  outcome: 'applied' | 'failed';
  /** Present only when outcome is 'failed'. */
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
