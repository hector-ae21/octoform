/**
 * Which planned operations depend on which others, and what that means when
 * one of them fails.
 *
 * Ordering alone was already handled, by writing the steps of `apply` in the
 * order they had to happen. That is enough right up until a step fails: the
 * sequence carries on regardless, so a ruleset naming the default branch is
 * still created after the rename that was supposed to give that branch its
 * name did not happen. The result is protection attached to a branch nobody
 * asked for, reported as applied.
 *
 * Modelling the edges instead of the sequence fixes both halves at once. The
 * order falls out of the graph, and a dependent whose prerequisite failed is
 * blocked rather than attempted — which is the same answer octoform already
 * gives whenever it cannot prove an operation is safe.
 *
 * The graph is owner-scoped because that is the widest thing an edge can
 * cross. A repository's ruleset can depend on that repository's rename; a
 * team's repository grant will depend on the team and the repository both
 * existing. Nothing depends on another account.
 */

import type { Change } from '../types/index.js';

/** One reason an operation cannot be attempted before another. */
export interface DependencyRule {
  /** Key, or key prefix, of the operation that has to wait. */
  dependent: string;
  /** Key of the operation it waits for. */
  requires: string;
  /** Why, phrased to be read as the blocked reason when the prerequisite fails. */
  because: string;
}

/**
 * Every edge octoform can currently draw.
 *
 * All three point at the default-branch rename for the same reason: each one
 * names a branch, and until the rename happens the name they were planned
 * against does not exist yet.
 */
export const DEPENDENCY_RULES: readonly DependencyRule[] = [
  {
    dependent: 'rulesets.',
    requires: 'default_branch.name',
    because: 'it targets branches by name and the default branch was not renamed',
  },
  {
    dependent: 'ensure_branches.',
    requires: 'default_branch.name',
    because: 'it branches from the default branch, which was not renamed',
  },
  {
    dependent: 'files.',
    requires: 'default_branch.name',
    because: 'it writes to the default branch, which was not renamed',
  },
];

/**
 * Fill in each change's prerequisites from the rules, for one repository's
 * planned changes.
 *
 * Only prerequisites that are themselves planned count. A ruleset does not
 * depend on a rename nobody asked for, so a run that changes no branch name
 * produces no edges at all.
 *
 * @param changes - Every change planned for one repository.
 */
export function withPrerequisites(changes: readonly Change[]): Change[] {
  const byKey = new Map(changes.map((change) => [change.key, change.id]));

  return changes.map((change) => {
    const prerequisites = DEPENDENCY_RULES.filter(
      (rule) => matches(change.key, rule.dependent) && byKey.has(rule.requires),
    )
      .map((rule) => byKey.get(rule.requires) as string)
      .filter((id) => id !== change.id);

    return { ...change, prerequisites: [...new Set(prerequisites)] };
  });
}

/**
 * Order changes so nothing is attempted before what it depends on.
 *
 * A stable topological sort: changes with no outstanding prerequisite keep
 * their planned order, which is already deterministic, so two runs over
 * unchanged state still produce the same sequence. A cycle cannot arise from
 * the rules above, but if one ever did the remaining changes are appended in
 * planned order rather than dropped — losing an operation silently would be
 * worse than running it in a questionable order.
 *
 * @param changes - Changes carrying their prerequisites.
 */
export function orderByDependency(changes: readonly Change[]): Change[] {
  const pending = [...changes];
  const satisfied = new Set<string>();
  const ordered: Change[] = [];

  while (pending.length > 0) {
    const index = pending.findIndex((change) =>
      change.prerequisites.every((id) => satisfied.has(id) || !known(changes, id)),
    );
    if (index === -1) {
      ordered.push(...pending);
      break;
    }
    const [next] = pending.splice(index, 1);
    if (!next) break;
    satisfied.add(next.id);
    ordered.push(next);
  }

  return ordered;
}

/**
 * The reason this change must not be attempted, given what has already
 * failed, or `undefined` when nothing stands in its way.
 *
 * @param change - The change about to be attempted.
 * @param failed - Ids of changes that were attempted and did not succeed.
 */
export function blockedByPrerequisite(
  change: Change,
  failed: ReadonlySet<string>,
): string | undefined {
  const unmet = change.prerequisites.find((id) => failed.has(id));
  if (unmet === undefined) return undefined;

  const rule = DEPENDENCY_RULES.find(
    (candidate) => matches(change.key, candidate.dependent) && unmet.endsWith(candidate.requires),
  );
  const because = rule?.because ?? 'an operation it depends on failed';
  return `not attempted: ${because}`;
}

function matches(key: string, dependent: string): boolean {
  return dependent.endsWith('.') ? key.startsWith(dependent) : key === dependent;
}

function known(changes: readonly Change[], id: string): boolean {
  return changes.some((change) => change.id === id);
}
