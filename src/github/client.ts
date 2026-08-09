import { Octokit } from '@octokit/rest';
import { UNREADABLE } from '../config/types.js';
import type { OwnerKind, RepoDetail, RepoState } from '../config/types.js';

export class AuthError extends Error {}

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
    // Octokit narrates every request, and logs a warning for any 4xx. Several
    // of the calls here expect a 403 or 404 as a legitimate answer — probing
    // whether a feature applies at all, for one — so that narration reports
    // failures that are not failures. Errors that matter are thrown, caught,
    // and reported by the CLI with a message that says what to do about them.
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

  // Fine-grained tokens do not report scopes at all. Absence is not evidence
  // of a missing scope, so it cannot be treated as a failure.
  if (typeof header !== 'string') return;

  const granted = header.split(',').map((s) => s.trim()).filter(Boolean);
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
    raw = await octokit.paginate(octokit.repos.listForOrg, { org: owner, per_page: 100, type: 'all' });
  } else {
    const me = await authenticatedLogin(octokit);
    raw =
      me && me.toLowerCase() === owner.toLowerCase()
        ? // Only /user/repos can see private repositories, and only for the
          // token's own account. affiliation: owner excludes repositories this
          // account merely collaborates on or belongs to as an org member,
          // which is what "configure my repos" means here.
          await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
            per_page: 100,
            affiliation: 'owner',
          })
        : // A different user's profile: only ever their public repositories,
          // regardless of whose token is making the request.
          await octokit.paginate(octokit.repos.listForUser, { username: owner, per_page: 100, type: 'owner' });
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
): Promise<RepoDetail> {
  const { data } = await octokit.repos.get({ owner, repo: base.name });
  const analysis = (data as { security_and_analysis?: Record<string, { status?: string } | undefined> })
    .security_and_analysis;
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

  const [alerts, codeScanning] = await Promise.all([
    probe(octokit, 'GET /repos/{owner}/{repo}/vulnerability-alerts', owner, base.name),
    codeScanningState(octokit, owner, base.name),
  ]);
  settings['security.vulnerability_alerts'] = alerts;
  settings['security.code_scanning_default_setup'] = codeScanning;

  return { ...base, settings };
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
): Promise<boolean | typeof UNREADABLE> {
  try {
    await octokit.request(route, { owner, repo });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return false;
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
      } catch {
        // Not fatal: the plan name is informational.
      }
    }
    // orgRulesets: false is a conservative stand-in, not a verified fact. A
    // personal GitHub Pro account CAN have private-repository rulesets
    // enforced; actually confirming that would mean creating a real ruleset
    // just to see whether it holds, which is too invasive for a read-only
    // probe. Until there is a cheaper way to check, this may under-report
    // what a Pro personal account can actually do.
    return { ownerKind: 'user', plan, orgRulesets: false };
  }

  let plan: string | undefined;
  try {
    const res = await octokit.orgs.get({ org: owner });
    plan = (res.data as { plan?: { name?: string } }).plan?.name;
  } catch {
    // Not an admin, or the org hides it. Not fatal.
  }

  // A 403 here is the expected answer on a plan without organisation rulesets,
  // not a failure.
  let orgRulesets = true;
  try {
    await octokit.request('GET /orgs/{org}/rulesets', { org: owner, per_page: 1 });
  } catch (error) {
    if ((error as { status?: number }).status === 403) orgRulesets = false;
  }

  return { ownerKind: 'org', plan, orgRulesets };
}
