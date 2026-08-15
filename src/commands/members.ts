/**
 * Deliberate, one-person-at-a-time changes to who is in an organisation.
 *
 * These are commands rather than declarations, and that is the whole design.
 * Everything else octoform manages is a state a file can describe and a run
 * can converge on. Organisation membership is not: an invitation is an act
 * addressed to a person, who is then emailed about it, and a file that listed
 * members authoritatively would remove somebody the first time a name was
 * mistyped. Neither belongs in something that runs on a schedule.
 *
 * So each of these takes one login, says what it is about to do, asks, and
 * does it once. GitHub's own note that inviting people too quickly runs into
 * secondary rate limiting is the API agreeing.
 */

import type { Octokit } from '@octokit/rest';
import { confirm } from '../cli-prompt.js';
import {
  EXIT_BLOCKED,
  EXIT_CHANGES_PENDING,
  EXIT_FAILED,
  EXIT_SUCCESS,
} from '../cli-exit-codes.js';
import { readOrganizationPeople } from '../github/client.js';
import { readInvitation, removalProblems } from '../core/members.js';
import { printable } from '../report/format.js';
import type { MembershipOptions, OwnerScope } from '../types/index.js';

export type { MembershipOptions } from '../types/index.js';

/** The roles GitHub's invitation endpoint accepts, in its own spelling. */
export const INVITATION_ROLES = ['admin', 'direct_member', 'billing_manager'] as const;

/**
 * Invite somebody to the organisation.
 *
 * The endpoint takes a numeric user id or an email address — not a login — so
 * a login is looked up first and the invitation is refused when nothing
 * answers to it. Inviting a stranger by a name nobody checked is exactly the
 * mistake this costs one request to avoid.
 */
export async function inviteMember(
  octokit: Octokit,
  scope: OwnerScope,
  login: string,
  options: MembershipOptions = {},
): Promise<number> {
  const role = options.role ?? 'direct_member';
  if (!INVITATION_ROLES.includes(role as (typeof INVITATION_ROLES)[number])) {
    console.error(
      `"${printable(role)}" is not an invitation role. Use one of: ${INVITATION_ROLES.join(', ')}.`,
    );
    return EXIT_BLOCKED;
  }

  const people = await readOrganizationPeople(octokit, scope.owner);
  if ([...people.admins, ...people.members].includes(login)) {
    console.log(`${printable(login)} is already a member of ${printable(scope.owner)}.`);
    return EXIT_SUCCESS;
  }

  const waiting = people.pending
    .map((raw) => readInvitation(raw))
    .find((invitation) => invitation.login === login);
  if (waiting) {
    console.log(
      `${printable(login)} was already invited as ${printable(waiting.role)} and has been waiting ${waiting.waitingDays} day(s). Nothing was sent.`,
    );
    return EXIT_SUCCESS;
  }

  let inviteeId: number;
  try {
    const { data } = await octokit.request('GET /users/{username}', { username: login });
    inviteeId = (data as { id: number }).id;
  } catch {
    console.error(
      `No GitHub account called "${printable(login)}". The invitation endpoint takes a user id rather than a login, so there is nothing to invite.`,
    );
    return EXIT_BLOCKED;
  }

  console.log(
    `Invite ${printable(login)} to ${printable(scope.owner)} as ${printable(role)}. They will be emailed about it.`,
  );
  if (!options.yes && !(await confirm('Send the invitation?'))) {
    console.log('Aborted. Nothing was sent.');
    return EXIT_CHANGES_PENDING;
  }

  try {
    const route: string = 'POST /orgs/{org}/invitations';
    await octokit.request(route, { org: scope.owner, invitee_id: inviteeId, role });
    console.log('Invitation sent.');
    return EXIT_SUCCESS;
  } catch (error) {
    console.error(`FAILED — ${printable((error as Error).message)}`);
    return EXIT_FAILED;
  }
}

/**
 * Take somebody out of the organisation, or withdraw the invitation they never
 * answered.
 *
 * One endpoint does both, which is why this command does not need to know
 * which case it is in: GitHub removes an active member and cancels a pending
 * invitation through the same request, and emails the person either way.
 */
export async function removeMember(
  octokit: Octokit,
  scope: OwnerScope,
  login: string,
  options: MembershipOptions = {},
): Promise<number> {
  const people = await readOrganizationPeople(octokit, scope.owner);
  const problems = removalProblems(login, people.admins, options.actor);
  if (problems.length > 0) {
    console.error(`Refused: ${problems.join('; ')}.`);
    return EXIT_BLOCKED;
  }

  const invited = people.pending.some((invitation) => invitation.login === login);
  const member = [...people.admins, ...people.members].includes(login);
  if (!member && !invited) {
    console.log(
      `${printable(login)} is not a member of ${printable(scope.owner)} and has no invitation waiting.`,
    );
    return EXIT_SUCCESS;
  }

  console.log(
    invited && !member
      ? `Withdraw the invitation to ${printable(login)}.`
      : `Remove ${printable(login)} from ${printable(scope.owner)}${people.admins.includes(login) ? ', who is an owner of it' : ''}. They lose every team and every repository the organisation gave them.`,
  );
  if (!options.yes && !(await confirm('Do it?'))) {
    console.log('Aborted. Nothing was changed.');
    return EXIT_CHANGES_PENDING;
  }

  try {
    await octokit.request('DELETE /orgs/{org}/memberships/{username}', {
      org: scope.owner,
      username: login,
    });
    console.log(invited && !member ? 'Invitation withdrawn.' : 'Removed.');
    /**
     * Worth saying because the request looks like it did more than it did:
     * membership granted through an enterprise team is not the organisation's
     * to take away, and survives this.
     */
    console.log(
      'Any membership they hold through an enterprise team is unaffected, and has to be removed there.',
    );
    return EXIT_SUCCESS;
  } catch (error) {
    console.error(`FAILED — ${printable((error as Error).message)}`);
    return EXIT_FAILED;
  }
}

/**
 * Turn a member into an outside collaborator.
 *
 * They stop being a member and keep only the repositories their current teams
 * gave them, which is a narrowing rather than a removal — but it is a removal
 * from the organisation, so it is guarded exactly like one.
 */
export async function convertMember(
  octokit: Octokit,
  scope: OwnerScope,
  login: string,
  options: MembershipOptions = {},
): Promise<number> {
  const people = await readOrganizationPeople(octokit, scope.owner);
  const problems = removalProblems(login, people.admins, options.actor);
  if (problems.length > 0) {
    console.error(`Refused: ${problems.join('; ')}.`);
    return EXIT_BLOCKED;
  }

  if (people.outsideCollaborators.includes(login)) {
    console.log(`${printable(login)} is already an outside collaborator.`);
    return EXIT_SUCCESS;
  }
  if (![...people.admins, ...people.members].includes(login)) {
    console.error(
      `${printable(login)} is not a member of ${printable(scope.owner)}, so there is no membership to convert.`,
    );
    return EXIT_BLOCKED;
  }

  console.log(
    `Convert ${printable(login)} to an outside collaborator. They stop being a member and keep only the repositories their current teams allow.`,
  );
  if (!options.yes && !(await confirm('Do it?'))) {
    console.log('Aborted. Nothing was changed.');
    return EXIT_CHANGES_PENDING;
  }

  try {
    await octokit.request('PUT /orgs/{org}/outside_collaborators/{username}', {
      org: scope.owner,
      username: login,
    });
    console.log('Converted.');
    return EXIT_SUCCESS;
  } catch (error) {
    console.error(`FAILED — ${printable((error as Error).message)}`);
    return EXIT_FAILED;
  }
}
