import { isManaged } from '../config/resolve.js';
import { UNREADABLE } from '../config/sentinels.js';
import { describeExistingRuleset, describeRuleset, sameRuleset, targetOf } from './rulesets.js';
import { withPrerequisites } from './dependencies.js';
import type {
  Change,
  EnvironmentPolicy,
  OperationKind,
  PlanOptions,
  PolicySet,
  RepoDetail,
  Risk,
} from '../types/index.js';

export type { PlanOptions } from '../types/index.js';

/**
 * A change before it carries the identity and classification only `planRepo`
 * can compute, because those need the owner and the complete picture of what
 * every other planned change for this repository looks like.
 */
type ChangeDraft = Omit<Change, 'id' | 'owner' | 'operation' | 'risk' | 'prerequisites'>;

/**
 * Risk by key prefix, matching the confirmation levels in the security model.
 * A prefix not listed here is `normal` — the common case for plain metadata.
 */
const RISK_BY_PREFIX: ReadonlyArray<readonly [string, Risk]> = [
  ['default_branch.', 'sensitive'],
  ['rulesets.', 'sensitive'],
  ['environments.', 'sensitive'],
  ['repo.visibility', 'sensitive'],
  ['repo.archived', 'sensitive'],
  ['repo.name', 'sensitive'],
];

function riskFor(key: string): Risk {
  return RISK_BY_PREFIX.find(([prefix]) => key.startsWith(prefix))?.[1] ?? 'normal';
}

/**
 * `create` when nothing existed to compare against, `update` otherwise. Every
 * change this planner produces today is one or the other; `attach`, `detach`
 * and `delete` have no producer yet.
 *
 * "Nothing existed" covers both a value that is explicitly unset and one the
 * observation never returned at all. The two are kept apart everywhere it
 * matters — an unobserved setting blocks rather than being planned over — but
 * neither is a thing to update.
 */
function operationFor(draft: ChangeDraft): OperationKind {
  return draft.from === null || draft.from === undefined ? 'create' : 'update';
}

/** Policy groups whose keys map one-to-one onto a repository setting. */
const SCALAR_GROUPS = ['features', 'merge', 'security', 'repo'] as const;

/**
 * Settings GitHub only exposes on a repository covered by Advanced Security.
 * Outside a public repository, an unreadable value for one of these is
 * explained by that alone.
 */
const ADVANCED_SECURITY_KEYS: ReadonlySet<string> = new Set([
  'security.secret_scanning',
  'security.secret_scanning_push_protection',
  'security.code_scanning_default_setup',
]);

/**
 * Explain an unreadable value from evidence already in hand instead of
 * guessing at a commercial plan. Repository visibility is observed, so where
 * it settles the question the reason is stated outright; where it does not,
 * the report says only what it knows.
 *
 * @param key - Fully qualified setting key, such as `security.secret_scanning`.
 * @param visibility - Observed repository visibility.
 */
function unreadableReason(key: string, visibility: RepoDetail['visibility']): string {
  if (visibility !== 'public' && ADVANCED_SECURITY_KEYS.has(key)) {
    const setting = key.slice(key.indexOf('.') + 1).replaceAll('_', ' ');
    return `${setting} is not available on a ${visibility} repository without Advanced Security`;
  }
  return 'current value could not be read, so the change was not attempted';
}

/**
 * A consequence this change carries that GitHub will not report.
 *
 * Turning the code scanning default setup on makes GitHub refuse every SARIF
 * upload from an advanced CodeQL workflow in the same repository. Neither side
 * fails: the setting applies, and the workflow keeps running and silently stops
 * publishing. Since the workflows were already read, the plan can say so first.
 *
 * @param key - Fully qualified setting key.
 * @param wanted - The declared value.
 * @param repo - The observed repository, including whatever structure was read.
 */
function consequenceOf(key: string, wanted: unknown, repo: RepoDetail): string | undefined {
  /**
   * GitHub reports `internal` as a visibility but will not accept it back, so
   * leaving it is a decision the configuration cannot reverse later.
   */
  if (key === 'repo.visibility' && repo.visibility === 'internal') {
    return `the repository is internal, and GitHub does not accept "internal" as a visibility to set, so changing this cannot be undone by changing the configuration back`;
  }

  if (key !== 'security.code_scanning_default_setup' || wanted !== true) return undefined;

  const workflows = repo.structure?.workflowsUploadingCodeScanning;
  if (workflows === undefined) {
    return 'workflow files could not be read, so an advanced CodeQL workflow that this would disable is unknown';
  }
  if (workflows.length === 0) return undefined;

  return `${workflows.join(', ')} upload code scanning results, and GitHub refuses those uploads while the default setup is configured`;
}

/**
 * Message defaults GitHub refuses on their own: it rejects a request that sets
 * one without also stating the matching title, which would fail every other
 * setting bundled into the same request along with it.
 *
 * Keyed by the setting that needs company, valued with the key in the same
 * group that has to accompany it. The accompanying value is taken from the
 * policy, never from the repository: sending the observed title instead would
 * let a plan made before somebody edited that title quietly put the old one
 * back — a change nobody declared and no report mentioned.
 */
const REQUIRES_COMPANION: Record<string, string> = {
  'merge.squash_message': 'squash_title',
  'merge.merge_commit_message': 'merge_commit_title',
};

/**
 * Settings GitHub only changes through a GraphQL mutation, which addresses the
 * repository by node id rather than by owner and name.
 *
 * The id is read alongside them. Without it there is no identity to send the
 * mutation against, so the change is blocked rather than attempted — the same
 * treatment an unreadable current value gets, and for the same reason.
 */
export const CHANGED_BY_MUTATION: ReadonlySet<string> = new Set([
  'features.discussions',
  'features.sponsorships',
  'features.pull_requests',
  'repo.issue_creation',
  'repo.pull_request_creation',
]);

/**
 * Keys inside a scalar group that {@link planScalars} must leave alone,
 * because a function of their own plans them.
 *
 * `repo.rename_from` names no setting at all — it guards another key. And a
 * rename has to be compared against that guard before it becomes a change, so
 * `repo.name` is planned beside it rather than as an ordinary value.
 */
const PLANNED_ELSEWHERE: ReadonlySet<string> = new Set(['repo.name', 'repo.rename_from']);

/**
 * Compare one repository against its resolved policy.
 *
 * Only settings the policy actually manages are considered: an absent or
 * cancelled value is not a difference, it is an instruction to look away.
 */
export function planRepo(
  owner: string,
  repo: RepoDetail,
  policy: PolicySet,
  options: PlanOptions,
): Change[] {
  const drafts: ChangeDraft[] = [];

  if (policy.manage === false) return [];

  /**
   * An archived repository refuses every write, so there is nothing to plan
   * against it — unless the policy asks for it to be unarchived, which is the
   * one change that can still be made. Everything else planned in that same
   * run waits for it through the dependency graph.
   */
  if (repo.archived && policy.repo?.archived !== false) return [];

  planScalars(repo, policy, drafts);
  planRename(repo, policy, drafts);
  planDefaultBranch(repo, policy, drafts);
  planEnsureBranches(repo, policy, drafts);
  planRulesets(repo, policy, options, drafts);
  planEnvironments(repo, policy, drafts);
  planFiles(repo, policy, drafts);

  return withPrerequisites(
    drafts.map((draft) => ({
      ...draft,
      id: `${owner}/${draft.repo}#${draft.key}`,
      owner,
      operation: operationFor(draft),
      risk: riskFor(draft.key),
      prerequisites: [],
    })),
  );
}

function planScalars(repo: RepoDetail, policy: PolicySet, changes: ChangeDraft[]): void {
  for (const group of SCALAR_GROUPS) {
    const declared = policy[group] as Record<string, unknown> | undefined;
    if (!declared) continue;

    for (const [name, wanted] of Object.entries(declared)) {
      if (!isManaged(wanted)) continue;

      const key = `${group}.${name}`;
      if (PLANNED_ELSEWHERE.has(key)) continue;
      const current = repo.settings[key];

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
          blocked: unreadableReason(key, repo.visibility),
        });
        continue;
      }
      if (same(current, wanted)) continue;

      const enforcement = repo.enforced?.[key];
      if (enforcement !== undefined) {
        changes.push({
          repo: repo.name,
          key,
          from: current,
          to: wanted,
          blocked: enforcement,
        });
        continue;
      }

      if (CHANGED_BY_MUTATION.has(key)) {
        changes.push({
          repo: repo.name,
          key,
          from: current,
          to: wanted,
          ...(repo.nodeId
            ? { payload: { repositoryId: repo.nodeId } }
            : {
                blocked:
                  "could not read the repository's GraphQL identity, which its mutation needs",
              }),
        });
        continue;
      }

      const companion = REQUIRES_COMPANION[key];
      if (companion) {
        const value = declared[companion];
        if (!isManaged(value)) {
          changes.push({
            repo: repo.name,
            key,
            from: current,
            to: wanted,
            blocked: `GitHub rejects this unless ${group}.${companion} is declared alongside it`,
          });
          continue;
        }
        changes.push({
          repo: repo.name,
          key,
          from: current,
          to: wanted,
          payload: { requires: { [`${group}.${companion}`]: value } },
        });
        continue;
      }

      changes.push({
        repo: repo.name,
        key,
        from: current,
        to: wanted,
        warning: consequenceOf(key, wanted, repo),
      });
    }
  }
}

/**
 * Renaming the repository itself.
 *
 * `rename_from` is required rather than optional, which is where this differs
 * from the default-branch rename. A policy layer is shared: `repo.name` on its
 * own, declared under `defaults` or a type, would ask for every repository
 * that layer covers to be given the same name. Naming what is being renamed
 * from is what keeps the change addressed at one repository, wherever it was
 * written.
 *
 * The rename is also the one change that invalidates the configuration that
 * asked for it, since repositories are declared under `repos.<name>`. That is
 * attached as a warning: it happens, and the file needs an edit afterwards.
 */
function planRename(repo: RepoDetail, policy: PolicySet, changes: ChangeDraft[]): void {
  const wanted = policy.repo?.name;
  if (!isManaged(wanted)) return;

  const current = repo.name;
  if (current === wanted) return;

  const renameFrom = policy.repo?.rename_from;
  if (!isManaged(renameFrom)) {
    changes.push({
      repo: current,
      key: 'repo.name',
      from: current,
      to: wanted,
      blocked:
        'a repository rename must declare repo.rename_from, so that a shared policy layer cannot rename every repository it covers',
    });
    return;
  }
  if (!renameFrom.includes(current)) {
    changes.push({
      repo: current,
      key: 'repo.name',
      from: current,
      to: wanted,
      blocked: `current name "${current}" is not in rename_from (${renameFrom.join(', ')})`,
    });
    return;
  }

  changes.push({
    repo: current,
    key: 'repo.name',
    from: current,
    to: wanted,
    warning: `repositories are declared under repos.<name>, so the entry for "${current}" will stop matching once this is applied`,
  });
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
function planDefaultBranch(repo: RepoDetail, policy: PolicySet, changes: ChangeDraft[]): void {
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
function planEnsureBranches(repo: RepoDetail, policy: PolicySet, changes: ChangeDraft[]): void {
  const wanted = policy.ensure_branches;
  if (!wanted?.length) return;

  const existing = repo.structure?.branches;

  /**
   * The source is the default branch as it will be once this run finishes, not
   * as it is now. A rename is ordered before these, so branching from the
   * observed name would ask GitHub for a ref the rename has already taken
   * away — a failure with nothing in the plan to explain it.
   */
  const source = isManaged(policy.default_branch?.name)
    ? policy.default_branch.name
    : repo.default_branch;

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
      to: `branch from ${source || 'the default branch'}`,
      payload: { branch, from: source },
    });
  }
}

function planRulesets(
  repo: RepoDetail,
  policy: PolicySet,
  options: PlanOptions,
  changes: ChangeDraft[],
): void {
  if (!policy.rulesets?.length) return;

  if (options.rulesetCapability.status !== 'supported' && repo.visibility === 'private') {
    for (const ruleset of policy.rulesets) {
      changes.push({
        repo: repo.name,
        key: `rulesets.${ruleset.name}`,
        from: null,
        to: describeRuleset(ruleset),
        blocked: `rulesets cannot be managed on this private repository: ${options.rulesetCapability.reason}`,
      });
    }
    return;
  }

  const existing = repo.structure?.rulesets;

  for (const declared of policy.rulesets) {
    const key = `rulesets.${declared.name}`;

    /**
     * Exactly one target says what a ruleset governs. Neither leaves nothing
     * to match, and two disagree with each other; guessing either way would
     * apply protection to refs nobody named.
     */
    if (targetOf(declared) === null) {
      changes.push({
        repo: repo.name,
        key,
        from: null,
        to: declared.name,
        blocked:
          'declare exactly one of target_branches, target_tags or target_pushes, so the refs it governs are not a guess',
      });
      continue;
    }

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
      from: describeExistingRuleset(current),
      to: describeRuleset(declared),
      payload: { ruleset: declared, id: current.id, existing: current },
    });
  }
}

/**
 * Environments are created when missing and their reviewers corrected, but an
 * environment nobody declared is left alone: this is not the place to discover
 * that a deployment target somebody set up by hand has disappeared.
 *
 * An environment guarded by a team rather than a user is a third case, neither
 * matching nor safely correctable: octoform cannot resolve a team the way it
 * resolves a user login (see `resolveReviewers` in github/apply.ts), so it is
 * reported as blocked instead of being read as "no reviewers" — which would
 * make a normal-looking change quietly replace the team's protection.
 */
function planEnvironments(repo: RepoDetail, policy: PolicySet, changes: ChangeDraft[]): void {
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

    const current = existing.find((e) => e.name === declared.name);
    if (!current) {
      changes.push({
        repo: repo.name,
        key,
        from: null,
        to: describeEnvironment(declared),
        payload: { environment: declared },
      });
      continue;
    }

    if (current.reviewers === UNREADABLE) {
      changes.push({
        repo: repo.name,
        key,
        from: UNREADABLE,
        to: describeEnvironment(declared),
        blocked:
          'has a team as a required reviewer — octoform only resolves users, and comparing would risk replacing the team',
      });
      continue;
    }

    if (same(current.reviewers, declared.reviewers ?? [])) continue;

    changes.push({
      repo: repo.name,
      key,
      from: describeExistingEnvironment(current.reviewers),
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
function planFiles(repo: RepoDetail, policy: PolicySet, changes: ChangeDraft[]): void {
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

function describeEnvironment(environment: EnvironmentPolicy): string {
  return environment.reviewers?.length
    ? `reviewers: ${environment.reviewers.join(', ')}`
    : 'no required reviewers';
}

function describeExistingEnvironment(reviewers: string[]): string {
  return reviewers.length ? `reviewers: ${reviewers.join(', ')}` : 'no required reviewers';
}

function same(current: unknown, wanted: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(wanted)) {
    if (current.length !== wanted.length) return false;
    const a = [...current].map(String).sort();
    const b = [...wanted].map(String).sort();
    return a.every((value, index) => value === b[index]);
  }
  if ((current === '' || current === null) && (wanted === '' || wanted === null)) return true;
  return current === wanted;
}
