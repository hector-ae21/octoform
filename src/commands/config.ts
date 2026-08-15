import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ConfigError, loadConfig, loadConfigWithSources } from '../config/resolve.js';
import { declaresRootRepositories, migrateToMultiOwner } from '../config/migrate.js';
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
  refuseStrandedImports(path);

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
 * Refuse a migration that the file's own imports would invalidate.
 *
 * Only the root file is converted, so a `repos` block at the root of an
 * imported file stays where it is. That block is legal beside a root `owner`
 * and rejected beside `owners`, which means converting the root alone turns a
 * configuration that loads into one that does not. Rewriting the import
 * instead is not this command's business — the operator did not offer that
 * file — so the migration stops and says which file has to move first.
 */
function refuseStrandedImports(path: string): void {
  const { sourceDigests } = loadConfigWithSources(path);
  const root = resolve(path);
  const stranded = Object.keys(sourceDigests)
    .filter((source) => source !== root)
    .filter((source) => declaresRootRepositories(readFileSync(source, 'utf8')));
  if (stranded.length === 0) return;

  throw new ConfigError(
    `${path} cannot be migrated automatically. ${stranded.join(', ')} ` +
      `${stranded.length === 1 ? 'declares' : 'declare'} "repos" at the root, and only the file ` +
      `you named is converted. A bare repository name does not identify anything once more than ` +
      `one account is in scope, so migrating this file alone would leave a configuration that no ` +
      `longer loads. Move those entries under the account they belong to, then migrate again.`,
  );
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
