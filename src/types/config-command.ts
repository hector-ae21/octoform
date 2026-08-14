/** Types for the offline `config validate` and `config migrate` commands. */

/** Write control for {@link migrateConfig}. */
export interface MigrateOptions {
  /**
   * Write the migrated file back to disk in place, instead of only printing
   * it. Refused when the file has uncommitted changes in a git working tree.
   */
  write?: boolean;
}
