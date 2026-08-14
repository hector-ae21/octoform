import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const referenceRoot = resolve(root, 'reference');
const check = parseArgs(process.argv.slice(2));
const temporaryRoot = check ? await mkdtemp(resolve(tmpdir(), 'octoform-reference-')) : undefined;
const outputRoot = temporaryRoot ?? referenceRoot;
const diagnosticHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
};

try {
  const packageMetadata = parseJson(await readFile(resolve(root, 'package.json'), 'utf8'));
  const capabilityConfig = parseJson(
    await readFile(resolve(referenceRoot, 'capabilities.config.json'), 'utf8'),
  );
  const apiSurfaceConfig = parseJson(
    await readFile(resolve(referenceRoot, 'github-api-surface.config.json'), 'utf8'),
  );
  const cliContract = await loadTypeScriptExport(
    resolve(root, 'src/cli-contract.ts'),
    'CLI_CONTRACT',
  );
  const buildConfigModel = await loadTypeScriptExport(
    resolve(root, 'src/config/shape.ts'),
    'configModel',
  );
  const schema = generateConfigurationSchema();
  const planArtifactSchema = generatePlanArtifactSchema();
  const capabilities = generateCapabilities(capabilityConfig, packageMetadata.version);
  const permissions = generatePermissions(
    capabilityConfig,
    apiSurfaceConfig,
    packageMetadata.version,
  );
  const cli = { ...cliContract, productVersion: packageMetadata.version };
  const configModel = { ...buildConfigModel(), productVersion: packageMetadata.version };
  const generated = new Map([
    ['config.schema.json', json(schema)],
    ['plan-artifact.schema.json', json(planArtifactSchema)],
    ['config-model.json', json(configModel)],
    ['cli.json', json(cli)],
    ['capabilities.json', json(capabilities)],
    ['permissions.json', json(permissions)],
  ]);

  await mkdir(outputRoot, { recursive: true });
  for (const [name, content] of generated) {
    assertSafe(name, content);
    await writeFile(resolve(outputRoot, name), content);
  }

  const checksums = await generateChecksums(generated);
  assertSafe('SHA256SUMS', checksums);
  await writeFile(resolve(outputRoot, 'SHA256SUMS'), checksums);

  if (check) {
    for (const name of [...generated.keys(), 'SHA256SUMS']) {
      await assertCurrent(name);
    }
    console.log('Generated reference artifacts are current.');
  } else {
    console.log(`Generated ${generated.size} reference artifacts and SHA256SUMS.`);
  }
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArgs(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--check') return true;
  throw new Error(`Unknown argument: ${args.join(' ')}`);
}

function generateConfigurationSchema() {
  const generated = createGenerator({
    path: resolve(root, 'src/types/config.ts'),
    tsconfig: resolve(root, 'tsconfig.json'),
    type: 'Config',
    expose: 'export',
    jsDoc: 'extended',
    skipTypeCheck: false,
    additionalProperties: false,
    sortProps: true,
  }).createSchema('Config');
  return {
    $id: 'https://hector-ae21.github.io/octoform-docs/0.3/assets/config.schema.json',
    ...generated,
  };
}

function generatePlanArtifactSchema() {
  const generated = createGenerator({
    path: resolve(root, 'src/types/plan-artifact.ts'),
    tsconfig: resolve(root, 'tsconfig.json'),
    type: 'PlanArtifact',
    expose: 'export',
    jsDoc: 'extended',
    skipTypeCheck: false,
    additionalProperties: false,
    sortProps: true,
  }).createSchema('PlanArtifact');
  return {
    $id: 'https://hector-ae21.github.io/octoform-docs/0.4/assets/plan-artifact.schema.json',
    ...generated,
  };
}

async function loadTypeScriptExport(path, name) {
  const source = await readFile(path, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(ts.formatDiagnostics(errors, diagnosticHost));
  }
  const encoded = Buffer.from(result.outputText).toString('base64');
  const contractModule = await import(`data:text/javascript;base64,${encoded}`);
  return contractModule[name];
}

function generateCapabilities(config, productVersion) {
  validateCapabilityConfig(config);
  return {
    schemaVersion: config.schemaVersion,
    productVersion,
    sources: config.sources,
    capabilities: config.capabilities
      .map((capability) => ({
        ...capability,
        configPaths: [...capability.configPaths].sort(),
        commands: [...capability.commands].sort(),
        ownerKinds: [...capability.ownerKinds].sort(),
        readRoutes: [...capability.readRoutes].sort(),
        writeRoutes: [...capability.writeRoutes].sort(),
        readPermissions: [...capability.readPermissions].sort(),
        writePermissions: [...capability.writePermissions].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function generatePermissions(config, apiSurfaceConfig, productVersion) {
  const currentRoutes = [...apiSurfaceConfig.rest.currentRoutes].sort();
  const knownRoutes = new Set(currentRoutes);
  const usedRoutes = new Set(
    config.capabilities.flatMap((capability) => [
      ...capability.readRoutes,
      ...capability.writeRoutes,
    ]),
  );
  const missing = currentRoutes.filter((route) => !usedRoutes.has(route));
  const unknown = [...usedRoutes].filter((route) => !knownRoutes.has(route)).sort();
  if (missing.length || unknown.length) {
    throw new Error(
      `Capability route coverage differs from the implementation register.\nMissing: ${missing.join(', ') || 'none'}\nUnknown: ${unknown.join(', ') || 'none'}`,
    );
  }

  const permissionIds = new Set(config.permissions.map((permission) => permission.id));
  const operations = currentRoutes.map((route) => {
    const access = route.startsWith('GET ') ? 'read' : 'write';
    const matching = config.capabilities.filter((capability) =>
      [...capability.readRoutes, ...capability.writeRoutes].includes(route),
    );
    const configured = config.routePermissions[route];
    const inferred = matching.flatMap((capability) =>
      access === 'read' ? capability.readPermissions : capability.writePermissions,
    );
    const permissions = [...new Set(configured ?? inferred)].sort();
    for (const permission of permissions) {
      if (!permissionIds.has(permission)) {
        throw new Error(`${route} references unknown permission profile ${permission}`);
      }
    }
    return {
      route,
      access,
      capabilityIds: matching.map((capability) => capability.id).sort(),
      permissionProfiles: permissions,
    };
  });

  return {
    schemaVersion: config.schemaVersion,
    productVersion,
    sources: config.sources,
    tokenModel:
      'Profiles for classic and fine-grained credentials are alternatives, not cumulative grants.',
    profiles: config.permissions
      .map((permission) => ({
        ...permission,
        capabilityIds: config.capabilities
          .filter((capability) =>
            [...capability.readPermissions, ...capability.writePermissions].includes(permission.id),
          )
          .map((capability) => capability.id)
          .sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    operations,
  };
}

function validateCapabilityConfig(config) {
  if (config.schemaVersion !== 1) throw new Error('Unsupported capability schema version');
  const permissionIds = uniqueIds(config.permissions, 'permission');
  uniqueIds(config.capabilities, 'capability');
  for (const capability of config.capabilities) {
    for (const permission of [...capability.readPermissions, ...capability.writePermissions]) {
      if (!permissionIds.has(permission)) {
        throw new Error(`${capability.id} references unknown permission profile ${permission}`);
      }
    }
  }
  for (const [route, permissions] of Object.entries(config.routePermissions)) {
    for (const permission of permissions) {
      if (!permissionIds.has(permission)) {
        throw new Error(`${route} references unknown permission profile ${permission}`);
      }
    }
  }
}

function uniqueIds(items, kind) {
  const ids = new Set();
  for (const item of items) {
    if (!item.id || ids.has(item.id)) throw new Error(`Duplicate or empty ${kind} id: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

async function generateChecksums(generated) {
  const releaseAssets = [
    'api.json',
    'capabilities.json',
    'cli.json',
    'config-model.json',
    'config.schema.json',
    'github-api-surface.json',
    'permissions.json',
    'plan-artifact.schema.json',
  ];
  const lines = [];
  for (const name of releaseAssets.sort()) {
    const content = generated.get(name) ?? (await readFile(resolve(referenceRoot, name), 'utf8'));
    assertSafe(name, content);
    lines.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
  }
  return `${lines.join('\n')}\n`;
}

function assertSafe(name, content) {
  const forbidden = [
    /github_pat_[A-Za-z0-9_]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /[A-Za-z]:\\\\(?:Users|GitHub)\\\\/,
    /\/(?:home|Users)\/[^/\s]+\//,
    /\.codex[\\/]personal[\\/]octoform[\\/]proposal/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(content))
      throw new Error(`${name} contains forbidden private or credential data`);
  }
}

async function assertCurrent(name) {
  const [actual, expected] = await Promise.all([
    readFile(resolve(outputRoot, name), 'utf8'),
    readFile(resolve(referenceRoot, name), 'utf8').catch(() => ''),
  ]);
  if (actual !== expected) {
    throw new Error(
      `Generated artifact ${name} is stale. Run npm run reference-artifacts and commit it.`,
    );
  }
}

function parseJson(source) {
  return JSON.parse(source);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
