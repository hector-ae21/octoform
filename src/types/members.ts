/** Types for the deliberate, one-person-at-a-time membership commands. */

/** How a membership command was invoked. */
export interface MembershipOptions {
  /** Skip the confirmation, for a run nobody is watching. */
  yes?: boolean;
  /**
   * The login this run is authenticated as.
   *
   * Only the guards use it, and only to refuse a command that would take away
   * the ability to undo itself.
   */
  actor?: string;
  /** The organisation role to invite somebody as. */
  role?: string;
}
