import type { Octokit } from '@octokit/rest';
import { isExcluded, resolvePolicy } from '../config/resolve.js';
import { detectLimits, getRepoDetail, listRepos, readPropertyValues } from '../github/client.js';
import { planRepo } from '../core/plan.js';
import { formatChange, groupByRepo } from '../report/format.js';
import type { Change, Config } from '../config/types.js';

export interface PlanResult {
  changes: Change[];
  blocked: Change[];
}

/**
 * Read-only. Says what `apply` would do, and just as importantly what it would
 * refuse to do and why.
 */
export async function plan(
  octokit: Octokit,
  config: Config,
  only?: { repo?: string; type?: string },
): Promise<PlanResult> {
  const limits = await detectLimits(octokit, config.org);
  const all = await listRepos(octokit, config.org);

  const property = config.classify?.property;
  const types = property
    ? await readPropertyValues(octokit, config.org, property)
    : new Map<string, string>();
  for (const repo of all) repo.type = types.get(repo.name);

  let targets = all.filter((r) => !isExcluded(config, r.name));
  if (only?.repo) targets = targets.filter((r) => r.name === only.repo);
  if (only?.type) targets = targets.filter((r) => (config.repos?.[r.name]?.type ?? r.type) === only.type);

  if (targets.length === 0) {
    console.log('No repositories match.');
    return { changes: [], blocked: [] };
  }

  // Rulesets are only enforced on private repositories on paid plans, and
  // organisation-wide rulesets are a paid feature outright. The second is the
  // cheaper thing to probe, so it stands in for the plan being a paid one.
  const options = { rulesetsEnforcedOnPrivate: limits.orgRulesets };

  const changes: Change[] = [];
  const blocked: Change[] = [];

  for (const repo of targets) {
    const detail = await getRepoDetail(octokit, config.org, repo);
    const policy = resolvePolicy(config, repo);
    for (const change of planRepo(detail, policy, options)) {
      (change.blocked ? blocked : changes).push(change);
    }
  }

  report(changes, blocked, targets.length);
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
