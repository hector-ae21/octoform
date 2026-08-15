/**
 * Checking that an account login from a configuration file could be a real
 * GitHub login before anything is done with it.
 *
 * A login read from a file is untrusted input that ends up in a request path.
 * Octokit encodes path parameters, so a malformed one cannot rewrite a route,
 * but it can still turn a typo into an opaque `404` several requests later
 * and it can carry characters that have no business being echoed to a
 * terminal. Rejecting it where the file loads turns all of that into one
 * error that names the file and the offending path.
 */

/**
 * GitHub's own rule for an account login: alphanumeric characters and single
 * hyphens, never starting or ending with one, at most 39 characters. Anything
 * else is not a login that could exist, whatever else it might be.
 */
const OWNER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

/** True when `login` has the shape GitHub issues to a user or organisation. */
export function isOwnerLogin(login: string): boolean {
  return OWNER_LOGIN.test(login);
}

/**
 * Why `login` cannot be a GitHub account, in words an author can act on, or
 * `undefined` when it can.
 *
 * The reason never repeats the login: it is reported alongside the YAML path
 * that holds it, and a value rejected for containing control characters is
 * the last thing that should be written back out unescaped.
 */
export function ownerLoginProblem(login: string): string | undefined {
  if (isOwnerLogin(login)) return undefined;
  if (login.length === 0) return 'it is empty';
  if (login.length > 39) return `it is ${login.length} characters long, and a login holds 39`;
  if (login.startsWith('-') || login.endsWith('-')) return 'a login cannot start or end with "-"';
  if (login.includes('--')) return 'a login cannot contain two hyphens in a row';
  if (hasControlCharacter(login)) return 'it contains control characters';
  if (login.includes('/')) return 'it contains "/", so it is probably an "owner/repo" by mistake';
  return 'a login holds only letters, digits and single hyphens';
}
