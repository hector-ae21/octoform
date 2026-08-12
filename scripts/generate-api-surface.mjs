import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'reference/github-api-surface.config.json');
const jsonOutputPath = resolve(root, 'docs/reference/github-api-surface.json');
const markdownOutputPath = resolve(root, 'docs/reference/github-api-surface.md');

const args = parseArgs(process.argv.slice(2));
const config = parseJson(await readFile(configPath, 'utf8'));
const openApi = await loadOpenApi(config.rest.source, args.openapi);
let configChanged = false;

if (args.graphqlSnapshot) {
  const snapshotPath = resolve(args.graphqlSnapshot);
  if (args.check) await assertGraphqlSnapshot(config, snapshotPath);
  else {
    await updateGraphqlSnapshot(config, snapshotPath);
    configChanged = true;
  }
}

if (args.updateRestSnapshot) {
  if (args.check) throw new Error('--update-rest-snapshot cannot be combined with --check');
  config.rest.reviewedOperations = listRelevantRestOperations(config, openApi);
  configChanged = true;
}

const register = buildRegister(config, openApi);
const json = `${JSON.stringify(register, null, 2)}\n`;
const markdown = renderMarkdown(register);

if (configChanged) await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

if (args.check) {
  await assertCurrent(jsonOutputPath, json);
  await assertCurrent(markdownOutputPath, markdown);
  console.log(`GitHub API surface is current: ${register.summary.total} operations.`);
} else {
  await writeFile(jsonOutputPath, json);
  await writeFile(markdownOutputPath, markdown);
  console.log(`Generated ${register.summary.total} GitHub API dispositions.`);
}

function parseArgs(values) {
  const parsed = {
    check: false,
    openapi: undefined,
    graphqlSnapshot: undefined,
    updateRestSnapshot: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--check') {
      parsed.check = true;
      continue;
    }
    if (value === '--update-rest-snapshot') {
      parsed.updateRestSnapshot = true;
      continue;
    }
    if (value === '--openapi' || value === '--graphql-snapshot') {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} needs a path`);
      if (value === '--openapi') parsed.openapi = next;
      else parsed.graphqlSnapshot = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

async function loadOpenApi(source, localPath) {
  const bytes = localPath
    ? await readFile(resolve(localPath))
    : Buffer.from(await (await fetch(source.url)).arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== source.sha256.trim().toLowerCase()) {
    throw new Error(`OpenAPI SHA-256 mismatch: expected ${source.sha256}, received ${digest}`);
  }
  return parseJson(bytes.toString('utf8'));
}

function buildRegister(config, openApi) {
  const currentRoutes = new Set(config.rest.currentRoutes);
  const reviewedOperations = new Set(config.rest.reviewedOperations);
  if (reviewedOperations.size !== config.rest.reviewedOperations.length) {
    throw new Error('Duplicate entry in rest.reviewedOperations');
  }
  const undispositioned = [];
  const rest = [];
  for (const [path, pathItem] of Object.entries(openApi.paths)) {
    if (!config.rest.scopePrefixes.some((prefix) => path.startsWith(prefix))) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) continue;
      const tag = operation.tags?.[0];
      if (!tag) throw new Error(`${method.toUpperCase()} ${path} has no tag`);
      const override = config.rest.overrides.find((candidate) =>
        matchesOverride(candidate, method, path, operation.operationId),
      );
      const policy =
        override ??
        (method === 'get'
          ? { ...config.rest.readDisposition, target: config.rest.mutationDispositionByTag[tag]?.target }
          : config.rest.mutationDispositionByTag[tag]);
      if (!policy) {
        throw new Error(`No disposition for ${method.toUpperCase()} ${path} (${tag})`);
      }
      validatePolicy(policy, `${method.toUpperCase()} ${path}`);
      const route = `${method.toUpperCase()} ${path}`;
      const implemented = currentRoutes.has(route);
      const reviewedKey = restOperationKey(method, path, operation.operationId);
      if (!reviewedOperations.delete(reviewedKey)) undispositioned.push(reviewedKey);
      rest.push({
        transport: 'rest',
        operation: operation.operationId,
        method: method.toUpperCase(),
        path,
        tag,
        summary: operation.summary ?? '',
        disposition: policy.disposition,
        target: implemented ? '0.3.1' : policy.target,
        rationale: policy.rationale,
        rule: policy.id,
        status: implemented ? 'implemented-v0.3.1' : statusFor(policy.disposition),
        deprecated: Boolean(operation.deprecated),
        githubApps: operation['x-github']?.enabledForGitHubApps ?? null,
        documentation: operation.externalDocs?.url ?? null,
      });
      currentRoutes.delete(route);
    }
  }
  if (currentRoutes.size > 0) {
    throw new Error(`Current REST routes absent from OpenAPI: ${[...currentRoutes].join(', ')}`);
  }
  if (undispositioned.length > 0) {
    throw new Error(`Relevant REST operations without reviewed disposition:\n${undispositioned.join('\n')}`);
  }
  if (reviewedOperations.size > 0) {
    throw new Error(`Reviewed REST operations absent from OpenAPI:\n${[...reviewedOperations].join('\n')}`);
  }

  const graphqlNames = new Set();
  const graphql = config.graphql.mutations.map((mutation) => {
    if (graphqlNames.has(mutation.name)) throw new Error(`Duplicate GraphQL mutation: ${mutation.name}`);
    graphqlNames.add(mutation.name);
    validatePolicy(mutation, `GraphQL mutation ${mutation.name}`);
    return {
      transport: 'graphql',
      operation: mutation.name,
      method: 'mutation',
      path: null,
      tag: mutation.family,
      summary: '',
      disposition: mutation.disposition,
      target: mutation.target,
      rationale: mutation.rationale,
      rule: 'graphql-explicit-snapshot',
      status: statusFor(mutation.disposition),
      deprecated: mutation.deprecated,
      githubApps: null,
      documentation: 'https://docs.github.com/en/graphql/reference/mutations',
    };
  });

  rest.sort(compareOperations);
  graphql.sort(compareOperations);
  const operations = [...rest, ...graphql];
  return {
    schemaVersion: config.schemaVersion,
    generatedFrom: {
      rest: config.rest.source,
      graphql: {
        endpoint: config.graphql.endpoint,
        capturedAt: config.graphql.capturedAt,
        mutationCount: graphql.length,
      },
    },
    summary: summarize(operations),
    operations,
  };
}

function listRelevantRestOperations(config, openApi) {
  const operations = [];
  for (const [path, pathItem] of Object.entries(openApi.paths)) {
    if (!config.rest.scopePrefixes.some((prefix) => path.startsWith(prefix))) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) continue;
      operations.push(restOperationKey(method, path, operation.operationId));
    }
  }
  return operations.sort();
}

function restOperationKey(method, path, operationId) {
  if (!operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
  return `${method.toUpperCase()} ${path} :: ${operationId}`;
}

function validatePolicy(policy, context) {
  const dispositions = new Set([
    'observational',
    'declarative',
    'sensitive-declarative',
    'operational',
    'excluded',
  ]);
  if (!dispositions.has(policy.disposition)) {
    throw new Error(`${context} has invalid disposition: ${policy.disposition}`);
  }
  if (policy.disposition === 'excluded' && policy.target !== null) {
    throw new Error(`${context} is excluded but has a target release`);
  }
  if (policy.disposition !== 'excluded' && !/^\d+\.\d+\.\d+$/.test(policy.target ?? '')) {
    throw new Error(`${context} needs a complete x.y.z target release`);
  }
  if (!policy.rationale?.trim()) throw new Error(`${context} needs a rationale`);
}

function matchesOverride(rule, method, path, operationId) {
  if (rule.methods && !rule.methods.includes(method.toUpperCase())) return false;
  if (rule.operationIds && !rule.operationIds.includes(operationId)) return false;
  if (rule.pathPattern && !new RegExp(rule.pathPattern).test(path)) return false;
  return true;
}

function statusFor(disposition) {
  if (disposition === 'excluded') return 'excluded';
  return 'planned';
}

function compareOperations(left, right) {
  return `${left.transport}:${left.path ?? ''}:${left.method}:${left.operation}`.localeCompare(
    `${right.transport}:${right.path ?? ''}:${right.method}:${right.operation}`,
  );
}

function summarize(operations) {
  const byTransport = countBy(operations, (operation) => operation.transport);
  const byDisposition = countBy(operations, (operation) => operation.disposition);
  const byTarget = countBy(operations, (operation) => operation.target ?? 'none');
  const implemented = operations.filter((operation) => operation.status === 'implemented-v0.3.1').length;
  const deprecated = operations.filter((operation) => operation.deprecated).length;
  return { total: operations.length, implemented, deprecated, byTransport, byDisposition, byTarget };
}

function countBy(items, keyFor) {
  return Object.fromEntries(
    [...items.reduce((counts, item) => {
      const key = keyFor(item);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function renderMarkdown(register) {
  const restRows = summarizeFamilies(register.operations.filter((operation) => operation.transport === 'rest'));
  const graphqlRows = summarizeFamilies(
    register.operations.filter((operation) => operation.transport === 'graphql'),
  );
  const current = register.operations.filter((operation) => operation.status === 'implemented-v0.3.1');
  return `# GitHub API surface disposition register

This register is generated by \`npm run api-surface\`. Do not edit it by hand.
The complete operation-level data is in
[\`github-api-surface.json\`](github-api-surface.json).

## Sources

| Transport | Source |
| --- | --- |
| REST | GitHub OpenAPI \`${register.generatedFrom.rest.apiVersion}\` at \`${register.generatedFrom.rest.commit}\`, SHA-256 \`${register.generatedFrom.rest.sha256}\` |
| GraphQL | Public schema mutation introspection captured \`${register.generatedFrom.graphql.capturedAt}\` (${register.generatedFrom.graphql.mutationCount} mutations) |

Octoform \`v0.3.1\` sends no REST version header, so GitHub currently applies
\`2022-11-28\`. The newer pinned description is used to disposition future API
coverage; it does not claim that \`v0.3.1\` already uses that version.

## Summary

| Measure | Count |
| --- | ---: |
| All dispositioned operations | ${register.summary.total} |
| REST operations | ${register.summary.byTransport.rest ?? 0} |
| GraphQL mutations | ${register.summary.byTransport.graphql ?? 0} |
| Implemented by \`v0.3.1\` | ${register.summary.implemented} |
| Deprecated upstream | ${register.summary.deprecated} |
${renderCountRows(register.summary.byDisposition)}

### Planned release targets

| Target | Operations |
| --- | ---: |
${renderTargetRows(register.summary.byTarget)}

## REST families

| Family | Total | Observational | Declarative | Sensitive declarative | Operational | Excluded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${renderFamilyRows(restRows)}

## GraphQL mutation families

| Family | Total | Observational | Declarative | Sensitive declarative | Operational | Excluded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${renderFamilyRows(graphqlRows)}

## Operations implemented by v0.3.1

| Method | Path | Operation | Disposition |
| --- | --- | --- | --- |
${current.map((operation) => `| ${operation.method} | \`${operation.path}\` | \`${operation.operation}\` | ${operation.disposition} |`).join('\n')}

Implemented means that \`v0.3.1\` invokes the operation in at least one bounded
context. It does not make every possible use of that operation safe for normal
desired-state reconciliation.

## Regeneration and review

\`npm run api-surface\` downloads the pinned REST description and regenerates
both artifacts from committed review metadata. \`npm run api-surface:check\`
performs the same work without writing and fails when either artifact is stale.

To review an intentional upstream refresh:

1. Pin the official REST description's API version, commit, URL and SHA-256 in
   \`reference/github-api-surface.config.json\`.
2. Capture the public GraphQL mutation fields \`name\`, \`isDeprecated\` and
   \`deprecationReason\` with deprecated fields included.
3. Run \`npm run api-surface -- --graphql-snapshot <path> --update-rest-snapshot\`.
4. Inspect every source, review-metadata and generated-artifact diff before
   accepting it.

Ordinary generation never expands the reviewed operation set. The update flags
are deliberately explicit so API growth cannot silently enter the register.

## Interpretation

- **Observational** operations provide inventory, capability evidence, or audit data.
- **Declarative** operations can represent ordinary durable desired state.
- **Sensitive declarative** operations manage secrets, access, security, identity, or broad policy.
- **Operational** operations are transient workflows or historical events and never run as an implicit \`apply\` side effect.
- **Excluded** operations are outside normal reconciliation because absence must never imply deletion, transfer, or another irreversible action.

An operation's target is a planning release, not a promise that GitHub grants it
to every owner or token. Runtime capability and permission evidence remains the
authority.
`;
}

function summarizeFamilies(operations) {
  const families = new Map();
  for (const operation of operations) {
    const family = families.get(operation.tag) ?? { total: 0 };
    family.total += 1;
    family[operation.disposition] = (family[operation.disposition] ?? 0) + 1;
    families.set(operation.tag, family);
  }
  return [...families].sort(([left], [right]) => left.localeCompare(right));
}

function renderFamilyRows(rows) {
  const count = (values, key) => values[key] ?? 0;
  return rows
    .map(
      ([family, values]) =>
        `| ${family} | ${values.total} | ${count(values, 'observational')} | ${count(values, 'declarative')} | ${count(values, 'sensitive-declarative')} | ${count(values, 'operational')} | ${count(values, 'excluded')} |`,
    )
    .join('\n');
}

function renderCountRows(counts) {
  return Object.entries(counts)
    .map(([name, count]) => `| ${name} operations | ${count} |`)
    .join('\n');
}

function renderTargetRows(counts) {
  return Object.entries(counts)
    .map(([target, count]) => `| ${target === 'none' ? 'Excluded' : `\`${target}\``} | ${count} |`)
    .join('\n');
}

async function updateGraphqlSnapshot(currentConfig, snapshotPath) {
  const source = await readGraphqlSnapshot(snapshotPath);
  currentConfig.graphql.mutations = source
    .map((field) => classifyGraphqlMutation(field))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function assertGraphqlSnapshot(currentConfig, snapshotPath) {
  const source = await readGraphqlSnapshot(snapshotPath);
  const actual = new Map(
    source.map((field) => [
      field.name,
      { deprecated: Boolean(field.isDeprecated), deprecationReason: field.deprecationReason ?? null },
    ]),
  );
  const reviewed = new Map(
    currentConfig.graphql.mutations.map((field) => [
      field.name,
      { deprecated: field.deprecated, deprecationReason: field.deprecationReason },
    ]),
  );
  const added = [...actual.keys()].filter((name) => !reviewed.has(name));
  const removed = [...reviewed.keys()].filter((name) => !actual.has(name));
  const changed = [...actual.keys()].filter(
    (name) => reviewed.has(name) && JSON.stringify(actual.get(name)) !== JSON.stringify(reviewed.get(name)),
  );
  if (added.length || removed.length || changed.length) {
    throw new Error(
      `GraphQL mutation snapshot needs review:\nadded: ${added.join(', ') || 'none'}\nremoved: ${removed.join(', ') || 'none'}\nchanged: ${changed.join(', ') || 'none'}`,
    );
  }
}

async function readGraphqlSnapshot(snapshotPath) {
  const source = parseJson(await readFile(snapshotPath, 'utf8'));
  if (!Array.isArray(source)) throw new Error('GraphQL snapshot must be an array');
  const names = source.map((field) => field.name);
  if (new Set(names).size !== names.length) throw new Error('GraphQL snapshot contains duplicate mutations');
  if (names.some((name) => typeof name !== 'string' || !name)) {
    throw new Error('GraphQL snapshot contains a mutation without a name');
  }
  return source;
}

function classifyGraphqlMutation(field) {
  const name = field.name;
  const excluded = /^transferEnterpriseOrganization$/;
  const sensitive =
    /(BranchProtectionRule|Environment|IpAllowList|RepositoryCustomProperty|RepositoryRuleset|InteractionLimit|Enterprise.*Setting|Organization.*Setting|TeamsRepository|RepositoryWebCommitSignoff|PullRequestCreationCapBypassUsers|EnterpriseIdentityProvider|EnterpriseAdministratorRole|EnterpriseOwnerOrganizationRole|TeamReviewAssignment)/;
  const declarative = /^(archiveRepository|unarchiveRepository|updateRepository|updateTopics)$/;
  let disposition = 'operational';
  let target = '0.6.0';
  let rationale = 'Transient collaboration, migration, delivery, or historical workflow.';
  let family = graphqlFamily(name);
  if (excluded.test(name)) {
    disposition = 'excluded';
    target = null;
    rationale = 'Deletion or ownership transfer is outside normal desired-state reconciliation.';
  } else if (sensitive.test(name)) {
    disposition = 'sensitive-declarative';
    target = family === 'repository-governance' || family === 'organization-governance' ? '0.5.0' : '0.6.0';
    rationale = 'Durable access, identity, security, or broad governance state.';
  } else if (declarative.test(name)) {
    disposition = 'declarative';
    target = '0.5.0';
    rationale = 'Durable repository desired state with readable current state.';
  }
  return {
    name,
    deprecated: Boolean(field.isDeprecated),
    deprecationReason: field.deprecationReason ?? null,
    family,
    disposition,
    target,
    rationale,
  };
}

function graphqlFamily(name) {
  if (/Enterprise|Organization|Team|IpAllowList|VerifiableDomain/.test(name)) return 'organization-governance';
  if (/Repository|BranchProtection|Ref|Topics|Environment/.test(name)) return 'repository-governance';
  if (/Project/.test(name)) return 'projects';
  if (/PullRequest|Review|Deployment|Check/.test(name)) return 'delivery';
  if (/Issue|Label|Assignable|Comment|Discussion|Reaction|Upvote|Star/.test(name)) return 'collaboration';
  if (/Sponsor/.test(name)) return 'sponsors';
  if (/Migration|Attribution/.test(name)) return 'migrations';
  return 'user-and-platform';
}

async function assertCurrent(path, expected) {
  let actual;
  try {
    actual = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Missing generated file: ${path}`);
  }
  if (actual !== expected) throw new Error(`Generated file is stale: ${path}`);
}

function parseJson(value) {
  return JSON.parse(value.replace(/^\uFEFF/, ''));
}
