import { UNREADABLE } from '../config/types.js';
import type { Change } from '../config/types.js';

/** One planned change, as a single line: `key: from -> to`. */
export function formatChange(change: Change): string {
  const suffix = change.blocked ? `  [skipped: ${change.blocked}]` : '';
  return `${change.key}: ${display(change.from)} -> ${display(change.to)}${suffix}`;
}

/**
 * GitHub represents "not set" as null, undefined or an empty string depending
 * on the field, and an empty topic list as an empty array. Spelling each out
 * beats printing a blank where a value should be.
 */
export function display(value: unknown): string {
  if (value === UNREADABLE) return '(unreadable)';
  if (value === null || value === undefined) return '(unset)';
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  if (value === '') return '(empty)';
  return String(value);
}

export function groupByRepo(changes: Change[]): Array<[string, Change[]]> {
  const map = new Map<string, Change[]>();
  for (const change of changes) {
    const list = map.get(change.repo) ?? [];
    list.push(change);
    map.set(change.repo, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
