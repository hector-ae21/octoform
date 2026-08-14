#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Refuse to run a build that is older than the source it was built from.
 *
 * This command runs `dist/`, not `src/`, so editing the source and running the
 * CLI happily executes the previous build — with no error, no warning, and
 * output that looks entirely legitimate. It cost a real debugging session:
 * `apply` applied the settings the old build knew about and silently skipped a
 * policy the new source had just added, which reads as "the tool ignored my
 * configuration" rather than "you did not rebuild".
 *
 * Only checked when `src/` is actually present. An installed copy from npm
 * ships `dist/` alone, where there is nothing to compare against and nothing
 * that could be stale.
 */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

try {
  const source = newestMtime(join(root, 'src'));
  const built = newestMtime(join(root, 'dist'));
  if (source > built) {
    console.error(
      'src/ is newer than dist/, and this command runs dist/.\n' +
        'Run `npm run build` first — otherwise you are testing the previous build,\n' +
        'which fails by quietly doing less than you asked for rather than by erroring.',
    );
    process.exit(1);
  }
} catch {}

const { main } = await import('../dist/cli.js');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
