/** Types describing what `audit` reports. */

/** One deviation from a declared audit expectation. */
export interface Finding {
  repo: string;
  issue: string;
}
