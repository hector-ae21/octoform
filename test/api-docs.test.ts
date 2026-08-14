import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

type ApiReflection = {
  name: string;
};

type ApiReference = {
  schemaVersion: string;
  name: string;
  children?: ApiReflection[];
};

const root = process.cwd();

test('the API reference covers every supported package export', async () => {
  const [entryPoint, referenceSource] = await Promise.all([
    readFile(resolve(root, 'src/index.ts'), 'utf8'),
    readFile(resolve(root, 'reference/api.json'), 'utf8'),
  ]);
  const sourceFile = ts.createSourceFile('src/index.ts', entryPoint, ts.ScriptTarget.Latest, true);
  const exports = sourceFile.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
    if (!ts.isNamedExports(statement.exportClause)) return [];
    return statement.exportClause.elements.map((element) => element.name.text);
  });
  const reference = JSON.parse(referenceSource) as ApiReference;
  const documented = reference.children?.map((reflection) => reflection.name) ?? [];

  assert.equal(reference.schemaVersion, '2.0');
  assert.equal(reference.name, 'Octoform API');
  assert.deepEqual(documented.sort(), exports.sort());
});

test('the API reference contains no absolute filesystem paths', async () => {
  const reference = JSON.parse(await readFile(resolve(root, 'reference/api.json'), 'utf8')) as unknown;
  for (const value of stringValues(reference)) {
    assert.doesNotMatch(value, /^[A-Za-z]:[\\/]/);
    assert.doesNotMatch(value, /^\/(?:home|Users)\//);
  }
});

function* stringValues(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* stringValues(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) yield* stringValues(item);
  }
}
