import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CLI_CONTRACT, renderUsage } from '../src/cli-contract.js';

type JsonSchema = {
  $id: string;
  $schema: string;
  $ref: string;
  definitions: Record<string, {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
  }>;
};

type CapabilityRegister = {
  schemaVersion: number;
  productVersion: string;
  capabilities: Array<{
    id: string;
    readRoutes: string[];
    writeRoutes: string[];
    readPermissions: string[];
    writePermissions: string[];
  }>;
};

type PermissionRegister = {
  schemaVersion: number;
  productVersion: string;
  profiles: Array<{ id: string }>;
  operations: Array<{
    route: string;
    capabilityIds: string[];
    permissionProfiles: string[];
  }>;
};

const root = process.cwd();
const packageMetadata = readJson<{ version: string }>('package.json');
const releaseReferenceNames = [
  'api.json',
  'capabilities.json',
  'cli.json',
  'config.schema.json',
  'github-api-surface.json',
  'permissions.json',
] as const;

test('the CLI manifest is the exact runtime help contract', () => {
  const manifest = readJson<Record<string, unknown>>('reference/cli.json');
  const { productVersion, ...contract } = manifest;
  assert.equal(productVersion, packageMetadata.version);
  assert.deepEqual(contract, CLI_CONTRACT);

  const usage = renderUsage();
  for (const command of CLI_CONTRACT.commands) assert.match(usage, new RegExp(escape(command.usage)));
  for (const option of CLI_CONTRACT.options) assert.match(usage, new RegExp(escape(option.syntax)));
});

test('the configuration schema exposes the strict Config contract', () => {
  const schema = readJson<JsonSchema>('reference/config.schema.json');
  const config = schema.definitions.Config;
  assert.equal(schema.$id, 'https://hector-ae21.github.io/octoform-docs/0.3/assets/config.schema.json');
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(schema.$ref, '#/definitions/Config');
  assert.equal(config?.additionalProperties, false);
  assert.deepEqual(config?.required, ['owner']);
  assert.ok(config?.properties?.owner);
  assert.ok(config?.properties?.defaults);
  assert.ok(config?.properties?.types);
  assert.ok(config?.properties?.repos);
});

test('every implemented route has capabilities and permission evidence', () => {
  const capabilities = readJson<CapabilityRegister>('reference/capabilities.json');
  const permissions = readJson<PermissionRegister>('reference/permissions.json');
  const surface = readJson<{ rest: { currentRoutes: string[] } }>(
    'reference/github-api-surface.config.json',
  );
  const capabilityIds = new Set(capabilities.capabilities.map((capability) => capability.id));
  const profileIds = new Set(permissions.profiles.map((profile) => profile.id));

  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(permissions.schemaVersion, 1);
  assert.equal(capabilities.productVersion, packageMetadata.version);
  assert.equal(permissions.productVersion, packageMetadata.version);
  assert.deepEqual(
    permissions.operations.map((operation) => operation.route),
    [...surface.rest.currentRoutes].sort(),
  );
  for (const operation of permissions.operations) {
    assert.ok(operation.capabilityIds.length > 0, operation.route);
    assert.ok(operation.permissionProfiles.length > 0, operation.route);
    for (const capability of operation.capabilityIds) assert.ok(capabilityIds.has(capability));
    for (const profile of operation.permissionProfiles) assert.ok(profileIds.has(profile));
  }
});

test('SHA256SUMS authenticates every generated release reference', () => {
  const expected = new Map(
    readFileSync(resolve(root, 'reference/SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [digest, name] = line.split(/\s{2}/);
        assert.ok(digest);
        assert.ok(name);
        return [name, digest];
      }),
  );
  assert.deepEqual([...expected.keys()], releaseReferenceNames);
  for (const [name, digest] of expected) {
    const actual = createHash('sha256')
      .update(readFileSync(resolve(root, 'reference', name)))
      .digest('hex');
    assert.equal(actual, digest, name);
  }
});

test('release references use canonical LF line endings', () => {
  for (const name of [...releaseReferenceNames, 'SHA256SUMS']) {
    assert.doesNotMatch(readFileSync(resolve(root, 'reference', name), 'utf8'), /\r/, name);
  }
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
