/**
 * Names a policy writes, and the numeric ids GitHub wants them as.
 *
 * Most of octoform's model needs no translation: a topic is a topic and a
 * branch is a branch. Rulesets are the exception. A bypass actor is a number,
 * and so is the repository a required workflow lives in, so a policy written in
 * names has to be turned into numbers before it can be sent — and a name that
 * turns out not to exist has to stop the change rather than reach the API.
 */

import type { UNREADABLE } from '../config/sentinels.js';
import type { BypassMode } from './config.js';

/** The kinds of actor GitHub lets a ruleset name. */
export type BypassActorType =
  'Integration' | 'OrganizationAdmin' | 'RepositoryRole' | 'Team' | 'DeployKey' | 'User';

/** A bypass actor in the shape GitHub stores and accepts. */
export interface StoredActor {
  actor_type: BypassActorType;
  /**
   * `null` for `DeployKey`, which stands for every deploy key at once, and for
   * `OrganizationAdmin`, whose id GitHub documents as ignored.
   */
  actor_id: number | null;
  bypass_mode: BypassMode;
}

/** Something named in a policy that has to become a number before it is sent. */
export interface Resolvable {
  kind: 'user' | 'team' | 'app' | 'repository';
  name: string;
}

/**
 * What each name a policy used turned out to be.
 *
 * Three answers, and they mean different things. A number resolved. `null` is
 * a name GitHub does not know, which blocks the change with a reason somebody
 * can act on. `UNREADABLE` is a lookup that did not answer at all — the name
 * may be perfectly good — and blocking that as though the actor did not exist
 * would be a guess dressed as a finding.
 *
 * Keyed by {@link Resolvable} through `identityKey`, never by bare name: a
 * team and a user can share one.
 */
export type Resolution = ReadonlyMap<string, number | null | typeof UNREADABLE>;
