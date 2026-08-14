import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigError, loadConfig } from '../config/resolve.js';
import { migrateToMultiOwner } from '../config/migrate.js';
import type { MigrateOptions } from '../types/index.js';

/**
 * Load and resolve a configuration, reporting what it declares. Never
 * contacts GitHub: everything it checks is local to the file and its
 * imports, which is what makes it safe to run in a pull request from an
 * untrusted fork.
 */
export function validateConfig(path: string): number {
  const config = loadConfig(path);

  console.log(`${path} is valid (configuration contract version ${config.version}).`);
  console.log('');
  console.log(`${config.owners.length} owner(s):`);
  for (const scope of config.owners) {
    const types = Object.keys(scope.types ?? {}).length;
    const repos = Object.keys(scope.repos ?? {}).length;
    console.log(`  ${scope.owner}  (${types} type(s), ${repos} repo entry/entries declared)`);
  }
  return 0;
}

/**
 * Convert a legacy single-owner file to the multi-owner shape.
 *
 * Prints the result rather than writing it, unless `--write` is given. This
 * mirrors `plan`/`apply`: the destructive step is the one that needs to be
 * asked for explicitly.
 */
export function migrateConfig(path: string, options: MigrateOptions = {}): number {
  const raw = readFileSync(path, 'utf8');
  const migrated = migrateToMultiOwner(raw, path);

  if (!options.write) {
    console.log(migrated.yaml);
    console.error(`\nPreview only. Re-run with --write to update ${path} in place.`);
    return 0;
  }

  const dirty = uncommittedChanges(path);
  if (dirty === true) {
    throw new ConfigError(
      `${path} has uncommitted changes. Commit or stash them first, so the migration can be ` +
        `reviewed as its own diff.`,
    );
  }

  writeFileSync(path, migrated.yaml, 'utf8');
  console.log(`Migrated ${path} for owner "${migrated.owner}".`);
  if (dirty === undefined) {
    console.log('(Not inside a git working tree — nothing checked before writing.)');
  }
  return 0;
}

/**
 * Whether `path` has uncommitted changes, or `undefined` when it is not
 * inside a git working tree at all — in which case there is no dirty-tree
 * protection to offer, and none to refuse over either.
 */
function uncommittedChanges(path: string): boolean | undefined {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--', path], {
      cwd: dirname(path),
      encoding: 'utf8',
    });
    return status.trim().length > 0;
  } catch {
    return undefined;
  }
}
