import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    config: { type: 'string', default: resolve(root, 'reference/github-api-surface.config.json') },
    'rest-current': { type: 'string' },
    'graphql-current': { type: 'string' },
    report: { type: 'string' },
  },
  strict: true,
});

let report;
let exitCode = 0;
try {
  const config = await readJson(values.config);
  const baselineBytes = await readBytes(config.rest.source.url);
  assertDigest(baselineBytes, config.rest.source.sha256);
  const baselineRest = parseJson(baselineBytes);
  const currentRest = await readJson(values['rest-current'] ?? config.rest.source.driftUrl);
  const currentGraphql = values['graphql-current']
    ? await readGraphqlFile(values['graphql-current'])
    : await readGraphql(config.graphql.endpoint, config.rest.source.apiVersion);
  const rest = compareContracts(
    buildRestContracts(config, baselineRest),
    buildRestContracts(config, currentRest),
  );
  const graphql = compareContracts(
    buildGraphqlContracts(config.graphql.mutations),
    buildGraphqlContracts(currentGraphql),
  );
  report = renderReport(config, rest, graphql);
  if (hasDrift(rest) || hasDrift(graphql)) exitCode = 1;
} catch (error) {
  exitCode = 2;
  report = `# GitHub API contract drift\n\nThe read-only audit could not complete.\n\n\`\`\`text\n${message(error)}\n\`\`\`\n`;
}

if (values.report) await writeFile(resolve(values.report), report);
console.log(report);
process.exitCode = exitCode;

function buildRestContracts(config, document) {
  if (!isObject(document.paths)) throw new Error('REST description has no paths mapping');
  const contracts = new Map();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!config.rest.scopePrefixes.some((prefix) => path.startsWith(prefix))) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) continue;
      const route = `${method.toUpperCase()} ${path}`;
      const references = new Set();
      const contract = normalize({ parameters: pathItem.parameters ?? [], operation });
      collectReferences(contract, document, references);
      contracts.set(route, {
        operation: contract,
        references: Object.fromEntries(
          [...references]
            .sort()
            .map((reference) => [
              reference,
              digest(normalize(resolveReference(document, reference))),
            ]),
        ),
      });
    }
  }
  return contracts;
}

function buildGraphqlContracts(fields) {
  if (!Array.isArray(fields)) throw new Error('GraphQL mutation snapshot must be an array');
  const contracts = new Map();
  for (const field of fields) {
    if (typeof field.name !== 'string' || !field.name) {
      throw new Error('GraphQL mutation snapshot contains a field without a name');
    }
    if (contracts.has(field.name)) throw new Error(`Duplicate GraphQL mutation: ${field.name}`);
    contracts.set(field.name, {
      deprecated: Boolean(field.isDeprecated ?? field.deprecated),
      deprecationReason: field.deprecationReason ?? null,
    });
  }
  return contracts;
}

function compareContracts(baseline, current) {
  const added = [...current.keys()].filter((key) => !baseline.has(key)).sort();
  const removed = [...baseline.keys()].filter((key) => !current.has(key)).sort();
  const changed = [];
  for (const key of [...baseline.keys()].filter((candidate) => current.has(candidate)).sort()) {
    const before = baseline.get(key);
    const after = current.get(key);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const paths = [];
    collectChangedPaths(before, after, '', paths, 12);
    changed.push({ key, paths });
  }
  return { baseline: baseline.size, current: current.size, added, removed, changed };
}

function collectChangedPaths(before, after, path, paths, limit) {
  if (paths.length >= limit || JSON.stringify(before) === JSON.stringify(after)) return;
  if (!isObject(before) || !isObject(after)) {
    paths.push(path || 'value');
    return;
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    if (paths.length >= limit) return;
    const next = path ? `${path}.${key}` : key;
    if (!(key in before) || !(key in after)) {
      paths.push(next);
      continue;
    }
    if (Array.isArray(before[key]) || Array.isArray(after[key])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) paths.push(next);
      continue;
    }
    collectChangedPaths(before[key], after[key], next, paths, limit);
  }
}

function collectReferences(value, document, references) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, document, references);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
    if (references.has(value.$ref)) return;
    references.add(value.$ref);
    collectReferences(resolveReference(document, value.$ref), document, references);
  }
  for (const child of Object.values(value)) collectReferences(child, document, references);
}

function resolveReference(document, reference) {
  let value = document;
  for (const segment of reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    value = value?.[segment];
  }
  if (value === undefined) throw new Error(`Unresolved REST reference: ${reference}`);
  return value;
}

function normalize(value, parentKey = '') {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalize(item));
    if (
      new Set(['allOf', 'anyOf', 'enum', 'oneOf', 'parameters', 'required', 'security']).has(
        parentKey,
      )
    ) {
      normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return normalized;
  }
  if (!isObject(value)) return value;
  const ignored = new Set([
    'description',
    'example',
    'examples',
    'externalDocs',
    'summary',
    'title',
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ignored.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child, key)]),
  );
}

async function readGraphql(endpoint, apiVersion) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for live GraphQL introspection');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'octoform-contract-drift',
      'x-github-api-version': apiVersion,
    },
    body: JSON.stringify({
      query:
        'query OctoformContractDrift { __type(name: "Mutation") { fields(includeDeprecated: true) { name isDeprecated deprecationReason } } }',
    }),
  });
  if (!response.ok) throw new Error(`GraphQL introspection failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `GraphQL introspection failed: ${payload.errors.map((error) => error.message).join('; ')}`,
    );
  }
  return payload.data?.__type?.fields;
}

async function readGraphqlFile(path) {
  const payload = await readJson(path);
  return Array.isArray(payload) ? payload : payload.data?.__type?.fields;
}

async function readJson(location) {
  return parseJson(await readBytes(location));
}

async function readBytes(location) {
  if (/^https:\/\//.test(location)) {
    const response = await fetch(location, {
      headers: { accept: 'application/json', 'user-agent': 'octoform-contract-drift' },
    });
    if (!response.ok) throw new Error(`Could not read ${location}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(resolve(location));
}

function parseJson(bytes) {
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function assertDigest(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `Pinned REST source failed integrity verification: expected ${expected}, received ${actual}`,
    );
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hasDrift(result) {
  return result.added.length > 0 || result.removed.length > 0 || result.changed.length > 0;
}

function renderReport(config, rest, graphql) {
  const lines = [
    '# GitHub API contract drift',
    '',
    `Checked the reviewed REST ${config.rest.source.apiVersion} contract and live GraphQL mutation surface at ${new Date().toISOString()}.`,
    '',
    '| Surface | Reviewed | Current | Added | Removed | Changed |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| REST | ${rest.baseline} | ${rest.current} | ${rest.added.length} | ${rest.removed.length} | ${rest.changed.length} |`,
    `| GraphQL mutations | ${graphql.baseline} | ${graphql.current} | ${graphql.added.length} | ${graphql.removed.length} | ${graphql.changed.length} |`,
    '',
  ];
  appendChanges(lines, 'REST', rest);
  appendChanges(lines, 'GraphQL mutations', graphql);
  if (!hasDrift(rest) && !hasDrift(graphql)) {
    lines.push('No contract drift detected. The reviewed baseline remains current.', '');
  } else {
    lines.push(
      'The baseline was not modified. Review every difference before updating dispositions or pinned evidence.',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function appendChanges(lines, title, result) {
  if (!hasDrift(result)) return;
  lines.push(`## ${title}`, '');
  appendList(lines, 'Added', result.added);
  appendList(lines, 'Removed', result.removed);
  if (result.changed.length > 0) {
    lines.push('### Changed', '');
    for (const change of result.changed.slice(0, 50)) {
      lines.push(`- \`${change.key}\`: ${change.paths.map((path) => `\`${path}\``).join(', ')}`);
    }
    if (result.changed.length > 50) lines.push(`- …and ${result.changed.length - 50} more.`);
    lines.push('');
  }
}

function appendList(lines, title, values) {
  if (values.length === 0) return;
  lines.push(`### ${title}`, '');
  for (const value of values.slice(0, 50)) lines.push(`- \`${value}\``);
  if (values.length > 50) lines.push(`- …and ${values.length - 50} more.`);
  lines.push('');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
