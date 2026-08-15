/**
 * One contract, held to every adapter between a declared policy and the shape
 * GitHub stores.
 *
 * Each resource octoform manages has a pair: something that reads GitHub's
 * answer into the model, and something that turns the model into a request.
 * Written apart, the two drift — a field readable under one name and written
 * under another looks correct from either side and is only wrong together, and
 * the symptom is a change planned on every run that never takes effect.
 *
 * So the cases here are deliberately not about any particular field. They put
 * a declared policy through the write side, read the result back, and require
 * the answer to say what the policy said. A field either survives that or the
 * pair is broken, whichever half is at fault.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalLevel, grantLevel, readLevel } from '../src/core/access.js';
import { protectionBody, readProtection } from '../src/core/branch-protection.js';
import {
  labelBody,
  milestoneBody,
  readLabel,
  readMilestone,
  sameLabel,
  sameMilestone,
} from '../src/core/collections.js';
import { readRuleset, rulesetBody, sameRuleset } from '../src/core/rulesets.js';
import { definitionBody, readDefinition, sameDefinition } from '../src/core/properties.js';
import { readTeam, sameTeam, teamBody } from '../src/core/teams.js';
import { repositoryConditions, sameRepositories } from '../src/core/organization-rulesets.js';
import type {
  BranchProtectionPolicy,
  PropertyDefinition,
  RulesetPolicy,
  RulesetRepositories,
  TeamPolicy,
} from '../src/types/index.js';

interface Adapter {
  resource: string;
  /**
   * Put a declared policy through the write side and read it back, answering
   * whether what came back still says what the policy said.
   */
  roundTrip: () => boolean;
  /** The same policy written twice, which must produce identical requests. */
  twice: () => [unknown, unknown];
  /** A policy declaring nothing, whose request must invent no values. */
  empty: () => Record<string, unknown>;
  /** Keys the empty request is allowed to carry, and why each one must be there. */
  required: readonly string[];
}

const RULESET: RulesetPolicy = {
  name: 'protect',
  target_branches: ['main'],
  exclude: ['release/*'],
  enforcement: 'evaluate',
  block_force_push: true,
  block_deletion: true,
  require_pull_request: true,
  required_approvals: 2,
  require_code_owner_review: true,
  required_checks: ['CI'],
  strict_required_checks: true,
  require_linear_history: true,
  commit_message_pattern: { operator: 'starts_with', pattern: 'feat' },
  restricted_file_paths: ['secrets/**'],
  max_file_size: 100,
};

const PROTECTION: BranchProtectionPolicy = {
  branch: 'main',
  enforce_admins: true,
  require_pull_request: true,
  required_approvals: 2,
  dismiss_stale_reviews: true,
  require_code_owner_review: true,
  required_checks: ['CI'],
  strict_required_checks: true,
  restrict_pushes: { users: ['hector'], teams: [], apps: [] },
  require_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: true,
  require_conversation_resolution: true,
  lock_branch: false,
  allow_fork_syncing: true,
};

const LABEL = { name: 'bug', color: '#D73A4A', description: 'Something is broken' };
const MILESTONE = {
  title: 'v1.0',
  description: 'First stable release',
  due: '2026-03-01',
  state: 'open' as const,
};

/**
 * Classic branch protection is the one resource whose request and response
 * shapes are not the same, so the round trip has to state the difference
 * rather than pretend there is none.
 *
 * GitHub takes a bare boolean for each switch and answers with `{ enabled }`,
 * and it takes a restriction as plain logins and answers with objects. Both
 * halves of the adapter are right about their own direction; only a test that
 * feeds one into the other has to bridge them, and writing the bridge here is
 * how the difference stays visible instead of being discovered again later.
 */
function asProtectionResponse(body: Record<string, unknown>): Parameters<typeof readProtection>[0] {
  const wrapped = (key: string): { enabled: boolean } => ({ enabled: body[key] === true });
  const named = (value: unknown): { users: Array<{ login: string }>; teams: []; apps: [] } => {
    const restriction = value as { users?: string[] } | null;
    return { users: (restriction?.users ?? []).map((login) => ({ login })), teams: [], apps: [] };
  };

  return {
    required_status_checks: body.required_status_checks as {
      strict?: boolean;
      contexts?: string[];
    },
    enforce_admins: wrapped('enforce_admins'),
    required_pull_request_reviews: body.required_pull_request_reviews as Parameters<
      typeof readProtection
    >[0]['required_pull_request_reviews'],
    ...(body.restrictions === null ? {} : { restrictions: named(body.restrictions) }),
    required_linear_history: wrapped('required_linear_history'),
    allow_force_pushes: wrapped('allow_force_pushes'),
    allow_deletions: wrapped('allow_deletions'),
    block_creations: wrapped('block_creations'),
    required_conversation_resolution: wrapped('required_conversation_resolution'),
    lock_branch: wrapped('lock_branch'),
    allow_fork_syncing: wrapped('allow_fork_syncing'),
  };
}

const DEFINITION: PropertyDefinition = {
  value_type: 'single_select',
  description: 'How closely this repository is watched',
  required: true,
  default_value: 'bronze',
  allowed_values: ['bronze', 'silver', 'gold'],
  values_editable_by: 'org_actors',
  require_explicit_values: true,
};

const TEAM: TeamPolicy = {
  name: 'Platform On-call',
  description: 'Carries the pager',
  privacy: 'closed',
  notifications: false,
  parent: 'platform',
};

const SELECTION: RulesetRepositories = {
  properties: [{ name: 'tier', values: ['gold', 'silver'] }],
  exclude_properties: [{ name: 'tier', values: ['retired'] }],
};

/**
 * A team's request and response disagree in one place, the way branch
 * protection's do: the parent goes out as a slug on `parent_team_slug` and
 * comes back as an object on `parent`. Bridging it here is what keeps that
 * asymmetry a stated fact rather than something rediscovered later.
 */
function asTeamResponse(body: Record<string, unknown>): Parameters<typeof readTeam>[0] {
  const parent = body.parent_team_slug;
  return {
    id: 1,
    slug: 'platform-oncall',
    name: body.name as string,
    description: body.description as string,
    privacy: body.privacy as string,
    notification_setting: body.notification_setting as string,
    parent: typeof parent === 'string' ? { slug: parent } : null,
  };
}

const ADAPTERS: readonly Adapter[] = [
  {
    resource: 'ruleset',
    roundTrip: () => {
      const body = rulesetBody(RULESET);
      const stored = readRuleset({
        id: 1,
        name: String(body.name),
        target: String(body.target),
        enforcement: String(body.enforcement),
        conditions: body.conditions as { ref_name?: { include?: string[]; exclude?: string[] } },
        rules: body.rules as Array<{ type: string; parameters?: Record<string, unknown> }>,
      });
      return sameRuleset(stored, RULESET);
    },
    twice: () => [rulesetBody(RULESET), rulesetBody(RULESET)],
    empty: () => rulesetBody({ name: 'empty', target_branches: [] }),
    required: ['name', 'target', 'enforcement', 'bypass_actors', 'conditions', 'rules'],
  },
  {
    resource: 'branch protection',
    roundTrip: () => {
      const stored = readProtection(asProtectionResponse(protectionBody(PROTECTION)));
      return Object.entries(PROTECTION)
        .filter(([key]) => key !== 'branch')
        .every(([key, wanted]) => {
          const held = (stored as Record<string, unknown>)[key];
          return JSON.stringify(held) === JSON.stringify(wanted);
        });
    },
    twice: () => [protectionBody(PROTECTION), protectionBody(PROTECTION)],
    empty: () => protectionBody({ branch: 'main' }),
    /** GitHub reads an omitted member of this body as an instruction to remove it. */
    required: [
      'required_status_checks',
      'enforce_admins',
      'required_pull_request_reviews',
      'restrictions',
      'required_linear_history',
      'allow_force_pushes',
      'allow_deletions',
      'block_creations',
      'required_conversation_resolution',
      'lock_branch',
      'allow_fork_syncing',
    ],
  },
  {
    resource: 'label',
    roundTrip: () => {
      const stored = readLabel(labelBody(LABEL) as Parameters<typeof readLabel>[0]);
      return stored !== undefined && sameLabel(stored, LABEL);
    },
    twice: () => [labelBody(LABEL), labelBody(LABEL)],
    empty: () => labelBody({ name: 'bare' }),
    required: ['name'],
  },
  {
    resource: 'milestone',
    roundTrip: () => {
      const body = milestoneBody(MILESTONE);
      const stored = readMilestone({ number: 1, ...body } as Parameters<typeof readMilestone>[0]);
      return stored !== undefined && sameMilestone(stored, MILESTONE);
    },
    twice: () => [milestoneBody(MILESTONE), milestoneBody(MILESTONE)],
    empty: () => milestoneBody({ title: 'bare' }),
    required: ['title'],
  },
  {
    resource: 'access level',
    roundTrip: () =>
      ['read', 'triage', 'write', 'maintain', 'admin', 'custom-role'].every(
        (level) => readLevel(grantLevel(level), undefined) === canonicalLevel(level),
      ),
    twice: () => [grantLevel('write'), grantLevel('write')],
    empty: () => ({ permission: grantLevel('read') }),
    required: ['permission'],
  },
  {
    resource: 'property definition',
    roundTrip: () => {
      const body = definitionBody(DEFINITION, undefined);
      const stored = readDefinition({ property_name: 'tier', ...body });
      return stored !== undefined && sameDefinition(stored, DEFINITION);
    },
    twice: () => [definitionBody(DEFINITION, undefined), definitionBody(DEFINITION, undefined)],
    empty: () => definitionBody({ value_type: 'string' }, undefined),
    /** The endpoint refuses a definition with no type, so this one field is not a value nobody asked for. */
    required: ['value_type'],
  },
  {
    resource: 'team',
    roundTrip: () => {
      const stored = readTeam(asTeamResponse(teamBody('platform-oncall', TEAM, true)));
      return stored !== undefined && sameTeam(stored, 'platform-oncall', TEAM);
    },
    twice: () => [teamBody('platform-oncall', TEAM, true), teamBody('platform-oncall', TEAM, true)],
    /** Updating a team that declares nothing sends nothing at all, since this endpoint patches. */
    empty: () => teamBody('platform-oncall', {}, false),
    required: [],
  },
  {
    resource: 'organisation ruleset selection',
    roundTrip: () => {
      const stored = readRuleset({
        id: 1,
        name: 'protect',
        conditions: repositoryConditions(SELECTION) as Parameters<
          typeof readRuleset
        >[0]['conditions'],
      });
      return sameRepositories(stored.repositories, SELECTION);
    },
    twice: () => [repositoryConditions(SELECTION), repositoryConditions(SELECTION)],
    empty: () => repositoryConditions({}),
    /** A selection that names nothing is refused while planning; the shape still has to be the one the endpoint takes. */
    required: ['repository_name'],
  },
];

for (const adapter of ADAPTERS) {
  test(`${adapter.resource}: what is written reads back as what was declared`, () => {
    assert.ok(
      adapter.roundTrip(),
      'a field written under one name and read under another is wrong only when the two are put together',
    );
  });

  test(`${adapter.resource}: the same policy always produces the same request`, () => {
    const [first, second] = adapter.twice();
    assert.deepEqual(first, second, 'a request that varies makes a plan unrepeatable');
  });

  test(`${adapter.resource}: a policy declaring nothing invents nothing`, () => {
    const body = adapter.empty();
    const extra = Object.keys(body).filter((key) => !adapter.required.includes(key));

    assert.deepEqual(
      extra,
      [],
      'anything here would be a value nobody asked for, sent as though they had',
    );
  });
}

test('every adapter between the model and GitHub is covered above', () => {
  /**
   * Named rather than derived: an adapter is a pair of functions, not a
   * declared shape, so there is nothing to enumerate it from. Keeping the list
   * here at least makes adding one without a contract a visible omission.
   */
  const covered = ADAPTERS.map((adapter) => adapter.resource).sort();

  assert.deepEqual(covered, [
    'access level',
    'branch protection',
    'label',
    'milestone',
    'organisation ruleset selection',
    'property definition',
    'ruleset',
    'team',
  ]);
});
