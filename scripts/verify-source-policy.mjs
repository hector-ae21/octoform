import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TSDocParser } from '@microsoft/tsdoc';
import ts from 'typescript';

const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.argv[2] ?? defaultRoot);
const codeRoots = ['src', 'bin', 'scripts'];
const codeExtensions = new Set(['.ts', '.js', '.mjs']);
const ignoredDirectories = new Set(['.git', '.test-build', 'dist', 'node_modules']);
const privateMarkers = [
  ['.codex', 'proposal'].join('/'),
  ['.codex', 'personal', 'octoform', 'proposal'].join('/'),
];
const allowedDirectives = new Set();
const parser = new TSDocParser();
const violations = [];

for (const directory of codeRoots) {
  for (const path of await files(resolve(root, directory))) {
    if (codeExtensions.has(extname(path))) await verifyComments(path);
  }
}

for (const path of await files(root)) {
  const extension = extname(path);
  if (!codeExtensions.has(extension) && !['.json', '.md', '.yml', '.yaml'].includes(extension)) continue;
  const source = (await readFile(path, 'utf8')).replaceAll('\\', '/');
  for (const marker of privateMarkers) {
    if (source.includes(marker)) violations.push(`${name(path)}: references private planning material`);
  }
}

if (violations.length > 0) {
  throw new Error(`Source policy violations:\n${violations.map((violation) => `- ${violation}`).join('\n')}`);
}

console.log('Source comments and public-reference boundaries are valid.');

async function verifyComments(path) {
  const source = await readFile(path, 'utf8');
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source,
  );

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const comment = scanner.getTokenText();
    const location = lineAndColumn(source, scanner.getTokenPos());
    if (allowedDirectives.has(comment.trim())) continue;
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || !comment.startsWith('/**')) {
      violations.push(`${name(path)}:${location}: only TSDoc block comments are permitted`);
      continue;
    }
    for (const message of parser.parseString(comment).log.messages) {
      violations.push(`${name(path)}:${location}: ${message.text}`);
    }
  }
}

async function files(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const paths = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await files(path));
    if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function lineAndColumn(source, position) {
  const before = source.slice(0, position);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  return `${line}:${position - lastBreak}`;
}

function name(path) {
  return relative(root, path).replaceAll('\\', '/');
}
