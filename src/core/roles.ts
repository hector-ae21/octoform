/**
 * Organisation roles: who holds them, and why octoform does not define them.
 *
 * This is assignment and nothing else, and that is a limit of the API rather
 * than a decision. The pinned description lists organisation roles and lets
 * them be granted to and revoked from users and teams; it has no endpoint that
 * creates one, and none at all for custom repository roles. A configuration
 * that named a role octoform could not find would therefore be naming a role,
 * not asking for one to be defined, and it is told so.
 *
 * There is one thing here that the ruleset bypass actors do not have. The role
 * listing maps a name to the id the assignment endpoints take, so a file can
 * say "Security manager" and octoform can still send a number. A ruleset's
 * repository roles have no such listing, which is why those are declared as
 * ids and these are not.
 */

import type { ExistingRole, RoleHolders } from '../types/index.js';

/** A role as GitHub returns it, reduced to what octoform compares. */
export function readRole(raw: {
  id?: number;
  name?: string;
  source?: string | null;
}): ExistingRole | undefined {
  if (!raw.name || raw.id === undefined) return undefined;
  const source =
    raw.source === 'Enterprise' || raw.source === 'Predefined' ? raw.source : 'Organization';
  return { id: raw.id, name: raw.name, source };
}

/**
 * What is wrong with a declared set of holders before anything is granted or
 * revoked.
 *
 * The two guards are the ones team membership already needed, for the same
 * reasons. An authoritative block naming nobody revokes the role from
 * everybody, which is what a half-rendered template looks like. And a run that
 * revokes the role from the account it is running as may be giving up the
 * permission it needed to put it back.
 *
 * @param holders - The declared holders.
 * @param actor - The login this run is authenticated as, when it is known.
 */
export function holderProblems(holders: RoleHolders, actor?: string): string[] {
  const problems: string[] = [];
  const users = holders.users ?? [];
  const teams = holders.teams ?? [];

  if (holders.authoritative) {
    if (users.length === 0 && teams.length === 0) {
      problems.push(
        'an authoritative role that names nobody would revoke it from everyone, which is not something a blank section should say',
      );
    }
    if (actor !== undefined && users.length > 0 && !users.includes(actor)) {
      problems.push(
        `it would revoke the role from "${actor}", the account this run is authenticated as, which may be the permission it needs to grant it back`,
      );
    }
  }

  return problems;
}

/** Who holds a role, in one line, for the report. */
export function describeHolders(holders: RoleHolders | ExistingRole): string {
  const users = holders.users ?? [];
  const teams = holders.teams ?? [];
  const parts: string[] = [];
  if (users.length > 0) parts.push(users.join(', '));
  if (teams.length > 0) parts.push(`teams ${teams.join(', ')}`);
  return parts.length === 0 ? 'nobody' : parts.join('; ');
}
