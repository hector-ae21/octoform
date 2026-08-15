/**
 * Comparing an organisation against its declared policy.
 *
 * Everything else octoform plans belongs to a repository. These settings
 * belong to the account above them, and two of them — the base permission and
 * what members may create — decide things about every repository the
 * organisation owns, including the ones no configuration mentions. That is why
 * they are planned and reported like any other change rather than applied by a
 * command of their own: a setting with that reach should never be the one
 * thing nobody saw a diff for.
 *
 * Custom property definitions belong here for the same reason and travel by a
 * different endpoint, so they are planned alongside the settings and applied
 * one at a time. See `core/properties.ts` for why a definition is read before
 * it is written.
 */

import { isManaged } from '../config/resolve.js';
import { UNREADABLE } from '../config/sentinels.js';
import type {
  Change,
  ExistingProperty,
  ExistingTeam,
  OrganizationPolicy,
  OrganizationState,
  OwnerKind,
  PropertyDefinition,
  Risk,
  TeamPolicy,
} from '../types/index.js';
import {
  asBody,
  definitionBody,
  definitionProblems,
  describeDefinition,
  sameDefinition,
} from './properties.js';
import { bypassProblems, workflowProblems } from './identity.js';
import { matchByName } from './collections.js';
import { describeTeam, sameTeam, teamBody, teamProblems } from './teams.js';
import type { RuleContext } from './rulesets.js';
import { describeExistingRuleset, describeRuleset, sameRuleset, targetOf } from './rulesets.js';
import {
  describeExistingRepositories,
  describeRepositories,
  organizationRulesetProblems,
  sameRepositories,
  targetProblems,
  unnamedWorkflows,
} from './organization-rulesets.js';

/** Every setting of the organisation itself, by the key a change carries. */
export const ORGANIZATION_KEYS: readonly string[] = [
  'organization.profile.name',
  'organization.profile.description',
  'organization.profile.company',
  'organization.profile.website',
  'organization.profile.location',
  'organization.profile.email',
  'organization.profile.twitter_username',
  'organization.members.base_permission',
  'organization.members.create_repositories',
  'organization.members.create_public_repositories',
  'organization.members.create_private_repositories',
  'organization.members.create_internal_repositories',
  'organization.members.fork_private_repositories',
  'organization.members.create_pages',
  'organization.members.create_public_pages',
  'organization.members.create_private_pages',
  'organization.members.web_commit_signoff_required',
  'organization.members.deploy_keys_enabled',
  'organization.members.organization_projects',
  'organization.members.repository_projects',
];

/**
 * The field each key is read from and written to, which is the same field in
 * both directions for every one of them.
 *
 * `website` is the exception in name only: GitHub calls it `blog`, and the
 * configuration does not, because nothing about it is a blog.
 */
export const ORGANIZATION_FIELDS: Readonly<Record<string, string>> = {
  'organization.profile.name': 'name',
  'organization.profile.description': 'description',
  'organization.profile.company': 'company',
  'organization.profile.website': 'blog',
  'organization.profile.location': 'location',
  'organization.profile.email': 'email',
  'organization.profile.twitter_username': 'twitter_username',
  'organization.members.base_permission': 'default_repository_permission',
  'organization.members.create_repositories': 'members_can_create_repositories',
  'organization.members.create_public_repositories': 'members_can_create_public_repositories',
  'organization.members.create_private_repositories': 'members_can_create_private_repositories',
  'organization.members.create_internal_repositories': 'members_can_create_internal_repositories',
  'organization.members.fork_private_repositories': 'members_can_fork_private_repositories',
  'organization.members.create_pages': 'members_can_create_pages',
  'organization.members.create_public_pages': 'members_can_create_public_pages',
  'organization.members.create_private_pages': 'members_can_create_private_pages',
  'organization.members.web_commit_signoff_required': 'web_commit_signoff_required',
  'organization.members.deploy_keys_enabled': 'deploy_keys_enabled_for_repositories',
  'organization.members.organization_projects': 'has_organization_projects',
  'organization.members.repository_projects': 'has_repository_projects',
};

/**
 * Settings that decide something about every repository the organisation owns,
 * including the ones the configuration says nothing about.
 *
 * Lowering the base permission takes access away from people who never
 * appeared in any repository's policy, and turning creation off changes what
 * the whole organisation can do tomorrow. Neither belongs in the same bucket
 * as a description.
 */
const REACHES_EVERY_REPOSITORY: ReadonlySet<string> = new Set([
  'organization.members.base_permission',
  'organization.members.create_repositories',
  'organization.members.create_public_repositories',
  'organization.members.create_private_repositories',
  'organization.members.create_internal_repositories',
  'organization.members.fork_private_repositories',
  'organization.members.web_commit_signoff_required',
  'organization.members.deploy_keys_enabled',
]);

/** What a policy declares, flattened onto the keys a change carries. */
export function declaredOrganization(policy: OrganizationPolicy): Map<string, unknown> {
  const declared = new Map<string, unknown>();
  for (const [group, values] of [
    ['profile', policy.profile],
    ['members', policy.members],
  ] as const) {
    for (const [name, value] of Object.entries(values ?? {})) {
      declared.set(`organization.${group}.${name}`, value);
    }
  }
  return declared;
}

/**
 * Compare an organisation against its policy.
 *
 * @param owner - The organisation login.
 * @param ownerKind - What the login turned out to be.
 * @param observed - The organisation as it stands, or nothing if unread.
 * @param policy - The declared organisation policy.
 */
export function planOrganization(
  owner: string,
  ownerKind: OwnerKind,
  observed: OrganizationState | undefined,
  policy: OrganizationPolicy | undefined,
): Change[] {
  if (!policy) return [];

  const changes: Change[] = [];
  const draft = (
    key: string,
    from: unknown,
    to: unknown,
    extra: {
      blocked?: string;
      risk?: Risk;
      operation?: Change['operation'];
      payload?: unknown;
      prerequisites?: string[];
    } = {},
  ): void => {
    changes.push({
      id: `${owner}#${key}`,
      owner,
      key,
      operation: extra.operation ?? (from === null || from === undefined ? 'create' : 'update'),
      risk: extra.risk ?? riskOf(key),
      prerequisites: extra.prerequisites ?? [],
      from,
      to,
      ...(extra.blocked === undefined ? {} : { blocked: extra.blocked }),
      ...(extra.payload === undefined ? {} : { payload: extra.payload }),
    });
  };

  for (const [key, wanted] of declaredOrganization(policy)) {
    if (!isManaged(wanted)) continue;

    if (ownerKind === 'user') {
      draft(key, null, wanted, {
        blocked: `"${owner}" is a personal account, which has none of the organisation settings`,
      });
      continue;
    }

    const held = observed?.settings?.[key];
    if (held === undefined) {
      draft(key, UNREADABLE, wanted, {
        blocked: 'could not read the current organisation settings',
      });
      continue;
    }
    if (held === UNREADABLE) {
      draft(key, held, wanted, {
        blocked: 'current value could not be read, so the change was not attempted',
      });
      continue;
    }
    if (same(held, wanted)) continue;

    draft(key, held, wanted);
  }

  planDefinitions(ownerKind, observed?.properties, policy, draft);
  planTeams(owner, ownerKind, observed?.teams, policy, draft);
  planOrganizationRulesets(owner, ownerKind, observed, policy, draft);

  return changes;
}

/**
 * Teams, which are the first thing octoform plans that refers to another thing
 * it is planning in the same run.
 *
 * A child team names its parent, so a child whose parent this run is creating
 * carries that creation as a prerequisite. The graph then does both halves:
 * the parent is attempted first, and a child whose parent failed is blocked
 * rather than sent to sit under a team that does not exist.
 */
function planTeams(
  owner: string,
  ownerKind: OwnerKind,
  existing: Record<string, ExistingTeam> | undefined,
  policy: OrganizationPolicy,
  draft: Draft,
): void {
  const declared = new Map<string, TeamPolicy>();
  for (const [slug, team] of Object.entries(policy.teams ?? {})) {
    if (isManaged(team)) declared.set(slug, team as TeamPolicy);
  }
  if (declared.size === 0) return;

  const problems = teamProblems(declared, existing);
  const byName = new Map(Object.entries(existing ?? {}));

  for (const [slug, team] of declared) {
    const key = `organization.teams.${slug}`;
    const shown = describeTeam(slug, team);

    if (ownerKind === 'user') {
      draft(key, null, shown, {
        blocked: `"${owner}" is a personal account, which has no teams`,
      });
      continue;
    }

    const wrong = problems.get(slug);
    if (wrong && wrong.length > 0) {
      draft(key, null, shown, { blocked: wrong.join('; ') });
      continue;
    }

    if (existing === undefined) {
      draft(key, UNREADABLE, shown, { blocked: 'could not read the organisation teams' });
      continue;
    }

    const found = matchByName(byName, slug, team.rename_from);

    if (team.mode === 'absent') {
      if (!found) continue;
      draft(key, describeTeam(found.entry.slug, found.entry), null, {
        operation: 'delete',
        risk: 'destructive',
        payload: { team: found.entry.slug, remove: true },
      });
      continue;
    }

    if (!found) {
      /**
       * A team created under a parent this run is also creating has to wait
       * for it. Only a parent that is actually being created counts: one that
       * already exists is nothing to wait for.
       */
      const parent = team.parent;
      const waitingFor =
        parent && declared.has(parent) && !byName.has(parent)
          ? [`${owner}#organization.teams.${parent}`]
          : [];
      draft(key, null, shown, {
        prerequisites: waitingFor,
        payload: { team: slug, body: teamBody(slug, team, true) },
      });
      continue;
    }

    if (sameTeam(found.entry, slug, team)) continue;

    draft(key, describeTeam(found.entry.slug, found.entry), shown, {
      operation: 'update',
      risk: teamRisk(found.entry, team),
      payload: { team: found.entry.slug, body: teamBody(slug, team, false) },
    });
  }
}

/**
 * What a team change costs.
 *
 * Widening a secret team to closed shows it, and everything about it, to the
 * whole organisation. Nothing else here is more than a label: a description, a
 * notification setting, a move between parents.
 */
function teamRisk(current: ExistingTeam, declared: TeamPolicy): Risk {
  return current.privacy === 'secret' && declared.privacy === 'closed' ? 'sensitive' : 'normal';
}

/**
 * Rulesets the organisation aims at repositories it selects.
 *
 * Every one of these is sensitive. A repository ruleset reaches the repository
 * it is on, and somebody looking at that repository can see it; an
 * organisation ruleset reaches whatever its condition matches, which includes
 * repositories no configuration names and nobody was reading the plan for.
 */
function planOrganizationRulesets(
  owner: string,
  ownerKind: OwnerKind,
  observed: OrganizationState | undefined,
  policy: OrganizationPolicy,
  draft: Draft,
): void {
  const existing = observed?.rulesets;
  const context: RuleContext = { resolution: observed?.resolved ?? new Map(), repository: '' };

  for (const declared of policy.rulesets ?? []) {
    const key = `organization.rulesets.${declared.name}`;
    const shown = `${describeRuleset(declared, context)}; ${describeRepositories(declared.repositories ?? {})}`;

    if (ownerKind === 'user') {
      draft(key, null, shown, {
        risk: 'sensitive',
        blocked: `"${owner}" is a personal account, which has no rulesets of its own to aim at repositories`,
      });
      continue;
    }

    /**
     * A name that did not resolve stops the whole ruleset, the same way it
     * does on a repository: sending the rest would create a ruleset that
     * enforces everything it was asked to and lets nobody past.
     */
    const target = targetOf(declared);
    const problems = [
      ...targetProblems(declared),
      ...organizationRulesetProblems(declared),
      ...(target === null
        ? []
        : bypassProblems(declared, context.resolution, ownerKind, target.target)),
      /**
       * Only the workflows that named their repository are looked up here.
       * The ones that did not are already refused above, and asking about a
       * repository called nothing would answer with a message about a name
       * nobody wrote.
       */
      ...(unnamedWorkflows(declared).length > 0
        ? []
        : workflowProblems(declared, context.resolution, context.repository)),
    ];
    if (problems.length > 0) {
      draft(key, null, shown, { risk: 'sensitive', blocked: problems.join('; ') });
      continue;
    }

    if (existing === undefined) {
      draft(key, UNREADABLE, shown, {
        risk: 'sensitive',
        blocked: 'could not read the existing organisation rulesets',
      });
      continue;
    }

    const current = existing.find((ruleset) => ruleset.name === declared.name);
    if (!current) {
      draft(key, null, shown, {
        risk: 'sensitive',
        payload: { ruleset: declared, context },
      });
      continue;
    }

    if (
      sameRuleset(current, declared, context) &&
      sameRepositories(current.repositories, declared.repositories ?? {})
    ) {
      continue;
    }

    draft(
      key,
      `${describeExistingRuleset(current, context)}; ${describeExistingRepositories(current)}`,
      shown,
      {
        operation: 'update',
        risk: 'sensitive',
        payload: { ruleset: declared, id: current.id, existing: current, context },
      },
    );
  }
}

/** How a change is drafted, shared by everything {@link planOrganization} plans. */
type Draft = (
  key: string,
  from: unknown,
  to: unknown,
  extra?: {
    blocked?: string;
    risk?: Risk;
    operation?: Change['operation'];
    payload?: unknown;
    prerequisites?: string[];
  },
) => void;

/**
 * Custom property definitions, which are the organisation's half of a feature
 * whose other half is a field on every repository.
 *
 * Unreadable definitions block every one of them rather than only the ones
 * that look different, and for a reason particular to this endpoint: it
 * replaces. Writing a definition without the one that stands is not an
 * uninformed change to one field, it is an uninformed change to all of them.
 */
function planDefinitions(
  ownerKind: OwnerKind,
  existing: Record<string, ExistingProperty> | undefined,
  policy: OrganizationPolicy,
  draft: Draft,
): void {
  for (const [name, declared] of Object.entries(policy.properties ?? {})) {
    if (!isManaged(declared)) continue;
    const key = `organization.properties.${name}`;
    const wanted = declared as PropertyDefinition;
    const removing = wanted.mode === 'absent';

    if (ownerKind === 'user') {
      draft(key, null, describeDefinition(wanted), {
        blocked: 'custom properties are an organisation feature, and a personal account has none',
      });
      continue;
    }

    if (existing === undefined) {
      draft(key, UNREADABLE, describeDefinition(wanted), {
        blocked:
          'could not read the current custom property definitions, and writing one replaces every field of it',
      });
      continue;
    }

    const current = existing[name];

    if (removing) {
      if (current === undefined) continue;
      draft(key, describeDefinition(current), null, {
        operation: 'delete',
        risk: 'destructive',
        payload: { property: name, remove: true },
      });
      continue;
    }

    const problems = definitionProblems(wanted);
    if (problems.length > 0) {
      draft(
        key,
        current === undefined ? null : describeDefinition(current),
        describeDefinition(wanted),
        {
          blocked: problems.join('; '),
        },
      );
      continue;
    }

    if (current?.source_type === 'enterprise') {
      draft(key, describeDefinition(current), describeDefinition(wanted), {
        blocked: 'defined by the enterprise, so the organisation cannot change it',
      });
      continue;
    }

    if (current !== undefined && sameDefinition(current, wanted)) continue;

    const body = definitionBody(wanted, current);
    draft(
      key,
      current === undefined ? null : describeDefinition(asBody(current)),
      describeDefinition(body),
      {
        operation: current === undefined ? 'create' : 'update',
        risk: definitionRisk(current, body),
        payload: { property: name, body },
      },
    );
  }
}

/**
 * What a definition change costs, which is not measured by how many fields it
 * touches.
 *
 * A definition that demands a value asks something of every repository the
 * organisation owns, and dropping an allowed value leaves whichever
 * repositories hold it holding one the definition no longer offers. Everything
 * else — a description, a new property nobody has to answer — changes what the
 * settings page shows and nothing else.
 */
function definitionRisk(
  current: ExistingProperty | undefined,
  body: Record<string, unknown>,
): Risk {
  if (body.required === true || body.require_explicit_values === true) return 'sensitive';

  const before = current?.allowed_values ?? null;
  const after = (body.allowed_values as string[] | undefined) ?? null;
  if (before && after && before.some((value) => !after.includes(value))) return 'sensitive';

  return 'normal';
}

function riskOf(key: string): Risk {
  return REACHES_EVERY_REPOSITORY.has(key) ? 'sensitive' : 'normal';
}

/** Unset and empty string are the same absence, the way they are on a repository. */
function same(current: unknown, wanted: unknown): boolean {
  if ((current === '' || current === null) && (wanted === '' || wanted === null)) return true;
  return current === wanted;
}
