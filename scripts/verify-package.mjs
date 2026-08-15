import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = await mkdtemp(resolve(tmpdir(), 'octoform-package-'));

try {
  const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  const quickStart = section(readme, '## Safe quick start', '## Configuration model');
  const configurations = fences(quickStart, 'yaml');
  const shellBlocks = fences(quickStart, 'bash');
  if (configurations.length !== 1) throw new Error('Safe quick start must contain one YAML block');
  if (shellBlocks.length !== 2) throw new Error('Safe quick start must contain two shell blocks');

  const pack = JSON.parse(
    runNpm(['pack', '--json', '--pack-destination', workspace, '--ignore-scripts'], root),
  );
  const packed = pack[0];
  if (!packed?.filename || !Array.isArray(packed.files)) {
    throw new Error('npm pack returned no artifact');
  }

  const packagedPaths = packed.files.map(({ path }) => path).sort();
  const required = [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'bin/octoform.js',
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ];
  for (const path of required) {
    if (!packagedPaths.includes(path)) throw new Error(`Packed package is missing ${path}`);
  }

  const forbidden = packagedPaths.filter(
    (path) =>
      /^(?:\.codex|\.github|docs|examples|reference|scripts|src|test)(?:\/|$)/u.test(path) ||
      /(?:^|\/)[^/]+\.test\.(?:d\.ts|js|js\.map)$/u.test(path) ||
      /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/u.test(path),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Packed package contains private or development files: ${forbidden.join(', ')}`,
    );
  }

  const installRoot = resolve(workspace, 'install');
  const tarball = resolve(workspace, packed.filename);
  runNpm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--prefix',
      installRoot,
      tarball,
    ],
    root,
  );

  const packageRoot = resolve(installRoot, 'node_modules', metadata.name);
  const policyPath = resolve(installRoot, 'octoform.yml');
  await writeFile(policyPath, configurations[0], 'utf8');
  const smokePath = resolve(installRoot, 'smoke.mjs');
  await writeFile(smokePath, smokeProgram(metadata.name, policyPath), 'utf8');
  run(process.execPath, [smokePath], installRoot);

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

  console.log(
    `Verified ${metadata.name}@${metadata.version}: ${packagedPaths.length} files, clean install, import, configuration, plan, and CLI help.`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function smokeProgram(packageName, policyPath) {
  return `import assert from 'node:assert/strict';
import { capability, loadConfig, planRepo, resolvePolicy } from ${JSON.stringify(packageName)};

const config = loadConfig(${JSON.stringify(policyPath)});
assert.equal(config.version, 1);
assert.equal(config.owners.length, 1);
const [scope] = config.owners;
assert.equal(scope.owner, 'your-account');
const repository = {
  name: 'example',
  visibility: 'public',
  archived: false,
  default_branch: 'main',
  description: null,
  homepage: null,
  topics: [],
  settings: {
    'features.issues': true,
    'features.wiki': true,
    'merge.delete_branch_on_merge': false,
    'repo.description': null,
    'repo.topics': [],
  },
};
const changes = planRepo(scope.owner, repository, resolvePolicy(scope, repository), {
  rulesetCapability: capability('supported', 'public repository', 'resource-state'),
});
assert.equal(changes.length, 1);
assert.equal(changes[0]?.key, 'merge.delete_branch_on_merge');
assert.equal(changes[0]?.id, 'your-account/example#merge.delete_branch_on_merge');
assert.equal(changes[0]?.owner, 'your-account');
assert.equal(changes[0]?.risk, 'normal');
console.log('Installed package import, configuration, and plan succeeded.');
`;
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
