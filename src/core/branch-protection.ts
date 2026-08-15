/**
 * Translation between declared branch protection and the shape GitHub stores.
 *
 * Classic protection has the same hazard rulesets do, more sharply: its update
 * endpoint requires `required_status_checks`, `enforce_admins`,
 * `required_pull_request_reviews` and `restrictions` to be present in every
 * request, and reads a missing one as `null` — remove it. There is no partial
 * update. So changing one field means sending all of them, and anything not
 * sent back is deleted.
 *
 * Reading the current protection and folding the declared keys over it is what
 * makes that safe. It is the same reason the ruleset model preserves rules it
 * was not asked about, arrived at from the opposite direction: there, GitHub
 * replaces a list; here, it replaces the whole object.
 */

import type {
  BranchProtectionPolicy,
  BranchProtectionSettings,
  BranchRestrictions,
} from '../types/index.js';

/** Every key that describes protection rather than naming the branch. */
export const PROTECTION_KEYS: readonly (keyof BranchProtectionSettings)[] = [
  'required_checks',
  'strict_required_checks',
  'enforce_admins',
  'require_pull_request',
  'required_approvals',
  'dismiss_stale_reviews',
  'require_code_owner_review',
  'require_last_push_approval',
  'dismissal_restrictions',
  'bypass_pull_request_allowances',
  'restrict_pushes',
  'require_linear_history',
  'allow_force_pushes',
  'allow_deletions',
  'block_creations',
  'require_conversation_resolution',
  'lock_branch',
  'allow_fork_syncing',
  'require_signatures',
];

/** Keys that configure pull-request reviews, and so ask for them. */
const REVIEW_KEYS: readonly (keyof BranchProtectionSettings)[] = [
  'required_approvals',
  'dismiss_stale_reviews',
  'require_code_owner_review',
  'require_last_push_approval',
  'dismissal_restrictions',
  'bypass_pull_request_allowances',
];

interface RawRestrictions {
  users?: Array<{ login?: string }>;
  teams?: Array<{ slug?: string }>;
  apps?: Array<{ slug?: string }>;
}

/** GitHub's protection response, reduced to the parts octoform manages. */
interface RawProtection {
  required_status_checks?: { strict?: boolean; contexts?: string[] };
  enforce_admins?: { enabled?: boolean };
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    required_approving_review_count?: number;
    require_last_push_approval?: boolean;
    dismissal_restrictions?: RawRestrictions;
    bypass_pull_request_allowances?: RawRestrictions;
  };
  restrictions?: RawRestrictions;
  required_linear_history?: { enabled?: boolean };
  allow_force_pushes?: { enabled?: boolean };
  allow_deletions?: { enabled?: boolean };
  block_creations?: { enabled?: boolean };
  required_conversation_resolution?: { enabled?: boolean };
  lock_branch?: { enabled?: boolean };
  allow_fork_syncing?: { enabled?: boolean };
  required_signatures?: { enabled?: boolean };
}

function readRestrictions(raw: RawRestrictions | undefined): BranchRestrictions | undefined {
  if (!raw) return undefined;
  return {
    users: (raw.users ?? []).map((user) => user.login ?? '').filter(Boolean),
    teams: (raw.teams ?? []).map((team) => team.slug ?? '').filter(Boolean),
    apps: (raw.apps ?? []).map((app) => app.slug ?? '').filter(Boolean),
  };
}

function writeRestrictions(restrictions: BranchRestrictions | undefined): {
  users: string[];
  teams: string[];
  apps: string[];
} {
  return {
    users: restrictions?.users ?? [],
    teams: restrictions?.teams ?? [],
    apps: restrictions?.apps ?? [],
  };
}

/**
 * Read stored protection into the shape a policy is written in.
 *
 * GitHub wraps most of these in `{ enabled }` and nests the review settings
 * one level down; flattening them here is what lets a policy be compared key
 * by key against what is actually in force.
 */
export function readProtection(raw: RawProtection): BranchProtectionSettings {
  const reviews = raw.required_pull_request_reviews;
  return {
    required_checks: raw.required_status_checks?.contexts ?? [],
    strict_required_checks: raw.required_status_checks?.strict === true,
    enforce_admins: raw.enforce_admins?.enabled === true,
    require_pull_request: reviews !== undefined,
    required_approvals: reviews?.required_approving_review_count ?? 0,
    dismiss_stale_reviews: reviews?.dismiss_stale_reviews === true,
    require_code_owner_review: reviews?.require_code_owner_reviews === true,
    require_last_push_approval: reviews?.require_last_push_approval === true,
    ...(readRestrictions(reviews?.dismissal_restrictions)
      ? { dismissal_restrictions: readRestrictions(reviews?.dismissal_restrictions) }
      : {}),
    ...(readRestrictions(reviews?.bypass_pull_request_allowances)
      ? {
          bypass_pull_request_allowances: readRestrictions(reviews?.bypass_pull_request_allowances),
        }
      : {}),
    ...(readRestrictions(raw.restrictions)
      ? { restrict_pushes: readRestrictions(raw.restrictions) }
      : {}),
    require_linear_history: raw.required_linear_history?.enabled === true,
    allow_force_pushes: raw.allow_force_pushes?.enabled === true,
    allow_deletions: raw.allow_deletions?.enabled === true,
    block_creations: raw.block_creations?.enabled === true,
    require_conversation_resolution: raw.required_conversation_resolution?.enabled === true,
    lock_branch: raw.lock_branch?.enabled === true,
    allow_fork_syncing: raw.allow_fork_syncing?.enabled === true,
    require_signatures: raw.required_signatures?.enabled === true,
  };
}

/**
 * The request body that puts protection on a branch, declared keys folded over
 * whatever is already there.
 *
 * The four required members are always present, because GitHub reads a missing
 * one as an instruction to remove it. Where a policy says nothing and there is
 * nothing stored either, they go out as `null`, which is that same instruction
 * said deliberately rather than by omission.
 *
 * @param policy - The declared protection.
 * @param existing - What is currently in force, when the branch has any.
 */
export function protectionBody(
  policy: BranchProtectionPolicy,
  existing?: BranchProtectionSettings | null,
): Record<string, unknown> {
  const settings: BranchProtectionSettings = { ...existing };
  for (const key of PROTECTION_KEYS) {
    const declared = policy[key];
    if (declared !== undefined) Object.assign(settings, { [key]: declared });
  }

  /**
   * Configuring reviews asks for them. Without this, a policy that says
   * `required_approvals: 2` and nothing else would send a review block GitHub
   * reads as "no approvals required" on a branch that had none — and, worse,
   * the reverse: the block is only ever sent when reviews are actually wanted,
   * so declaring `enforce_admins` alone cannot start requiring pull requests
   * on a branch where nobody asked for them.
   */
  if (policy.require_pull_request === undefined && REVIEW_KEYS.some((key) => policy[key])) {
    settings.require_pull_request = true;
  }

  const checks = settings.required_checks;
  const reviews = settings.require_pull_request === true ? settings : undefined;

  return {
    required_status_checks: checks?.length
      ? { strict: settings.strict_required_checks ?? false, contexts: checks }
      : null,
    enforce_admins: settings.enforce_admins ?? false,
    required_pull_request_reviews: reviews
      ? {
          dismiss_stale_reviews: reviews.dismiss_stale_reviews ?? false,
          require_code_owner_reviews: reviews.require_code_owner_review ?? false,
          required_approving_review_count: reviews.required_approvals ?? 0,
          require_last_push_approval: reviews.require_last_push_approval ?? false,
          ...(reviews.dismissal_restrictions
            ? { dismissal_restrictions: writeRestrictions(reviews.dismissal_restrictions) }
            : {}),
          ...(reviews.bypass_pull_request_allowances
            ? {
                bypass_pull_request_allowances: writeRestrictions(
                  reviews.bypass_pull_request_allowances,
                ),
              }
            : {}),
        }
      : null,
    restrictions: settings.restrict_pushes ? writeRestrictions(settings.restrict_pushes) : null,
    required_linear_history: settings.require_linear_history ?? false,
    allow_force_pushes: settings.allow_force_pushes ?? false,
    allow_deletions: settings.allow_deletions ?? false,
    block_creations: settings.block_creations ?? false,
    required_conversation_resolution: settings.require_conversation_resolution ?? false,
    lock_branch: settings.lock_branch ?? false,
    allow_fork_syncing: settings.allow_fork_syncing ?? false,
  };
}

/**
 * Whether what is in force already says everything the policy declares.
 *
 * Only declared keys count, so protection somebody configured by hand and did
 * not write down is not a difference — the same rule the ruleset comparison
 * follows, and for the same reason.
 */
export function sameProtection(
  current: BranchProtectionSettings | null,
  declared: BranchProtectionPolicy,
): boolean {
  if (current === null) return false;
  return PROTECTION_KEYS.every((key) => {
    const wanted = declared[key];
    if (wanted === undefined) return true;
    return same(current[key], wanted);
  });
}

/** Protection in one line, for the report. */
export function describeProtection(settings: BranchProtectionSettings): string {
  const parts: string[] = [];
  if (settings.required_approvals !== undefined && settings.required_approvals > 0) {
    parts.push(`${settings.required_approvals} approval(s)`);
  } else if (settings.require_pull_request) {
    parts.push('pull request required');
  }
  if (settings.required_checks?.length)
    parts.push(`checks: ${settings.required_checks.join(', ')}`);
  if (settings.enforce_admins) parts.push('admins included');
  if (settings.restrict_pushes) parts.push('push restricted');
  if (settings.require_linear_history) parts.push('linear history');
  if (settings.require_signatures) parts.push('signed commits');
  if (settings.lock_branch) parts.push('locked');
  if (settings.allow_force_pushes) parts.push('force-push allowed');
  if (settings.allow_deletions) parts.push('deletion allowed');
  return parts.length > 0 ? parts.join('; ') : 'protected, with nothing octoform manages set';
}

function same(current: unknown, wanted: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(wanted)) {
    if (current.length !== wanted.length) return false;
    const a = [...current].map(String).sort();
    const b = [...wanted].map(String).sort();
    return a.every((value, index) => value === b[index]);
  }
  if (typeof current === 'object' && typeof wanted === 'object') {
    return JSON.stringify(normalize(current)) === JSON.stringify(normalize(wanted));
  }
  return current === wanted;
}

/** Compare a restriction by its contents, whichever order or gaps it was written with. */
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value ?? null;
  const restrictions = value as BranchRestrictions;
  return {
    users: [...(restrictions.users ?? [])].sort(),
    teams: [...(restrictions.teams ?? [])].sort(),
    apps: [...(restrictions.apps ?? [])].sort(),
  };
}
