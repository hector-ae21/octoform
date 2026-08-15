import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { ConfigError, loadConfig, loadConfigWithSources } from '../config/resolve.js';
import {
  declaresRootRepositories,
  migrateToMultiOwner,
  moveRepositoriesUnderOwner,
} from '../config/migrate.js';
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
  const migrated = migrateToMultiOwner(readFileSync(path, 'utf8'), path);
  const stranded = strandedImports(path).map((source) => ({
    path: source,
    // Shown the way the root file declares it, rather than as the absolute
    // path resolution produced, so the preview matches what is in `imports`.
    shown: relative(dirname(path), source).split(sep).join('/'),
    ...moveRepositoriesUnderOwner(readFileSync(source, 'utf8'), migrated.owner, source),
  }));
  const files = [{ path, shown: path, ...migrated }, ...stranded];

  if (!options.write) {
    for (const file of files) {
      console.log(`# ${file.shown}`);
      console.log(file.yaml);
    }
    console.error(
      `\nPreview only. Re-run with --write to update ${describe(files.length)} in place.`,
    );
    return 0;
  }

  /**
   * Every file is checked before any of them is written. A migration that
   * converted the root and then refused an import would leave exactly the
   * broken state this whole feature exists to avoid.
   */
  const states = files.map((file) => ({ ...file, dirty: uncommittedChanges(file.path) }));
  const blocked = states.filter((file) => file.dirty === true);
  if (blocked.length > 0) {
    throw new ConfigError(
      `${blocked.map((file) => file.shown).join(', ')} ${blocked.length === 1 ? 'has' : 'have'} ` +
        `uncommitted changes. Commit or stash them first, so the migration can be reviewed as ` +
        `its own diff. Nothing was written.`,
    );
  }

  for (const file of states) writeFileSync(file.path, file.yaml, 'utf8');

  console.log(`Migrated ${describe(files.length)} for owner "${migrated.owner}":`);
  for (const file of states) console.log(`  ${file.shown}`);
  if (states.some((file) => file.dirty === undefined)) {
    console.log('(Not inside a git working tree — nothing checked before writing.)');
  }
  return 0;
}

function describe(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/**
 * Imported files whose root `repos` block the root conversion would strand.
 *
 * Such a block is legal beside a root `owner` and rejected beside `owners`, so
 * converting the root on its own turns a configuration that loads into one
 * that does not. `0.4.1` refused the whole migration for this reason; the
 * files are now converted alongside the root instead, which is why this
 * returns them rather than throwing.
 *
 * Sorted so two runs over the same configuration migrate in the same order and
 * print the same preview.
 */
function strandedImports(path: string): string[] {
  const { sourceDigests } = loadConfigWithSources(path);
  const root = resolve(path);
  return Object.keys(sourceDigests)
    .filter((source) => source !== root)
    .filter((source) => declaresRootRepositories(readFileSync(source, 'utf8')))
    .sort();
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
      // Outside a working tree git says so on stderr, which is this function's
      // answer rather than something the operator needs to read.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim().length > 0;
  } catch {
    return undefined;
  }
}
