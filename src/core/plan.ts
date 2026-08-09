import { isManaged } from '../config/resolve.js';
import { UNREADABLE } from '../config/types.js';
import type {
  Change,
  EnvironmentPolicy,
  ExistingRuleset,
  PolicySet,
  RepoDetail,
  RulesetPolicy,
} from '../config/types.js';

/** Policy groups whose keys map one-to-one onto a repository setting. */
const SCALAR_GROUPS = ['features', 'merge', 'security', 'repo'] as const;

/**
 * Policies octoform can express but cannot yet carry out. Declaring one and
 * having it silently do nothing is the worst outcome available, so they are
 * reported as blocked instead of skipped in silence.
 */
const NOT_IMPLEMENTED: Record<string, string> = {
  // Not a gap in effort: GitHub's REST API has no field for this anywhere.
  // repos/update does not accept has_discussions, and there is no dedicated
  // endpoint either — enabling Discussions is GraphQL-only as of this
  // writing. Revisit if that changes.
  'features.discussions': 'not applicable over the REST API',
};

export interface PlanOptions {
  /** False when the plan does not enforce rulesets on private repositories. */
  rulesetsEnforcedOnPrivate: boolean;
}

/**
 * Compare one repository against its resolved policy.
 *
 * Only settings the policy actually manages are considered: an absent or
 * cancelled value is not a difference, it is an instruction to look away.
 */
export function planRepo(
  repo: RepoDetail,
  policy: PolicySet,
  options: PlanOptions,
): Change[] {
  const changes: Change[] = [];

  if (policy.manage === false) return changes;

  if (repo.archived) {
    // An archived repository is read-only on GitHub's side. Reporting changes
    // that can never be applied would just be noise on every run.
    return changes;
  }

  planScalars(repo, policy, changes);
  planDefaultBranch(repo, policy, changes);
  planEnsureBranches(repo, policy, changes);
  planRulesets(repo, policy, options, changes);
  planEnvironments(repo, policy, changes);
  planFiles(repo, policy, changes);

  return changes;
}

function planScalars(repo: RepoDetail, policy: PolicySet, changes: Change[]): void {
  for (const group of SCALAR_GROUPS) {
    const declared = policy[group] as Record<string, unknown> | undefined;
    if (!declared) continue;

    for (const [name, wanted] of Object.entries(declared)) {
      if (!isManaged(wanted)) continue;

      const key = `${group}.${name}`;
      const current = repo.settings[key];

      // Checked before anything else: an unimplemented policy has no current
      // value to read, and reporting that as "unknown setting" would blame the
      // configuration for a gap in this tool.
      const unimplemented = NOT_IMPLEMENTED[key];
      if (unimplemented) {
        changes.push({ repo: repo.name, key, from: current ?? null, to: wanted, blocked: unimplemented });
        continue;
      }

      if (current === undefined) {
        changes.push({
          repo: repo.name,
          key,
          from: current,
          to: wanted,
          blocked: 'not a setting octoform knows about',
        });
        continue;
      }
      if (current === UNREADABLE) {
        changes.push({
          repo: repo.name,
          key,
          from: current,
          to: wanted,
          blocked: 'current value could not be read, probably not available on this plan',
        });
        continue;
      }
      if (same(current, wanted)) continue;

      changes.push({ repo: repo.name, key, from: current, to: wanted });
    }
  }
}

/**
 * Renaming the default branch is the one change here that reaches outside the
 * repository's settings: GitHub retargets open pull requests and redirects the
 * old name, but it does not rewrite a workflow that names the branch, nor
 * anyone's clone. So `rename_from` exists to keep the rename deliberate — it
 * only fires for a branch whose current name was actually anticipated — and
 * any workflow naming the old branch is attached to the change as a warning,
 * because after the rename those workflows quietly stop triggering.
 */
function planDefaultBranch(repo: RepoDetail, policy: PolicySet, changes: Change[]): void {
  const wanted = policy.default_branch?.name;
  if (!isManaged(wanted)) return;

  const current = repo.default_branch;
  if (!current) {
    changes.push({
      repo: repo.name,
      key: 'default_branch.name',
      from: null,
      to: wanted,
      blocked: 'the repository has no default branch to rename, probably because it is empty',
    });
    return;
  }
  if (current === wanted) return;

  const renameFrom = policy.default_branch?.rename_from;
  if (isManaged(renameFrom) && !renameFrom.includes(current)) {
    changes.push({
      repo: repo.name,
      key: 'default_branch.name',
      from: current,
      to: wanted,
      // The whole point of rename_from is that a branch nobody listed is a
      // branch nobody thought about. Renaming it anyway would be the tool
      // deciding something the configuration declined to decide.
      blocked: `current default branch "${current}" is not in rename_from (${renameFrom.join(', ')})`,
    });
    return;
  }

  const affected = repo.structure?.workflowsNamingDefaultBranch;
  const warning =
    affected === undefined
      ? 'workflow files could not be read, so any that name the old branch are unknown'
      : affected.length > 0
        ? `${affected.join(', ')} name "${current}" and will stop triggering until updated`
        : undefined;

  changes.push({
    repo: repo.name,
    key: 'default_branch.name',
    from: current,
    to: wanted,
    ...(warning ? { warning } : {}),
    payload: { from: current, to: wanted },
  });
}

/**
 * `ensure_branches` guarantees a branch exists; it never deletes one, and it
 * never touches a branch's contents. A branch that already exists is left
 * exactly as it is, whatever it points at.
 */
function planEnsureBranches(repo: RepoDetail, policy: PolicySet, changes: Change[]): void {
  const wanted = policy.ensure_branches;
  if (!wanted?.length) return;

  const existing = repo.structure?.branches;

  for (const branch of wanted) {
    const key = `ensure_branches.${branch}`;
    if (existing === undefined) {
      changes.push({
        repo: repo.name,
        key,
        from: UNREADABLE,
        to: 'exists',
        blocked: 'could not read the repository branches',
      });
      continue;
    }
    if (existing[branch]) continue;
    changes.push({
      repo: repo.name,
      key,
      from: null,
      to: `branch from ${repo.default_branch || 'the default branch'}`,
      payload: { branch, from: repo.default_branch },
    });
  }
}

function planRulesets(
  repo: RepoDetail,
  policy: PolicySet,
  options: PlanOptions,
  changes: Change[],
): void {
  if (!policy.rulesets?.length) return;

  if (!options.rulesetsEnforcedOnPrivate && repo.visibility === 'private') {
    for (const ruleset of policy.rulesets) {
      changes.push({
        repo: repo.name,
        key: `rulesets.${ruleset.name}`,
        from: null,
        to: describeRuleset(ruleset),
        // A ruleset that exists but is never enforced is worse than none at
        // all: it reads as protection that is not there.
        blocked: 'rulesets are not enforced on private repositories on this plan',
      });
    }
    return;
  }

  const existing = repo.structure?.rulesets;

  for (const declared of policy.rulesets) {
    const key = `rulesets.${declared.name}`;
    if (existing === undefined) {
      changes.push({
        repo: repo.name,
        key,
        from: UNREADABLE,
        to: describeRuleset(declared),
        blocked: 'could not read the existing rulesets',
      });
      continue;
    }

    const current = existing.find((r) => r.name === declared.name);
    if (!current) {
      changes.push({
        repo: repo.name,
        key,
        from: null,
        to: describeRuleset(declared),
        payload: { ruleset: declared },
      });
      continue;
    }
    if (sameRuleset(current, declared)) continue;

    changes.push({
      repo: repo.name,
      key,
      from: describeRuleset(current),
      to: describeRuleset(declared),
      payload: { ruleset: declared, id: current.id },
    });
  }
}

/**
 * Environments are created when missing and their reviewers corrected, but an
 * environment nobody declared is left alone: this is not the place to discover
 * that a deployment target somebody set up by hand has disappeared.
 */
function planEnvironments(repo: RepoDetail, policy: PolicySet, changes: Change[]): void {
  if (!policy.environments?.length) return;

  const existing = repo.structure?.environments;

  for (const declared of policy.environments) {
    const key = `environments.${declared.name}`;
    if (existing === undefined) {
      changes.push({
        repo: repo.name,
        key,
        from: UNREADABLE,
        to: describeEnvironment(declared),
        blocked: 'could not read the existing environments',
      });
      continue;
    }
    if (existing.includes(declared.name)) continue;

    changes.push({
      repo: repo.name,
      key,
      from: null,
      to: describeEnvironment(declared),
      payload: { environment: declared },
    });
  }
}

/**
 * `create-if-missing` is the only mode, and deliberately so: seeding what is
 * absent is safe, while overwriting whatever a repository already has at that
 * path is the fastest way to destroy work nobody asked this tool to touch.
 */
function planFiles(repo: RepoDetail, policy: PolicySet, changes: Change[]): void {
  if (!policy.files?.length) return;

  const existing = repo.structure?.files;

  for (const declared of policy.files) {
    const key = `files.${declared.path}`;
    if (existing === undefined) {
      changes.push({
        repo: repo.name,
        key,
        from: UNREADABLE,
        to: declared.from,
        blocked: 'could not check whether the file is already there',
      });
      continue;
    }
    if (existing[declared.path]) continue;

    changes.push({
      repo: repo.name,
      key,
      from: null,
      to: `seed from ${declared.from}`,
      payload: { file: declared },
    });
  }
}

function describeRuleset(ruleset: RulesetPolicy | ExistingRuleset): string {
  const parts = [ruleset.target_branches.join(', ')];
  if (ruleset.required_approvals !== undefined) parts.push(`${ruleset.required_approvals} approval(s)`);
  if (ruleset.required_checks?.length) parts.push(`checks: ${ruleset.required_checks.join(', ')}`);
  if (ruleset.block_force_push) parts.push('no force-push');
  if (ruleset.block_deletion) parts.push('no deletion');
  return parts.join('; ');
}

function describeEnvironment(environment: EnvironmentPolicy): string {
  return environment.reviewers?.length
    ? `reviewers: ${environment.reviewers.join(', ')}`
    : 'no required reviewers';
}

/**
 * Compares only what octoform manages. A ruleset carrying rules this tool does
 * not model is not "different" — treating it as such would make every run
 * offer to strip whatever somebody configured by hand.
 */
function sameRuleset(current: ExistingRuleset, declared: RulesetPolicy): boolean {
  return (
    same(current.target_branches, declared.target_branches) &&
    (current.required_approvals ?? 0) === (declared.required_approvals ?? 0) &&
    same(current.required_checks ?? [], declared.required_checks ?? []) &&
    current.block_force_push === (declared.block_force_push ?? false) &&
    current.block_deletion === (declared.block_deletion ?? false)
  );
}

function same(current: unknown, wanted: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(wanted)) {
    if (current.length !== wanted.length) return false;
    const a = [...current].map(String).sort();
    const b = [...wanted].map(String).sort();
    return a.every((value, index) => value === b[index]);
  }
  // GitHub returns an unset description or homepage as an empty string in some
  // responses and null in others; neither is a reason to plan a change.
  if ((current === '' || current === null) && (wanted === '' || wanted === null)) return true;
  return current === wanted;
}
