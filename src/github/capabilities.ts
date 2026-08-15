import type { CapabilityResult, CapabilitySource, CapabilityStatus } from '../types/index.js';

/** Build one capability decision, stamped with when the evidence was gathered. */
export function capability(
  status: CapabilityStatus,
  reason: string,
  source: CapabilitySource,
): CapabilityResult {
  return { status, reason, source, observedAt: new Date().toISOString() };
}

/**
 * The HTTP status of a thrown Octokit error, or `undefined` for anything that
 * is not one — a network failure, for instance, has no status to classify by
 * and must not be mistaken for a `404`.
 *
 * Centralized so every capability probe classifies an error the same way,
 * rather than each repeating its own `(error as { status?: number }).status`
 * cast.
 */
export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** GitHub's own error message, when the response body carried one. */
export function errorMessage(error: unknown): string {
  const typed = error as { message?: unknown; response?: { data?: { message?: unknown } } } | null;
  const fromBody = typed?.response?.data?.message;
  if (typeof fromBody === 'string') return fromBody;
  return typeof typed?.message === 'string' ? typed.message : '';
}
