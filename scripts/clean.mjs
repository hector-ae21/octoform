import { rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = new Map([
  ['build', resolve(root, 'dist')],
  ['test', resolve(root, '.test-build')],
]);
const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : [...targets.keys()];

for (const name of names) {
  if (!targets.has(name)) throw new Error(`Unknown clean target: ${name}`);
}

for (const name of new Set(names)) {
  const target = targets.get(name);
  const localPath = target ? relative(root, target) : '..';
  if (!target || localPath.startsWith('..') || localPath === '') {
    throw new Error(`Refusing to clean outside the project: ${target ?? name}`);
  }
  await rm(target, { recursive: true, force: true });
}

console.log(`Cleaned ${[...new Set(names)].join(', ')} output.`);
