import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

type Policy = {
  disposition: string;
  target: string | null;
  rationale: string;
};

type RegisterOperation = Policy & {
  transport: 'rest' | 'graphql';
  operation: string;
  method: string;
  path: string | null;
  status: string;
};

type Register = {
  schemaVersion: number;
  generatedFrom: {
    rest: { apiVersion: string; commit: string; sha256: string };
    graphql: { capturedAt: string; mutationCount: number };
  };
  summary: {
    total: number;
    implemented: number;
    byTransport: Record<string, number>;
    byDisposition: Record<string, number>;
    byTarget: Record<string, number>;
    byImplementedIn: Record<string, number>;
  };
  operations: RegisterOperation[];
};

type SurfaceConfig = {
  schemaVersion: number;
  rest: {
    implementedRoutes: Record<string, string[]>;
    reviewedOperations: string[];
  };
  graphql: {
    mutations: Array<
      Policy & { name: string; deprecated: boolean; deprecationReason: string | null }
    >;
  };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const register = readJson<Register>('reference/github-api-surface.json');
const config = readJson<SurfaceConfig>('reference/github-api-surface.config.json');
const dispositions = new Set([
  'observational',
  'declarative',
  'sensitive-declarative',
  'operational',
  'excluded',
]);

test('the generated API surface has valid complete dispositions', () => {
  assert.equal(register.schemaVersion, config.schemaVersion);
  assert.equal(register.summary.total, register.operations.length);
  assert.equal(register.summary.total, 1_337);
  assert.equal(register.summary.byTransport.rest, 1_063);
  assert.equal(register.summary.byTransport.graphql, 274);
  assert.equal(register.generatedFrom.rest.apiVersion, '2026-03-10');
  assert.match(register.generatedFrom.rest.commit, /^[0-9a-f]{40}$/);
  assert.match(register.generatedFrom.rest.sha256, /^[0-9a-f]{64}$/);

  const identities = new Set<string>();
  for (const operation of register.operations) {
    const identity = `${operation.transport}:${operation.method}:${operation.path ?? ''}:${operation.operation}`;
    assert.equal(identities.has(identity), false, `duplicate operation ${identity}`);
    identities.add(identity);
    assert.equal(dispositions.has(operation.disposition), true, identity);
    assert.ok(operation.rationale.trim(), identity);
    if (operation.disposition === 'excluded') assert.equal(operation.target, null, identity);
    else assert.match(operation.target ?? '', /^\d+\.\d+\.\d+$/, identity);
  }
});

test('irreversible owner and repository operations remain excluded', () => {
  const excluded = register.operations
    .filter((operation) => operation.disposition === 'excluded')
    .map((operation) => `${operation.transport}:${operation.operation}`)
    .sort();
  assert.deepEqual(excluded, [
    'graphql:transferEnterpriseOrganization',
    'rest:orgs/delete',
    'rest:repos/delete',
    'rest:repos/transfer',
  ]);
});

test('every relevant REST operation is explicitly reviewed', () => {
  const reviewed = new Set(config.rest.reviewedOperations);
  assert.equal(reviewed.size, config.rest.reviewedOperations.length);
  const generated = register.operations
    .filter((operation) => operation.transport === 'rest')
    .map((operation) => `${operation.method} ${operation.path} :: ${operation.operation}`);
  assert.deepEqual(new Set(generated), reviewed);
  assert.equal(register.summary.byTransport.rest, reviewed.size);
});

test('the GraphQL mutation snapshot and generated register agree', () => {
  const configured = new Map(config.graphql.mutations.map((mutation) => [mutation.name, mutation]));
  const generated = register.operations.filter((operation) => operation.transport === 'graphql');
  assert.equal(configured.size, config.graphql.mutations.length);
  assert.equal(register.generatedFrom.graphql.mutationCount, generated.length);
  assert.equal(register.summary.byTransport.graphql, generated.length);
  for (const operation of generated) {
    const mutation = configured.get(operation.operation);
    assert.ok(mutation, operation.operation);
    assert.equal(operation.disposition, mutation.disposition);
    assert.equal(operation.target, mutation.target);
    assert.equal(operation.rationale, mutation.rationale);
  }
});

test('every implemented route is stamped with the release it actually arrived in', () => {
  const declared = new Map<string, string>();
  for (const [version, routes] of Object.entries(config.rest.implementedRoutes)) {
    for (const route of routes) {
      assert.equal(declared.has(route), false, `${route} is declared under two releases`);
      declared.set(route, version);
    }
  }

  const stamped = new Map(
    register.operations
      .filter((operation) => operation.status.startsWith('implemented-v'))
      .map((operation) => [
        `${operation.method} ${operation.path}`,
        operation.status.slice('implemented-v'.length),
      ]),
  );

  assert.deepEqual(stamped, declared);
  assert.equal(register.summary.implemented, declared.size);
  for (const [version, routes] of Object.entries(config.rest.implementedRoutes)) {
    assert.equal(register.summary.byImplementedIn[version], routes.length, version);
  }
});

/**
 * `byTarget` counts an implemented operation under the release it shipped in
 * and a planned one under the release it is aimed at, so on its own it cannot
 * separate the two once both exist for the same release.
 */
test('a release that both shipped and is planned for keeps the two counts apart', () => {
  const shipped = register.summary.byImplementedIn['0.5.0'] ?? 0;
  const targeted = register.summary.byTarget['0.5.0'] ?? 0;

  assert.ok(shipped > 0, 'this release has shipped operations');
  assert.ok(targeted > shipped, 'and still has more planned than shipped');
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
}
