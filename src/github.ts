import { Octokit } from '@octokit/rest';
import type { RepoState } from './types.js';

export class AuthError extends Error {}

export interface PlanLimits {
  /** Organisation plan name as GitHub reports it, when visible. */
  plan?: string;
  /** Organisation-wide rulesets need a paid plan. */
  orgRulesets: boolean;
}

export function createClient(): Octokit {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new AuthError(
      'No token found. Set GITHUB_TOKEN or GH_TOKEN to a token with "repo" and, ' +
        'for custom properties and rulesets, "admin:org".',
    );
  }
  return new Octokit({
    auth: token,
    userAgent: 'octoform',
    // Octokit narrates every request, and logs a warning for any 4xx. Several
    // of the calls here expect a 403 as a legitimate answer — probing whether
    // a plan offers a feature, for one — so that narration reports failures
    // that are not failures. Errors that matter are thrown, caught, and
    // reported by the CLI with a message that says what to do about them.
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

export async function listRepos(octokit: Octokit, org: string): Promise<RepoState[]> {
  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org,
    per_page: 100,
    type: 'all',
  });

  return repos.map((r) => ({
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
 * Read one custom property for every repository in the organisation.
 *
 * Returns an empty map when the organisation's plan does not offer custom
 * properties, so that classification falls back to the configuration file
 * instead of the whole run failing.
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
 * What the organisation's plan actually allows.
 *
 * Probed rather than inferred from the plan name: the plan is only visible to
 * an org admin, and the mapping from plan name to feature is not something to
 * hard-code and then be wrong about.
 */
export async function detectLimits(octokit: Octokit, org: string): Promise<PlanLimits> {
  let plan: string | undefined;
  try {
    const res = await octokit.orgs.get({ org });
    plan = (res.data as { plan?: { name?: string } }).plan?.name;
  } catch {
    // Not an admin, or the org hides it. Not fatal.
  }

  // A 403 here is the expected answer on a plan without organisation rulesets,
  // not a failure.
  let orgRulesets = true;
  try {
    await octokit.request('GET /orgs/{org}/rulesets', { org, per_page: 1 });
  } catch (error) {
    if ((error as { status?: number }).status === 403) orgRulesets = false;
  }

  return { plan, orgRulesets };
}
