import { isManaged } from './config.js';
import type { Change, PolicySet, RepoDetail } from './types.js';

/** Policy groups whose keys map one-to-one onto a repository setting. */
const SCALAR_GROUPS = ['features', 'merge', 'security', 'repo'] as const;

/**
 * Policies octoform can express but cannot yet carry out. Declaring one and
 * having it silently do nothing is the worst outcome available, so they are
 * reported as blocked instead of skipped in silence.
 */
const NOT_IMPLEMENTED: Record<string, string> = {
  'security.automated_security_fixes': 'not implemented yet',
  'security.private_vulnerability_reporting': 'not implemented yet',
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
      if (current === null) {
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

  if (policy.rulesets?.length && !options.rulesetsEnforcedOnPrivate && repo.visibility === 'private') {
    for (const ruleset of policy.rulesets) {
      changes.push({
        repo: repo.name,
        key: `rulesets.${ruleset.name}`,
        from: null,
        to: ruleset.target_branches.join(', '),
        // A ruleset that exists but is never enforced is worse than none at
        // all: it reads as protection that is not there.
        blocked: 'rulesets are not enforced on private repositories on this plan',
      });
    }
  }

  return changes;
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

export function formatChange(change: Change): string {
  const from = display(change.from);
  const to = display(change.to);
  const suffix = change.blocked ? `  [skipped: ${change.blocked}]` : '';
  return `${change.key}: ${from} -> ${to}${suffix}`;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '(unset)';
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  if (value === '') return '(empty)';
  return String(value);
}
