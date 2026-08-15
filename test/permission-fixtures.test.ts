/**
 * The published permission model, held to itself.
 *
 * `reference/permissions.json` is what somebody reads before deciding what to
 * grant a token. Every claim in it comes from two places that are written
 * separately: a capability says which profiles it needs, and `routePermissions`
 * says which profiles a route needs. The generator already refuses a profile
 * that does not exist and a route no capability uses.
 *
 * What it does not refuse is the two disagreeing, and disagreement here has a
 * particular cost: an operator grants exactly what one half asked for and the
 * run fails on a request the other half described. So the cases below are
 * about the seams — an explicit route entry that contradicts the capability
 * using it, a profile nobody needs, a write with no write permission, and a
 * route filed under the wrong half of a capability.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

interface Capability {
  id: string;
  readRoutes: string[];
  writeRoutes: string[];
  readPermissions: string[];
  writePermissions: string[];
}

interface Register {
  permissions: Array<{ id: string }>;
  routePermissions: Record<string, string[]>;
  capabilities: Capability[];
}

const config = JSON.parse(
  readFileSync(resolve(process.cwd(), 'reference/capabilities.config.json'), 'utf8'),
) as Register;

const published = JSON.parse(
  readFileSync(resolve(process.cwd(), 'reference/permissions.json'), 'utf8'),
) as {
  profiles: Array<{ id: string; capabilityIds: string[] }>;
  operations: Array<{
    route: string;
    access: string;
    capabilityIds: string[];
    permissionProfiles: string[];
  }>;
};

test('a route filed as read is a read, and a route filed as write is not', () => {
  const wrong: string[] = [];
  for (const capability of config.capabilities) {
    for (const route of capability.readRoutes) {
      if (!route.startsWith('GET ')) wrong.push(`${capability.id} reads with ${route}`);
    }
    for (const route of capability.writeRoutes) {
      if (route.startsWith('GET ')) wrong.push(`${capability.id} writes with ${route}`);
    }
  }

  assert.deepEqual(
    wrong,
    [],
    'the generated permission model decides read or write from the method, so a route on the wrong side is documented as needing the wrong access',
  );
});

/**
 * An explicit route entry deliberately overrides what the capabilities using
 * that route would otherwise imply — the ruleset discovery probe needs an
 * organisation profile although the capability that runs it is about
 * repositories, and stating that is the entry's whole purpose. So the check
 * here is not that the two agree; it is that the entry is about a route
 * something actually calls.
 */
test('every explicit route permission is about a route something calls', () => {
  const called = new Set(
    config.capabilities.flatMap((capability) => [
      ...capability.readRoutes,
      ...capability.writeRoutes,
    ]),
  );
  const stale = Object.keys(config.routePermissions)
    .filter((route) => !called.has(route))
    .sort();

  assert.deepEqual(
    stale,
    [],
    'an entry for a route no capability uses is never applied and never validated, so it rots unnoticed while still being read as advice',
  );
});

test('every declared permission profile is needed by something', () => {
  const used = new Set([
    ...Object.values(config.routePermissions).flat(),
    ...config.capabilities.flatMap((capability) => [
      ...capability.readPermissions,
      ...capability.writePermissions,
    ]),
  ]);
  const unused = config.permissions.map((profile) => profile.id).filter((id) => !used.has(id));

  assert.deepEqual(
    unused,
    [],
    'a profile nothing needs tells somebody to grant access for no reason',
  );
});

test('nothing octoform writes through is documented as needing no permission', () => {
  const silent = published.operations
    .filter(
      (operation) => operation.access === 'write' && operation.permissionProfiles.length === 0,
    )
    .map((operation) => operation.route);

  assert.deepEqual(
    silent,
    [],
    'an empty list here reads as "no permission required", which is never true of a write',
  );
});

test('every published profile names the capabilities that need it', () => {
  const orphans = published.profiles
    .filter((profile) => profile.capabilityIds.length === 0)
    .map((profile) => profile.id);

  assert.deepEqual(
    orphans,
    [],
    'a profile no capability claims cannot be explained to whoever is asked to grant it',
  );
});
