import type { Octokit } from '@octokit/rest';
import { isExcluded, repoType } from '../config/resolve.js';
import { classifyRepo, pathsUsedBy } from '../core/classify.js';
import {
  detectOwnerKind,
  listRepos,
  readPropertyValues,
  readRepoFile,
  setPropertyValues,
} from '../github/client.js';
import type { Config } from '../config/types.js';

/** Mutation control for {@link classify}. */
export interface ClassifyOptions {
  /** Write the proposals to the custom property. Organisations only. */
  apply?: boolean;
}

export interface Proposal {
  repo: string;
  type: string;
}

/**
 * Propose a type for every repository that has none recorded.
 *
 * Prints and stops there unless `--apply` is given, for the same reason `plan`
 * and `apply` are separate commands: a rule that matches more than its author
 * expected is much easier to notice in a list than after it has been written
 * to seventeen repositories.
 *
 * A repository that already has a type is never re-examined. Classification
 * exists to fill in what is missing, not to argue with a decision somebody
 * already made — including one made by hand, against the rules.
 */
export async function classify(
  octokit: Octokit,
  config: Config,
  options: ClassifyOptions = {},
): Promise<number> {
  const rules = config.classify?.rules ?? [];
  if (rules.length === 0) {
    console.log(
      'No classify rules declared. Add classify.rules to the configuration to use this command.',
    );
    return 0;
  }

  const property = config.classify?.property;
  const kind = await detectOwnerKind(octokit, config.owner);
  const all = await listRepos(octokit, config.owner, kind);

  const recorded =
    property && kind === 'org'
      ? await readPropertyValues(octokit, config.owner, property)
      : new Map<string, string>();
  for (const repo of all) repo.type = recorded.get(repo.name);

  const unclassified = all.filter(
    (r) => !isExcluded(config, r.name) && !repoType(config, r) && !r.archived,
  );

  if (unclassified.length === 0) {
    console.log('Every repository already has a type. Nothing to propose.');
    return 0;
  }

  const paths = pathsUsedBy(rules);
  const proposals: Proposal[] = [];
  const undecided: string[] = [];

  for (const repo of unclassified) {
    const files: Record<string, string | null> = {};
    for (const path of paths) {
      files[path] = await readRepoFile(octokit, config.owner, repo.name, path);
    }

    const type = classifyRepo(rules, { visibility: repo.visibility, files });
    if (type) proposals.push({ repo: repo.name, type });
    else undecided.push(repo.name);
  }

  report(proposals, undecided);

  if (proposals.length === 0) return 0;

  if (!options.apply) {
    console.log('\nNothing was changed. Re-run with --apply to record these.');
    return 0;
  }

  if (kind !== 'org' || !property) {
    console.log(
      `\nCannot record these automatically: ${
        kind === 'org'
          ? 'no classify.property is declared'
          : `"${config.owner}" is a personal account, which has no custom properties`
      }. Copy them into the configuration as repos.<name>.type instead.`,
    );
    return 1;
  }

  return write(octokit, config.owner, property, proposals);
}

async function write(
  octokit: Octokit,
  owner: string,
  property: string,
  proposals: Proposal[],
): Promise<number> {
  const byType = new Map<string, string[]>();
  for (const proposal of proposals) {
    const list = byType.get(proposal.type) ?? [];
    list.push(proposal.repo);
    byType.set(proposal.type, list);
  }

  console.log('');
  let failures = 0;
  for (const [type, repos] of byType) {
    try {
      await setPropertyValues(octokit, owner, property, type, repos);
      console.log(`  ${type}: recorded on ${repos.length} repositories`);
    } catch (error) {
      failures++;
      console.log(`  ${type}: FAILED — ${(error as Error).message}`);
    }
  }

  console.log('');
  console.log(
    failures === 0
      ? 'All proposals recorded.'
      : `${failures} type(s) failed — see above. Run 'octoform properties sync' first if the property does not exist yet.`,
  );
  return failures === 0 ? 0 : 1;
}

function report(proposals: Proposal[], undecided: string[]): void {
  if (proposals.length > 0) {
    const width = Math.max(...proposals.map((p) => p.repo.length), 4);
    console.log(`${proposals.length} proposal(s):\n`);
    for (const proposal of proposals) {
      console.log(`  ${proposal.repo.padEnd(width)}  ${proposal.type}`);
    }
  }

  if (undecided.length > 0) {
    console.log(
      `\n${undecided.length} matched no rule and are left alone: ${undecided.join(', ')}`,
    );
  }
}
