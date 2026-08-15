/** Types describing which configuration declarations apply to which owner kind. */

import type { OwnerKind } from './repository.js';

/** One configuration path that applies to only one kind of owner. */
export interface Applicability {
  /** Dotted path of the declaration, relative to the owner. */
  path: string;
  /** The owner kinds the declaration means something for. */
  appliesTo: readonly OwnerKind[];
  /** Why it does not apply elsewhere, and what happens instead. */
  reason: string;
}

/** One declaration that does not apply to the owner that declared it. */
export interface NotApplicable {
  owner: string;
  path: string;
  reason: string;
}
