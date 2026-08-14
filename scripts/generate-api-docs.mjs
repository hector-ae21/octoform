import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const typedoc = resolve(root, 'node_modules/typedoc/bin/typedoc');
const options = resolve(root, 'typedoc.json');
const committedOutput = resolve(root, 'reference/api.json');
const check = process.argv.slice(2).includes('--check');
const temporaryRoot = check ? await mkdtemp(resolve(tmpdir(), 'octoform-api-docs-')) : undefined;
const output = temporaryRoot ? resolve(temporaryRoot, 'api.json') : committedOutput;

try {
  const result = spawnSync(process.execPath, [typedoc, '--options', options, '--json', output], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);

  const generatedReference = JSON.parse(await readFile(output, 'utf8'));
  await writeFile(output, `${JSON.stringify(normalizeStrings(generatedReference), null, '\t')}\n`);

  if (check) {
    const [actual, expected] = await Promise.all([
      readFile(output, 'utf8'),
      readFile(committedOutput, 'utf8'),
    ]);
    if (actual !== expected) {
      throw new Error(
        'The public API reference is stale. Run npm run api-docs and commit reference/api.json.',
      );
    }
    console.log('Public API reference is current.');
  }
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}

function normalizeStrings(value) {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n');
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeStrings(item)]),
  );
}
