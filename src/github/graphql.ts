/**
 * The GraphQL transport, normalized against the REST one.
 *
 * GraphQL differs from REST in one way that matters to a tool that plans
 * mutations: a response can carry `data` and `errors` together under HTTP
 * `200`. Treated like a REST response, that reads as complete success, and a
 * plan built on a partial observation is a plan that proposes changes nobody
 * can see the evidence for.
 *
 * So nothing here decides on the caller's behalf. A request returns what
 * arrived and what failed; {@link requireComplete} refuses a partial answer,
 * and {@link valueOrUnreadable} narrows one failed field to the same
 * `UNREADABLE` sentinel a REST read produces, so the planner blocks that field
 * exactly as it would have done over REST.
 */

import { UNREADABLE } from '../config/sentinels.js';
import type {
  GraphqlFailure,
  GraphqlFailureKind,
  GraphqlOutcome,
  GraphqlRetryPolicy,
} from '../types/index.js';
import type { Octokit } from '@octokit/rest';

export type { GraphqlFailure, GraphqlOutcome, GraphqlRetryPolicy } from '../types/index.js';

/**
 * GitHub's own error types, mapped onto the meanings the planner understands.
 *
 * An unlisted type is `unavailable` rather than anything more specific: an
 * error nobody has classified is not evidence that a thing is absent, and
 * treating it as `not-found` would let an unknown failure read as a confirmed
 * denial — the mistake `detectRulesetCapability` exists to avoid on the REST
 * side.
 */
const FAILURE_KINDS: Readonly<Record<string, GraphqlFailureKind>> = {
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  INSUFFICIENT_SCOPES: 'forbidden',
  UNAUTHORIZED: 'forbidden',
  RATE_LIMITED: 'rate-limited',
  UNPROCESSABLE: 'unprocessable',
  SERVICE_UNAVAILABLE: 'unavailable',
};

/** Failures worth attempting again, because they describe a moment rather than a state. */
const TRANSIENT: ReadonlySet<GraphqlFailureKind> = new Set(['rate-limited', 'unavailable']);

const DEFAULT_RETRY: GraphqlRetryPolicy = {
  attempts: 2,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Reduce GitHub's error array to the normalized vocabulary.
 *
 * Pure, and exported for the tests that prove an unrecognized type never
 * degrades into a confident answer.
 *
 * @param errors - The `errors` array from a GraphQL response.
 */
export function normalizeFailures(errors: readonly unknown[]): GraphqlFailure[] {
  return errors.map((raw) => {
    const error = raw as { type?: unknown; message?: unknown; path?: unknown };
    const type = typeof error.type === 'string' ? error.type : '';
    const path = Array.isArray(error.path) ? error.path.join('.') : '';
    return {
      path,
      kind: FAILURE_KINDS[type] ?? 'unavailable',
      message: typeof error.message === 'string' ? error.message : 'no message',
    };
  });
}

/**
 * Send one GraphQL query and report what arrived alongside what failed.
 *
 * Retries only while every failure is transient and no data arrived: a
 * response that already carried part of the answer is not repeated, because
 * repeating it would spend budget re-reading what is already in hand. A
 * mutation is never retried — pass `{ attempts: 0 }` for one, since an
 * ambiguous write must be resolved by observing, not by trying again.
 *
 * @param octokit - Authenticated client.
 * @param query - The GraphQL document to send.
 * @param variables - Variables for that document.
 * @param retry - Retry policy; the default retries a read twice.
 */
export async function graphqlRequest<T>(
  octokit: Octokit,
  query: string,
  variables: Record<string, unknown> = {},
  retry: GraphqlRetryPolicy = DEFAULT_RETRY,
): Promise<GraphqlOutcome<T>> {
  let outcome = await attempt<T>(octokit, query, variables);

  for (let remaining = retry.attempts; remaining > 0; remaining--) {
    const retryable =
      outcome.data === undefined &&
      outcome.failures.length > 0 &&
      outcome.failures.every((failure) => TRANSIENT.has(failure.kind));
    if (!retryable) break;
    await retry.wait(backoff(retry.attempts - remaining));
    outcome = await attempt<T>(octokit, query, variables);
  }

  return outcome;
}

/**
 * The data, or an error naming what stopped the answer being complete.
 *
 * Use this wherever a partial answer cannot be reasoned about — deciding
 * whether a collection is authoritative, for instance, where a missing member
 * and an unreadable one lead to opposite conclusions.
 *
 * @param outcome - Result of a GraphQL request.
 * @param subject - What was being read, for the error message.
 */
export function requireComplete<T>(outcome: GraphqlOutcome<T>, subject: string): T {
  if (outcome.failures.length === 0 && outcome.data !== undefined) return outcome.data;

  const detail = outcome.failures
    .map((failure) => `${failure.path || 'request'}: ${failure.kind} — ${failure.message}`)
    .join('; ');
  throw new Error(
    `Could not read ${subject} completely: ${detail || 'no data and no reported reason'}`,
  );
}

/**
 * One field's value, or `UNREADABLE` when this request failed to produce it.
 *
 * This is what makes the transport interchangeable with the REST one. The
 * planner already blocks a change whose current value is `UNREADABLE` rather
 * than guessing; routing a GraphQL failure to the same sentinel means a field
 * read over GraphQL blocks for the same reason and reports the same way.
 *
 * A failure on an ancestor counts: if `repository` failed, everything beneath
 * it is unreadable too, not merely absent.
 *
 * @param outcome - Result of a GraphQL request.
 * @param path - Dotted path of the field being read.
 * @param read - Extracts the field once the data is known to be present.
 */
export function valueOrUnreadable<T, V>(
  outcome: GraphqlOutcome<T>,
  path: string,
  read: (data: T) => V,
): V | typeof UNREADABLE {
  const failed = outcome.failures.some(
    (failure) =>
      failure.path === '' || path === failure.path || path.startsWith(`${failure.path}.`),
  );
  if (failed || outcome.data === undefined) return UNREADABLE;
  return read(outcome.data);
}

async function attempt<T>(
  octokit: Octokit,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlOutcome<T>> {
  try {
    const data = await octokit.graphql<T>(query, variables);
    return { data, failures: [] };
  } catch (error) {
    const thrown = error as {
      errors?: unknown;
      data?: unknown;
      status?: unknown;
      message?: unknown;
    };
    if (Array.isArray(thrown.errors)) {
      return {
        data: (thrown.data as T | undefined) ?? undefined,
        failures: normalizeFailures(thrown.errors),
      };
    }
    return { data: undefined, failures: [transportFailure(thrown)] };
  }
}

/**
 * A failure that never reached GraphQL's own error array — a transport-level
 * status, or something with no status at all.
 */
function transportFailure(error: { status?: unknown; message?: unknown }): GraphqlFailure {
  const status = typeof error.status === 'number' ? error.status : undefined;
  const message = typeof error.message === 'string' ? error.message : 'request failed';
  if (status === 401 || status === 403) return { path: '', kind: 'forbidden', message };
  if (status === 404) return { path: '', kind: 'not-found', message };
  if (status === 429) return { path: '', kind: 'rate-limited', message };
  return { path: '', kind: 'unavailable', message };
}

/** Wait longer after each failed attempt, starting at a second. */
function backoff(attemptsMade: number): number {
  return 1000 * 2 ** attemptsMade;
}
