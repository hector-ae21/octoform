import { Octokit } from '@octokit/rest';
import { UNREADABLE } from '../config/sentinels.js';
import { capability, errorMessage, errorStatus } from './capabilities.js';
import { graphqlRequest, valueOrUnreadable } from './graphql.js';
import { readProtection } from '../core/branch-protection.js';
import { readRuleset } from '../core/rulesets.js';
import { identityKey, namesToResolve } from '../core/identity.js';
import { CHANGED_BY_MUTATION } from '../core/plan.js';
import type {
  BranchProtectionSettings,
  CapabilityResult,
  ExistingEnvironment,
  ExistingRuleset,
  OwnerDiscovery,
  OwnerKind,
  PlanLimits,
  PolicySet,
  RateLimitStatus,
  RepoDetail,
  RepoState,
  RepoStructure,
  Resolution,
  Resolvable,
  SettingValue,
  TokenProvider,
} from '../types/index.js';

export type {
  CapabilityResult,
  OwnerDiscovery,
  PlanLimits,
  RateLimitStatus,
} from '../types/index.js';

/** The GitHub REST API version octoform is written against. */
export const REST_API_VERSION = '2022-11-28';

/** Authentication or token-scope error that can be corrected by the operator. */
export class AuthError extends Error {}

/** Create an authenticated GitHub client from `GITHUB_TOKEN` or `GH_TOKEN`. */
/**
 * Resolves in order: a token or {@link TokenProvider} passed explicitly,
 * `GITHUB_TOKEN`, then `GH_TOKEN`. Nothing else is searched — not shell
 * history, not a git credential store, not an unrelated environment
 * variable — so where the token came from is always one of these three
 * places, never a guess.
 */
export function createClient(token?: string | TokenProvider): Octokit {
  const supplied = typeof token === 'function' ? token() : token;
  const resolved = supplied ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!resolved) {
    throw new AuthError(
      'No token found. Pass one explicitly, or set GITHUB_TOKEN or GH_TOKEN, to a token with ' +
        '"repo" and, for organisation custom properties and rulesets, "admin:org".',
    );
  }
  return new Octokit({
    auth: resolved,
    userAgent: 'octoform',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    request: { headers: { 'x-github-api-version': REST_API_VERSION } },
  });
}

/**
 * Fail early and legibly on a missing scope, and return the core rate-limit
 * budget this same response already carried.
 *
 * Without the scope check, the first call that needs `admin:org` returns a
 * bare 403 whose message says nothing about which scope is missing, which is
 * the single most common way to get stuck when setting this up. The rate
 * limit is read from this request's own headers rather than a dedicated one:
 * every authenticated GitHub response carries it for free, so a second
 * request to ask the same question would only spend more of the budget it is
 * trying to report on.
 */
export async function requireScopes(octokit: Octokit, needed: string[]): Promise<RateLimitStatus> {
  const res = await octokit.request('GET /user');
  const header = res.headers['x-oauth-scopes'];

  if (typeof header === 'string') {
    const granted = header
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const missing = needed.filter((scope) => !granted.includes(scope));
    if (missing.length > 0) {
      throw new AuthError(
        `Token is missing the ${missing.join(', ')} scope(s). ` +
          `Run: gh auth refresh -h github.com -s ${missing.join(',')}`,
      );
    }
  }

  return rateLimitFromHeaders(res.headers);
}

function rateLimitFromHeaders(headers: Record<string, unknown>): RateLimitStatus {
  const asNumber = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    remaining: asNumber(headers['x-ratelimit-remaining']),
    limit: asNumber(headers['x-ratelimit-limit']),
    reset: asNumber(headers['x-ratelimit-reset']),
  };
}

/**
 * A one-line warning when the core rate-limit budget is low enough to
 * threaten the rest of the run, or `undefined` when there is nothing to say.
 *
 * A run against several owners can spend its budget on the first few and fail
 * partway through the rest with a bare `403`; surfacing the remaining budget
 * up front, while there is still time to wait for the reset or narrow the
 * selection, is more useful than discovering it from a failure later.
 */
export function rateLimitWarning(status: RateLimitStatus): string | undefined {
  if (status.remaining === undefined || !status.limit) return undefined;
  if (status.remaining > status.limit * 0.1) return undefined;

  const resetAt =
    status.reset !== undefined ? new Date(status.reset * 1000).toISOString() : 'an unknown time';
  return `only ${status.remaining}/${status.limit} API requests remain; resets at ${resetAt}`;
}

const ownerDiscoveries = new WeakMap<Octokit, Map<string, Promise<OwnerDiscovery>>>();

/**
 * Resolve what an owner login actually is: an organisation or a personal
 * account, and GitHub's numeric identity for it.
 *
 * Kind is asked of the API rather than declared in configuration, because an
 * org and a user can share a login and configuration is the wrong place to
 * get that wrong. The numeric id is the identity that survives a rename;
 * addressing an owner by it elsewhere is how two logins that briefly collide
 * during a rename cannot be confused with each other.
 *
 * The answer is remembered for the life of the client, keyed by login. A run
 * that governs several owners asks about each of them from more than one
 * place — `detectOwnerKind` below shares this same cache — and an account
 * does not stop being an organisation halfway through a run. Nothing is
 * written outside the process, and a fresh client asks again.
 */
export async function discoverOwner(octokit: Octokit, owner: string): Promise<OwnerDiscovery> {
  const known = ownerDiscoveries.get(octokit) ?? new Map<string, Promise<OwnerDiscovery>>();
  ownerDiscoveries.set(octokit, known);
  const cached = known.get(owner);
  if (cached) return cached;

  const pending = requestOwnerDiscovery(octokit, owner);
  known.set(owner, pending);
  try {
    return await pending;
  } catch (error) {
    known.delete(owner);
    throw error;
  }
}

/** The owner kind alone, for callers that have no use for the numeric identity. */
export async function detectOwnerKind(octokit: Octokit, owner: string): Promise<OwnerKind> {
  return (await discoverOwner(octokit, owner)).kind;
}

async function requestOwnerDiscovery(octokit: Octokit, owner: string): Promise<OwnerDiscovery> {
  try {
    const { data } = await octokit.request('GET /orgs/{org}', { org: owner });
    return { login: owner, kind: 'org', id: data.id };
  } catch (error) {
    if (errorStatus(error) !== 404) throw error;
  }
  const { data } = await octokit.request('GET /users/{username}', { username: owner });
  return { login: owner, kind: 'user', id: data.id };
}

/**
 * The authenticated token's own login, or undefined for a token type that
 * does not expose one. Used to tell "manage my own account" (which can see
 * private repositories, via /user/repos) apart from "look at someone else's
 * public profile" (which never can, no matter whose token is used).
 */
export async function authenticatedLogin(octokit: Octokit): Promise<string | undefined> {
  try {
    const { data } = await octokit.users.getAuthenticated();
    return data.login;
  } catch {
    return undefined;
  }
}

/** List repositories owned by an organization or personal account. */
export async function listRepos(
  octokit: Octokit,
  owner: string,
  kind: OwnerKind,
): Promise<RepoState[]> {
  let raw: Array<{
    name: string;
    visibility?: string;
    private?: boolean;
    archived?: boolean;
    default_branch?: string;
    description?: string | null;
    homepage?: string | null;
    topics?: string[];
  }>;

  if (kind === 'org') {
    raw = await octokit.paginate(octokit.repos.listForOrg, {
      org: owner,
      per_page: 100,
      type: 'all',
    });
  } else {
    const me = await authenticatedLogin(octokit);
    raw =
      me && me.toLowerCase() === owner.toLowerCase()
        ? await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
            per_page: 100,
            affiliation: 'owner',
          })
        : await octokit.paginate(octokit.repos.listForUser, {
            username: owner,
            per_page: 100,
            type: 'owner',
          });
  }

  return raw.map((r) => ({
    name: r.name,
    visibility: (r.visibility ?? (r.private ? 'private' : 'public')) as RepoState['visibility'],
    archived: r.archived ?? false,
    default_branch: r.default_branch ?? '',
    description: r.description ?? null,
    homepage: r.homepage ?? null,
    topics: r.topics ?? [],
  }));
}

/**
 * Everything `plan` compares against, flattened into the same dotted keys the
 * configuration uses. Gathered per repository, because most of it is not in
 * the account-wide listing and some of it has an endpoint of its own.
 *
 * Owner-agnostic: `GET /repos/{owner}/{repo}` and everything else called here
 * answer the same way whether `owner` is an organisation or a person.
 */
export async function getRepoDetail(
  octokit: Octokit,
  owner: string,
  base: RepoState,
  policy?: PolicySet,
): Promise<RepoDetail> {
  const { data } = await octokit.repos.get({ owner, repo: base.name });
  const analysis = (
    data as { security_and_analysis?: Record<string, { status?: string } | undefined> }
  ).security_and_analysis;
  const enabled = (key: string): boolean | typeof UNREADABLE => {
    const status = analysis?.[key]?.status;
    return status === undefined ? UNREADABLE : status === 'enabled';
  };

  const settings: RepoDetail['settings'] = {
    'features.issues': data.has_issues ?? null,
    'features.wiki': data.has_wiki ?? null,
    'features.projects': data.has_projects ?? null,
    'features.discussions': (data as { has_discussions?: boolean }).has_discussions ?? null,

    'merge.allow_squash': data.allow_squash_merge ?? null,
    'merge.allow_merge_commit': data.allow_merge_commit ?? null,
    'merge.allow_rebase': data.allow_rebase_merge ?? null,
    'merge.allow_auto_merge': data.allow_auto_merge ?? null,
    'merge.allow_update_branch': data.allow_update_branch ?? null,
    'merge.delete_branch_on_merge': data.delete_branch_on_merge ?? null,
    'merge.squash_title': data.squash_merge_commit_title ?? null,
    'merge.squash_message': data.squash_merge_commit_message ?? null,
    'merge.merge_commit_title': data.merge_commit_title ?? null,
    'merge.merge_commit_message': data.merge_commit_message ?? null,

    'repo.description': data.description ?? null,
    'repo.homepage': data.homepage ?? null,
    'repo.topics': data.topics ?? [],
    'repo.name': data.name,
    'repo.visibility': data.visibility ?? (data.private ? 'private' : 'public'),
    'repo.archived': data.archived ?? null,
    'repo.template': (data as { is_template?: boolean }).is_template ?? null,
    'repo.allow_forking': data.allow_forking ?? null,
    'repo.web_commit_signoff_required':
      (data as { web_commit_signoff_required?: boolean }).web_commit_signoff_required ?? null,

    'security.secret_scanning': enabled('secret_scanning'),
    'security.secret_scanning_push_protection': enabled('secret_scanning_push_protection'),
  };

  const [alerts, codeScanning, autoFixes, privateReporting, immutableReleases] = await Promise.all([
    probe(octokit, 'GET /repos/{owner}/{repo}/vulnerability-alerts', owner, base.name),
    codeScanningState(octokit, owner, base.name),
    enabledFlag(octokit, 'GET /repos/{owner}/{repo}/automated-security-fixes', owner, base.name),
    enabledFlag(
      octokit,
      'GET /repos/{owner}/{repo}/private-vulnerability-reporting',
      owner,
      base.name,
    ),
    immutableReleasesState(octokit, owner, base.name),
  ]);
  settings['security.vulnerability_alerts'] = alerts;
  settings['security.code_scanning_default_setup'] = codeScanning;
  settings['security.automated_security_fixes'] = autoFixes;
  settings['security.private_vulnerability_reporting'] = privateReporting;
  settings['security.immutable_releases'] = immutableReleases.enabled;

  const enforced: Record<string, string> = {};
  if (immutableReleases.enforcedByOwner) {
    enforced['security.immutable_releases'] =
      `${owner} enforces immutable releases across its repositories`;
  }

  const graphql =
    policy && needsGraphql(policy)
      ? await readGraphqlSettings(octokit, owner, base.name)
      : { settings: {} };
  Object.assign(settings, graphql.settings);

  const structure = policy ? await getRepoStructure(octokit, owner, base, policy) : undefined;

  return {
    ...base,
    settings,
    ...(graphql.nodeId ? { nodeId: graphql.nodeId } : {}),
    ...(Object.keys(enforced).length > 0 ? { enforced } : {}),
    ...(structure ? { structure } : {}),
  };
}

/**
 * Whether the current owner plan and token can manage rulesets on one private
 * repository.
 *
 * GitHub exposes no direct "can manage private rulesets" capability. Branch
 * protection has the same plan availability as repository rulesets, however,
 * and its read-only endpoint distinguishes an unprotected branch from a plan
 * or permission failure: 404 "Branch not protected" means the feature is
 * available but unused, while 403 means this owner/token combination cannot
 * manage it. A generic 404 is deliberately not treated as proof of either,
 * since GitHub also uses opaque 404s when a token cannot see a resource at
 * all — that case is reported `unknown`, not guessed at.
 */
export async function detectRulesetCapability(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<CapabilityResult> {
  if (!defaultBranch) {
    return capability('unknown', 'the repository has no default branch to probe', 'resource-state');
  }

  try {
    await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: defaultBranch,
    });
    return capability('supported', 'branch protection is readable for this repository', 'endpoint');
  } catch (error) {
    const status = errorStatus(error);
    const message = errorMessage(error);

    if (status === 404 && /^branch not protected$/i.test(message.trim())) {
      return capability(
        'supported',
        'the endpoint answered; this branch simply has no protection configured yet',
        'endpoint',
      );
    }
    if (status === 404) {
      return capability(
        'unknown',
        'GitHub returned an unexplained 404 for branch protection',
        'endpoint',
      );
    }
    if (status === 403) {
      return capability(
        'forbidden',
        'the current owner plan and token cannot manage rulesets on private repositories',
        'permission',
      );
    }
    throw error;
  }
}

/**
 * Gather only what this repository's policy actually asks about.
 *
 * Each of these costs at least one request, several cost one per declared
 * item, and most repositories declare none of them — so nothing here is
 * fetched speculatively. Every field is left `undefined` when it could not be
 * read, which `plan` reports as blocked rather than treating as "absent".
 */
async function getRepoStructure(
  octokit: Octokit,
  owner: string,
  base: RepoState,
  policy: PolicySet,
): Promise<RepoStructure | undefined> {
  const structure: RepoStructure = {};
  let asked = false;

  if (policy.environments?.length) {
    asked = true;
    structure.environments = await listEnvironments(octokit, owner, base.name);
  }

  if (policy.rulesets?.length) {
    asked = true;
    structure.rulesets = await listRulesets(octokit, owner, base.name);
    const names = namesToResolve(policy, `${owner}/${base.name}`);
    if (names.length > 0) structure.resolved = await resolveIdentities(octokit, owner, names);
  }

  if (policy.branch_protection?.length) {
    asked = true;
    const entries = await Promise.all(
      policy.branch_protection.map(
        async (declared) =>
          [
            declared.branch,
            await readBranchProtection(octokit, owner, base.name, declared.branch),
          ] as const,
      ),
    );
    if (entries.every(([, protection]) => protection !== UNREADABLE)) {
      /** A branch that does not exist is left out, not recorded as unprotected. */
      structure.branchProtection = Object.fromEntries(
        entries.filter(
          (entry): entry is readonly [string, BranchProtectionSettings | null] =>
            entry[1] !== undefined && entry[1] !== UNREADABLE,
        ),
      );
    }
  }

  if (policy.ensure_branches?.length) {
    asked = true;
    const entries = await Promise.all(
      policy.ensure_branches.map(async (branch) => {
        const exists = await probe(
          octokit,
          'GET /repos/{owner}/{repo}/branches/{branch}',
          owner,
          base.name,
          {
            branch,
          },
        );
        return [branch, exists] as const;
      }),
    );
    if (entries.every(([, exists]) => exists !== UNREADABLE)) {
      structure.branches = Object.fromEntries(entries as Array<readonly [string, boolean]>);
    }
  }

  if (policy.files?.length) {
    asked = true;
    const entries = await Promise.all(
      policy.files.map(async (file) => {
        const exists = await probe(
          octokit,
          'GET /repos/{owner}/{repo}/contents/{path}',
          owner,
          base.name,
          {
            path: file.path,
          },
        );
        return [file.path, exists] as const;
      }),
    );
    if (entries.every(([, exists]) => exists !== UNREADABLE)) {
      structure.files = Object.fromEntries(entries as Array<readonly [string, boolean]>);
    }
  }

  const wantedBranch = policy.default_branch?.name;
  if (wantedBranch && base.default_branch && wantedBranch !== base.default_branch) {
    asked = true;
    structure.workflowsNamingDefaultBranch = await workflowsNaming(
      octokit,
      owner,
      base.name,
      base.default_branch,
    );
  }

  /**
   * Only worth a request when a policy would switch the default setup on.
   * Turning it off cannot disable a workflow, and leaving it alone changes
   * nothing either way.
   */
  if (policy.security?.code_scanning_default_setup === true) {
    asked = true;
    structure.workflowsUploadingCodeScanning = await workflowsMatching(
      octokit,
      owner,
      base.name,
      /github\/codeql-action\/(analyze|upload-sarif)/,
    );
  }

  return asked ? structure : undefined;
}

interface RawEnvironment {
  name: string;
  protection_rules?: Array<{
    type: string;
    reviewers?: Array<{ type: string; reviewer?: { login?: string } }>;
  }>;
}

async function listEnvironments(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<ExistingEnvironment[] | undefined> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/environments', {
      owner,
      repo,
    });
    const list = (data as { environments?: RawEnvironment[] }).environments ?? [];
    return list.map((e) => ({ name: e.name, reviewers: reviewerLogins(e) }));
  } catch {
    return undefined;
  }
}

/**
 * Only `User`-type required reviewers, by login. `Team` reviewers exist on
 * the same GitHub feature but are not modeled here: `apply`'s
 * `resolveReviewers` only ever resolves a declared reviewer to a user id, so
 * a team it did not create can be neither compared against nor written by
 * it. Their presence turns the whole field `UNREADABLE` instead of silently
 * reporting "no reviewers" — see the type's own doc comment for why.
 */
function reviewerLogins(environment: RawEnvironment): string[] | typeof UNREADABLE {
  const rule = environment.protection_rules?.find((r) => r.type === 'required_reviewers');
  const reviewers = rule?.reviewers ?? [];
  if (reviewers.some((r) => r.type !== 'User')) return UNREADABLE;
  return reviewers.map((r) => r.reviewer?.login).filter((login): login is string => Boolean(login));
}

/**
 * Classic protection on one branch.
 *
 * `null` is a branch with no protection, which GitHub answers with a 404
 * carrying the message "Branch not protected" — the same distinction
 * `detectRulesetCapability` relies on. Any other failure is `UNREADABLE`,
 * including an unexplained 404, because a branch nobody can see is not a
 * branch nobody protected. A branch that does not exist is left out of the
 * map entirely, which the planner reports separately.
 */
async function readBranchProtection(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<BranchProtectionSettings | null | typeof UNREADABLE | undefined> {
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/branches/{branch}/protection',
      { owner, repo, branch },
    );
    return readProtection(data as Parameters<typeof readProtection>[0]);
  } catch (error) {
    if (errorStatus(error) !== 404) return UNREADABLE;
    if (/^branch not protected$/i.test(errorMessage(error).trim())) return null;
    return (await probe(octokit, 'GET /repos/{owner}/{repo}/branches/{branch}', owner, repo, {
      branch,
    })) === false
      ? undefined
      : UNREADABLE;
  }
}

/**
 * Repository rulesets, reduced to the rules octoform models.
 *
 * The list endpoint returns summaries with no rules in them, so each ruleset
 * has to be fetched again by id to see what it actually enforces. That is one
 * extra request per existing ruleset, which is why this only runs for a
 * repository whose policy declares at least one.
 */
async function listRulesets(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<ExistingRuleset[] | undefined> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner, repo });
    const summaries = data as Array<{ id: number; name: string }>;

    const full = await Promise.all(
      summaries.map(async (summary) => {
        const res = await octokit.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
          owner,
          repo,
          ruleset_id: summary.id,
        });
        return readRuleset(res.data as Parameters<typeof readRuleset>[0]);
      }),
    );
    return full;
  } catch {
    return undefined;
  }
}

/**
 * Look up every name a ruleset policy has to send as a number.
 *
 * Done while reading so that a name nobody can find is a blocked line in the
 * plan rather than an exception raised mid-apply, and so that a team named by
 * three rulesets costs one request rather than three.
 *
 * The three answers stay apart on purpose: an id, `null` for a name GitHub
 * does not know, and `UNREADABLE` for a lookup that failed. Reading the last
 * as the middle one would report a perfectly good team as nonexistent because
 * a request timed out.
 */
async function resolveIdentities(
  octokit: Octokit,
  owner: string,
  names: readonly Resolvable[],
): Promise<Resolution> {
  const entries = await Promise.all(
    names.map(
      async (resolvable) =>
        [identityKey(resolvable), await lookupIdentity(octokit, owner, resolvable)] as const,
    ),
  );
  return new Map(entries);
}

async function lookupIdentity(
  octokit: Octokit,
  owner: string,
  resolvable: Resolvable,
): Promise<number | null | typeof UNREADABLE> {
  const [route, parameters] = identityRequest(owner, resolvable);
  try {
    const { data } = await octokit.request(route, parameters);
    const id = (data as { id?: unknown }).id;
    return typeof id === 'number' ? id : UNREADABLE;
  } catch (error) {
    return errorStatus(error) === 404 ? null : UNREADABLE;
  }
}

function identityRequest(owner: string, resolvable: Resolvable): [string, Record<string, string>] {
  switch (resolvable.kind) {
    case 'user':
      return ['GET /users/{username}', { username: resolvable.name }];
    case 'team':
      return ['GET /orgs/{org}/teams/{team_slug}', { org: owner, team_slug: resolvable.name }];
    case 'app':
      return ['GET /apps/{app_slug}', { app_slug: resolvable.name }];
    case 'repository': {
      const [repoOwner = owner, repoName = resolvable.name] = resolvable.name.split('/');
      return ['GET /repos/{owner}/{repo}', { owner: repoOwner, repo: repoName }];
    }
  }
}

/**
 * Workflow files that mention a branch name. Used to warn before a rename,
 * since `on: push: branches: [old-name]` keeps parsing fine and simply stops
 * matching anything — a failure mode with no error message attached to it.
 */
async function workflowsNaming(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string[] | undefined> {
  return await workflowsMatching(octokit, owner, repo, new RegExp(`\\b${escapeRegExp(branch)}\\b`));
}

/**
 * Workflow files whose text matches a pattern.
 *
 * A repository's workflows are the one place octoform can see a consequence
 * that GitHub will not report: a change to repository settings can stop a
 * workflow doing its job without either of them failing. Reading them is how
 * a warning gets evidence instead of being a guess.
 *
 * `undefined` means the workflows could not be read, which is not the same as
 * there being none — a caller has to keep those apart, the same way an
 * unreadable setting is kept apart from an absent one. A repository with no
 * workflows directory answers `404`, and that genuinely is none.
 */
async function workflowsMatching(
  octokit: Octokit,
  owner: string,
  repo: string,
  pattern: RegExp,
): Promise<string[] | undefined> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: '.github/workflows',
    });
    const entries = data as Array<{ name: string; path: string; type: string }>;
    const files = entries.filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name));

    const matching = await Promise.all(
      files.map(async (file) => {
        try {
          const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner,
            repo,
            path: file.path,
          });
          const content = (res.data as { content?: string }).content ?? '';
          const text = Buffer.from(content, 'base64').toString('utf8');
          return pattern.test(text) ? file.path : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return matching.filter((path): path is string => path !== undefined);
  } catch (error) {
    if (errorStatus(error) === 404) return [];
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Endpoints that answer with a bare 204/404 rather than a body. `UNREADABLE`
 * means the answer could not be read at all, which is different from "off"
 * and must not be planned as a change.
 */
async function probe(
  octokit: Octokit,
  route: string,
  owner: string,
  repo: string,
  extra: Record<string, string> = {},
): Promise<boolean | typeof UNREADABLE> {
  try {
    await octokit.request(route, { owner, repo, ...extra });
    return true;
  } catch (error) {
    const status = errorStatus(error);
    if (status === 404) return false;
    return UNREADABLE;
  }
}

/**
 * Endpoints that answer 200 with `{ enabled: boolean }` rather than encoding
 * the answer in the status code. A 404 from one of these is not "disabled" —
 * it means the endpoint was not reachable for this repository at all, which is
 * exactly the case `UNREADABLE` exists for.
 */
async function enabledFlag(
  octokit: Octokit,
  route: string,
  owner: string,
  repo: string,
): Promise<boolean | typeof UNREADABLE> {
  try {
    const { data } = await octokit.request(route, { owner, repo });
    const enabled = (data as { enabled?: boolean }).enabled;
    return typeof enabled === 'boolean' ? enabled : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/**
 * Settings GitHub exposes on its GraphQL API and nowhere else, with the field
 * each one is read from.
 *
 * `features.discussions` is deliberately absent: the REST repository response
 * already carries it, and reading it here as well would make a failed GraphQL
 * request turn a value that was in hand into an unreadable one. Only its
 * *write* needs GraphQL, which is what {@link RepoDetail.nodeId} is for.
 */
const GRAPHQL_ONLY_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['features.sponsorships', 'hasSponsorshipsEnabled'],
  ['features.pull_requests', 'hasPullRequestsEnabled'],
  ['repo.issue_creation', 'issueCreationPolicy'],
  ['repo.pull_request_creation', 'pullRequestCreationPolicy'],
];

const REPOSITORY_SETTINGS_QUERY = `
  query RepositorySettings($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      ${GRAPHQL_ONLY_SETTINGS.map(([, field]) => field).join('\n      ')}
    }
  }
`;

interface GraphqlRepositorySettings {
  repository: ({ id: string } & Record<string, unknown>) | null;
}

/**
 * The settings only GraphQL knows about, plus the node identity its mutation
 * needs, in one request.
 *
 * Asked for only when a policy manages one of them, because most repositories
 * declare none and the request costs the same either way. Every field narrows
 * to `UNREADABLE` on failure, exactly as a REST read does, so the planner
 * blocks it for the same reason and reports it the same way — which is the
 * whole point of the normalized transport.
 */
async function readGraphqlSettings(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<{ nodeId?: string; settings: Record<string, SettingValue> }> {
  const outcome = await graphqlRequest<GraphqlRepositorySettings>(
    octokit,
    REPOSITORY_SETTINGS_QUERY,
    { owner, name: repo },
  );

  const settings: Record<string, SettingValue> = {};
  for (const [key, field] of GRAPHQL_ONLY_SETTINGS) {
    const value = valueOrUnreadable(
      outcome,
      `repository.${field}`,
      (data) => data.repository?.[field],
    );
    settings[key] =
      value === UNREADABLE || typeof value === 'boolean' || typeof value === 'string'
        ? (value as SettingValue)
        : UNREADABLE;
  }

  const id = valueOrUnreadable(outcome, 'repository.id', (data) => data.repository?.id);
  return { ...(typeof id === 'string' ? { nodeId: id } : {}), settings };
}

/**
 * Whether a policy manages anything that has to be changed through GraphQL,
 * and therefore needs the repository's node identity read alongside it.
 */
function needsGraphql(policy: PolicySet): boolean {
  return [...CHANGED_BY_MUTATION].some((key) => {
    const [group = '', name = ''] = key.split('.');
    const declared = (policy as unknown as Record<string, Record<string, unknown> | undefined>)[
      group
    ];
    return declared?.[name] !== undefined && declared?.[name] !== null;
  });
}

/**
 * Whether published releases are immutable, and whether the owner is the one
 * deciding that.
 *
 * The same response answers both, so the enforcement half is free: an owner
 * that enforces immutable releases leaves the repository able to read the
 * setting but not to turn it off. Reporting that as a blocked change is only
 * possible because it is read here rather than discovered from a rejected
 * request.
 */
async function immutableReleasesState(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<{ enabled: boolean | typeof UNREADABLE; enforcedByOwner: boolean }> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/immutable-releases', {
      owner,
      repo,
    });
    const answer = data as { enabled?: boolean; enforced_by_owner?: boolean };
    return {
      enabled: typeof answer.enabled === 'boolean' ? answer.enabled : UNREADABLE,
      enforcedByOwner: answer.enforced_by_owner === true,
    };
  } catch {
    return { enabled: UNREADABLE, enforcedByOwner: false };
  }
}

async function codeScanningState(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<boolean | typeof UNREADABLE> {
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/code-scanning/default-setup',
      { owner, repo },
    );
    return (data as { state?: string }).state === 'configured';
  } catch {
    return UNREADABLE;
  }
}

/**
 * Read one custom property for every repository in the organisation.
 *
 * Custom properties are an organisation-only feature: callers should not
 * invoke this for a personal account at all, since there is nothing to read
 * there, not even an empty result. It still degrades to an empty map on a
 * 403/404 from an organisation whose plan does not offer the feature, so that
 * classification falls back to the configuration file instead of the whole
 * run failing.
 */
export async function readPropertyValues(
  octokit: Octokit,
  org: string,
  property: string,
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  try {
    const pages = await octokit.paginate('GET /orgs/{org}/properties/values', {
      org,
      per_page: 100,
    });
    for (const entry of pages as Array<{
      repository_name: string;
      properties: Array<{ property_name: string; value: string | null }>;
    }>) {
      const match = entry.properties?.find((p) => p.property_name === property);
      if (match?.value) values.set(entry.repository_name, match.value);
    }
  } catch (error) {
    const status = errorStatus(error);
    if (status === 403 || status === 404) return values;
    throw error;
  }
  return values;
}

/**
 * A file's contents, or null when the repository does not have it.
 *
 * Only used for classification, where "no such file" is the answer half the
 * rules are looking for rather than a failure.
 */
export async function readRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path,
    });
    const content = (data as { content?: string; encoding?: string }).content;
    if (typeof content !== 'string') return null;
    return Buffer.from(content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Create or update the custom property definition itself.
 *
 * `allowed_values` is not declared anywhere in the configuration: it is the
 * set of type names under `types`. Asking an author to list them twice is
 * asking for the two lists to disagree, and the one that would silently win is
 * the one GitHub stores rather than the one the file shows.
 */
export async function putPropertySchema(
  octokit: Octokit,
  org: string,
  property: string,
  allowedValues: string[],
): Promise<void> {
  await octokit.request('PUT /orgs/{org}/properties/schema/{custom_property_name}', {
    org,
    custom_property_name: property,
    value_type: 'single_select',
    allowed_values: allowedValues,
    required: false,
  });
}

/**
 * Assign a property value to repositories, in one call for each distinct
 * value: the endpoint takes a list of repositories and a list of properties,
 * so a whole type's worth of repositories costs a single request.
 */
export async function setPropertyValues(
  octokit: Octokit,
  org: string,
  property: string,
  value: string,
  repos: string[],
): Promise<void> {
  await octokit.request('PATCH /orgs/{org}/properties/values', {
    org,
    repository_names: repos,
    properties: [{ property_name: property, value }],
  });
}

const planLimits = new WeakMap<Octokit, Map<string, Promise<PlanLimits>>>();

/**
 * Remembered for the life of the client, keyed by owner.
 *
 * `audit` and a future `inspect capabilities` command both ask about the same
 * owner, and the probes behind this call cost a request each — there is no
 * reason a second question in the same run should pay for them again.
 */
export async function detectLimits(
  octokit: Octokit,
  owner: string,
  kind: OwnerKind,
): Promise<PlanLimits> {
  const known = planLimits.get(octokit) ?? new Map<string, Promise<PlanLimits>>();
  planLimits.set(octokit, known);
  const cached = known.get(owner);
  if (cached) return cached;

  const pending = requestLimits(octokit, owner, kind);
  known.set(owner, pending);
  try {
    return await pending;
  } catch (error) {
    known.delete(owner);
    throw error;
  }
}

/**
 * What the account actually allows.
 *
 * Probed rather than inferred from a plan name: the plan is only visible to
 * an organisation admin (or to a personal account looking at itself), and the
 * mapping from plan name to feature is not something to hard-code and then be
 * wrong about. For a personal account, organisation-only features are simply
 * absent — there is nothing to probe, and saying so is not a plan limitation.
 */
async function requestLimits(
  octokit: Octokit,
  owner: string,
  kind: OwnerKind,
): Promise<PlanLimits> {
  if (kind === 'user') {
    let plan: string | undefined;
    const me = await authenticatedLogin(octokit);
    if (me && me.toLowerCase() === owner.toLowerCase()) {
      try {
        const { data } = await octokit.users.getAuthenticated();
        plan = (data as { plan?: { name?: string } }).plan?.name;
      } catch {}
    }
    return { ownerKind: 'user', plan, orgRulesets: false };
  }

  let plan: string | undefined;
  try {
    const res = await octokit.orgs.get({ org: owner });
    plan = (res.data as { plan?: { name?: string } }).plan?.name;
  } catch {}

  let orgRulesets = true;
  try {
    await octokit.request('GET /orgs/{org}/rulesets', { org: owner, per_page: 1 });
  } catch (error) {
    if (errorStatus(error) === 403) orgRulesets = false;
  }

  return { ownerKind: 'org', plan, orgRulesets };
}
