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
import { planRepo } from '../core/plan.js';
import { formatChange, groupByRepo } from '../report/format.js';
import type { Change, OwnerScope, PlanResult } from '../types/index.js';

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
  only?: { repo?: string; type?: string },
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

  if (targets.length === 0) {
    if (!opts?.quiet) console.log('No repositories match.');
    return { changes: [], blocked: [] };
  }

  const changes: Change[] = [];
  const blocked: Change[] = [];

  for (const repo of targets) {
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
    for (const change of planRepo(detail, policy, { rulesetCapability })) {
      (change.blocked ? blocked : changes).push(change);
    }
  }

  if (!opts?.quiet) report(changes, blocked, targets.length);
  return { changes, blocked };
}

function report(changes: Change[], blocked: Change[], scanned: number): void {
  if (changes.length === 0 && blocked.length === 0) {
    console.log(`${scanned} repositories match the configuration. Nothing to do.`);
    return;
  }

  if (changes.length > 0) {
    console.log(`${changes.length} change(s) across ${countRepos(changes)} repositories:\n`);
    for (const [repo, group] of groupByRepo(changes)) {
      console.log(`  ${repo}`);
      for (const change of group) console.log(`    ${formatChange(change)}`);
      console.log('');
    }
  }

  if (blocked.length > 0) {
    console.log(`${blocked.length} not applied:\n`);
    for (const [repo, group] of groupByRepo(blocked)) {
      console.log(`  ${repo}`);
      for (const change of group) console.log(`    ${formatChange(change)}`);
      console.log('');
    }
  }

  console.log('Nothing was changed. This command only reports.');
}

function countRepos(changes: Change[]): number {
  return new Set(changes.map((c) => c.repo)).size;
}
