/** Types for the offline `config validate` and `config migrate` commands. */

/** Write control for {@link migrateConfig}. */
export interface MigrateOptions {
  /**
   * Write the migrated file back to disk in place, instead of only printing
   * it. Refused when the file has uncommitted changes in a git working tree.
   */
  write?: boolean;
}

/** The result of migrating one file's content. */
export interface MigratedConfig {
  /** The rewritten file content, ready to preview or write back. */
  yaml: string;
  /** The owner the file declared, now the key under `owners`. */
  owner: string;
}
