/**
 * Translation between a declared permission level and the several names GitHub
 * has for the same one.
 *
 * There are three vocabularies in play for five levels. The grant endpoints
 * take `pull` and `push`; invitations take `read` and `write`; a collaborator
 * reads back as `role_name`, which the API describes with an example and no
 * enumeration at all. `triage`, `maintain` and `admin` are spelled the same
 * way everywhere, which is exactly what makes the other two easy to miss.
 *
 * Everything is canonicalised on the way in and spelled the way each endpoint
 * wants on the way out, so nothing above this module has to know that "write"
 * and "push" are the same permission — or, worse, discover it by planning the
 * same change on every run.
 */

import type { AccessLevel } from '../types/index.js';

/** The five levels GitHub builds in, in the spelling octoform reports. */
export const BUILT_IN_LEVELS: readonly string[] = ['read', 'triage', 'write', 'maintain', 'admin'];

/** octoform's own word for revoking a grant. GitHub has no value for it. */
export const REVOKED = 'none';

/** Every spelling of a built-in level, by the canonical one. */
const SPELLINGS: Readonly<Record<string, string>> = {
  read: 'read',
  pull: 'read',
  triage: 'triage',
  write: 'write',
  push: 'write',
  maintain: 'maintain',
  admin: 'admin',
};

/** What each level is called by the endpoints that grant it. */
const GRANT_SPELLING: Readonly<Record<string, string>> = {
  read: 'pull',
  triage: 'triage',
  write: 'push',
  maintain: 'maintain',
  admin: 'admin',
};

/**
 * The booleans a collaborator carries alongside its role name, weakest first.
 *
 * Unlike `role_name`, this set is enumerated in GitHub's own description, so it
 * is the reliable fallback when the name is missing or unfamiliar.
 */
const IMPLIED_BY: readonly (readonly [string, string])[] = [
  ['admin', 'admin'],
  ['maintain', 'maintain'],
  ['push', 'write'],
  ['triage', 'triage'],
  ['pull', 'read'],
];

/** Whether a level is one of GitHub's own rather than a custom role. */
export function isBuiltIn(level: AccessLevel): boolean {
  return SPELLINGS[level.toLowerCase()] !== undefined;
}

/**
 * One canonical name for a level, whichever spelling it arrived in.
 *
 * A name that is not built-in is a custom repository role, and is returned
 * untouched: those are granted by name, and octoform has no table of them to
 * check it against.
 */
export function canonicalLevel(level: AccessLevel): string {
  return SPELLINGS[level.toLowerCase()] ?? level;
}

/** The spelling the collaborator and team grant endpoints take. */
export function grantLevel(level: AccessLevel): string {
  return GRANT_SPELLING[canonicalLevel(level)] ?? level;
}

/**
 * The spelling an invitation takes, which is the canonical one.
 *
 * A custom role has no invitation spelling at all: the invitation endpoints
 * enumerate the five built-ins and nothing else. Callers check
 * {@link isBuiltIn} before amending one.
 */
export function invitationLevel(level: AccessLevel): string {
  return canonicalLevel(level);
}

/**
 * What a collaborator or team currently holds, read from whichever of the two
 * signals GitHub provided.
 *
 * `role_name` wins when it names something, because it is the only signal that
 * can say "custom role". The booleans are consulted when it does not, and they
 * are read weakest-last so the strongest true one is what comes out.
 *
 * @param roleName - GitHub's `role_name` or legacy `permission` string.
 * @param permissions - The `permissions` object, when the response carried one.
 */
export function readLevel(
  roleName: string | undefined,
  permissions: Record<string, boolean> | undefined,
): string | undefined {
  if (roleName) return canonicalLevel(roleName);
  for (const [flag, level] of IMPLIED_BY) {
    if (permissions?.[flag] === true) return level;
  }
  return undefined;
}

/** Whether what is held already is what the policy asks for. */
export function sameLevel(current: string | undefined, declared: AccessLevel): boolean {
  if (current === undefined) return declared === REVOKED;
  return canonicalLevel(current) === canonicalLevel(declared);
}
