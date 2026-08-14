/**
 * Frozen exit-code classes for the `v0` line.
 *
 * Numbers never change meaning once published here, and a script that
 * branches on one of these can trust it across every release under `v0`: the
 * difference between "there was drift" (1), "something was blocked" (4) and
 * "something failed" (5) is the whole reason this exists instead of a single
 * generic non-zero code.
 */

/** Nothing to report. The run found no drift and nothing was blocked or failed. */
export const EXIT_SUCCESS = 0;

/** `audit` or `plan` found drift, or `apply` was declined, and nothing was applied. */
export const EXIT_CHANGES_PENDING = 1;

/** The command line, or the resolved configuration, could not be understood. */
export const EXIT_USAGE_ERROR = 2;

/** The token is missing, lacks a required scope, or was rejected by GitHub. */
export const EXIT_AUTH_ERROR = 3;

/** At least one operation could not be planned or applied due to a capability or read failure. */
export const EXIT_BLOCKED = 4;

/** At least one operation, or the run itself, failed outright. */
export const EXIT_FAILED = 5;
