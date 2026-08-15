import { UNREADABLE } from '../config/sentinels.js';
import type { Change } from '../types/index.js';

/**
 * One planned change, as a single line: `key: from -> to`.
 *
 * A blocked change says why it will not happen; a warned one says what it will
 * break on its way through. Both are appended rather than filtered out — the
 * point of the report is that nothing is silently dropped.
 */
export function formatChange(change: Change): string {
  const suffix = change.blocked
    ? `  [skipped: ${printable(change.blocked)}]`
    : change.warning
      ? `  [warning: ${printable(change.warning)}]`
      : '';
  return `${change.key}: ${display(change.from)} -> ${display(change.to)}${suffix}`;
}

/**
 * Render a value that came from GitHub, or from a configuration file, safely
 * for a terminal.
 *
 * Repository names, descriptions, topics and property values are writable by
 * anyone with access to the account being audited, which is not always the
 * person running octoform. A control character in one of them is not a display
 * problem: an escape sequence can overwrite lines that were already printed,
 * hide a blocked change from the summary, or imitate the confirmation prompt
 * `apply` is about to show. Each one is replaced by its escaped form, so the
 * report shows what the value is instead of letting it act.
 */
export function printable(value: string): string {
  let rendered = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    rendered += control ? `\\x${code.toString(16).padStart(2, '0')}` : character;
  }
  return rendered;
}

/**
 * GitHub represents "not set" as null, undefined or an empty string depending
 * on the field, and an empty topic list as an empty array. Spelling each out
 * beats printing a blank where a value should be.
 */
export function display(value: unknown): string {
  if (value === UNREADABLE) return '(unreadable)';
  if (value === null || value === undefined) return '(unset)';
  if (Array.isArray(value))
    return value.length === 0 ? '(none)' : value.map((item) => printable(String(item))).join(', ');
  if (value === '') return '(empty)';
  return printable(String(value));
}

/**
 * Group changes by repository in stable repository-name order.
 *
 * A change with no repository belongs to the owner itself, and is grouped
 * under a heading that cannot be mistaken for a repository name — a
 * repository really can be called the same thing as the organisation that
 * owns it.
 */
export function groupByRepo(changes: Change[]): Array<[string, Change[]]> {
  const map = new Map<string, Change[]>();
  for (const change of changes) {
    const group = change.repo ?? `(${change.owner}: the organisation itself)`;
    const list = map.get(group) ?? [];
    list.push(change);
    map.set(group, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
