import { createInterface } from 'node:readline/promises';
import type { Octokit } from '@octokit/rest';
import { applyRepoChanges } from '../github/apply.js';
import { plan } from './plan.js';
import { formatChange, groupByRepo } from '../report/format.js';
import type { OwnerScope } from '../config/types.js';

/** Repository selection and confirmation controls for {@link apply}. */
export interface ApplyOptions {
  repo?: string;
  type?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
}

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
): Promise<number> {
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
    return 0;
  }

  console.log(`${changes.length} change(s) to apply:\n`);
  for (const [repoName, group] of groupByRepo(changes)) {
    console.log(`  ${repoName}`);
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
    return 1;
  }

  console.log('');
  let failures = 0;
  for (const [repoName, group] of groupByRepo(changes)) {
    const results = await applyRepoChanges(octokit, scope.owner, repoName, group);
    for (const result of results) {
      if (result.outcome === 'failed') failures++;
      const outcome = result.outcome === 'applied' ? 'done' : `FAILED — ${result.error}`;
      console.log(`  ${repoName}  ${result.key}: ${outcome}`);
    }
  }

  console.log('');
  console.log(
    failures === 0 ? 'All changes applied.' : `${failures} change(s) failed — see above.`,
  );
  return failures === 0 ? 0 : 1;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}
