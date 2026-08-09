import type { Octokit } from '@octokit/rest';
import { isExcluded, repoType } from '../config/resolve.js';
import { detectLimits, detectOwnerKind, listRepos, readPropertyValues } from '../github/client.js';
import type { AuditConfig, Config, OwnerKind, RepoState } from '../config/types.js';

export interface Finding {
  repo: string;
  issue: string;
}

/**
 * Read-only. Reports what deviates from the declared expectations and never
 * changes anything, so it is safe to run before any of the config is trusted.
 */
export async function audit(octokit: Octokit, config: Config): Promise<number> {
  const kind = await detectOwnerKind(octokit, config.owner);
  const limits = await detectLimits(octokit, config.owner, kind);
  const all = await listRepos(octokit, config.owner, kind);

  const property = config.classify?.property;
  // Custom properties are an organisation feature. A personal account has no
  // such API to call, not even an empty one, so this is skipped rather than
  // attempted and swallowed.
  const types =
    property && kind === 'org'
      ? await readPropertyValues(octokit, config.owner, property)
      : new Map<string, string>();

  if (property && kind === 'org' && types.size === 0) {
    console.log(
      `Note: no values found for the "${property}" custom property. Either none ` +
        `are set yet, or this plan does not expose them. Types declared in the ` +
        `configuration file are still used.\n`,
    );
  } else if (property && kind === 'user') {
    console.log(
      `Note: "${config.owner}" is a personal account, so the "${property}" custom ` +
        `property does not apply — that is an organisation-only feature. Types ` +
        `declared under "repos" in the configuration file are used instead.\n`,
    );
  }

  for (const repo of all) repo.type = types.get(repo.name);

  const excluded = all.filter((r) => isExcluded(config, r.name));
  const considered = all.filter((r) => !isExcluded(config, r.name));

  const findings: Finding[] = [];
  for (const repo of considered) {
    findings.push(...inspect(repo, config));
  }

  report(config, kind, considered, excluded, findings, limits.plan, limits.orgRulesets);
  return findings.length;
}

function inspect(repo: RepoState, config: Config): Finding[] {
  const rules: AuditConfig = config.audit ?? {};
  const found: Finding[] = [];

  if (repo.archived) return found;

  if (rules.require_type !== false && !repoType(config, repo)) {
    found.push({ repo: repo.name, issue: 'no type recorded' });
  }

  if (matchesVisibility(repo, rules.require_description?.visibility) && !repo.description) {
    found.push({ repo: repo.name, issue: 'no description' });
  }

  if (matchesVisibility(repo, rules.require_topics?.visibility) && repo.topics.length === 0) {
    found.push({ repo: repo.name, issue: 'no topics' });
  }

  if (typeof rules.max_topics === 'number' && repo.topics.length > rules.max_topics) {
    found.push({
      repo: repo.name,
      issue: `${repo.topics.length} topics, over the limit of ${rules.max_topics}`,
    });
  }

  return found;
}

/**
 * An absent `visibility` means the rule was not declared at all, which is the
 * tri-state "not managed" and must not match anything.
 */
function matchesVisibility(repo: RepoState, visibility: string | undefined): boolean {
  if (visibility === undefined) return false;
  return repo.visibility === visibility;
}

function report(
  config: Config,
  kind: OwnerKind,
  considered: RepoState[],
  excluded: RepoState[],
  findings: Finding[],
  plan: string | undefined,
  orgRulesets: boolean,
): void {
  const width = Math.max(...considered.map((r) => r.name.length), 4);

  const label = kind === 'org' ? 'Organisation' : 'Personal account';
  console.log(`${label}: ${config.owner}${plan ? ` (${plan} plan)` : ''}`);
  if (kind === 'org' && !orgRulesets) {
    console.log(
      'Organisation-wide rulesets are not available on this plan. Branch rules ' +
        'are applied per repository instead.',
    );
  }
  console.log('');

  console.log(`${'REPO'.padEnd(width)}  ${'TYPE'.padEnd(14)}  VISIBILITY`);
  for (const repo of [...considered].sort(sortByTypeThenName(config))) {
    const type = repoType(config, repo) ?? '-';
    const archived = repo.archived ? ' (archived)' : '';
    console.log(`${repo.name.padEnd(width)}  ${type.padEnd(14)}  ${repo.visibility}${archived}`);
  }

  if (excluded.length > 0) {
    console.log(`\nExcluded (${excluded.length}): ${excluded.map((r) => r.name).join(', ')}`);
  }

  console.log('');
  if (findings.length === 0) {
    console.log('No findings.');
    return;
  }

  console.log(`${findings.length} finding(s):`);
  for (const finding of findings) {
    console.log(`  ${finding.repo.padEnd(width)}  ${finding.issue}`);
  }
}

function sortByTypeThenName(config: Config) {
  return (a: RepoState, b: RepoState): number => {
    const ta = repoType(config, a) ?? '~';
    const tb = repoType(config, b) ?? '~';
    return ta === tb ? a.name.localeCompare(b.name) : ta.localeCompare(tb);
  };
}
