import type { Octokit } from '@octokit/rest';
import { isExcluded, resolvePolicy } from '../config/resolve.js';
import {
  authenticatedLogin,
  detectOwnerKind,
  detectRulesetCapability,
  getOrganizationDetail,
  getRepoDetail,
  listRepos,
  readOrganizationRulesets,
  readPropertyDefinitions,
  readPropertyValues,
  readTeams,
  resolveOwnerNames,
} from '../github/client.js';
import { capability } from '../github/capabilities.js';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../core/concurrency.js';
import { planRepo } from '../core/plan.js';
import { planOrganization } from '../core/organization.js';
import { namesToResolve } from '../core/identity.js';
import { formatChange, groupByRepo, printable } from '../report/format.js';
import type {
  Change,
  OrganizationPolicy,
  OrganizationState,
  OwnerScope,
  PlanResult,
  PlanSelector,
  PlanSummary,
} from '../types/index.js';

export type { PlanResult } from '../types/index.js';

/**
 * Read-only. Says what `apply` would do, and just as importantly what it would
 * refuse to do and why.
 *
 * `quiet` suppresses the console report without changing what is computed or
 * returned: `apply` calls this to get the same diff without plan's own
 * "nothing was changed" framing, which would be actively wrong to print
 * moments before it changes something.
 */
export async function plan(
  octokit: Octokit,
  scope: OwnerScope,
  only?: PlanSelector,
  opts?: { quiet?: boolean },
): Promise<PlanResult> {
  const kind = await detectOwnerKind(octokit, scope.owner);
  /**
   * Read once for the whole run: every repository asks the same question of
   * it, and the answer cannot change while the run is in progress.
   */
  const actor = await authenticatedLogin(octokit);
  const all = await listRepos(octokit, scope.owner, kind);

  const property = scope.classify?.property;
  const types =
    property && kind === 'org'
      ? await readPropertyValues(octokit, scope.owner, property)
      : new Map<string, string>();
  for (const repo of all) repo.type = types.get(repo.name);

  let targets = all.filter((r) => !isExcluded(scope, r.name));
  if (only?.repo) targets = targets.filter((r) => r.name === only.repo);
  if (only?.type)
    targets = targets.filter((r) => (scope.repos?.[r.name]?.type ?? r.type) === only.type);
  /**
   * Sorted so that two runs against unchanged remote state produce operations
   * in the same order regardless of the order GitHub's API happened to answer
   * in — ordering is part of the contract, not an accident of pagination.
   */
  targets = [...targets].sort((a, b) => a.name.localeCompare(b.name));

  if (targets.length === 0) {
    if (!opts?.quiet) console.log('No repositories match.');
    return { changes: [], blocked: [], errors: [], scanned: 0 };
  }

  /**
   * The organisation itself is planned before its repositories, and only when
   * a policy asks about it: reading it otherwise would spend a request to
   * compare nothing.
   */
  const organizationChanges = scope.organization
    ? planOrganization(
        scope.owner,
        kind,
        kind === 'org'
          ? await readOrganization(octokit, scope.owner, scope.organization)
          : undefined,
        scope.organization,
      )
    : [];

  const perRepo = await mapWithConcurrency<
    (typeof targets)[number],
    { repo: string; changes: Change[] } | { repo: string; error: string }
  >(targets, only?.concurrency ?? DEFAULT_CONCURRENCY, async (repo) => {
    try {
      const policy = resolvePolicy(scope, repo);
      const rulesetCapability =
        repo.visibility !== 'private' || !policy.rulesets?.length
          ? capability(
              'supported',
              'rulesets are always available on public repositories',
              'resource-state',
            )
          : await detectRulesetCapability(octokit, scope.owner, repo.name, repo.default_branch);
      const detail = await getRepoDetail(octokit, scope.owner, repo, policy);
      return {
        repo: repo.name,
        changes: planRepo(scope.owner, detail, policy, {
          rulesetCapability,
          ownerKind: kind,
          ...(actor === undefined ? {} : { actor }),
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { repo: repo.name, error: message };
    }
  });

  const changes: Change[] = [];
  const blocked: Change[] = [];
  const errors: PlanResult['errors'] = [];
  for (const change of organizationChanges) (change.blocked ? blocked : changes).push(change);
  for (const result of perRepo) {
    if ('error' in result) {
      errors.push({ repo: result.repo, message: result.error });
      continue;
    }
    for (const change of result.changes) (change.blocked ? blocked : changes).push(change);
  }

  if (!opts?.quiet) report(changes, blocked, errors, targets.length);
  return { changes, blocked, errors, scanned: targets.length };
}

/**
 * Gather the organisation, asking only about what the policy declares.
 *
 * The property definitions cost a request of their own, so a file that
 * declares no property never pays for it. A file that does gets them read
 * before anything is planned, because writing a definition replaces it and
 * there is nothing to carry forward from a listing that was never fetched.
 */
async function readOrganization(
  octokit: Octokit,
  owner: string,
  policy: OrganizationPolicy,
): Promise<OrganizationState> {
  const settings = await getOrganizationDetail(octokit, owner);
  const properties = policy.properties ? await readPropertyDefinitions(octokit, owner) : undefined;
  const rulesets = policy.rulesets?.length
    ? await readOrganizationRulesets(octokit, owner)
    : undefined;
  const teams = policy.teams ? await readTeams(octokit, owner) : undefined;
  /**
   * The names a ruleset has to send as numbers are looked up once for the
   * whole organisation, so a team named by three rulesets costs one request
   * and a name nobody can find becomes a blocked line rather than an
   * exception raised part way through applying.
   */
  const resolved = policy.rulesets?.length
    ? await resolveOwnerNames(octokit, owner, namesToResolve({ rulesets: policy.rulesets }, ''))
    : undefined;

  return {
    ...(settings === undefined ? {} : { settings }),
    ...(properties === undefined ? {} : { properties }),
    ...(rulesets === undefined ? {} : { rulesets }),
    ...(teams === undefined ? {} : { teams }),
    ...(resolved === undefined ? {} : { resolved }),
  };
}

/**
 * Reduce a plan to the counts that matter, per repository rather than per
 * operation: a repository that both applied one setting and was blocked on
 * another is not "unchanged," and one this run could not even read is not
 * "matching" either — it counts as `failed`, distinct from both.
 */
export function summarizePlan(result: PlanResult): PlanSummary {
  const changedRepos = repositoriesIn(result.changes);
  const blockedRepos = repositoriesIn(result.blocked);
  const failedRepos = new Set(result.errors.map((e) => e.repo));
  const changed = changedRepos.size;
  const blockedOnly = [...blockedRepos].filter((repo) => !changedRepos.has(repo)).length;
  const failed = failedRepos.size;
  const unchanged = Math.max(0, result.scanned - changed - blockedOnly - failed);
  return {
    scanned: result.scanned,
    changed,
    blocked: blockedOnly,
    blockedRepositories: blockedRepos.size,
    failed,
    unchanged,
  };
}

function report(
  changes: Change[],
  blocked: Change[],
  errors: PlanResult['errors'],
  scanned: number,
): void {
  if (changes.length === 0 && blocked.length === 0 && errors.length === 0) {
    console.log(`${scanned} repositories match the configuration. Nothing to do.`);
    return;
  }

  if (changes.length > 0) {
    console.log(`${changes.length} change(s) across ${countRepos(changes)} repositories:\n`);
    for (const [repo, group] of groupByRepo(changes)) {
      console.log(`  ${printable(repo)}`);
      for (const change of group) console.log(`    ${formatChange(change)}`);
      console.log('');
    }
  }

  if (blocked.length > 0) {
    console.log(`${blocked.length} not applied:\n`);
    for (const [repo, group] of groupByRepo(blocked)) {
      console.log(`  ${printable(repo)}`);
      for (const change of group) console.log(`    ${formatChange(change)}`);
      console.log('');
    }
  }

  if (errors.length > 0) {
    console.log(`${errors.length} repositories could not be examined:\n`);
    for (const error of [...errors].sort((a, b) => a.repo.localeCompare(b.repo))) {
      console.log(`  ${printable(error.repo)}: ${printable(error.message)}`);
    }
    console.log('');
  }

  console.log('Nothing was changed. This command only reports.');
}

/**
 * The repositories a set of changes touches. A change belonging to the owner
 * itself touches none, so it is left out rather than counted as a repository
 * with no name.
 */
function repositoriesIn(changes: Change[]): Set<string> {
  return new Set(
    changes.map((change) => change.repo).filter((name): name is string => name !== undefined),
  );
}

function countRepos(changes: Change[]): number {
  return repositoriesIn(changes).size;
}
