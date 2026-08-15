/**
 * Which parts of a configuration mean anything for which kind of owner.
 *
 * Some GitHub features exist only for organisations. A shared preset has to
 * stay shareable, so declaring one of those under a personal account is not an
 * error by itself: it is reported as not applicable and the rest of the file
 * still applies. Authors who would rather be stopped can ask for that with
 * strict validation, and get the same list as failures instead.
 */

import type { Applicability, NotApplicable } from '../types/applicability.js';
import type { OwnerKind, OwnerScope } from '../types/index.js';

/**
 * The declarations whose applicability depends on owner kind.
 *
 * Everything absent from this list applies to every owner. Adding a resource
 * family that is organisation-only means adding it here, which is what keeps
 * the diagnostic and the documentation from being written separately.
 */
export const APPLICABILITY: readonly Applicability[] = [
  {
    path: 'classify.property',
    appliesTo: ['org'],
    reason:
      'custom properties are an organisation-only feature, so repository types come from ' +
      'the "repos" entries in the configuration file instead',
  },
];

/**
 * Report every declaration in this scope that its owner cannot use.
 *
 * Returns an empty list when the scope declares nothing owner-specific, which
 * is the common case and the reason this stays out of the planner.
 */
export function notApplicable(scope: OwnerScope, kind: OwnerKind): NotApplicable[] {
  const found: NotApplicable[] = [];
  for (const entry of APPLICABILITY) {
    if (entry.appliesTo.includes(kind)) continue;
    if (!isDeclared(scope, entry.path)) continue;
    found.push({ owner: scope.owner, path: entry.path, reason: entry.reason });
  }
  return found;
}

/** Phrase one finding as a sentence naming the owner, the path and the fallback. */
export function describeNotApplicable(finding: NotApplicable, kind: OwnerKind): string {
  const label = kind === 'org' ? 'an organisation' : 'a personal account';
  return `"${finding.owner}" is ${label}, so "${finding.path}" does not apply: ${finding.reason}.`;
}

function isDeclared(scope: OwnerScope, path: string): boolean {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined && current !== null;
}
