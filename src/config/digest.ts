/**
 * Reproducible digests of configuration content and structure.
 *
 * Both digests exist so a saved plan can prove, before it is ever applied,
 * that nothing about what produced it has changed: not the file content
 * (`sourceDigest`), and not what that content resolved to for the owners the
 * plan actually covers (`configDigest`). Key order in the input JSON must
 * never affect either digest, which is why both canonicalize before hashing
 * rather than hashing `JSON.stringify` directly.
 */

import { createHash } from 'node:crypto';

/** SHA-256 of raw file content, hex-encoded. */
export function sourceDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * SHA-256 of a value's canonical JSON form: object keys sorted recursively,
 * so two structurally identical values always hash the same regardless of
 * the order their keys happened to be constructed in.
 */
export function structuralDigest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}
