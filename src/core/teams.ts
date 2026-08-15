/**
 * Teams: comparing declared ones against what the organisation has, and
 * refusing the shapes GitHub's own description says it will not keep.
 *
 * Two things make teams unlike every other collection octoform manages.
 *
 * They refer to each other. A team names its parent, so the order they are
 * created in matters and a child whose parent was never created has nowhere to
 * go. That is why the planner gives a child a prerequisite rather than trusting
 * the order the file happens to be written in.
 *
 * And deleting one is not local. GitHub deletes a parent's child teams along
 * with it, so `mode: absent` on a team with declared children is a file asking
 * for two contradictory things, and is refused rather than resolved.
 *
 * The update endpoint patches rather than replaces — GitHub's words are that
 * editing a team without a parameter "leaves `privacy` intact" — so unlike a
 * custom property definition, only the declared fields are sent.
 */

import type { ExistingTeam, TeamMembership, TeamPolicy, TeamRole } from '../types/index.js';

/** How GitHub spells a team's notification choice. */
const NOTIFICATIONS = {
  on: 'notifications_enabled',
  off: 'notifications_disabled',
} as const;

/**
 * A team as GitHub returns it, reduced to what octoform compares.
 *
 * The notification setting comes back as one of two strings that differ only
 * in the word `disabled`. It is a boolean, and it is stored as one here so the
 * configuration can say so too.
 */
export function readTeam(raw: {
  id?: number;
  slug?: string;
  name?: string;
  description?: string | null;
  privacy?: string;
  notification_setting?: string;
  parent?: { slug?: string } | null;
}): ExistingTeam | undefined {
  if (!raw.slug || raw.id === undefined) return undefined;
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name ?? raw.slug,
    description: raw.description ?? null,
    privacy: raw.privacy === 'secret' ? 'secret' : 'closed',
    notifications: raw.notification_setting !== NOTIFICATIONS.off,
    parent: raw.parent?.slug ?? null,
  };
}

/**
 * The name a declared team goes by, which is its slug when it says nothing
 * else. The slug is a handle people already use; making a file repeat it as a
 * display name would add a second place for the two to disagree.
 */
export function teamName(slug: string, declared: TeamPolicy): string {
  return declared.name ?? slug;
}

/**
 * The request body that creates or updates a team.
 *
 * Only what the policy states, because this endpoint patches: a field left out
 * keeps what it had. `parent` is the one field with two spellings for absence
 * — empty detaches, and GitHub takes `null` for that, while `null` in the
 * configuration already means "stop managing this".
 *
 * @param slug - The slug the team is declared under.
 * @param declared - The team as the configuration states it.
 * @param creating - Whether this body creates the team rather than updating it.
 */
export function teamBody(
  slug: string,
  declared: TeamPolicy,
  creating: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (creating || declared.name !== undefined) body.name = teamName(slug, declared);
  if (declared.description !== undefined) body.description = declared.description;
  if (declared.privacy !== undefined) body.privacy = declared.privacy;
  if (declared.notifications !== undefined) {
    body.notification_setting = declared.notifications ? NOTIFICATIONS.on : NOTIFICATIONS.off;
  }
  if (declared.parent !== undefined) {
    body.parent_team_slug = declared.parent === '' ? null : declared.parent;
  }

  return body;
}

/** Whether the stored team already says everything the policy declares. */
export function sameTeam(current: ExistingTeam, slug: string, declared: TeamPolicy): boolean {
  if (current.slug !== slug) return false;
  if (declared.name !== undefined && current.name !== declared.name) return false;
  if (declared.description !== undefined && (current.description ?? '') !== declared.description) {
    return false;
  }
  if (declared.privacy !== undefined && current.privacy !== declared.privacy) return false;
  if (declared.notifications !== undefined && current.notifications !== declared.notifications) {
    return false;
  }
  if (declared.parent !== undefined && (current.parent ?? '') !== declared.parent) return false;
  return true;
}

/**
 * What is wrong with the declared teams, read against each other rather than
 * one at a time.
 *
 * Every one of these needs the whole set to answer: whether a parent exists,
 * whether a team has children, whether the parents lead back round to where
 * they started. Checking a team on its own would miss all three.
 *
 * @param declared - Every declared team, by slug, cancellations already dropped.
 * @param existing - The teams the organisation has, or nothing if unread.
 */
export function teamProblems(
  declared: ReadonlyMap<string, TeamPolicy>,
  existing: Record<string, ExistingTeam> | undefined,
): Map<string, string[]> {
  const problems = new Map<string, string[]>();
  const add = (slug: string, reason: string): void => {
    problems.set(slug, [...(problems.get(slug) ?? []), reason]);
  };

  const parents = new Set<string>();
  for (const team of declared.values()) {
    if (team.parent) parents.add(team.parent);
  }

  for (const [slug, team] of declared) {
    const removing = team.mode === 'absent';

    if (team.parent) {
      const known = declared.has(team.parent) || existing?.[team.parent] !== undefined;
      if (!known) {
        add(slug, `its parent "${team.parent}" is neither declared nor an existing team`);
      }
      if (declared.get(team.parent)?.mode === 'absent') {
        add(
          slug,
          `its parent "${team.parent}" is declared absent, so it would have nowhere to sit`,
        );
      }
      if (team.privacy === 'secret') {
        add(
          slug,
          'a team with a parent cannot be secret, so declare privacy closed or leave it out',
        );
      }
    }

    if (parents.has(slug) && team.privacy === 'secret') {
      add(slug, 'a team with children cannot be secret, so declare privacy closed or leave it out');
    }

    if (removing) {
      const orphans = [...declared]
        .filter(([child, entry]) => entry.parent === slug && entry.mode !== 'absent')
        .map(([child]) => child);
      if (orphans.length > 0) {
        add(
          slug,
          `deleting it would delete ${orphans.join(', ')} with it, which the configuration declares should exist`,
        );
      }
    }

    const cycle = parentCycle(declared, slug);
    if (cycle) add(slug, `its parents lead back to itself: ${cycle.join(' under ')}`);
  }

  return problems;
}

/** A team in one line, for the report. */
export function describeTeam(slug: string, team: TeamPolicy | ExistingTeam): string {
  const name = 'slug' in team ? team.name : teamName(slug, team);
  const parts = [name === slug ? slug : `${slug} (${name})`];
  if (team.privacy) parts.push(team.privacy);
  if (team.notifications === false) parts.push('notifications off');
  const parent = 'slug' in team ? (team.parent ?? '') : (team.parent ?? undefined);
  if (parent) parts.push(`under ${parent}`);
  else if (parent === '') parts.push('at the top');
  if (team.description) parts.push(team.description);
  return parts.join('; ');
}

/**
 * Everyone the policy names for a team, with the role each is named at.
 *
 * A login in both lists is not merged into one answer here. The two lists
 * disagreeing is a contradiction in the file, and {@link membershipProblems}
 * says so rather than picking whichever came last.
 */
export function declaredMembership(membership: TeamMembership): Map<string, TeamRole> {
  const declared = new Map<string, TeamRole>();
  for (const login of membership.members ?? []) declared.set(login, 'member');
  for (const login of membership.maintainers ?? []) declared.set(login, 'maintainer');
  return declared;
}

/**
 * What is wrong with a declared membership before anyone is added or removed.
 *
 * The two guards on authoritative removal are the point of this function. An
 * authoritative block that names nobody empties the team, which is what a
 * half-rendered template looks like and never what anyone means. And a run
 * that removes the account it is running as can be the last thing that account
 * is able to do to the team.
 *
 * @param membership - The declared membership.
 * @param actor - The login the run is authenticated as, when it is known.
 */
export function membershipProblems(membership: TeamMembership, actor?: string): string[] {
  const problems: string[] = [];
  const both = (membership.maintainers ?? []).filter((login) =>
    (membership.members ?? []).includes(login),
  );

  for (const login of both) {
    problems.push(
      `"${login}" is declared as both a maintainer and a member, so the role is a guess`,
    );
  }

  if (membership.authoritative) {
    const named = declaredMembership(membership);
    if (named.size === 0) {
      problems.push(
        'an authoritative membership that names nobody would empty the team, which is not something a blank section should say',
      );
    }
    if (actor !== undefined && named.size > 0 && !named.has(actor)) {
      problems.push(
        `it would remove "${actor}", the account this run is authenticated as, which could be the last change that account can make to this team`,
      );
    }
  }

  return problems;
}

/**
 * The chain of parents from a team back to itself, or nothing when there is
 * none.
 *
 * A cycle is not something GitHub would store; it is something a file can say,
 * and saying it would otherwise turn into a run that waits for a team to be
 * created before creating it.
 */
function parentCycle(
  declared: ReadonlyMap<string, TeamPolicy>,
  start: string,
): string[] | undefined {
  const seen: string[] = [start];
  let current = declared.get(start)?.parent;

  while (current) {
    if (current === start) return [...seen, start];
    if (seen.includes(current)) return undefined;
    seen.push(current);
    current = declared.get(current)?.parent;
  }
  return undefined;
}
