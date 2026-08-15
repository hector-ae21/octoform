/**
 * Comparison for the collections a repository carries: labels, milestones and
 * custom property values.
 *
 * They have one problem in common. Each entry has a human name that is also
 * the only handle a configuration can address it by, and each of those names
 * can be changed on GitHub without the thing itself being replaced. So a
 * declared name that does not match anything is ambiguous — a new entry, or an
 * old one somebody renamed — and guessing wrong destroys work: recreating a
 * label loses it from every issue it was on.
 *
 * `rename_from` resolves that ambiguity the way the repository and default
 * branch renames already do. It is the configuration saying which old name it
 * expects, so the rename only fires when it was actually anticipated.
 */

import type {
  ExistingLabel,
  ExistingMilestone,
  LabelPolicy,
  MilestonePolicy,
} from '../types/index.js';

/**
 * A label colour as GitHub stores it: six lower-case hex digits, no `#`.
 *
 * A policy may write it either way and in either case. Normalising here is
 * what stops `#D73A4A` and `d73a4a` reading as a difference that gets planned
 * on every run and applied to no effect.
 */
export function normalizeColor(color: string): string {
  return color.replace(/^#/, '').toLowerCase();
}

/**
 * The calendar day of a milestone's due date, in UTC.
 *
 * A due date is a day, but GitHub stores it as a timestamp and picks the time
 * itself. That time is not something a policy states and not something anyone
 * asked for, so comparing it would report a difference nobody could resolve.
 */
export function dueDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

/** A due date as the timestamp GitHub's endpoints take. */
export function dueTimestamp(value: string): string {
  return value.length === 10 ? `${value}T00:00:00Z` : value;
}

/**
 * The existing entry a declared one refers to.
 *
 * The declared name wins when something already has it. Only when nothing does
 * is `rename_from` consulted, so a policy that renames `a` to `b` on a
 * repository that already has both leaves `a` alone rather than colliding two
 * entries into one.
 */
export function matchByName<T>(
  existing: ReadonlyMap<string, T>,
  name: string,
  renameFrom: readonly string[] | undefined,
): { entry: T; renamedFrom?: string } | undefined {
  const direct = existing.get(name);
  if (direct !== undefined) return { entry: direct };

  for (const old of renameFrom ?? []) {
    const found = existing.get(old);
    if (found !== undefined) return { entry: found, renamedFrom: old };
  }
  return undefined;
}

/** Whether a stored label already says everything the policy declares. */
export function sameLabel(current: ExistingLabel, declared: LabelPolicy): boolean {
  if (current.name !== declared.name) return false;
  if (declared.color !== undefined && current.color !== normalizeColor(declared.color)) {
    return false;
  }
  if (declared.description !== undefined && (current.description ?? '') !== declared.description) {
    return false;
  }
  return true;
}

/** Whether a stored milestone already says everything the policy declares. */
export function sameMilestone(current: ExistingMilestone, declared: MilestonePolicy): boolean {
  if (current.title !== declared.title) return false;
  if (declared.state !== undefined && current.state !== declared.state) return false;
  if (declared.description !== undefined && (current.description ?? '') !== declared.description) {
    return false;
  }
  if (declared.due !== undefined && current.due !== dueDate(dueTimestamp(declared.due))) {
    return false;
  }
  return true;
}

/** A label in one line, for the report. */
export function describeLabel(label: LabelPolicy | ExistingLabel): string {
  const parts = [label.name];
  if (label.color) parts.push(`#${normalizeColor(label.color)}`);
  if (label.description) parts.push(label.description);
  return parts.join(' ');
}

/** A milestone in one line, for the report. */
export function describeMilestone(milestone: MilestonePolicy | ExistingMilestone): string {
  const parts = [milestone.title];
  if (milestone.state) parts.push(milestone.state);
  const due = 'due' in milestone ? milestone.due : undefined;
  if (due) parts.push(`due ${dueDate(dueTimestamp(due)) ?? due}`);
  if (milestone.description) parts.push(milestone.description);
  return parts.join('; ');
}

/**
 * Whether a stored property value already says what the policy declares.
 *
 * A multi-select is a set: GitHub returns its values in whatever order it
 * stored them, and a policy listing the same values in another order is not
 * asking for anything to change.
 */
export function samePropertyValue(
  current: string | string[] | undefined,
  declared: string | string[],
): boolean {
  if (isCleared(declared)) return current === undefined;
  if (Array.isArray(declared) || Array.isArray(current)) {
    const a = [
      ...(Array.isArray(current) ? current : current === undefined ? [] : [current]),
    ].sort();
    const b = [...(Array.isArray(declared) ? declared : [declared])].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return current === declared;
}

/**
 * Whether a declared value asks for the property to be unset.
 *
 * `null` already means "stop managing this" everywhere in the configuration,
 * so it cannot also mean "remove the value". An empty value is the same
 * absence a repository description uses, which is a convention the
 * configuration already has rather than a token invented here.
 */
export function isCleared(declared: string | string[]): boolean {
  return Array.isArray(declared) ? declared.length === 0 : declared === '';
}

/** A property value in one line, for the report. */
export function describePropertyValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}
