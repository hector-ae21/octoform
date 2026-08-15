import type { Octokit } from '@octokit/rest';
import {
  detectLimits,
  detectRulesetCapability,
  discoverOwner,
  readOrganizationPeople,
} from '../github/client.js';
import { capability } from '../github/capabilities.js';
import { describeNotApplicable, notApplicable } from '../config/applicability.js';
import { notInTheOrganization, peopleNamedBy, readInvitation } from '../core/members.js';
import { printable } from '../report/format.js';
import type {
  InspectedCapabilities,
  InspectedMembers,
  InspectedOwner,
  InspectedRepository,
  OwnerScope,
} from '../types/index.js';

/**
 * The fully resolved policy for one owner, with nothing left to imports,
 * types, or policy references to explain: this is what `plan` would actually
 * compare a repository against.
 *
 * Read-only and offline — it never contacts GitHub, the same as
 * `config validate`. What it cannot yet show is which layer contributed each
 * value; today it shows only the final, resolved shape.
 */
export function inspectConfig(scopes: OwnerScope[]): InspectedOwner[] {
  return scopes.map((scope) => ({ owner: scope.owner, resolved: scope }));
}

/**
 * What octoform determined this owner supports, and the evidence behind it —
 * the same discovery and applicability checks every command already runs,
 * surfaced directly instead of inferred from a plan's side effects.
 */
export async function inspectCapabilities(
  octokit: Octokit,
  scope: OwnerScope,
  repo?: string,
): Promise<InspectedCapabilities> {
  const discovery = await discoverOwner(octokit, scope.owner);
  const limits = await detectLimits(octokit, scope.owner, discovery.kind);
  const findings = notApplicable(scope, discovery.kind).map((finding) => ({
    path: finding.path,
    reason: describeNotApplicable(finding, discovery.kind),
  }));

  return {
    discovery,
    plan: limits.plan,
    organizationRulesets: limits.orgRulesets,
    notApplicable: findings,
    ...(repo === undefined
      ? {}
      : { repository: await inspectRepository(octokit, scope.owner, repo) }),
  };
}

/**
 * What one repository supports, which is not always what its owner supports.
 *
 * Rulesets are the reason this is asked per repository rather than per owner:
 * on a private repository they depend on the account's plan and on the token,
 * and octoform refuses to assume either. On a public repository they are
 * always available, so nothing is probed and the answer says so — a probe
 * whose result is known in advance is a request spent proving nothing.
 */
async function inspectRepository(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<InspectedRepository> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
  const { visibility, default_branch: defaultBranch } = data as {
    visibility?: string;
    default_branch?: string;
  };

  const rulesets =
    visibility === 'private'
      ? await detectRulesetCapability(octokit, owner, repo, defaultBranch ?? '')
      : capability(
          'supported',
          'rulesets are always available on a repository that is not private',
          'resource-state',
        );

  return { name: repo, visibility: visibility ?? 'unknown', rulesets };
}

/** Print one owner's resolved configuration as text. */
export function reportInspectedConfig(entries: InspectedOwner[]): void {
  for (const entry of entries) {
    console.log(`=== ${entry.owner} ===`);
    console.log(JSON.stringify(entry.resolved, null, 2));
    console.log('');
  }
}

/**
 * Who is in the organisation, and which of the people the configuration names
 * are not.
 *
 * Read-only and organisation-only. A personal account has no members, no
 * outside collaborators and no invitations, so there is nothing here to report
 * rather than an empty version of it.
 *
 * @param scope - The resolved configuration, read for the people it names.
 * @param now - The moment invitation ages are measured against.
 */
export async function inspectMembers(
  octokit: Octokit,
  scope: OwnerScope,
  now: Date = new Date(),
): Promise<InspectedMembers> {
  const people = await readOrganizationPeople(octokit, scope.owner);
  const pendingInvitations = people.pending.map((raw) => readInvitation(raw, now));

  /**
   * Everyone the organisation knows in any capacity. Being an outside
   * collaborator counts, and so does having been invited: neither is a person
   * the configuration is about to introduce.
   */
  const known = new Set([
    ...people.admins,
    ...people.members,
    ...people.outsideCollaborators,
    ...pendingInvitations.map((invitation) => invitation.login).filter((login) => login !== null),
  ]);

  return {
    owner: scope.owner,
    admins: [...people.admins].sort(),
    members: [...people.members].sort(),
    outsideCollaborators: [...people.outsideCollaborators].sort(),
    ...(people.withoutTwoFactor === undefined
      ? {}
      : { withoutTwoFactor: [...people.withoutTwoFactor].sort() }),
    pendingInvitations,
    failedInvitations: people.failed.map((raw) => readInvitation(raw, now)),
    notInTheOrganization: notInTheOrganization(peopleNamedBy(scope), known),
  };
}

/** Print one organisation's membership report as text. */
export function reportInspectedMembers(report: InspectedMembers): void {
  console.log(`Organisation: ${printable(report.owner)}`);
  console.log(`  owners: ${list(report.admins)}`);
  console.log(`  members: ${list(report.members)}`);
  console.log(`  outside collaborators: ${list(report.outsideCollaborators)}`);
  console.log(
    report.withoutTwoFactor === undefined
      ? '  without two-factor authentication: not visible to this token'
      : `  without two-factor authentication: ${list(report.withoutTwoFactor)}`,
  );

  if (report.pendingInvitations.length > 0) {
    console.log('  invited and waiting:');
    for (const invitation of report.pendingInvitations) {
      console.log(
        `    ${printable(invitation.login ?? invitation.email ?? 'unnamed')} as ${printable(invitation.role)}, ${invitation.waitingDays} day(s)`,
      );
    }
  }

  if (report.failedInvitations.length > 0) {
    console.log('  invitations that failed:');
    for (const invitation of report.failedInvitations) {
      console.log(
        `    ${printable(invitation.login ?? invitation.email ?? 'unnamed')}: ${printable(invitation.failedReason ?? 'no reason recorded')}`,
      );
    }
  }

  if (report.notInTheOrganization.length === 0) {
    console.log('  everybody the configuration names is already known here');
  } else {
    console.log('  named by the configuration but not in the organisation:');
    for (const person of report.notInTheOrganization) {
      console.log(`    ${printable(person.login)}: ${person.named.map(printable).join(', ')}`);
    }
  }
  console.log('');
}

function list(logins: readonly string[]): string {
  return logins.length === 0 ? 'none' : logins.map(printable).join(', ');
}

/** Print one owner's capability report as text. */
export function reportInspectedCapabilities(owner: string, report: InspectedCapabilities): void {
  const label = report.discovery.kind === 'org' ? 'Organisation' : 'Personal account';
  console.log(
    `${label}: ${owner} (id ${report.discovery.id})${report.plan ? ` — ${report.plan} plan` : ''}`,
  );
  console.log(
    `  organisation-wide rulesets: ${report.organizationRulesets ? 'available' : 'not available'}`,
  );
  if (report.notApplicable.length === 0) {
    console.log('  no declarations that do not apply to this owner');
  } else {
    console.log('  declarations that do not apply to this owner:');
    for (const finding of report.notApplicable)
      console.log(`    ${finding.path}: ${finding.reason}`);
  }
  if (report.repository) {
    const { name, visibility, rulesets } = report.repository;
    console.log(`  ${name} (${visibility}):`);
    console.log(`    rulesets: ${rulesets.status} — ${rulesets.reason} (${rulesets.source})`);
  }
  console.log('');
}
