/** Types for supplying the credential octoform authenticates with. */

/**
 * Supplies a token on demand rather than as a plain string, so a caller can
 * defer to a secret manager, a short-lived GitHub App installation token, or
 * any other source without octoform needing to know which.
 */
export type TokenProvider = () => string | undefined;
