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
