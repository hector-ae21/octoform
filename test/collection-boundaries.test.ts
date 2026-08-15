/**
 * One property, held to every collection octoform manages: it touches what the
 * policy names and nothing else, and it removes something only where the
 * policy said so in as many words.
 *
 * Each family is covered by an entry in the table below, and the last case
 * derives the list of families from the configuration shape itself. Adding a
 * new collection without covering it here fails that case rather than shipping
 * a family whose removal behaviour nobody stated.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POLICY_SET } from '../src/config/shape.js';
import { planRepo } from '../src/core/plan.js';
import { capability } from '../src/github/capabilities.js';
import type {
  OperationKind,
  PlanOptions,
  PolicySet,
  RepoDetail,
  RepoStructure,
} from '../src/types/index.js';

const OPTIONS: PlanOptions = {
  rulesetCapability: capability('supported', 'assumed in this suite', 'permission'),
  ownerKind: 'org',
};

const repo = (structure: RepoStructure): RepoDetail => ({
  name: 'thing',
  visibility: 'public',
  archived: false,
  default_branch: 'main',
  description: null,
  homepage: null,
  topics: [],
  settings: {},
  structure,
});

interface Family {
  /** The prefix a change of this family carries in its key. */
  key: string;
  /** A policy naming one entry, matching what the repository already has. */
  names: PolicySet;
  /**
   * What the repository has: the named entry, as the policy wants it, plus an
   * entry nobody declared where the family can observe one at all.
   */
  structure: RepoStructure;
  /** Whether the observed state can hold an entry the policy never named. */
  stray?: string;
  /** A policy asking for the named entry to go, where the family allows it. */
  removes?: PolicySet;
  /** What that removal is classified as. */
  operation?: OperationKind;
}

const FAMILIES: readonly Family[] = [
  {
    key: 'ensure_branches',
    names: { ensure_branches: ['declared'] },
    structure: { branches: { declared: true } },
  },
  {
    key: 'branch_protection',
    names: { branch_protection: [{ branch: 'declared', enforce_admins: true }] },
    structure: {
      branchProtection: { declared: { enforce_admins: true } },
      rulesets: [],
    },
  },
  {
    key: 'rulesets',
    names: { rulesets: [{ name: 'declared', target_branches: ['main'] }] },
    structure: {
      rulesets: [
        {
          id: 1,
          name: 'declared',
          target: 'branch',
          enforcement: 'active',
          include: ['main'],
          exclude: [],
          bypass: [],
          rules: {},
          unmodelled: [],
        },
        {
          id: 2,
          name: 'stray',
          target: 'branch',
          enforcement: 'active',
          include: ['other'],
          exclude: [],
          bypass: [],
          rules: {},
          unmodelled: [],
        },
      ],
    },
    stray: 'stray',
  },
  {
    key: 'access.users',
    names: { access: { users: { declared: 'write' } } },
    structure: { collaborators: { declared: 'write', stray: 'admin' }, invitations: {} },
    stray: 'stray',
    removes: { access: { users: { declared: 'none' } } },
    operation: 'detach',
  },
  {
    key: 'access.teams',
    names: { access: { teams: { declared: 'write' } } },
    structure: { teamAccess: { declared: 'write', stray: 'admin' } },
    stray: 'stray',
    removes: { access: { teams: { declared: 'none' } } },
    operation: 'detach',
  },
  {
    key: 'labels',
    names: { labels: [{ name: 'declared', color: 'ffffff' }] },
    structure: {
      labels: {
        declared: { name: 'declared', color: 'ffffff', description: null, default: false },
        stray: { name: 'stray', color: '000000', description: null, default: true },
      },
    },
    stray: 'stray',
    removes: { labels: [{ name: 'declared', mode: 'absent' }] },
    operation: 'delete',
  },
  {
    key: 'milestones',
    names: { milestones: [{ title: 'declared', state: 'open' }] },
    structure: {
      milestones: {
        declared: { number: 1, title: 'declared', description: null, state: 'open' },
        stray: { number: 2, title: 'stray', description: null, state: 'closed' },
      },
    },
    stray: 'stray',
    removes: { milestones: [{ title: 'declared', mode: 'absent' }] },
    operation: 'delete',
  },
  {
    key: 'properties',
    names: { properties: { declared: 'kept' } },
    structure: { propertyValues: { declared: 'kept', stray: 'untouched' } },
    stray: 'stray',
    removes: { properties: { declared: '' } },
    operation: 'update',
  },
  {
    key: 'environments',
    names: { environments: [{ name: 'declared', reviewers: [] }] },
    structure: {
      environments: [
        { name: 'declared', reviewers: [] },
        { name: 'stray', reviewers: [] },
      ],
    },
    stray: 'stray',
  },
  {
    key: 'files',
    names: { files: [{ path: 'declared', from: '/tmp/declared', mode: 'create-if-missing' }] },
    structure: { files: { declared: true } },
  },
];

for (const family of FAMILIES) {
  test(`${family.key}: an entry the policy does not name is left alone`, () => {
    const changes = planRepo('account', repo(family.structure), family.names, OPTIONS);

    assert.deepEqual(
      changes.map((change) => change.key),
      [],
      'the declared entry already matches, so nothing at all should be planned',
    );
  });

  if (family.stray !== undefined) {
    test(`${family.key}: the undeclared entry is genuinely there to be noticed`, () => {
      /**
       * Without this the case above would pass on a fixture that simply has no
       * stray entry in it, which proves nothing.
       */
      const observed = JSON.stringify(family.structure);
      assert.match(observed, new RegExp(family.stray ?? ''), 'the fixture must hold a stray entry');
    });
  }

  const removes = family.removes;
  if (removes) {
    test(`${family.key}: removal happens only where the policy asks for it`, () => {
      const changes = planRepo('account', repo(family.structure), removes, OPTIONS);

      assert.equal(changes.length, 1, 'and only for the entry that asked');
      assert.equal(changes[0]?.key, `${family.key}.declared`);
      assert.equal(changes[0]?.operation, family.operation);
    });
  }
}

test('a change that removes something is always destructive, whatever the family', () => {
  for (const family of FAMILIES) {
    if (!family.removes) continue;
    const [change] = planRepo('account', repo(family.structure), family.removes, OPTIONS);
    if (change?.operation !== 'delete' && change?.operation !== 'detach') continue;
    assert.equal(change.risk, 'destructive', `${family.key} removes without saying so`);
  }
});

/**
 * Collections of the configuration, derived from the shape rather than listed
 * by hand: a top-level policy field holding a list or a map, and a map one
 * level inside one of those fields.
 *
 * A list inside a value object — `repo.topics`, `default_branch.rename_from` —
 * is not one of these. It is a single value that happens to have several parts,
 * replaced whole, with no entry anybody addresses on its own.
 */
function declaredCollections(): string[] {
  const found: string[] = [];
  for (const [name, field] of Object.entries(POLICY_SET.fields)) {
    if (field.shape.kind === 'object') {
      for (const [child, childField] of Object.entries(field.shape.of().fields)) {
        if (childField.shape.kind === 'map') found.push(`${name}.${child}`);
      }
      continue;
    }
    if (['scalar-list', 'object-list', 'map'].includes(field.shape.kind)) found.push(name);
  }
  return found;
}

/**
 * `policies` is exempt: it names fragments of this same configuration to fold
 * in, so it is part of how a policy is written rather than something a
 * repository holds.
 */
const NOT_A_REPOSITORY_COLLECTION: ReadonlySet<string> = new Set(['policies']);

test('every collection the configuration declares is covered above', () => {
  const covered = new Set(FAMILIES.map((family) => family.key));
  const missing = declaredCollections()
    .filter((name) => !NOT_A_REPOSITORY_COLLECTION.has(name))
    .filter((name) => !covered.has(name));

  assert.deepEqual(
    missing,
    [],
    'a new collection has to state here whether and how it removes an entry',
  );
});
