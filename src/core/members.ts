/**
 * Reading a configuration for the people it names, and comparing that list
 * against who is actually in the organisation.
 *
 * The listings on their own are things GitHub will show anybody. What a
 * configuration file adds is the question nobody can answer from either side
 * alone: of the people this file grants things to, which ones are not in the
 * organisation at all? Those are the grants that will turn into invitations,
 * and an invitation nobody accepts is access that never arrives while the file
 * goes on claiming it does.
 */

import type {
  InspectedInvitation,
  InspectedPerson,
  OwnerScope,
  PolicySet,
  RawInvitation,
} from '../types/index.js';

/** Milliseconds in a day, for the only arithmetic in this module. */
const DAY = 24 * 60 * 60 * 1000;

/**
 * Every login a configuration names, with the paths that name them.
 *
 * The paths are the point: a login that appears once because somebody typed it
 * into one repository's access list is a different finding from one that three
 * teams and an organisation role all depend on.
 *
 * @param scope - One owner's resolved configuration.
 */
export function peopleNamedBy(scope: OwnerScope): Map<string, string[]> {
  const named = new Map<string, string[]>();
  const add = (login: string, path: string): void => {
    named.set(login, [...(named.get(login) ?? []), path]);
  };

  for (const [slug, team] of Object.entries(scope.organization?.teams ?? {})) {
    if (!team?.membership) continue;
    for (const login of team.membership.maintainers ?? []) {
      add(login, `organization.teams.${slug}.membership.maintainers`);
    }
    for (const login of team.membership.members ?? []) {
      add(login, `organization.teams.${slug}.membership.members`);
    }
  }

  for (const [role, holders] of Object.entries(scope.organization?.roles ?? {})) {
    for (const login of holders?.users ?? []) add(login, `organization.roles.${role}.users`);
  }

  for (const [path, policy] of policyLayers(scope)) {
    for (const [login, level] of Object.entries(policy.access?.users ?? {})) {
      /** A revocation names somebody in order to take something away. */
      if (level === null || level === undefined || level === 'none') continue;
      add(login, `${path}.access.users`);
    }
  }

  return named;
}

/**
 * The people a configuration names who are in no part of the organisation.
 *
 * An outside collaborator counts as known: having repository access without
 * being a member is a legitimate arrangement, not an omission. So does someone
 * already invited — they have been asked, and asking again is not the finding.
 *
 * @param named - Logins the configuration names, with where.
 * @param known - Every login the organisation knows, in any capacity.
 */
export function notInTheOrganization(
  named: ReadonlyMap<string, string[]>,
  known: ReadonlySet<string>,
): InspectedPerson[] {
  const missing: InspectedPerson[] = [];
  for (const [login, paths] of named) {
    if (known.has(login)) continue;
    missing.push({ login, named: [...paths].sort() });
  }
  return missing.sort((left, right) => left.login.localeCompare(right.login));
}

/**
 * An invitation as GitHub returns it, with the age that makes a stale one
 * visible.
 *
 * The age is whole days rather than a timestamp difference, because the useful
 * question is "has this been sitting there for a fortnight", not how many
 * seconds ago it was sent.
 *
 * @param raw - The invitation as returned.
 * @param now - The moment to measure against, so a test can fix it.
 */
export function readInvitation(raw: RawInvitation, now: Date = new Date()): InspectedInvitation {
  const createdAt = raw.created_at ?? '';
  const sent = Date.parse(createdAt);
  return {
    login: raw.login ?? null,
    email: raw.email ?? null,
    role: raw.role ?? 'direct_member',
    createdAt,
    waitingDays: Number.isNaN(sent) ? 0 : Math.max(0, Math.floor((now.getTime() - sent) / DAY)),
    ...(raw.failed_at ? { failedAt: raw.failed_at } : {}),
    ...(raw.failed_reason ? { failedReason: raw.failed_reason } : {}),
  };
}

/** Every layer of a resolved scope that can carry an access policy, with its path. */
function policyLayers(scope: OwnerScope): Array<[string, PolicySet]> {
  const layers: Array<[string, PolicySet]> = [];
  if (scope.defaults) layers.push(['defaults', scope.defaults]);
  for (const [type, policy] of Object.entries(scope.types ?? {})) {
    layers.push([`types.${type}`, policy]);
  }
  for (const [repo, policy] of Object.entries(scope.repos ?? {})) {
    layers.push([`repos.${repo}`, policy]);
  }
  return layers;
}
