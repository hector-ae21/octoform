/**
 * Rulesets an organisation aims at repositories it selects.
 *
 * The rules are the same rules a repository can carry, so nothing about them
 * is restated here. What an organisation ruleset has and a repository's cannot
 * is a condition saying which repositories it is about, and that condition is
 * the whole of this module: how it is built, how it is read back, and the
 * three things GitHub's own description says it will not accept.
 *
 * The difference is worth stating plainly, because it is not a difference of
 * degree. A repository's ruleset is one the repository's administrators can
 * change or remove. An organisation's is not — which is what makes it the
 * level at which a rule is a rule rather than a default, and the level at
 * which getting the selection wrong reaches repositories nobody was looking at.
 */

import { targetOf } from './rulesets.js';
import type {
  ExistingRuleset,
  OrganizationRulesetPolicy,
  RuleSettings,
  RulesetPropertyMatch,
  RulesetRepositories,
  WorkflowRequirement,
} from '../types/index.js';

/**
 * Rules an organisation ruleset cannot carry, by the policy key that declares
 * one, with what to say when a file asks for it anyway.
 *
 * Both are in GitHub's repository rule list and neither is in its organisation
 * one. Sending either would be a request the endpoint has already documented
 * it does not accept, so it is refused while planning instead — where it is a
 * line somebody can read rather than a failure part way through a run.
 */
const NOT_AT_ORGANIZATION_LEVEL: ReadonlyArray<{ key: keyof RuleSettings; reason: string }> = [
  {
    key: 'merge_queue',
    reason: 'a merge queue rule is not among the rules an organisation ruleset can carry',
  },
];

/** The conditions that say which repositories a ruleset reaches. */
export function repositoryConditions(repositories: RulesetRepositories): Record<string, unknown> {
  if (repositories.properties || repositories.exclude_properties) {
    return {
      repository_property: {
        include: (repositories.properties ?? []).map(propertySpec),
        exclude: (repositories.exclude_properties ?? []).map(propertySpec),
      },
    };
  }

  /**
   * `protected` is sent only when it is asked for. The conditions are replaced
   * on every update, so leaving it out is how it is turned off — and sending
   * `false` where the stored ruleset simply has nothing would read as a
   * difference on every run.
   */
  return {
    repository_name: {
      include: repositories.include ?? [],
      exclude: repositories.exclude ?? [],
      ...(repositories.protected === true ? { protected: true } : {}),
    },
  };
}

/**
 * Whether the stored selection already says what the policy declares.
 *
 * Compared whole rather than field by field, because an update replaces the
 * conditions: a selection that differs in any part is about to become the
 * declared one in every part.
 */
export function sameRepositories(
  current: RulesetRepositories | undefined,
  declared: RulesetRepositories,
): boolean {
  if (current === undefined) return false;
  return canonical(repositoryConditions(current)) === canonical(repositoryConditions(declared));
}

/**
 * What is wrong with an organisation ruleset before anything is sent.
 *
 * Every one of these is something GitHub's description states, not something
 * inferred from how the API behaved once. A file that asks for one of them has
 * asked for a request that cannot succeed, and the useful moment to say so is
 * while the plan is being read.
 */
export function organizationRulesetProblems(policy: OrganizationRulesetPolicy): string[] {
  const problems: string[] = [];
  const selection = policy.repositories;

  const byName = selection?.include !== undefined || selection?.exclude !== undefined;
  const byProperty =
    selection?.properties !== undefined || selection?.exclude_properties !== undefined;

  if (!byName && !byProperty) {
    problems.push(
      'declare repositories.include or repositories.properties, so which repositories it governs is not a guess',
    );
  }
  if (byName && byProperty) {
    problems.push(
      'declare repositories by name or by property, not both: GitHub takes one repository condition beside the refs',
    );
  }
  if (byProperty && selection?.protected !== undefined) {
    problems.push(
      'repositories.protected is part of the name condition, so it cannot be asked for alongside property targeting',
    );
  }

  for (const { key, reason } of NOT_AT_ORGANIZATION_LEVEL) {
    if (policy[key] !== undefined) problems.push(reason);
  }

  for (const match of [
    ...(selection?.properties ?? []),
    ...(selection?.exclude_properties ?? []),
  ]) {
    if (match.values.length === 0) {
      problems.push(
        `the property "${match.name}" is targeted with no values, so it matches nothing`,
      );
    }
  }

  for (const workflow of unnamedWorkflows(policy)) {
    problems.push(
      `the required workflow ${workflow.path} must name the repository it comes from: there is no current repository here for it to default to`,
    );
  }

  return problems;
}

/**
 * Required workflows that named neither a repository nor an id.
 *
 * On a repository's ruleset that is fine — the workflow comes from the
 * repository being managed. An organisation ruleset has no such repository,
 * and defaulting to one would pick a workflow file at random from whichever
 * repository happened to be in scope.
 */
export function unnamedWorkflows(
  policy: OrganizationRulesetPolicy,
): readonly WorkflowRequirement[] {
  return (policy.required_workflows ?? []).filter(
    (workflow) => workflow.repository === undefined && workflow.repository_id === undefined,
  );
}

/** The selection in one line, for the report. */
export function describeRepositories(repositories: RulesetRepositories): string {
  if (repositories.properties || repositories.exclude_properties) {
    const parts = (repositories.properties ?? []).map(describeMatch);
    const without = (repositories.exclude_properties ?? []).map(describeMatch);
    if (without.length > 0) parts.push(`except ${without.join(' and ')}`);
    return `repositories where ${parts.join(' and ')}`;
  }

  const include = repositories.include ?? [];
  const parts = [`repositories ${include.length > 0 ? include.join(', ') : 'none'}`];
  if (repositories.exclude?.length) parts.push(`except ${repositories.exclude.join(', ')}`);
  if (repositories.protected) parts.push('which cannot be renamed');
  return parts.join(', ');
}

/**
 * The target an organisation ruleset governs, which is the same question a
 * repository's asks and gets a different default for.
 *
 * A repository's ruleset that names no target is a mistake, because it would
 * govern nothing. An organisation's can legitimately name none: with no refs
 * to match it still selects repositories, which is what a push ruleset is.
 */
export function targetProblems(policy: OrganizationRulesetPolicy): string[] {
  return targetOf(policy) === null
    ? [
        'declare exactly one of target_branches, target_tags or target_pushes, so the refs it governs are not a guess',
      ]
    : [];
}

function propertySpec(match: RulesetPropertyMatch): Record<string, unknown> {
  return {
    name: match.name,
    property_values: [...match.values].sort(),
    source: match.source ?? 'custom',
  };
}

function describeMatch(match: RulesetPropertyMatch): string {
  return `${match.name} is ${match.values.join(' or ')}`;
}

/** The selection a stored ruleset holds, for the report. */
export function describeExistingRepositories(current: ExistingRuleset): string {
  return current.repositories === undefined
    ? 'no repository condition'
    : describeRepositories(current.repositories);
}

/** A stable rendering of a value, so two structures compare as their contents. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, held]) => `${key}:${canonical(held)}`).join(',')}}`;
}
