import { readFileSync } from 'node:fs';
import type { Octokit } from '@octokit/rest';
import { graphqlRequest } from './graphql.js';
import { blockedByPrerequisite, orderByDependency } from '../core/dependencies.js';
import { protectionBody } from '../core/branch-protection.js';
import { REVOKED, grantLevel, invitationLevel } from '../core/access.js';
import { labelBody, milestoneBody } from '../core/collections.js';
import { ORGANIZATION_FIELDS } from '../core/organization.js';
import { batchPropertyValues } from '../core/properties.js';
import { deletePropertySchema, putPropertySchema, setPropertyValues } from './client.js';
import type { RuleContext } from '../core/rulesets.js';
import { rulesetBody } from '../core/rulesets.js';
import type {
  AppliedChange,
  BranchProtectionPolicy,
  BranchProtectionSettings,
  Change,
  EnvironmentPolicy,
  ExistingRuleset,
  FilePolicy,
  LabelPolicy,
  MilestonePolicy,
  RulesetPolicy,
} from '../types/index.js';

export type { AppliedChange } from '../types/index.js';

/** Maps dotted plan keys to fields in the repository update body. */
const PATCH_FIELDS: Record<string, string> = {
  'features.issues': 'has_issues',
  'features.wiki': 'has_wiki',
  'features.projects': 'has_projects',
  'merge.allow_squash': 'allow_squash_merge',
  'merge.allow_merge_commit': 'allow_merge_commit',
  'merge.allow_rebase': 'allow_rebase_merge',
  'merge.allow_auto_merge': 'allow_auto_merge',
  'merge.allow_update_branch': 'allow_update_branch',
  'merge.delete_branch_on_merge': 'delete_branch_on_merge',
  'merge.squash_title': 'squash_merge_commit_title',
  'merge.squash_message': 'squash_merge_commit_message',
  'merge.merge_commit_title': 'merge_commit_title',
  'merge.merge_commit_message': 'merge_commit_message',
  'repo.description': 'description',
  'repo.homepage': 'homepage',
  'repo.allow_forking': 'allow_forking',
  'repo.web_commit_signoff_required': 'web_commit_signoff_required',
  'repo.visibility': 'visibility',
  'repo.template': 'is_template',
  'repo.name': 'name',
};

/**
 * Archiving is its own request rather than a field of the bundled one, because
 * its position matters: once it lands nothing else can be written, and until
 * it is undone nothing else can be written either. The planner puts the rest
 * of the run on the correct side of it; sending it in the same body as those
 * changes would leave GitHub to decide the order instead.
 */
const ARCHIVE_KEY = 'repo.archived';

/** Maps dotted plan keys to fields in the nested security settings object. */
const SECURITY_AND_ANALYSIS_FIELDS: Record<string, string> = {
  'security.secret_scanning': 'secret_scanning',
  'security.secret_scanning_push_protection': 'secret_scanning_push_protection',
};

/**
 * Maps dotted plan keys to fields of GitHub's `updateRepository` mutation, for
 * the settings its REST API cannot change at all.
 */
export const MUTATION_FIELDS: Record<string, string> = {
  'features.discussions': 'hasDiscussionsEnabled',
  'features.sponsorships': 'hasSponsorshipsEnabled',
  'features.pull_requests': 'hasPullRequestsEnabled',
  'repo.issue_creation': 'issueCreationPolicy',
  'repo.pull_request_creation': 'pullRequestCreationPolicy',
};

const UPDATE_REPOSITORY_MUTATION = `
  mutation UpdateRepositorySettings($input: UpdateRepositoryInput!) {
    updateRepository(input: $input) {
      repository { id }
    }
  }
`;

/**
 * Security toggles that are their own endpoint, enabled with PUT and disabled
 * with DELETE, with no request body either way.
 */
const PUT_DELETE_TOGGLES: Record<string, string> = {
  'security.vulnerability_alerts': '/repos/{owner}/{repo}/vulnerability-alerts',
  'security.automated_security_fixes': '/repos/{owner}/{repo}/automated-security-fixes',
  'security.private_vulnerability_reporting':
    '/repos/{owner}/{repo}/private-vulnerability-reporting',
  'security.immutable_releases': '/repos/{owner}/{repo}/immutable-releases',
};

/**
 * Apply every change `plan` found for one repository that is not blocked.
 *
 * Grouped by the endpoint each key actually belongs to, not one call per
 * setting: everything that fits in the repository PATCH body — features,
 * merge options, description, homepage, and the two security_and_analysis
 * toggles, which GitHub nests inside the same PATCH rather than exposing
 * separately — goes in a single request. Enabling five such settings costs
 * one API call, not five. Everything else has an endpoint of its own.
 *
 * Each group succeeds or fails together: if the one PATCH request for a
 * repository's settings fails, every change bundled into it is reported as
 * failed with the same reason, since none of them actually happened.
 *
 * Order is deliberate where it matters. The default branch is renamed before
 * anything that could name a branch, so a ruleset or a seeded file lands
 * against the name the configuration actually declares. Unarchiving comes
 * before everything, and archiving after everything, because on either side of
 * those the repository accepts no writes at all.
 */
export async function applyRepoChanges(
  octokit: Octokit,
  owner: string,
  repo: string,
  planned: Change[],
): Promise<AppliedChange[]> {
  const results: AppliedChange[] = [];
  const changes = orderByDependency(planned);
  const failed = new Set<string>();

  /**
   * Record an outcome, remembering a failure so anything depending on it can
   * be stopped before it is sent.
   */
  const record = (result: AppliedChange): void => {
    if (result.outcome !== 'applied') failed.add(result.id);
    results.push(result);
  };

  /**
   * Whether this change was stopped by something that already failed. The
   * blocked result is recorded here so the caller sees one entry per planned
   * change either way.
   */
  const stopped = (change: Change): boolean => {
    const reason = blockedByPrerequisite(change, failed);
    if (reason === undefined) return false;
    record({ ...change, outcome: 'blocked', error: reason });
    return true;
  };

  const archive = changes.find((change) => change.key === ARCHIVE_KEY);
  if (archive?.to === false) {
    record(await attempt(archive, () => setArchived(octokit, owner, repo, false)));
  }

  const patchBody: Record<string, unknown> = {};
  const securityAndAnalysis: Record<string, { status: 'enabled' | 'disabled' }> = {};
  const bundled: Change[] = [];

  for (const change of changes) {
    if (change.key === ARCHIVE_KEY) continue;
    const field = PATCH_FIELDS[change.key];
    if (field) {
      if (stopped(change)) continue;
      /**
       * A setting GitHub will not accept alone brings its companion with it.
       * A companion that is itself a planned change sets the same field from
       * its own branch of this loop; whichever arrives first wins, and both
       * carry the value the configuration declared, so the two agree.
       */
      for (const [key, value] of Object.entries(companionsOf(change))) {
        const companionField = PATCH_FIELDS[key];
        if (companionField && !(companionField in patchBody)) patchBody[companionField] = value;
      }
      patchBody[field] = change.to;
      bundled.push(change);
      continue;
    }
    const secField = SECURITY_AND_ANALYSIS_FIELDS[change.key];
    if (secField) {
      if (stopped(change)) continue;
      securityAndAnalysis[secField] = { status: change.to ? 'enabled' : 'disabled' };
      bundled.push(change);
    }
  }

  if (Object.keys(securityAndAnalysis).length > 0) {
    patchBody.security_and_analysis = securityAndAnalysis;
  }

  if (bundled.length > 0) {
    try {
      await octokit.request('PATCH /repos/{owner}/{repo}', { owner, repo, ...patchBody });
      for (const change of bundled) record({ ...change, outcome: 'applied' });
    } catch (error) {
      const message = describeError(error);
      for (const change of bundled) record({ ...change, outcome: 'failed', error: message });
    }
  }

  for (const result of await applyMutationSettings(octokit, changes, stopped)) record(result);

  const topics = changes.find((c) => c.key === 'repo.topics');
  if (topics && !stopped(topics)) {
    record(
      await attempt(topics, () =>
        octokit.request('PUT /repos/{owner}/{repo}/topics', {
          owner,
          repo,
          names: Array.isArray(topics.to) ? (topics.to as string[]) : [],
        }),
      ),
    );
  }

  for (const [key, path] of Object.entries(PUT_DELETE_TOGGLES)) {
    const change = changes.find((c) => c.key === key);
    if (!change || stopped(change)) continue;
    record(
      await attempt(change, () =>
        octokit.request(`${change.to ? 'PUT' : 'DELETE'} ${path}`, { owner, repo }),
      ),
    );
  }

  const codeScanning = changes.find((c) => c.key === 'security.code_scanning_default_setup');
  if (codeScanning && !stopped(codeScanning)) {
    record(
      await attempt(codeScanning, () =>
        octokit.request('PATCH /repos/{owner}/{repo}/code-scanning/default-setup', {
          owner,
          repo,
          state: codeScanning.to ? 'configured' : 'not-configured',
        }),
      ),
    );
  }

  const rename = changes.find((c) => c.key === 'default_branch.name');
  if (rename && !stopped(rename)) {
    const payload = rename.payload as { from: string; to: string } | undefined;
    record(
      await attempt(rename, async () => {
        if (!payload) throw new Error('no branch to rename from');
        await octokit.request('POST /repos/{owner}/{repo}/branches/{branch}/rename', {
          owner,
          repo,
          branch: payload.from,
          new_name: payload.to,
        });
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('ensure_branches.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as { branch: string; from: string } | undefined;
    record(
      await attempt(change, async () => {
        if (!payload?.from) throw new Error('no source branch to create from');
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner,
          repo,
          ref: `heads/${payload.from}`,
        });
        await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
          owner,
          repo,
          ref: `refs/heads/${payload.branch}`,
          sha: (data as { object: { sha: string } }).object.sha,
        });
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('access.users.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as
      { login: string; level: string; invitation?: number } | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no collaborator to change');
        const { login, level, invitation } = payload;

        if (level === REVOKED) {
          /**
           * An invitation is withdrawn through its own endpoint; removing the
           * collaborator would not touch one that has never been accepted.
           */
          if (invitation !== undefined) {
            await octokit.request('DELETE /repos/{owner}/{repo}/invitations/{invitation_id}', {
              owner,
              repo,
              invitation_id: invitation,
            });
            return;
          }
          await octokit.request('DELETE /repos/{owner}/{repo}/collaborators/{username}', {
            owner,
            repo,
            username: login,
          });
          return;
        }

        /**
         * Amending the pending invitation rather than re-sending it: the
         * second one would be refused, and cancelling to re-invite would throw
         * away an invitation somebody may be about to accept.
         */
        if (invitation !== undefined) {
          const amend: string = 'PATCH /repos/{owner}/{repo}/invitations/{invitation_id}';
          await octokit.request(amend, {
            owner,
            repo,
            invitation_id: invitation,
            permissions: invitationLevel(level),
          });
          return;
        }

        await octokit.request('PUT /repos/{owner}/{repo}/collaborators/{username}', {
          owner,
          repo,
          username: login,
          permission: grantLevel(level),
        });
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('access.teams.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as { slug: string; level: string } | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no team grant to change');
        const route =
          payload.level === REVOKED
            ? 'DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}'
            : 'PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}';
        await octokit.request(route, {
          org: owner,
          team_slug: payload.slug,
          owner,
          repo,
          ...(payload.level === REVOKED ? {} : { permission: grantLevel(payload.level) }),
        });
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('labels.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as { label: LabelPolicy; name?: string } | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no label to change');
        const { label, name } = payload;

        if (label.mode === 'absent') {
          await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
            owner,
            repo,
            name: name ?? label.name,
          });
          return;
        }

        if (name === undefined) {
          const create: string = 'POST /repos/{owner}/{repo}/labels';
          await octokit.request(create, { owner, repo, ...labelBody(label) });
          return;
        }

        await octokit.request('PATCH /repos/{owner}/{repo}/labels/{name}', {
          owner,
          repo,
          name,
          ...labelBody(label, name),
        });
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('milestones.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as { milestone: MilestonePolicy; number?: number } | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no milestone to change');
        const { milestone, number } = payload;

        if (milestone.mode === 'absent') {
          await octokit.request('DELETE /repos/{owner}/{repo}/milestones/{milestone_number}', {
            owner,
            repo,
            milestone_number: number ?? 0,
          });
          return;
        }

        const body = milestoneBody(milestone);

        if (number === undefined) {
          const create: string = 'POST /repos/{owner}/{repo}/milestones';
          await octokit.request(create, { owner, repo, ...body });
          return;
        }
        await octokit.request('PATCH /repos/{owner}/{repo}/milestones/{milestone_number}', {
          owner,
          repo,
          milestone_number: number,
          ...body,
        });
      }),
    );
  }

  const propertyChanges = changes.filter((c) => c.key.startsWith('properties.'));
  if (propertyChanges.length > 0) {
    const sending = propertyChanges.filter((change) => !stopped(change));
    for (const result of await applyPropertyValues(octokit, owner, sending)) record(result);
  }

  for (const change of changes.filter((c) => c.key.startsWith('environments.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as { environment: EnvironmentPolicy } | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no environment to create');
        const reviewers = await resolveReviewers(octokit, payload.environment.reviewers ?? []);
        await octokit.request('PUT /repos/{owner}/{repo}/environments/{environment_name}', {
          owner,
          repo,
          environment_name: payload.environment.name,
          reviewers,
        });
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('branch_protection.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as
      | { protection: BranchProtectionPolicy; existing?: BranchProtectionSettings | null }
      | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no protection to apply');
        const route: string = 'PUT /repos/{owner}/{repo}/branches/{branch}/protection';
        await octokit.request(route, {
          owner,
          repo,
          branch: payload.protection.branch,
          ...protectionBody(payload.protection, payload.existing),
        });
        /**
         * Required signatures is the one protection with an endpoint of its
         * own, and it is left alone unless the policy says something: sending
         * a `DELETE` for an undeclared key would turn silence into a removal.
         */
        const signatures = payload.protection.require_signatures;
        if (signatures === undefined) return;
        await octokit.request(
          `${signatures ? 'POST' : 'DELETE'} /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures`,
          { owner, repo, branch: payload.protection.branch },
        );
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('rulesets.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as
      | { ruleset: RulesetPolicy; id?: number; existing?: ExistingRuleset; context?: RuleContext }
      | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no ruleset to apply');
        const body = rulesetBody(payload.ruleset, payload.existing, payload.context);
        const route: string =
          payload.id === undefined
            ? 'POST /repos/{owner}/{repo}/rulesets'
            : 'PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}';
        await octokit.request(route, {
          owner,
          repo,
          ...(payload.id === undefined ? {} : { ruleset_id: payload.id }),
          ...body,
        });
      }),
    );
  }

  for (const change of changes.filter((c) => c.key.startsWith('files.'))) {
    if (stopped(change)) continue;
    const payload = change.payload as { file: FilePolicy } | undefined;
    record(
      await attempt(change, async () => {
        if (!payload) throw new Error('no file to seed');
        /**
         * Read as bytes. Decoding to a string first and encoding it back
         * replaces every byte that is not valid UTF-8, which quietly corrupts
         * anything that is not text — an icon, a font, a signature.
         */
        let content: Buffer;
        try {
          content = readFileSync(payload.file.from);
        } catch {
          throw new Error(`cannot read local file ${payload.file.from}`);
        }
        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
          owner,
          repo,
          path: payload.file.path,
          message: payload.file.message ?? `chore: add ${payload.file.path}`,
          content: content.toString('base64'),
          ...(payload.file.branch === undefined ? {} : { branch: payload.file.branch }),
        });
      }),
    );
  }

  if (archive?.to === true && !stopped(archive)) {
    record(await attempt(archive, () => setArchived(octokit, owner, repo, true)));
  }

  return results;
}

function setArchived(
  octokit: Octokit,
  owner: string,
  repo: string,
  archived: boolean,
): Promise<unknown> {
  return octokit.request('PATCH /repos/{owner}/{repo}', { owner, repo, archived });
}

/**
 * Send every GraphQL-only setting for one repository in a single mutation.
 *
 * Grouped for the same reason the repository PATCH is: they are fields of one
 * operation, so five of them cost one request. They succeed or fail together,
 * and the mutation is never retried — an ambiguous write is resolved by
 * observing, not by sending it again.
 *
 * The node id comes from the plan, which read it alongside the values it is
 * comparing against. A change that reached here without one was blocked at
 * planning time, so the guard here is a last resort rather than the report.
 */
async function applyMutationSettings(
  octokit: Octokit,
  changes: Change[],
  stopped: (change: Change) => boolean,
): Promise<AppliedChange[]> {
  const mutated = changes.filter(
    (change) => MUTATION_FIELDS[change.key] !== undefined && !stopped(change),
  );
  if (mutated.length === 0) return [];

  const input: Record<string, unknown> = {};
  for (const change of mutated) input[MUTATION_FIELDS[change.key] as string] = change.to;
  const repositoryId = mutated
    .map((change) => (change.payload as { repositoryId?: string } | undefined)?.repositoryId)
    .find((id): id is string => typeof id === 'string');

  if (!repositoryId) {
    return mutated.map((change) => ({
      ...change,
      outcome: 'failed',
      error: 'no repository node id to address the mutation to',
    }));
  }

  const outcome = await graphqlRequest(
    octokit,
    UPDATE_REPOSITORY_MUTATION,
    { input: { repositoryId, ...input } },
    { attempts: 0, wait: async () => {} },
  );

  if (outcome.failures.length > 0) {
    const reason = outcome.failures
      .map((failure) => `${failure.kind}: ${failure.message}`)
      .join('; ');
    return mutated.map((change) => ({ ...change, outcome: 'failed', error: reason }));
  }
  return mutated.map((change) => ({ ...change, outcome: 'applied' }));
}

/**
 * The environments endpoint identifies reviewers by numeric id, while a
 * configuration file sensibly names them by login. A login that does not
 * resolve fails the whole change rather than quietly creating an environment
 * with fewer reviewers than were asked for.
 */
async function resolveReviewers(
  octokit: Octokit,
  logins: string[],
): Promise<Array<{ type: 'User'; id: number }>> {
  const resolved: Array<{ type: 'User'; id: number }> = [];
  for (const login of logins) {
    try {
      const { data } = await octokit.request('GET /users/{username}', { username: login });
      resolved.push({ type: 'User', id: (data as { id: number }).id });
    } catch {
      throw new Error(`cannot resolve reviewer "${login}" to a GitHub user`);
    }
  }
  return resolved;
}

/**
 * Settings that must be sent alongside this one for GitHub to accept it, by
 * plan key. Empty for everything except the merge message defaults, which the
 * planner refuses outright when their companion was never declared — so a
 * change that reaches here either needs nothing or already carries it.
 */
function companionsOf(change: Change): Record<string, unknown> {
  const requires = (change.payload as { requires?: Record<string, unknown> } | undefined)?.requires;
  return requires ?? {};
}

async function attempt(change: Change, call: () => Promise<unknown>): Promise<AppliedChange> {
  try {
    await call();
    return { ...change, outcome: 'applied' };
  } catch (error) {
    return { ...change, outcome: 'failed', error: describeError(error) };
  }
}

function describeError(error: unknown): string {
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : String(error);
  return status ? `${status}: ${message}` : message;
}

/**
 * Apply every organisation change that is not blocked.
 *
 * The settings all live on one object and are written through one PATCH, so
 * that group succeeds or fails together — the same rule the repository
 * settings body already follows, and reported the same way, since none of them
 * happened if the request did not.
 *
 * Custom property definitions are the exception, and not by preference: each
 * one has its own endpoint. One request each also means one outcome each,
 * which is worth having for an operation that replaces a definition wholesale.
 */
export async function applyOrganizationChanges(
  octokit: Octokit,
  owner: string,
  planned: Change[],
): Promise<AppliedChange[]> {
  const changes = planned.filter((change) => change.key.startsWith('organization.'));
  if (changes.length === 0) return [];

  const settings = changes.filter((change) => ORGANIZATION_FIELDS[change.key] !== undefined);
  const definitions = changes.filter((change) => change.key.startsWith('organization.properties.'));

  const results: AppliedChange[] = [];

  if (settings.length > 0) {
    const body: Record<string, unknown> = {};
    for (const change of settings) body[ORGANIZATION_FIELDS[change.key] as string] = change.to;
    try {
      await octokit.request('PATCH /orgs/{org}', { org: owner, ...body });
      results.push(...settings.map((change) => ({ ...change, outcome: 'applied' as const })));
    } catch (error) {
      const message = describeError(error);
      results.push(
        ...settings.map((change) => ({ ...change, outcome: 'failed' as const, error: message })),
      );
    }
  }

  for (const change of definitions) {
    const payload = change.payload as
      { property: string; body?: Record<string, unknown>; remove?: boolean } | undefined;
    results.push(
      await attempt(change, async () => {
        if (!payload) throw new Error('no property definition to write');
        if (payload.remove) {
          await deletePropertySchema(octokit, owner, payload.property);
          return;
        }
        await putPropertySchema(octokit, owner, payload.property, payload.body ?? {});
      }),
    );
  }

  return results;
}

/**
 * Set custom property values, spending as few requests as the endpoints allow.
 *
 * A group of repositories asking for the same values goes through the
 * organisation's endpoint, which takes thirty at a time. A single repository
 * goes through its own, which needs only that repository's permission — there
 * is nothing to save by reaching for the wider one when the request count is
 * the same either way.
 *
 * A shared request has a shared outcome. GitHub does not say which repository
 * it refused, so every repository in a failed batch is reported failed with
 * the same message rather than octoform inventing an attribution.
 */
export async function applyPropertyValues(
  octokit: Octokit,
  owner: string,
  planned: Change[],
): Promise<AppliedChange[]> {
  const changes = planned.filter((change) => change.key.startsWith('properties.'));
  if (changes.length === 0) return [];

  const results: AppliedChange[] = [];
  for (const batch of batchPropertyValues(changes)) {
    const single = batch.repositories.length === 1 ? batch.repositories[0] : undefined;
    try {
      if (single !== undefined) {
        await octokit.request('PATCH /repos/{owner}/{repo}/properties/values', {
          owner,
          repo: single,
          properties: batch.properties,
        });
      } else {
        await setPropertyValues(octokit, owner, batch.repositories, batch.properties);
      }
      results.push(...batch.changes.map((change) => ({ ...change, outcome: 'applied' as const })));
    } catch (error) {
      const message =
        batch.repositories.length === 1
          ? describeError(error)
          : `${describeError(error)} (one request covering ${batch.repositories.length} repositories)`;
      results.push(
        ...batch.changes.map((change) => ({
          ...change,
          outcome: 'failed' as const,
          error: message,
        })),
      );
    }
  }
  return results;
}
