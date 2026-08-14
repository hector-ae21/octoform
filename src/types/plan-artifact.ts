/** Types for the saved plan artifact `plan --out` writes and `apply --plan` consumes. */

import type { Change } from './repository.js';

/** The version of `octoform plan --out`'s file format, independent of the package version. */
export type PlanArtifactSchemaVersion = 1;

/** Everything one owner contributes to a saved plan. */
export interface PlanArtifactOwner {
  login: string;
  /** GitHub's numeric identity for this owner, re-checked before apply. */
  id: number;
  changes: Change[];
  blocked: Change[];
}

/**
 * A frozen plan: exactly what `apply --plan` is allowed to do, and the
 * evidence it checks before doing any of it.
 */
export interface PlanArtifact {
  schemaVersion: PlanArtifactSchemaVersion;
  /** The octoform version that produced this file. */
  octoformVersion: string;
  /** The authenticated login that produced this file. */
  actor: string;
  /** When the plan was observed. */
  observedAt: string;
  /** After this time, `apply --plan` refuses the file outright. */
  expiresAt: string;
  /** The `--config` path this plan was produced from. */
  configPath: string;
  /** Digest of the resolved configuration for exactly the owners below. */
  configDigest: string;
  /** Digest of every source file that contributed, by absolute path. */
  sourceDigests: Record<string, string>;
  owners: PlanArtifactOwner[];
}

/** Why a saved plan was refused. One reason per distinct failure mode. */
export type PlanRejectionReason =
  | 'unsupported-schema-version'
  | 'expired'
  | 'actor-mismatch'
  | 'owner-identity-mismatch'
  | 'config-digest-mismatch'
  | 'source-digest-mismatch';

/** The result of checking a saved plan before applying it. */
export type PlanVerification = { valid: true } | { valid: false; reason: PlanRejectionReason; detail: string };
