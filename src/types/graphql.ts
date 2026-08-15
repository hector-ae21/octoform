/**
 * How a GraphQL failure classifies, in the same vocabulary the REST side
 * already uses.
 *
 * The planner must not be able to tell which transport produced a value, so a
 * GraphQL failure is reduced to the same small set of meanings a REST status
 * code carries rather than being surfaced as GitHub's own error type string.
 */
export type GraphqlFailureKind =
  'not-found' | 'forbidden' | 'rate-limited' | 'unprocessable' | 'unavailable';

/** One thing that went wrong inside an otherwise successful GraphQL response. */
export interface GraphqlFailure {
  /**
   * Dotted path into the response that this failure applies to, or the empty
   * string when GitHub blamed the request as a whole rather than one field.
   */
  path: string;
  kind: GraphqlFailureKind;
  /** GitHub's own message, kept verbatim so a report can quote it. */
  message: string;
}

/**
 * The result of one GraphQL request, with partial success made explicit.
 *
 * A GraphQL response can carry data and errors at the same time under HTTP
 * `200`. Returning both, rather than choosing for the caller, is what stops a
 * partial observation being mistaken for a complete one.
 */
export interface GraphqlOutcome<T> {
  /** Whatever GitHub returned, which may be incomplete when `failures` is not empty. */
  data: T | undefined;
  failures: readonly GraphqlFailure[];
}

/** How many times a read may be retried, and how long to wait between attempts. */
export interface GraphqlRetryPolicy {
  /** Attempts after the first. `0` disables retrying. */
  attempts: number;
  /** Called between attempts. Injectable so a test never actually waits. */
  wait: (milliseconds: number) => Promise<void>;
}
