/** Types describing how a run is narrowed to a subset of a configuration. */

/** A parsed `--repo` value: an optional owner qualifier and a repository name. */
export interface RepoSelector {
  /** Present only when the value was written as `owner/name`. */
  owner?: string;
  name: string;
}
