/** Shapes describing what the GitHub API told octoform about an owner. */

import type { OwnerKind } from './repository.js';

/** Observable owner limits used to explain audit and planning behavior. */
export interface PlanLimits {
  ownerKind: OwnerKind;
  /** Account plan name as GitHub reports it, when visible. Organisations only. */
  plan?: string;
  /**
   * Whether organisation-wide rulesets are available. Always false for a
   * personal account — it is not a plan restriction there, there is simply no
   * such concept — and probed for an organisation, since it needs a paid plan.
   */
  orgRulesets: boolean;
}
