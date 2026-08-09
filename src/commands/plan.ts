import type { Octokit } from '@octokit/rest';
import { isExcluded, resolvePolicy } from '../config/resolve.js';
import { detectLimits, detectOwnerKind, getRepoDetail, listRepos, readPropertyValues } from '../github/client.js';
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
 *
 * `quiet` suppresses the console report without changing what is computed or
 * returned: `apply` calls this to get the same diff without plan's own
 * "nothing was changed" framing, which would be actively wrong to print
 * moments before it changes something.
 */
export async function plan(
  octokit: Octokit,
  config: Config,
  only?: { repo?: string; type?: string },
  opts?: { quiet?: boolean },
): Promise<PlanResult> {
  const kind = await detectOwnerKind(octokit, config.owner);
  const limits = await detectLimits(octokit, config.owner, kind);
  const all = await listRepos(octokit, config.owner, kind);

  // Custom properties are an organisation feature; a personal account has no
  // such API to call.
  const property = config.classify?.property;
  const types =
    property && kind === 'org'
      ? await readPropertyValues(octokit, config.owner, property)
      : new Map<string, string>();
  for (const repo of all) repo.type = types.get(repo.name);

  let targets = all.filter((r) => !isExcluded(config, r.name));
  if (only?.repo) targets = targets.filter((r) => r.name === only.repo);
  if (only?.type) targets = targets.filter((r) => (config.repos?.[r.name]?.type ?? r.type) === only.type);

  if (targets.length === 0) {
    if (!opts?.quiet) console.log('No repositories match.');
    return { changes: [], blocked: [] };
  }

  // Rulesets are only enforced on private repositories on paid plans, and
  // organisation-wide rulesets are a paid feature outright — and simply do
  // not exist for a personal account. `orgRulesets` doubles as the answer to
  // both, since a plan without one does not have the other either.
  const options = { rulesetsEnforcedOnPrivate: limits.orgRulesets };

  const changes: Change[] = [];
  const blocked: Change[] = [];

  for (const repo of targets) {
    // Resolved first, and handed to the reader: most of what a plan could ask
    // GitHub about costs a request per declared item, so the policy decides
    // what is worth looking up at all.
    const policy = resolvePolicy(config, repo);
    const detail = await getRepoDetail(octokit, config.owner, repo, policy);
    for (const change of planRepo(detail, policy, options)) {
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
