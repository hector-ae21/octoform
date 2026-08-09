// Runs the compiled tests by naming each file explicitly, rather than
// relying on `node --test`'s own path/glob handling.
//
// Every variant of that was tried and failed differently across the CI
// matrix, and all three failures trace back to the same thing: the compiled
// output lives under .test-build, a dot-prefixed directory. `node --test`'s
// default discovery (no path given) treats dot directories as invisible and
// fell through to the real test/*.ts sources instead — which fail, since
// their `../src/x.js` imports only resolve once compiled, and Node was
// running them as TypeScript directly. An explicit directory argument
// resolved as a plain module specifier instead of a directory to scan, and
// an explicit glob pattern found nothing, for the same dot-exclusion reason
// glob implementations apply by convention.
//
// fs.readdirSync has no such convention — it just lists what is there — so
// building the file list this way sidesteps every one of those questions,
// and the way the list is passed to node (spawnSync with an explicit argv
// array) is the single most basic, unambiguous form node --test supports:
// a literal list of files, with no discovery or pattern matching involved.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const dir = '.test-build/test';
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => `${dir}/${name}`);

if (files.length === 0) {
  console.error(`No compiled test files found in ${dir}. Did the build step run?`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
