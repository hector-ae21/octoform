/** Types describing repository classification, from facts to proposal. */

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

/** Mutation control for {@link classify}. */
export interface ClassifyOptions {
  /** Write the proposals to the custom property. Organisations only. */
  apply?: boolean;
}

/** One repository's proposed type, awaiting confirmation before it is recorded. */
export interface Proposal {
  repo: string;
  type: string;
}
