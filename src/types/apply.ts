/** Types describing what `apply` accepts and what it produces. */

import type { Change } from './repository.js';

/** Repository selection and confirmation controls for {@link apply}. */
export interface ApplyOptions {
  repo?: string;
  type?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
}

/** The outcome of carrying out one change against the GitHub API. */
export interface AppliedChange extends Change {
  outcome: 'applied' | 'failed';
  /** Present only when outcome is 'failed'. */
  error?: string;
}
