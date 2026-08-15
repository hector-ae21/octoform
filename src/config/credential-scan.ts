/**
 * Rejecting credential-shaped values wherever configuration is loaded.
 *
 * A token typed or pasted into `octoform.yml` is a token committed to
 * whatever stores that file, printed in every diff, and readable by anyone
 * who can read the repository. Catching the shape of the value, not asking
 * the author to promise they did not do this, is the only version of this
 * check worth having.
 */

/**
 * Prefixes GitHub itself uses for issued tokens. Deliberately narrow: these
 * shapes are unambiguous, so flagging them never rejects an ordinary
 * configuration value by accident the way a generic "looks like base64"
 * heuristic would.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bghp_[A-Za-z0-9]{36,}\b/,
  /\bgho_[A-Za-z0-9]{36,}\b/,
  /\bghu_[A-Za-z0-9]{36,}\b/,
  /\bghs_[A-Za-z0-9]{36,}\b/,
  /\bghr_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
];

function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Walk a parsed configuration value and return the YAML path of the first
 * credential-shaped string found, or `undefined` when there is none.
 *
 * Mapping keys are checked as well as values. A token pasted where a login or
 * a repository name belongs is in the file either way, and the path reported
 * for one names its parent rather than the key itself — repeating it would be
 * the leak this check exists to prevent.
 *
 * Only the path is ever returned, never the value: the error this feeds must
 * be able to say where the problem is without copying the secret into a
 * terminal, a log or a bug report.
 */
export function findCredentialShapedValue(value: unknown, path = ''): string | undefined {
  if (typeof value === 'string') {
    return looksLikeCredential(value) ? path || '(root)' : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findCredentialShapedValue(item, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (looksLikeCredential(key)) {
        return path ? `${path} (one of its keys)` : '(a key at the root of the file)';
      }
      const found = findCredentialShapedValue(item, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return undefined;
}
