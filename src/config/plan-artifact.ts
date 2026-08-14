/**
 * Building and verifying the saved plan artifact.
 *
 * `apply --plan` must perform exactly the plan that was reviewed, even when
 * minutes or hours pass between the two and the person approving is not the
 * process carrying it out. Verification here is what makes that a checked
 * property instead of an assumption: a stale plan fails outright rather than
 * being silently repaired or re-planned.
 */

import { readFileSync } from 'node:fs';
import { structuralDigest } from './digest.js';
import { ConfigError, loadConfigWithSources } from './resolve.js';
import type {
  OwnerScope,
  PlanArtifact,
  PlanArtifactOwner,
  PlanIdentity,
  PlanResult,
  PlanVerification,
} from '../types/index.js';

const SCHEMA_VERSION = 1;

/** How long a saved plan remains valid when the caller does not say otherwise. */
export const DEFAULT_PLAN_EXPIRY_MINUTES = 60;

/**
 * Assemble a saved plan from the results already computed for each selected
 * owner.
 *
 * Nothing here talks to GitHub: the actor and the owners' numeric identities
 * arrive as data, gathered once by the caller that already holds a client.
 * That keeps the artifact — the thing an operator reviews and an automated
 * apply trusts — decided entirely by inputs a test can hand it.
 */
export function buildPlanArtifact(
  actor: string | undefined,
  configPath: string,
  sourceDigests: Record<string, string>,
  selectedOwners: OwnerScope[],
  results: ReadonlyMap<string, PlanResult>,
  ownerIds: ReadonlyMap<string, number>,
  octoformVersion: string,
  expiryMinutes: number = DEFAULT_PLAN_EXPIRY_MINUTES,
): PlanArtifact {
  if (!actor) {
    throw new ConfigError(
      'Cannot save a plan: this token does not expose an authenticated login to record as the actor.',
    );
  }

  const now = new Date();
  const owners: PlanArtifactOwner[] = selectedOwners.map((scope) => {
    const result = results.get(scope.owner);
    const id = ownerIds.get(scope.owner);
    if (!result || id === undefined) {
      throw new ConfigError(`Internal error: no plan result for owner "${scope.owner}".`);
    }
    return { login: scope.owner, id, changes: result.changes, blocked: result.blocked };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    octoformVersion,
    actor,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiryMinutes * 60_000).toISOString(),
    configPath,
    configDigest: structuralDigest(selectedOwners),
    sourceDigests,
    owners,
  };
}

/**
 * Re-check every claim a saved plan makes before it is allowed to apply
 * anything. Each failure mode is distinct and named, rather than a single
 * generic "stale plan" — the operator needs to know which check failed to
 * decide whether to re-plan or investigate.
 *
 * `observed` carries what the current run resolved about the identities the
 * plan named. Taking it as data rather than a client is what lets every
 * rejection path be exercised without a network.
 */
export function verifyPlanArtifact(
  artifact: PlanArtifact,
  observed: PlanIdentity,
): PlanVerification {
  if (artifact.schemaVersion !== SCHEMA_VERSION) {
    return {
      valid: false,
      reason: 'unsupported-schema-version',
      detail: `plan schema version ${artifact.schemaVersion} is not supported (expected ${SCHEMA_VERSION})`,
    };
  }

  if (new Date(artifact.expiresAt).getTime() <= Date.now()) {
    return { valid: false, reason: 'expired', detail: `the plan expired at ${artifact.expiresAt}` };
  }

  if (observed.actor !== artifact.actor) {
    return {
      valid: false,
      reason: 'actor-mismatch',
      detail:
        `the plan was produced by "${artifact.actor}", but the current token authenticates as ` +
        `"${observed.actor ?? 'an identity this token does not expose'}"`,
    };
  }

  for (const owner of artifact.owners) {
    if (observed.ownerIds.get(owner.login) !== owner.id) {
      return {
        valid: false,
        reason: 'owner-identity-mismatch',
        detail: `"${owner.login}" resolved to a different account than the one the plan was made against`,
      };
    }
  }

  let reloaded: ReturnType<typeof loadConfigWithSources>;
  try {
    reloaded = loadConfigWithSources(artifact.configPath);
  } catch (error) {
    return {
      valid: false,
      reason: 'source-digest-mismatch',
      detail: `the configuration could not be reloaded from "${artifact.configPath}": ${(error as Error).message}`,
    };
  }

  for (const [path, digest] of Object.entries(artifact.sourceDigests)) {
    if (reloaded.sourceDigests[path] !== digest) {
      return {
        valid: false,
        reason: 'source-digest-mismatch',
        detail: `"${path}" has changed since the plan was made`,
      };
    }
  }

  const selected = reloaded.config.owners.filter((scope) =>
    artifact.owners.some((owner) => owner.login === scope.owner),
  );
  if (structuralDigest(selected) !== artifact.configDigest) {
    return {
      valid: false,
      reason: 'config-digest-mismatch',
      detail: 'the resolved configuration for these owners has changed since the plan was made',
    };
  }

  return { valid: true };
}

/** Read and parse a saved plan file, failing clearly on anything that is not one. */
export function readPlanArtifact(path: string): PlanArtifact {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read plan file: ${path}`);
  }
  try {
    return JSON.parse(raw) as PlanArtifact;
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
}
