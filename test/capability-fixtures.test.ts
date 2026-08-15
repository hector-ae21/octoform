/**
 * The published capability register, held to what the planner actually does.
 *
 * `reference/capabilities.json` ships with every release and states, for each
 * thing octoform manages, which kinds of owner it works on. That is a claim
 * about behaviour, and a claim in a generated artifact is the easiest kind to
 * let go stale — nothing breaks when it stops being true, it just quietly
 * misinforms whoever reads it.
 *
 * So each capability that a repository policy can express is planned here
 * against all four combinations of owner kind and visibility, and the register
 * is required to agree: what it says is organisation-only must block on a
 * personal repository, and what it says works on both must not block for that
 * reason on either.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { planRepo } from '../src/core/plan.js';
import { capability } from '../src/github/capabilities.js';
import type {
  Change,
  OwnerKind,
  PlanOptions,
  PolicySet,
  RepoDetail,
  RepoStructure,
} from '../src/types/index.js';

interface RegisterCapability {
  id: string;
  ownerKinds: string[];
  configPaths: string[];
}

const register = JSON.parse(
  readFileSync(resolve(process.cwd(), 'reference/capabilities.json'), 'utf8'),
) as { capabilities: RegisterCapability[] };

/**
 * Observed state complete enough that nothing blocks merely for not having
 * been read. Anything that does block is then blocking for a reason worth
 * reporting, which is what these cases are about.
 */
const STRUCTURE: RepoStructure = {
  rulesets: [],
  branchProtection: { main: null },
  branches: { develop: true },
  collaborators: {},
  invitations: {},
  teamAccess: {},
  labels: {},
  milestones: {},
  propertyValues: {},
  environments: [],
  files: { '.github/x.yml': true },
  resolved: new Map([['user:hector', 1]]),
};

const SETTINGS: Record<string, unknown> = {
  'features.issues': true,
  'features.wiki': true,
  'features.projects': true,
  'features.discussions': false,
  'features.sponsorships': false,
  'features.pull_requests': true,
  'merge.allow_squash': true,
  'repo.description': null,
  'repo.homepage': null,
  'repo.topics': [],
  'repo.allow_forking': true,
  'repo.web_commit_signoff_required': false,
  'repo.issue_creation': 'ALL',
  'repo.pull_request_creation': 'ALL',
  'repo.template': false,
  'security.vulnerability_alerts': false,
  'security.automated_security_fixes': false,
  'security.private_vulnerability_reporting': false,
  'security.secret_scanning': false,
  'security.secret_scanning_push_protection': false,
  'security.code_scanning_default_setup': false,
  'security.immutable_releases': false,
};

function repo(visibility: 'public' | 'private'): RepoDetail {
  return {
    name: 'thing',
    visibility,
    archived: false,
    default_branch: 'main',
    description: null,
    homepage: null,
    topics: [],
    nodeId: 'R_abc',
    settings: SETTINGS as RepoDetail['settings'],
    structure: STRUCTURE,
    workflowsUploadingCodeScanning: undefined,
  } as RepoDetail;
}

/**
 * One policy fragment per capability, chosen to actually produce a change so
 * that "did not block" is a statement about the capability rather than about
 * a policy that asked for nothing.
 */
const EXERCISES: Readonly<Record<string, { policy: PolicySet; key: string }>> = {
  'repository-features': { policy: { features: { issues: false } }, key: 'features.issues' },
  'repository-discussions': {
    policy: { features: { discussions: true } },
    key: 'features.discussions',
  },
  'repository-graphql-settings': {
    policy: { features: { sponsorships: true } },
    key: 'features.sponsorships',
  },
  'merge-settings': { policy: { merge: { allow_squash: false } }, key: 'merge.allow_squash' },
  'repository-metadata': { policy: { repo: { description: 'set' } }, key: 'repo.description' },
  'repository-topics': { policy: { repo: { topics: ['a'] } }, key: 'repo.topics' },
  'repository-guarded-changes': { policy: { repo: { template: true } }, key: 'repo.template' },
  'vulnerability-alerts': {
    policy: { security: { vulnerability_alerts: true } },
    key: 'security.vulnerability_alerts',
  },
  'automated-security-fixes': {
    policy: { security: { automated_security_fixes: true } },
    key: 'security.automated_security_fixes',
  },
  'private-vulnerability-reporting': {
    policy: { security: { private_vulnerability_reporting: true } },
    key: 'security.private_vulnerability_reporting',
  },
  'secret-scanning-settings': {
    policy: { security: { secret_scanning: true } },
    key: 'security.secret_scanning',
  },
  'code-scanning-default-setup': {
    policy: { security: { code_scanning_default_setup: true } },
    key: 'security.code_scanning_default_setup',
  },
  'immutable-releases': {
    policy: { security: { immutable_releases: true } },
    key: 'security.immutable_releases',
  },
  'default-branch-rename': {
    policy: { default_branch: { name: 'trunk', rename_from: ['main'] } },
    key: 'default_branch.name',
  },
  'ensured-branches': { policy: { ensure_branches: ['fresh'] }, key: 'ensure_branches.fresh' },
  'branch-protection': {
    policy: { branch_protection: [{ branch: 'main', enforce_admins: true }] },
    key: 'branch_protection.main',
  },
  'repository-rulesets': {
    policy: { rulesets: [{ name: 'protect', target_branches: ['main'], block_deletion: true }] },
    key: 'rulesets.protect',
  },
  'ruleset-bypass-actors': {
    policy: {
      rulesets: [{ name: 'protect', target_branches: ['main'], bypass: [{ users: ['hector'] }] }],
    },
    key: 'rulesets.protect',
  },
  'ruleset-required-workflows': {
    policy: {
      rulesets: [
        {
          name: 'protect',
          target_branches: ['main'],
          required_workflows: [{ path: 'ci.yml', repository_id: 9 }],
        },
      ],
    },
    key: 'rulesets.protect',
  },
  'repository-collaborators': {
    policy: { access: { users: { hector: 'write' } } },
    key: 'access.users.hector',
  },
  'team-repository-access': {
    policy: { access: { teams: { reviewers: 'write' } } },
    key: 'access.teams.reviewers',
  },
  'repository-labels': { policy: { labels: [{ name: 'bug' }] }, key: 'labels.bug' },
  'repository-milestones': { policy: { milestones: [{ title: 'v1' }] }, key: 'milestones.v1' },
  'repository-property-values': {
    policy: { properties: { team: 'platform' } },
    key: 'properties.team',
  },
  'deployment-environments': {
    policy: { environments: [{ name: 'prod' }] },
    key: 'environments.prod',
  },
  'create-if-missing-files': {
    policy: { files: [{ path: 'new.yml', from: '/tmp/new.yml', mode: 'create-if-missing' }] },
    key: 'files.new.yml',
  },
};

/**
 * Capabilities no repository policy expresses: discovery, classification and
 * the audit expectations, which describe how repositories are found and sorted
 * rather than anything planned against one.
 */
const NOT_PLANNED_PER_REPOSITORY: ReadonlySet<string> = new Set([
  /**
   * Planned against the owner rather than a repository, so there is no
   * repository to plan them on. Their own cases live in organization.test.ts,
   * properties.definitions.test.ts and organization-rulesets.test.ts.
   */
  'organization-profile',
  'organization-member-policies',
  'organization-property-definitions',
  'organization-rulesets',
  'organization-teams',
  'organization-role-assignment',
  'team-membership',
  'organization-member-inventory',
  'audit-expectations',
  'authenticated-identity',
  'owner-kind',
  'repository-inventory',
  'repository-classification',
  'organization-custom-properties',
]);

function planned(
  policy: PolicySet,
  ownerKind: OwnerKind,
  visibility: 'public' | 'private',
): Change[] {
  const options: PlanOptions = {
    rulesetCapability: capability('supported', 'assumed in this suite', 'permission'),
    ownerKind,
  };
  return planRepo('account', repo(visibility), policy, options);
}

for (const entry of register.capabilities) {
  if (NOT_PLANNED_PER_REPOSITORY.has(entry.id)) continue;
  const exercise = EXERCISES[entry.id];
  if (!exercise) continue;

  const organisationOnly = !entry.ownerKinds.includes('personal');

  for (const visibility of ['public', 'private'] as const) {
    test(`${entry.id}: personal + ${visibility} agrees with the register`, () => {
      const change = planned(exercise.policy, 'user', visibility).find(
        (candidate) => candidate.key === exercise.key,
      );

      assert.ok(change, `nothing was planned for ${exercise.key}, so the case proves nothing`);
      if (organisationOnly) {
        assert.ok(
          change.blocked,
          'the register says this needs an organisation, so a personal repository must be told why',
        );
      } else {
        assert.equal(
          change.blocked,
          undefined,
          'the register says this works on a personal repository',
        );
      }
    });

    test(`${entry.id}: organisation + ${visibility} is never blocked by owner kind`, () => {
      const change = planned(exercise.policy, 'org', visibility).find(
        (candidate) => candidate.key === exercise.key,
      );

      assert.ok(change, `nothing was planned for ${exercise.key}, so the case proves nothing`);
      assert.doesNotMatch(
        String(change.blocked ?? ''),
        /personal (repository|account)/u,
        'an organisation cannot be refused for not being one',
      );
    });
  }
}

test('rulesets on a private repository need evidence before anything is attempted', () => {
  const changes = planRepo(
    'account',
    repo('private'),
    EXERCISES['repository-rulesets']?.policy ?? {},
    {
      rulesetCapability: capability('forbidden', 'no evidence in this fixture', 'permission'),
      ownerKind: 'user',
    },
  );

  assert.equal(changes.length, 1);
  assert.match(String(changes[0]?.blocked), /no evidence in this fixture/u);
});

test('a public repository never needs that evidence', () => {
  const changes = planRepo(
    'account',
    repo('public'),
    EXERCISES['repository-rulesets']?.policy ?? {},
    {
      rulesetCapability: capability('forbidden', 'no evidence in this fixture', 'permission'),
      ownerKind: 'user',
    },
  );

  assert.equal(changes[0]?.blocked, undefined);
});

test('every capability a repository policy can express has a fixture', () => {
  const missing = register.capabilities
    .map((entry) => entry.id)
    .filter((id) => !NOT_PLANNED_PER_REPOSITORY.has(id))
    .filter((id) => !(id in EXERCISES));

  assert.deepEqual(
    missing,
    [],
    'a published capability with no fixture is a claim about behaviour that nothing checks',
  );
});
