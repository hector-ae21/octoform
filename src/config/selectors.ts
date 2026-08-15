/**
 * Narrowing a resolved configuration to the owners and repository a run should
 * actually touch.
 *
 * Everything here is pure and offline: it works on the already-loaded
 * `ResolvedConfig`, never on GitHub. Detecting whether a bare `--repo` name is
 * ambiguous across several owners needs their live repository lists, so that
 * check is not here — it belongs to the caller, which is the only place that
 * already talks to the API.
 */

import { ConfigError } from './resolve.js';
import type { OwnerScope, RepoSelector, ResolvedConfig } from '../types/index.js';

/**
 * Keep only the requested owners, in the order the configuration declared
 * them.
 *
 * A login that is not declared is an error, not a silent no-op: `--owner` is
 * how an operator states which accounts they mean to touch, and a typo there
 * should never quietly resolve to "every account except the one I meant."
 */
export function selectOwners(config: ResolvedConfig, logins: readonly string[]): OwnerScope[] {
  if (logins.length === 0) return config.owners;

  const known = new Map(config.owners.map((scope) => [scope.owner, scope]));
  const unknown = logins.filter((login) => !known.has(login));
  if (unknown.length > 0) {
    throw new ConfigError(
      `--owner ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not declared in this ` +
        `configuration (known: ${config.owners.map((scope) => scope.owner).join(', ')}).`,
    );
  }

  const requested = new Set(logins);
  return config.owners.filter((scope) => requested.has(scope.owner));
}

/** Split a `--repo` value into its optional owner qualifier and repository name. */
export function parseRepoSelector(raw: string): RepoSelector {
  const separator = raw.indexOf('/');
  if (separator < 0) return { name: raw };
  const owner = raw.slice(0, separator);
  const name = raw.slice(separator + 1);
  if (!owner || !name) {
    throw new ConfigError(`--repo "${raw}" is not a valid "owner/name" selector.`);
  }
  return { owner, name };
}

/**
 * Apply a qualified `--repo owner/name` to an owner selection.
 *
 * Narrows to exactly that one owner. Rejects a selector whose owner is not
 * declared, and rejects one that contradicts an `--owner` selection already
 * made explicitly — the two disagreeing is almost certainly a mistake, and
 * silently picking one would hide it.
 */
export function narrowToQualifiedRepo(
  config: ResolvedConfig,
  selected: OwnerScope[],
  selector: RepoSelector & { owner: string },
  ownerWasExplicit: boolean,
): OwnerScope[] {
  const match = config.owners.find((scope) => scope.owner === selector.owner);
  if (!match) {
    throw new ConfigError(
      `--repo "${selector.owner}/${selector.name}" names the owner "${selector.owner}", which is ` +
        `not declared in this configuration (known: ${config.owners.map((scope) => scope.owner).join(', ')}).`,
    );
  }
  if (ownerWasExplicit && !selected.some((scope) => scope.owner === selector.owner)) {
    throw new ConfigError(
      `--repo "${selector.owner}/${selector.name}" and --owner disagree: "${selector.owner}" is not ` +
        `among the selected owner(s) (${selected.map((scope) => scope.owner).join(', ')}).`,
    );
  }
  return [match];
}
