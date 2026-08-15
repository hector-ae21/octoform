import type { Octokit } from '@octokit/rest';
import { confirm } from '../cli-prompt.js';
import {
  EXIT_BLOCKED,
  EXIT_CHANGES_PENDING,
  EXIT_FAILED,
  EXIT_SUCCESS,
} from '../cli-exit-codes.js';
import {
  applyOrganizationChanges,
  applyPropertyValues,
  applyRepoChanges,
} from '../github/apply.js';
import { separateValues } from '../core/properties.js';
import { plan } from './plan.js';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../core/concurrency.js';
import { formatChange, groupByRepo, printable } from '../report/format.js';
import type {
  AppliedChange,
  ApplyOptions,
  ApplyRunResult,
  ApplySummary,
  OwnerScope,
} from '../types/index.js';

export type { ApplyOptions, ApplyRunResult } from '../types/index.js';

/**
 * Compute the same diff `plan` would, show it, ask before doing anything, and
 * only then call the GitHub API.
 *
 * Reuses `plan` for the diff itself rather than recomputing it, so `apply`
 * can never disagree with what `octoform plan` just told you it would do.
 */
export async function apply(
  octokit: Octokit,
  scope: OwnerScope,
  options: ApplyOptions = {},
): Promise<ApplyRunResult> {
  const { changes, blocked } = await plan(
    octokit,
    scope,
    { repo: options.repo, type: options.type },
    { quiet: true },
  );

  if (changes.length === 0) {
    console.log(
      blocked.length > 0
        ? `Nothing to apply. ${blocked.length} change(s) are blocked — run 'octoform plan' to see why.`
        : 'Nothing to apply. Every matching repository already matches the configuration.',
    );
    return {
      status: blocked.length > 0 ? EXIT_BLOCKED : EXIT_SUCCESS,
      summary: { applied: 0, failed: 0, blocked: blocked.length },
    };
  }

  console.log(`${changes.length} change(s) to apply:\n`);
  for (const [repoName, group] of groupByRepo(changes)) {
    console.log(`  ${printable(repoName)}`);
    for (const change of group) console.log(`    ${formatChange(change)}`);
    console.log('');
  }
  if (blocked.length > 0) {
    console.log(
      `(${blocked.length} more are blocked and will not be attempted — see 'octoform plan')\n`,
    );
  }

  if (!options.yes && !(await confirm(`Apply ${changes.length} change(s)?`))) {
    console.log('Aborted. Nothing was changed.');
    return {
      status: EXIT_CHANGES_PENDING,
      summary: { applied: 0, failed: 0, blocked: blocked.length },
    };
  }

  console.log('');
  /**
   * The organisation goes first. Its base permission is a floor under every
   * repository, so lowering it before the per-repository grants run is the
   * order in which the run never briefly grants more than the policy asks for.
   */
  const organizationResults = await applyOrganizationChanges(
    octokit,
    scope.owner,
    changes.filter((change) => change.repo === undefined),
  );
  for (const result of organizationResults) {
    const outcome =
      result.outcome === 'applied' ? 'done' : `FAILED — ${printable(result.error ?? '')}`;
    console.log(`  ${printable(scope.owner)}  ${result.key}: ${outcome}`);
  }

  /**
   * Then the property values, which can travel in shared requests and so are
   * not the repositories' to send one at a time. They go before the
   * repositories because a value decides which organisation rules govern a
   * repository: setting it first means the repository's own changes happen
   * under the rules the configuration asks for rather than the previous ones.
   */
  const { shared, sequential } = separateValues(
    changes.filter((change) => change.repo !== undefined),
  );
  const valueResults = await applyPropertyValues(octokit, scope.owner, shared);
  for (const result of valueResults) {
    const outcome =
      result.outcome === 'applied' ? 'done' : `FAILED — ${printable(result.error ?? '')}`;
    console.log(`  ${printable(result.repo ?? '')}  ${result.key}: ${outcome}`);
  }

  const grouped = groupByRepo(sequential);
  const perRepo = await mapWithConcurrency(
    grouped,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async ([repoName, group]) => {
      try {
        return await applyRepoChanges(octokit, scope.owner, repoName, group);
      } catch (error) {
        return group.map((change): AppliedChange => ({
          ...change,
          outcome: 'failed',
          error: (error as Error).message ?? String(error),
        }));
      }
    },
  );

  const beforeRepositories = [...organizationResults, ...valueResults];
  let failures = beforeRepositories.filter((r) => r.outcome === 'failed').length;
  let unattempted = 0;
  for (const [index, results] of perRepo.entries()) {
    const repoName = grouped[index]?.[0] ?? '';
    for (const result of results) {
      if (result.outcome === 'failed') failures++;
      if (result.outcome === 'blocked') unattempted++;
      const outcome =
        result.outcome === 'applied'
          ? 'done'
          : result.outcome === 'blocked'
            ? `BLOCKED — ${printable(result.error ?? '')}`
            : `FAILED — ${printable(result.error ?? '')}`;
      console.log(`  ${printable(repoName)}  ${result.key}: ${outcome}`);
    }
  }

  console.log('');
  const note = [
    failures > 0 ? `${failures} change(s) failed` : undefined,
    unattempted > 0
      ? `${unattempted} were not attempted because something they depend on failed`
      : undefined,
  ].filter(Boolean);
  console.log(note.length === 0 ? 'All changes applied.' : `${note.join(', and ')} — see above.`);
  const allResults = [...beforeRepositories, ...perRepo.flat()];
  const status =
    failures > 0 ? EXIT_FAILED : blocked.length + unattempted > 0 ? EXIT_BLOCKED : EXIT_SUCCESS;
  return { status, summary: summarizeApply(allResults, blocked.length) };
}

/**
 * Reduce an apply run's results to the counts that matter.
 *
 * `blockedCount` carries what planning already refused to hand over. Anything
 * this run stopped attempting, because a prerequisite failed part way through,
 * is added to it: both were left alone for the same reason, and counting them
 * apart would suggest one of them might have been half-applied.
 */
export function summarizeApply(results: AppliedChange[], blockedCount: number): ApplySummary {
  const applied = results.filter((r) => r.outcome === 'applied').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const unattempted = results.filter((r) => r.outcome === 'blocked').length;
  return { applied, failed, blocked: blockedCount + unattempted };
}
