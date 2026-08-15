/**
 * Translation between a declared ruleset and the shape GitHub stores.
 *
 * GitHub keeps a ruleset's rules as a list of tagged objects, and a rule is
 * either present or absent — there is no rule that is switched off. A policy,
 * meanwhile, has to be able to say `block_force_push: false` and mean it, and
 * has to read top to bottom rather than as a list of one-field objects.
 *
 * Both directions are derived from one description of the mapping, so a rule
 * cannot be readable and unwritable, or written under a name nothing reads
 * back. The tests round-trip that description rather than each rule by hand.
 */

import type {
  CodeScanningRule,
  ExistingRuleset,
  MergeQueueRule,
  PatternRule,
  RuleSettings,
  RulesetEnforcement,
  RulesetPolicy,
  RulesetTarget,
} from '../types/index.js';

/** A GitHub rule as it is stored: a type, and parameters for some of them. */
interface RawRule {
  type: string;
  parameters?: Record<string, unknown>;
}

/**
 * Rules that carry nothing but their own presence, by the policy key that
 * turns each one on.
 *
 * These are where the two models disagree most directly: `false` here is not a
 * value GitHub stores, it is the instruction to leave the rule out.
 */
const SWITCH_RULES: Readonly<Record<string, string>> = {
  block_creation: 'creation',
  block_deletion: 'deletion',
  block_force_push: 'non_fast_forward',
  require_linear_history: 'required_linear_history',
  require_signatures: 'required_signatures',
  require_license_compliance_scanning: 'license_compliance_scanning',
};

/** One rule that has parameters, and how its policy keys map onto them. */
interface ParameterRule {
  type: string;
  /** Declaring any of these declares the rule. */
  keys: readonly (keyof RuleSettings)[];
  write: (settings: RuleSettings) => Record<string, unknown>;
  read: (parameters: Record<string, unknown>) => Partial<RuleSettings>;
}

const pattern = (parameters: Record<string, unknown>): PatternRule => ({
  operator: parameters['operator'] as PatternRule['operator'],
  pattern: String(parameters['pattern'] ?? ''),
  ...(parameters['negate'] === true ? { negate: true } : {}),
  ...(parameters['name'] ? { name: String(parameters['name']) } : {}),
});

const patternParameters = (rule: PatternRule): Record<string, unknown> => ({
  operator: rule.operator,
  pattern: rule.pattern,
  negate: rule.negate ?? false,
  ...(rule.name ? { name: rule.name } : {}),
});

/**
 * A pattern rule, of which GitHub has five that differ only in what text they
 * are matched against.
 */
function patternRule(type: string, key: keyof RuleSettings): ParameterRule {
  return {
    type,
    keys: [key],
    write: (settings) => patternParameters(settings[key] as PatternRule),
    read: (parameters) => ({ [key]: pattern(parameters) }) as Partial<RuleSettings>,
  };
}

/** A rule holding exactly one value under a name of its own. */
function singleValueRule(type: string, key: keyof RuleSettings, parameter: string): ParameterRule {
  return {
    type,
    keys: [key],
    write: (settings) => ({ [parameter]: settings[key] }),
    read: (parameters) => ({ [key]: parameters[parameter] }) as Partial<RuleSettings>,
  };
}

const PARAMETER_RULES: readonly ParameterRule[] = [
  {
    type: 'pull_request',
    keys: [
      'require_pull_request',
      'required_approvals',
      'dismiss_stale_reviews',
      'require_code_owner_review',
      'require_last_push_approval',
      'require_thread_resolution',
      'allowed_merge_methods',
    ],
    write: (settings) => ({
      required_approving_review_count: settings.required_approvals ?? 0,
      dismiss_stale_reviews_on_push: settings.dismiss_stale_reviews ?? false,
      require_code_owner_review: settings.require_code_owner_review ?? false,
      require_last_push_approval: settings.require_last_push_approval ?? false,
      required_review_thread_resolution: settings.require_thread_resolution ?? false,
      ...(settings.allowed_merge_methods
        ? { allowed_merge_methods: settings.allowed_merge_methods }
        : {}),
    }),
    read: (parameters) => ({
      require_pull_request: true,
      required_approvals: Number(parameters['required_approving_review_count'] ?? 0),
      dismiss_stale_reviews: parameters['dismiss_stale_reviews_on_push'] === true,
      require_code_owner_review: parameters['require_code_owner_review'] === true,
      require_last_push_approval: parameters['require_last_push_approval'] === true,
      require_thread_resolution: parameters['required_review_thread_resolution'] === true,
      ...(Array.isArray(parameters['allowed_merge_methods'])
        ? {
            allowed_merge_methods: parameters[
              'allowed_merge_methods'
            ] as RuleSettings['allowed_merge_methods'],
          }
        : {}),
    }),
  },
  {
    type: 'required_status_checks',
    keys: ['required_checks', 'strict_required_checks', 'checks_not_enforced_on_create'],
    write: (settings) => ({
      required_status_checks: (settings.required_checks ?? []).map((context) => ({ context })),
      strict_required_status_checks_policy: settings.strict_required_checks ?? false,
      do_not_enforce_on_create: settings.checks_not_enforced_on_create ?? false,
    }),
    read: (parameters) => ({
      required_checks: ((parameters['required_status_checks'] ?? []) as Array<{ context?: string }>)
        .map((check) => check.context ?? '')
        .filter(Boolean),
      strict_required_checks: parameters['strict_required_status_checks_policy'] === true,
      checks_not_enforced_on_create: parameters['do_not_enforce_on_create'] === true,
    }),
  },
  {
    type: 'update',
    keys: ['block_update', 'allow_fetch_and_merge'],
    write: (settings) => ({
      update_allows_fetch_and_merge: settings.allow_fetch_and_merge ?? false,
    }),
    read: (parameters) => ({
      block_update: true,
      allow_fetch_and_merge: parameters['update_allows_fetch_and_merge'] === true,
    }),
  },
  singleValueRule(
    'required_deployments',
    'required_deployments',
    'required_deployment_environments',
  ),
  singleValueRule('file_path_restriction', 'restricted_file_paths', 'restricted_file_paths'),
  singleValueRule(
    'file_extension_restriction',
    'restricted_file_extensions',
    'restricted_file_extensions',
  ),
  singleValueRule('max_file_size', 'max_file_size', 'max_file_size'),
  singleValueRule('max_file_path_length', 'max_file_path_length', 'max_file_path_length'),
  {
    type: 'merge_queue',
    keys: ['merge_queue'],
    write: (settings) => ({ ...(settings.merge_queue as MergeQueueRule) }),
    read: (parameters) => ({ merge_queue: parameters as MergeQueueRule }),
  },
  {
    type: 'code_scanning',
    keys: ['required_code_scanning'],
    write: (settings) => ({ code_scanning_tools: settings.required_code_scanning }),
    read: (parameters) => ({
      required_code_scanning: (parameters['code_scanning_tools'] ?? []) as CodeScanningRule[],
    }),
  },
  {
    type: 'copilot_code_review',
    keys: ['copilot_code_review'],
    write: (settings) => ({ ...settings.copilot_code_review }),
    read: (parameters) => ({
      copilot_code_review: parameters as RuleSettings['copilot_code_review'],
    }),
  },
  patternRule('commit_message_pattern', 'commit_message_pattern'),
  patternRule('commit_author_email_pattern', 'commit_author_email_pattern'),
  patternRule('committer_email_pattern', 'committer_email_pattern'),
  patternRule('branch_name_pattern', 'branch_name_pattern'),
  patternRule('tag_name_pattern', 'tag_name_pattern'),
];

/** Every rule type this module can read back out of GitHub's own shape. */
const MODELLED: ReadonlySet<string> = new Set([
  ...Object.values(SWITCH_RULES),
  ...PARAMETER_RULES.map((rule) => rule.type),
]);

/** Every policy key that describes a rule rather than the ruleset itself. */
export const RULE_KEYS: readonly (keyof RuleSettings)[] = [
  ...(Object.keys(SWITCH_RULES) as (keyof RuleSettings)[]),
  ...PARAMETER_RULES.flatMap((rule) => rule.keys),
];

/** Which of the three targets a policy declared, and the refs it names. */
export function targetOf(policy: RulesetPolicy): {
  target: RulesetTarget;
  include: string[];
} | null {
  const declared = [
    policy.target_branches !== undefined ? ('branch' as const) : undefined,
    policy.target_tags !== undefined ? ('tag' as const) : undefined,
    policy.target_pushes ? ('push' as const) : undefined,
  ].filter((value): value is RulesetTarget => value !== undefined);

  if (declared.length !== 1) return null;
  const target = declared[0] as RulesetTarget;
  const include = target === 'branch' ? (policy.target_branches ?? []) : (policy.target_tags ?? []);
  return { target, include: target === 'push' ? [] : include };
}

/**
 * Read a stored ruleset into the shape a policy is written in, keeping any
 * rule this module does not model so an update can put it back.
 */
export function readRuleset(raw: {
  id: number;
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: RawRule[];
}): ExistingRuleset {
  const rules: RuleSettings = {};
  const unmodelled: unknown[] = [];

  for (const rule of raw.rules ?? []) {
    if (!MODELLED.has(rule.type)) {
      unmodelled.push(rule);
      continue;
    }
    const switched = Object.entries(SWITCH_RULES).find(([, type]) => type === rule.type);
    if (switched) {
      Object.assign(rules, { [switched[0]]: true });
      continue;
    }
    const binding = PARAMETER_RULES.find((candidate) => candidate.type === rule.type);
    if (binding) Object.assign(rules, binding.read(rule.parameters ?? {}));
  }

  /** An absent switch rule is that rule turned off, not an unknown. */
  for (const key of Object.keys(SWITCH_RULES) as (keyof RuleSettings)[]) {
    if (rules[key] === undefined) Object.assign(rules, { [key]: false });
  }

  return {
    id: raw.id,
    name: raw.name,
    target: (raw.target ?? 'branch') as RulesetTarget,
    enforcement: (raw.enforcement ?? 'active') as RulesetEnforcement,
    include: (raw.conditions?.ref_name?.include ?? []).map(fromRefName),
    exclude: (raw.conditions?.ref_name?.exclude ?? []).map(fromRefName),
    rules,
    unmodelled,
  };
}

/**
 * The rules to send for a ruleset, declared ones folded over whatever is
 * already there.
 *
 * A rule the policy did not mention keeps whatever it had, because updating a
 * ruleset replaces its whole list and octoform has no business deleting a rule
 * nobody asked it about. A rule the policy switched off is the one removal
 * this produces, and only because the file said so.
 *
 * @param policy - The declared ruleset.
 * @param existing - The stored ruleset, when there is one to preserve.
 */
export function rulesFor(policy: RulesetPolicy, existing?: ExistingRuleset): RawRule[] {
  const settings: RuleSettings = { ...existing?.rules };
  for (const key of RULE_KEYS) {
    const declared = (policy as RuleSettings)[key];
    if (declared !== undefined) Object.assign(settings, { [key]: declared });
  }

  const rules: RawRule[] = [];
  for (const [key, type] of Object.entries(SWITCH_RULES)) {
    if (settings[key as keyof RuleSettings] === true) rules.push({ type });
  }
  for (const binding of PARAMETER_RULES) {
    if (!binding.keys.some((key) => settings[key] !== undefined)) continue;
    /** `block_update: false` and `require_pull_request: false` remove the rule. */
    if (settings[binding.keys[0] as keyof RuleSettings] === false) continue;
    rules.push({ type: binding.type, parameters: binding.write(settings) });
  }

  return [...rules, ...((existing?.unmodelled ?? []) as RawRule[])];
}

/** The request body that creates or replaces a ruleset. */
export function rulesetBody(
  policy: RulesetPolicy,
  existing?: ExistingRuleset,
): Record<string, unknown> {
  const target = targetOf(policy);
  return {
    name: policy.name,
    target: target?.target ?? 'branch',
    enforcement: policy.enforcement ?? 'active',
    conditions:
      target?.target === 'push'
        ? {}
        : {
            ref_name: {
              include: (target?.include ?? []).map((ref) => toRefName(ref, target?.target)),
              exclude: (policy.exclude ?? []).map((ref) => toRefName(ref, target?.target)),
            },
          },
    rules: rulesFor(policy, existing),
  };
}

/**
 * Whether the stored ruleset already says everything the policy declares.
 *
 * Only declared keys are compared. A rule somebody configured by hand, and a
 * rule octoform models but this policy says nothing about, are both left out
 * of the question — otherwise every run would offer to strip them.
 */
export function sameRuleset(current: ExistingRuleset, declared: RulesetPolicy): boolean {
  const target = targetOf(declared);
  if (target && target.target !== current.target) return false;
  if (target && !sameList(current.include, target.include)) return false;
  if (declared.exclude !== undefined && !sameList(current.exclude, declared.exclude)) return false;
  if (declared.enforcement !== undefined && declared.enforcement !== current.enforcement) {
    return false;
  }

  return RULE_KEYS.every((key) => {
    const wanted = (declared as RuleSettings)[key];
    if (wanted === undefined) return true;
    return same(current.rules[key], wanted);
  });
}

/** A ruleset in one line, for the report. */
export function describeRuleset(policy: RulesetPolicy): string {
  const target = targetOf(policy);
  const parts = [
    target?.target === 'push'
      ? 'every push'
      : `${target?.target ?? 'branch'}: ${(target?.include ?? []).join(', ')}`,
  ];
  if (policy.exclude?.length) parts.push(`except ${policy.exclude.join(', ')}`);
  if (policy.enforcement && policy.enforcement !== 'active') parts.push(policy.enforcement);
  parts.push(...ruleSummary(policy));
  return parts.join('; ');
}

/** The stored ruleset in the same one-line form, so a diff reads as a diff. */
export function describeExistingRuleset(current: ExistingRuleset): string {
  const parts = [
    current.target === 'push' ? 'every push' : `${current.target}: ${current.include.join(', ')}`,
  ];
  if (current.exclude.length) parts.push(`except ${current.exclude.join(', ')}`);
  if (current.enforcement !== 'active') parts.push(current.enforcement);
  parts.push(...ruleSummary(current.rules));
  if (current.unmodelled.length) parts.push(`${current.unmodelled.length} unmanaged rule(s)`);
  return parts.join('; ');
}

function ruleSummary(settings: RuleSettings): string[] {
  const parts: string[] = [];
  if (settings.required_approvals !== undefined) {
    parts.push(`${settings.required_approvals} approval(s)`);
  } else if (settings.require_pull_request) {
    parts.push('pull request required');
  }
  if (settings.required_checks?.length)
    parts.push(`checks: ${settings.required_checks.join(', ')}`);
  if (settings.required_deployments?.length) {
    parts.push(`deployments: ${settings.required_deployments.join(', ')}`);
  }
  if (settings.block_force_push) parts.push('no force-push');
  if (settings.block_deletion) parts.push('no deletion');
  if (settings.block_creation) parts.push('no creation');
  if (settings.block_update) parts.push('no update');
  if (settings.require_linear_history) parts.push('linear history');
  if (settings.require_signatures) parts.push('signed commits');
  return parts;
}

/**
 * Ruleset conditions are stored as full refs (`refs/heads/main`), except for
 * the `~ALL` / `~DEFAULT_BRANCH` placeholders, which stand on their own. The
 * configuration says `main`, so the two forms are translated at this boundary
 * and nowhere else — `plan` compares ref names, not refs.
 */
export function toRefName(ref: string, target: RulesetTarget = 'branch'): string {
  if (ref.startsWith('~') || ref.startsWith('refs/')) return ref;
  return `refs/${target === 'tag' ? 'tags' : 'heads'}/${ref}`;
}

/**
 * Whether a ruleset's ref patterns cover a branch.
 *
 * Used to notice that a branch is claimed by both a ruleset and classic
 * protection. Erring towards "yes" is deliberate: reporting an overlap that
 * turns out to be harmless costs a sentence in the plan, while missing a real
 * one leaves two features quietly fighting over the same branch.
 *
 * @param patterns - Ref names or patterns from a ruleset's include list.
 * @param branch - The branch classic protection names.
 * @param defaultBranch - What `~DEFAULT_BRANCH` currently resolves to.
 */
export function coversBranch(
  patterns: readonly string[],
  branch: string,
  defaultBranch: string,
): boolean {
  return patterns.some((raw) => {
    const pattern = fromRefName(raw);
    if (pattern === '~ALL') return true;
    if (pattern === '~DEFAULT_BRANCH') return branch === defaultBranch;
    if (!pattern.includes('*')) return pattern === branch;
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${expression}$`).test(branch);
  });
}

function fromRefName(ref: string): string {
  if (ref.startsWith('~')) return ref;
  return ref.replace(/^refs\/(?:heads|tags)\//, '');
}

function sameList(current: readonly string[], wanted: readonly string[]): boolean {
  if (current.length !== wanted.length) return false;
  const a = [...current].sort();
  const b = [...wanted].sort();
  return a.every((value, index) => value === b[index]);
}

function same(current: unknown, wanted: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(wanted)) {
    return sameList(current.map(String), wanted.map(String));
  }
  if (typeof current === 'object' && typeof wanted === 'object') {
    return JSON.stringify(current ?? null) === JSON.stringify(wanted ?? null);
  }
  return current === wanted;
}
