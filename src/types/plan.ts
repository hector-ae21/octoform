/** Types describing what `plan` needs and what it returns. */

import type { Change } from './repository.js';

/** Capability evidence required to plan one repository safely. */
export interface PlanOptions {
  /** False when the plan does not enforce rulesets on private repositories. */
  rulesetsEnforcedOnPrivate: boolean;
}

/** Mutable and blocked operations produced by a read-only plan. */
export interface PlanResult {
  changes: Change[];
  blocked: Change[];
}
