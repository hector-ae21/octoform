/**
 * Turning the names in a ruleset policy into the numbers GitHub's ruleset
 * endpoints take, and refusing to send anything when a name did not resolve.
 *
 * Bypass actors and required workflows are the only places octoform has to do
 * this. Everywhere else GitHub accepts a login, a slug or a path, so a policy
 * says what it means and the request says the same thing. Here it cannot: the
 * ruleset API takes a team as an integer, and there is no form of the request
 * that names one.
 *
 * The lookup happens while reading, not while applying. That is the whole
 * point of doing it here rather than at the request: a misspelled team becomes
 * a blocked line in the plan, next to everything else that will not happen,
 * instead of an exception thrown after some other change has already landed.
 */

import { UNREADABLE } from '../config/sentinels.js';
import type {
  BypassActorType,
  BypassMode,
  OwnerKind,
  PolicySet,
  Resolution,
  Resolvable,
  RulesetBypass,
  RulesetPolicy,
  RulesetTarget,
  StoredActor,
  WorkflowRequirement,
} from '../types/index.js';

/** One actor a policy named, before its name became a number. */
interface DeclaredActor {
  type: BypassActorType;
  /** The name to look up, for the kinds that have one. */
  resolvable?: Resolvable;
  /** The id a policy gave directly, which only repository roles do. */
  id?: number;
  mode: BypassMode;
}

/** How a {@link Resolvable} is keyed, so a team and a user can share a name. */
export function identityKey(resolvable: Resolvable): string {
  return `${resolvable.kind}:${resolvable.name}`;
}

/**
 * Every name in a policy that has to be looked up before anything is sent.
 *
 * @param policy - The declared policy.
 * @param repository - `owner/name` of the repository being managed, which is
 *   where a required workflow lives when it does not say otherwise.
 */
export function namesToResolve(policy: PolicySet, repository: string): Resolvable[] {
  const found = new Map<string, Resolvable>();
  const add = (resolvable: Resolvable): void => {
    found.set(identityKey(resolvable), resolvable);
  };

  for (const ruleset of policy.rulesets ?? []) {
    for (const actor of declaredActors(ruleset.bypass)) {
      if (actor.resolvable) add(actor.resolvable);
    }
    for (const workflow of ruleset.required_workflows ?? []) {
      const name = workflowRepository(workflow, repository);
      if (name !== undefined) add({ kind: 'repository', name });
    }
  }

  return [...found.values()];
}

/** Flatten the groups a policy writes into one actor per line. */
function declaredActors(groups: readonly RulesetBypass[] | undefined): DeclaredActor[] {
  const actors: DeclaredActor[] = [];

  for (const group of groups ?? []) {
    const mode = group.mode ?? 'always';
    for (const name of group.users ?? []) {
      actors.push({ type: 'User', resolvable: { kind: 'user', name }, mode });
    }
    for (const name of group.teams ?? []) {
      actors.push({ type: 'Team', resolvable: { kind: 'team', name }, mode });
    }
    for (const name of group.apps ?? []) {
      actors.push({ type: 'Integration', resolvable: { kind: 'app', name }, mode });
    }
    for (const id of group.roles ?? []) {
      actors.push({ type: 'RepositoryRole', id, mode });
    }
    if (group.deploy_keys) actors.push({ type: 'DeployKey', mode });
    if (group.organization_admins) actors.push({ type: 'OrganizationAdmin', mode });
  }

  return actors;
}

/**
 * The bypass list to send, or the existing one when the policy says nothing.
 *
 * Updating a ruleset replaces its bypass list the same way it replaces its
 * rules, so silence has to be sent as "what is already there" rather than as
 * an empty list. Declaring `bypass: []` is how a policy actually revokes
 * everything, and it has to be written to mean it.
 *
 * @param policy - The declared ruleset.
 * @param existing - The stored bypass list, when there is one to preserve.
 * @param resolution - Names already looked up.
 */
export function bypassFor(
  policy: RulesetPolicy,
  existing: readonly StoredActor[] | undefined,
  resolution: Resolution,
): StoredActor[] {
  if (policy.bypass === undefined) return [...(existing ?? [])];

  const actors: StoredActor[] = [];
  for (const actor of declaredActors(policy.bypass)) {
    const id = actorId(actor, resolution);
    if (id === UNREADABLE) continue;
    actors.push({ actor_type: actor.type, actor_id: id, bypass_mode: actor.mode });
  }
  return actors;
}

/**
 * Whether the stored bypass list already says what the policy declares.
 *
 * A policy that says nothing about bypass matches anything, for the same
 * reason an undeclared rule does: octoform is not here to discover that
 * somebody granted an exception by hand.
 */
export function sameBypass(
  current: readonly StoredActor[],
  declared: RulesetPolicy,
  resolution: Resolution,
): boolean {
  if (declared.bypass === undefined) return true;
  const wanted = bypassFor(declared, undefined, resolution).map(actorSignature).sort();
  const held = current.map(actorSignature).sort();
  return wanted.length === held.length && wanted.every((value, index) => value === held[index]);
}

/**
 * Every reason a declared bypass cannot be sent as written.
 *
 * All of them come from constraints GitHub documents on the endpoint itself,
 * not from octoform's opinion of them: an organisation actor on a personal
 * repository, and a `pull_request` bypass where GitHub does not accept one.
 * The unresolved names are the other half, and the reason they read as
 * separate sentences is that "no such team" and "could not check" call for
 * different things from whoever reads the plan.
 *
 * @param policy - The declared ruleset.
 * @param resolution - Names already looked up.
 * @param ownerKind - Whether the repository belongs to an organisation.
 * @param target - What the ruleset governs, which limits `pull_request`.
 */
export function bypassProblems(
  policy: RulesetPolicy,
  resolution: Resolution,
  ownerKind: OwnerKind,
  target: RulesetTarget,
): string[] {
  const problems: string[] = [];

  for (const actor of declaredActors(policy.bypass)) {
    const name = actor.resolvable?.name;

    if (ownerKind === 'user' && (actor.type === 'Team' || actor.type === 'OrganizationAdmin')) {
      problems.push(
        actor.type === 'Team'
          ? `there are no teams on a personal repository, so "${name}" cannot be granted a bypass`
          : 'there are no organisation owners on a personal repository, so organization_admins cannot be granted a bypass',
      );
      continue;
    }

    if (actor.mode === 'pull_request' && actor.type === 'DeployKey') {
      problems.push('a deploy key cannot bypass on pull requests, only always or exempt');
      continue;
    }

    if (actor.mode === 'pull_request' && target !== 'branch') {
      problems.push(
        `a ${target} ruleset has no pull requests, so bypass mode pull_request cannot apply to it`,
      );
      continue;
    }

    const id = actorId(actor, resolution);
    if (id === UNREADABLE) {
      problems.push(`could not look up the ${actor.resolvable?.kind} "${name}"`);
    } else if (id === null && actor.resolvable) {
      problems.push(`no ${actor.resolvable.kind} called "${name}"`);
    }
  }

  return problems;
}

/**
 * Every reason a declared required workflow cannot be sent as written.
 *
 * @param policy - The declared ruleset.
 * @param resolution - Names already looked up.
 * @param repository - `owner/name` a workflow defaults to.
 */
export function workflowProblems(
  policy: RulesetPolicy,
  resolution: Resolution,
  repository: string,
): string[] {
  const problems: string[] = [];

  for (const workflow of policy.required_workflows ?? []) {
    const name = workflowRepository(workflow, repository);
    if (name === undefined) continue;
    const id = resolution.get(identityKey({ kind: 'repository', name }));
    if (id === UNREADABLE) problems.push(`could not look up the repository "${name}"`);
    else if (id === null || id === undefined) {
      problems.push(`no repository called "${name}", which ${workflow.path} would come from`);
    }
  }

  return problems;
}

/**
 * Which repository a workflow needs looked up, or `undefined` when it needs
 * none: a workflow that came back from GitHub, or one whose policy wrote the
 * id outright, already has its answer.
 */
function workflowRepository(workflow: WorkflowRequirement, repository: string): string | undefined {
  if (workflow.repository !== undefined) return workflow.repository;
  return workflow.repository_id === undefined ? repository : undefined;
}

/**
 * A required workflow in the shape GitHub stores it, with its repository
 * resolved. Callers reach here only once {@link workflowProblems} is empty.
 */
export function storedWorkflow(
  workflow: WorkflowRequirement,
  resolution: Resolution,
  repository: string,
): Record<string, unknown> {
  /**
   * A workflow read back out of GitHub carries the id and no name, so the name
   * is only consulted when there is one — otherwise a workflow living in
   * another repository would be re-read as living in this one.
   */
  const name = workflowRepository(workflow, repository);
  const id =
    name === undefined
      ? workflow.repository_id
      : resolution.get(identityKey({ kind: 'repository', name }));

  return {
    path: workflow.path,
    repository_id: typeof id === 'number' ? id : 0,
    ...(workflow.ref ? { ref: workflow.ref } : {}),
    ...(workflow.sha ? { sha: workflow.sha } : {}),
  };
}

/**
 * A bypass list in one line, for the report.
 *
 * Actors the policy named are printed as the names it used, by reading the
 * resolution backwards; anything else prints as the id, which is all GitHub
 * gave. So the exceptions somebody wrote down read as words, and the ones they
 * did not read as the numbers they are — which is itself the useful signal.
 */
export function describeBypass(actors: readonly StoredActor[], resolution?: Resolution): string {
  if (actors.length === 0) return 'nobody bypasses';
  const names = new Map<string, string>();
  for (const [key, value] of resolution ?? []) {
    if (typeof value === 'number') names.set(`${key.split(':')[0] ?? ''}:${String(value)}`, key);
  }
  return `bypass: ${actors.map((actor) => describeActor(actor, names)).join(', ')}`;
}

/** The resolvable kind each actor type is looked up as. */
const ACTOR_KIND: Readonly<Partial<Record<BypassActorType, Resolvable['kind']>>> = {
  User: 'user',
  Team: 'team',
  Integration: 'app',
};

function describeActor(actor: StoredActor, names: ReadonlyMap<string, string>): string {
  const kind = ACTOR_KIND[actor.actor_type];
  const named =
    kind !== undefined && actor.actor_id !== null
      ? names.get(`${kind}:${String(actor.actor_id)}`)
      : undefined;
  const who =
    named ??
    (actor.actor_id === null ? actor.actor_type : `${actor.actor_type} ${String(actor.actor_id)}`);
  return actor.bypass_mode === 'always' ? who : `${who} (${actor.bypass_mode})`;
}

/**
 * The id to send for one actor.
 *
 * `DeployKey` stands for every deploy key at once and `OrganizationAdmin` has
 * its id documented as ignored, so both are sent as `null` — which is also why
 * neither is compared by id.
 */
function actorId(actor: DeclaredActor, resolution: Resolution): number | null | typeof UNREADABLE {
  if (actor.type === 'DeployKey' || actor.type === 'OrganizationAdmin') return null;
  if (actor.id !== undefined) return actor.id;
  if (!actor.resolvable) return null;
  return resolution.get(identityKey(actor.resolvable)) ?? null;
}

/**
 * How one actor is compared. The id is dropped for the two kinds that do not
 * have a meaningful one, because GitHub echoes back whatever it likes there
 * and a comparison on it would report a difference on every run.
 */
function actorSignature(actor: StoredActor): string {
  const identified = actor.actor_type === 'DeployKey' || actor.actor_type === 'OrganizationAdmin';
  return `${actor.actor_type}:${identified ? '' : String(actor.actor_id ?? '')}:${actor.bypass_mode}`;
}
