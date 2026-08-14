/** Types describing what `plan` needs and what it returns. */

import type { CapabilityResult } from './capabilities.js';
import type { Change } from './repository.js';

/** Capability evidence required to plan one repository safely. */
export interface PlanOptions {
  /** Whether rulesets can be managed on this repository, and why. */
  rulesetCapability: CapabilityResult;
}

/** Mutable and blocked operations produced by a read-only plan. */
export interface PlanResult {
  changes: Change[];
  blocked: Change[];
}
