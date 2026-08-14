import type { Octokit } from '@octokit/rest';
import { isExcluded, resolvePolicy } from '../config/resolve.js';
import {
  detectOwnerKind,
  detectRulesetCapability,
  getRepoDetail,
  listRepos,
  readPropertyValues,
} from '../github/client.js';
import { capability } from '../github/capabilities.js';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../core/concurrency.js';
import { planRepo } from '../core/plan.js';
import { formatChange, groupByRepo, printable } from '../report/format.js';
import type { Change, OwnerScope, PlanResult, PlanSelector, PlanSummary } from '../types/index.js';

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
      return { repo: repo.name, changes: planRepo(scope.owner, detail, policy, { rulesetCapability }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { repo: repo.name, error: message };
    }
  });

  const changes: Change[] = [];
  const blocked: Change[] = [];
  const errors: PlanResult['errors'] = [];
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
 * Reduce a plan to the counts that matter, per repository rather than per
 * operation: a repository that both applied one setting and was blocked on
 * another is not "unchanged," and one this run could not even read is not
 * "matching" either — it counts as `failed`, distinct from both.
 */
export function summarizePlan(result: PlanResult): PlanSummary {
  const changedRepos = new Set(result.changes.map((c) => c.repo));
  const blockedRepos = new Set(result.blocked.map((c) => c.repo));
  const failedRepos = new Set(result.errors.map((e) => e.repo));
  const changed = changedRepos.size;
  const blockedOnly = [...blockedRepos].filter((repo) => !changedRepos.has(repo)).length;
  const failed = failedRepos.size;
  const unchanged = Math.max(0, result.scanned - changed - blockedOnly - failed);
  return { scanned: result.scanned, changed, blocked: blockedOnly, failed, unchanged };
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

function countRepos(changes: Change[]): number {
  return new Set(changes.map((c) => c.repo)).size;
}
