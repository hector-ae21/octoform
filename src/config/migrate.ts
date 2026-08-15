/**
 * Converting a legacy single-owner configuration file to the multi-owner
 * shape, without changing what it means.
 *
 * Operates on the YAML document tree, not on parsed plain objects: moving
 * whole key/value pairs, rather than resolved values, is what keeps a
 * comment attached to the key it was written above. `imports` and `policies`
 * are left exactly where they are — only the owner-scoped keys move, because
 * they are the only ones whose meaning depends on which owner they belong to.
 */

import { Pair, Scalar, YAMLMap, parseDocument } from 'yaml';
import { ConfigError } from './resolve.js';
import type { MigratedConfig } from '../types/index.js';

export type { MigratedConfig } from '../types/index.js';

const OWNER_SCOPED_KEYS = ['classify', 'audit', 'defaults', 'types', 'repos', 'exclude'];

/**
 * Migrate one file's raw content in memory. Never touches disk.
 *
 * Rejects a file that has already been migrated, or one that never declared
 * a single `owner` to migrate in the first place — both are reported as
 * errors rather than silently returning the input unchanged, so a caller
 * cannot mistake "nothing to do" for "it worked."
 */
export function migrateToMultiOwner(raw: string, sourcePath: string): MigratedConfig {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new ConfigError(`${sourcePath}: ${doc.errors[0]?.message ?? 'invalid YAML'}`);
  }

  if (!(doc.contents instanceof YAMLMap)) {
    throw new ConfigError(`${sourcePath} is not a YAML mapping.`);
  }
  /**
   * Widened from the parser's own node types, which reject the synthetic
   * pairs this function builds below: those never had a source range to
   * begin with.
   */
  const root = doc.contents as YAMLMap;

  if (root.items.some((pair) => keyName(pair) === 'owners')) {
    throw new ConfigError(`${sourcePath} already declares "owners" — it is already migrated.`);
  }
  const ownerPair = root.items.find((pair) => keyName(pair) === 'owner');
  if (!ownerPair) {
    throw new ConfigError(`${sourcePath} has no root "owner" — there is nothing to migrate.`);
  }

  const owner = doc.get('owner');
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new ConfigError(`${sourcePath}: "owner" must be a non-empty string.`);
  }

  /**
   * A comment written above `owner:` is attached to that key, not to the
   * file. Deleting the key would delete the comment with it, so it is
   * rescued here and reattached to whatever ends up first in the file.
   */
  const leadingComment = ownerPair.key instanceof Scalar ? ownerPair.key.commentBefore : undefined;

  const insertAt = root.items.indexOf(ownerPair);
  const moved: Pair[] = [];
  root.items = root.items.filter((pair) => {
    const key = keyName(pair);
    if (key === 'owner') return false;
    if (OWNER_SCOPED_KEYS.includes(key ?? '')) {
      moved.push(pair);
      return false;
    }
    return true;
  });

  const ownerBlock = new YAMLMap();
  ownerBlock.items = moved;
  const owners = new YAMLMap();
  owners.set(owner, ownerBlock);
  root.items.splice(
    Math.min(insertAt, root.items.length),
    0,
    new Pair(new Scalar('owners'), owners),
  );

  if (!root.items.some((pair) => keyName(pair) === 'version')) {
    root.items.unshift(new Pair(new Scalar('version'), new Scalar(1)));
  }

  if (leadingComment) {
    const first = root.items[0];
    if (first?.key instanceof Scalar) first.key.commentBefore = leadingComment;
  }

  return { yaml: doc.toString(), owner };
}

function keyName(pair: Pair): string | undefined {
  const key = pair.key;
  return key instanceof Scalar && typeof key.value === 'string' ? key.value : undefined;
}
