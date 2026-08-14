import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = await mkdtemp(resolve(tmpdir(), 'octoform-readme-'));

try {
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  const quickStart = section(readme, '## Safe quick start', '## Configuration model');
  const configurations = fences(quickStart, 'yaml');
  const shellBlocks = fences(quickStart, 'bash');
  if (configurations.length !== 1) throw new Error('Safe quick start must contain one YAML block');
  if (shellBlocks.length !== 2) throw new Error('Safe quick start must contain two shell blocks');

  runNpm(['run', 'build'], root);
  const pack = JSON.parse(runNpm(['pack', '--json', '--pack-destination', workspace], root));
  const packed = pack[0];
  if (!packed?.filename || !Array.isArray(packed.files))
    throw new Error('npm pack returned no artifact');

  const packagedPaths = packed.files.map(({ path }) => path);
  for (const required of [
    'README.md',
    'LICENSE',
    'bin/octoform.js',
    'dist/index.js',
    'dist/index.d.ts',
  ]) {
    if (!packagedPaths.includes(required)) throw new Error(`Packed package is missing ${required}`);
  }
  const duplicateDocumentation = packagedPaths.filter(
    (path) => path === 'example.yml' || path.startsWith('docs/') || path.startsWith('examples/'),
  );
  if (duplicateDocumentation.length > 0) {
    throw new Error(
      `Packed package contains migrated documentation: ${duplicateDocumentation.join(', ')}`,
    );
  }

  const installRoot = resolve(workspace, 'install');
  const tarball = resolve(workspace, packed.filename);
  runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installRoot, tarball],
    root,
  );

  const packageRoot = resolve(installRoot, 'node_modules/@hector21/octoform');
  const policyPath = resolve(workspace, 'octoform.yml');
  await writeFile(policyPath, configurations[0], 'utf8');
  const { loadConfig } = await import(pathToFileURL(resolve(packageRoot, 'dist/index.js')).href);
  const config = loadConfig(policyPath);
  if (config.owner !== 'your-account')
    throw new Error('Packed package did not load the README policy');

  const help = run(
    process.execPath,
    [resolve(packageRoot, 'bin/octoform.js'), '--help'],
    packageRoot,
  );
  for (const command of shellBlocks.flatMap(commands)) {
    const [name, ...args] = command.split(/\s+/u);
    if (name !== 'octoform') throw new Error(`Unexpected executable in quick start: ${name}`);
    const operation = args[0];
    if (!operation || !help.includes(`octoform ${operation}`)) {
      throw new Error(`Packed CLI help does not expose README command: ${command}`);
    }
    for (const flag of args.filter((value) => value.startsWith('--'))) {
      if (!help.includes(flag))
        throw new Error(`Packed CLI help does not expose README flag: ${flag}`);
    }
  }

  console.log('Validated README policy and commands against the packed package.');
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function section(document, start, end) {
  const from = document.indexOf(start);
  const to = document.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`README section boundary is missing: ${start}`);
  return document.slice(from, to);
}

function fences(document, language) {
  const marker = String.fromCharCode(96).repeat(3);
  return [
    ...document.matchAll(
      new RegExp(`${marker}${language}\\r?\\n([\\s\\S]*?)\\r?\\n${marker}`, 'gu'),
    ),
  ].map((match) => match[1]);
}

function commands(block) {
  return block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('octoform '));
}

function runNpm(args, cwd) {
  if (!process.env.npm_execpath) throw new Error('npm_execpath is unavailable');
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
