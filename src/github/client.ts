import { Octokit } from '@octokit/rest';
import { UNREADABLE } from '../config/types.js';
import type {
  ExistingEnvironment,
  ExistingRuleset,
  OwnerKind,
  PolicySet,
  RepoDetail,
  RepoState,
  RepoStructure,
} from '../config/types.js';

/** Authentication or token-scope error that can be corrected by the operator. */
export class AuthError extends Error {}

/** Observable owner limits used to explain audit and planning behavior. */
export interface PlanLimits {
  ownerKind: OwnerKind;
  /** Account plan name as GitHub reports it, when visible. Organisations only. */
  plan?: string;
  /**
   * Whether organisation-wide rulesets are available. Always false for a
   * personal account — it is not a plan restriction there, there is simply no
   * such concept — and probed for an organisation, since it needs a paid plan.
   */
  orgRulesets: boolean;
}

/** Create an authenticated GitHub client from `GITHUB_TOKEN` or `GH_TOKEN`. */
export function createClient(): Octokit {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new AuthError(
      'No token found. Set GITHUB_TOKEN or GH_TOKEN to a token with "repo" and, ' +
        'for organisation custom properties and rulesets, "admin:org".',
    );
  }
  return new Octokit({
    auth: token,
    userAgent: 'octoform',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

/**
 * Fail early and legibly on a missing scope.
 *
 * Without this the first call that needs `admin:org` returns a bare 403 whose
 * message says nothing about which scope is missing, which is the single most
 * common way to get stuck when setting this up.
 */
export async function requireScopes(octokit: Octokit, needed: string[]): Promise<void> {
  const res = await octokit.request('GET /user');
  const header = res.headers['x-oauth-scopes'];

  if (typeof header !== 'string') return;

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

/**
 * Whether `owner` is an organisation or a personal account. This drives which
 * listing endpoint to use and which features even apply, and it is asked of
 * the API rather than declared in configuration: an org and a user can share
 * a login, and configuration is the wrong place to get that wrong.
 */
export async function detectOwnerKind(octokit: Octokit, owner: string): Promise<OwnerKind> {
  try {
    await octokit.request('GET /orgs/{org}', { org: owner });
    return 'org';
  } catch (error) {
    if ((error as { status?: number }).status === 404) return 'user';
    throw error;
  }
}

/**
 * The authenticated token's own login, or undefined for a token type that
 * does not expose one. Used to tell "manage my own account" (which can see
 * private repositories, via /user/repos) apart from "look at someone else's
 * public profile" (which never can, no matter whose token is used).
 */
async function authenticatedLogin(octokit: Octokit): Promise<string | undefined> {
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

    'repo.description': data.description ?? null,
    'repo.homepage': data.homepage ?? null,
    'repo.topics': data.topics ?? [],
    'repo.allow_forking': data.allow_forking ?? null,
    'repo.web_commit_signoff_required':
      (data as { web_commit_signoff_required?: boolean }).web_commit_signoff_required ?? null,

    'security.secret_scanning': enabled('secret_scanning'),
    'security.secret_scanning_push_protection': enabled('secret_scanning_push_protection'),
  };

  const [alerts, codeScanning, autoFixes, privateReporting] = await Promise.all([
    probe(octokit, 'GET /repos/{owner}/{repo}/vulnerability-alerts', owner, base.name),
    codeScanningState(octokit, owner, base.name),
    enabledFlag(octokit, 'GET /repos/{owner}/{repo}/automated-security-fixes', owner, base.name),
    enabledFlag(
      octokit,
      'GET /repos/{owner}/{repo}/private-vulnerability-reporting',
      owner,
      base.name,
    ),
  ]);
  settings['security.vulnerability_alerts'] = alerts;
  settings['security.code_scanning_default_setup'] = codeScanning;
  settings['security.automated_security_fixes'] = autoFixes;
  settings['security.private_vulnerability_reporting'] = privateReporting;

  const structure = policy ? await getRepoStructure(octokit, owner, base, policy) : undefined;

  return { ...base, settings, ...(structure ? { structure } : {}) };
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
 * manage it. A generic 404 is deliberately not accepted as proof, since
 * GitHub also uses opaque 404s when a token cannot see a resource.
 */
export async function detectPrivateRulesetCapability(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<boolean> {
  if (!defaultBranch) return false;

  try {
    await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: defaultBranch,
    });
    return true;
  } catch (error) {
    const apiError = error as {
      status?: number;
      message?: string;
      response?: { data?: { message?: string } };
    };
    const message = apiError.response?.data?.message ?? apiError.message ?? '';

    if (apiError.status === 404) return /^branch not protected$/i.test(message.trim());
    if (apiError.status === 403) return false;
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
        return toExistingRuleset(res.data as RawRuleset);
      }),
    );
    return full;
  } catch {
    return undefined;
  }
}

interface RawRuleset {
  id: number;
  name: string;
  conditions?: { ref_name?: { include?: string[] } };
  rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
}

function toExistingRuleset(raw: RawRuleset): ExistingRuleset {
  const rules = raw.rules ?? [];
  const pullRequest = rules.find((r) => r.type === 'pull_request');
  const statusChecks = rules.find((r) => r.type === 'required_status_checks');

  const approvals = pullRequest?.parameters?.['required_approving_review_count'];
  const checks = statusChecks?.parameters?.['required_status_checks'] as
    Array<{ context?: string }> | undefined;

  return {
    id: raw.id,
    name: raw.name,
    target_branches: (raw.conditions?.ref_name?.include ?? []).map(fromRefName),
    ...(typeof approvals === 'number' ? { required_approvals: approvals } : {}),
    ...(checks ? { required_checks: checks.map((c) => c.context ?? '').filter(Boolean) } : {}),
    block_force_push: rules.some((r) => r.type === 'non_fast_forward'),
    block_deletion: rules.some((r) => r.type === 'deletion'),
  };
}

/**
 * Ruleset conditions are stored as full refs (`refs/heads/main`), except for
 * the `~ALL` / `~DEFAULT_BRANCH` placeholders, which stand on their own. The
 * configuration says `main`, so the two forms are translated at this boundary
 * and nowhere else — `plan` compares branch names, not refs.
 */
export function toRefName(branch: string): string {
  if (branch.startsWith('~')) return branch;
  if (branch.startsWith('refs/')) return branch;
  return `refs/heads/${branch}`;
}

function fromRefName(ref: string): string {
  if (ref.startsWith('~')) return ref;
  return ref.replace(/^refs\/heads\//, '');
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
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: '.github/workflows',
    });
    const entries = data as Array<{ name: string; path: string; type: string }>;
    const files = entries.filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name));

    const naming = await Promise.all(
      files.map(async (file) => {
        try {
          const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner,
            repo,
            path: file.path,
          });
          const content = (res.data as { content?: string }).content ?? '';
          const text = Buffer.from(content, 'base64').toString('utf8');
          const mentions = new RegExp(`\\b${escapeRegExp(branch)}\\b`).test(text);
          return mentions ? file.path : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return naming.filter((path): path is string => path !== undefined);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return [];
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
    const status = (error as { status?: number }).status;
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
    const status = (error as { status?: number }).status;
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

/**
 * What the account actually allows.
 *
 * Probed rather than inferred from a plan name: the plan is only visible to
 * an organisation admin (or to a personal account looking at itself), and the
 * mapping from plan name to feature is not something to hard-code and then be
 * wrong about. For a personal account, organisation-only features are simply
 * absent — there is nothing to probe, and saying so is not a plan limitation.
 */
export async function detectLimits(
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
    if ((error as { status?: number }).status === 403) orgRulesets = false;
  }

  return { ownerKind: 'org', plan, orgRulesets };
}
