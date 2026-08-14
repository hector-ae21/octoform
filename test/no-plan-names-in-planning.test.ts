import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/**
 * The modules that decide what to plan must never see a commercial plan name
 * or a plan-derived limit: the decision comes from owner kind, permissions,
 * and actual endpoint behavior instead. The cheapest way to keep that true is
 * structural — these modules do not import from the GitHub transport at all,
 * so there is nothing plan-shaped for them to see even by accident.
 */
const PURE_PLANNING_DIRECTORIES = ['src/core', 'src/config'];
const FORBIDDEN_IMPORT = /from\s+['"](\.\.\/)*github\/client(\.js)?['"]/;

test('pure planning modules never import the GitHub transport', () => {
  const offenders: string[] = [];

  for (const directory of PURE_PLANNING_DIRECTORIES) {
    for (const file of readdirSync(resolve(process.cwd(), directory))) {
      if (!file.endsWith('.ts')) continue;
      const path = resolve(process.cwd(), directory, file);
      const source = readFileSync(path, 'utf8');
      if (FORBIDDEN_IMPORT.test(source)) offenders.push(`${directory}/${file}`);
    }
  }

  assert.deepEqual(offenders, []);
});
