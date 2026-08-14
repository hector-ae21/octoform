import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const verifier = resolve(process.cwd(), 'scripts/verify-source-policy.mjs');

test('valid TSDoc comments pass the source policy', async () => {
  const result = await verify({
    'src/example.ts': '/** A supported value. */\nexport const value = 1;\n',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('line comments fail the source policy', async () => {
  const result = await verify({ 'src/example.ts': '// narrative\nexport const value = 1;\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only TSDoc block comments are permitted/);
});

test('invalid TSDoc syntax fails the source policy', async () => {
  const result = await verify({
    'src/example.ts': '/** A value > another value. */\nexport const value = 1;\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /character should be escaped/);
});

test('private planning references fail the source policy', async () => {
  const marker = ['.codex', 'proposal', 'TASKS.md'].join('/');
  const result = await verify({ 'README.md': `Internal details: ${marker}\n` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /references private planning material/);
});

async function verify(contents: Record<string, string>) {
  const root = await mkdtemp(resolve(tmpdir(), 'octoform-source-policy-'));
  try {
    for (const [path, content] of Object.entries(contents)) {
      const target = resolve(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    return spawnSync(process.execPath, [verifier, root], { encoding: 'utf8' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
