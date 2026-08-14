import type { ClassifyRule } from '../config/types.js';

/**
 * What a rule is allowed to look at. Deliberately small: a rule can ask about
 * a repository's visibility and about files it names, and nothing else. Every
 * question a rule can ask has to be answerable by fetching a known list of
 * paths up front, which is what keeps classification to one predictable set of
 * requests per repository rather than an open-ended crawl.
 */
export interface RepoFacts {
  visibility: string;
  /** File content by path, or `null` when the repository does not have it. */
  files: Record<string, string | null>;
}

/** Every path any rule needs, so they can be fetched once, before matching. */
export function pathsUsedBy(rules: ClassifyRule[]): string[] {
  const paths = new Set<string>();
  for (const rule of rules) {
    if (rule.when.file_exists) paths.add(rule.when.file_exists);
  }
  return [...paths];
}

/**
 * The type the first matching rule proposes, or undefined when none match.
 *
 * First match wins, so order in the configuration file is significant and
 * narrower rules belong above broader ones — "a package.json with private:
 * true" has to be tested before "a package.json", or nothing would ever reach
 * the narrower rule. That is a property of the file, not of this code: octoform
 * has no idea which of the two is narrower.
 */
export function classifyRepo(rules: ClassifyRule[], facts: RepoFacts): string | undefined {
  for (const rule of rules) {
    if (matches(rule, facts)) return rule.type;
  }
  return undefined;
}

function matches(rule: ClassifyRule, facts: RepoFacts): boolean {
  const { visibility, file_exists: filePath, json } = rule.when;

  if (visibility !== undefined && facts.visibility !== visibility) return false;

  if (filePath === undefined) {
    return json === undefined;
  }

  const content = facts.files[filePath];
  if (content === null || content === undefined) return false;
  if (json === undefined) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;

  const record = parsed as Record<string, unknown>;
  return Object.entries(json).every(([key, expected]) => record[key] === expected);
}
