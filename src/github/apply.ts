import type { Octokit } from '@octokit/rest';
import type { Change } from '../config/types.js';

export interface AppliedChange extends Change {
  outcome: 'applied' | 'failed';
  /** Present only when outcome is 'failed'. */
  error?: string;
}

/** Dotted plan key -> field name in the PATCH /repos/{owner}/{repo} body. */
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
  'repo.description': 'description',
  'repo.homepage': 'homepage',
  'repo.allow_forking': 'allow_forking',
  'repo.web_commit_signoff_required': 'web_commit_signoff_required',
};

/** Dotted plan key -> key inside the nested security_and_analysis object. */
const SECURITY_AND_ANALYSIS_FIELDS: Record<string, string> = {
  'security.secret_scanning': 'secret_scanning',
  'security.secret_scanning_push_protection': 'secret_scanning_push_protection',
};

/**
 * Apply every change `plan` found for one repository that is not blocked.
 *
 * Grouped by the endpoint each key actually belongs to, not one call per
 * setting: everything that fits in the repository PATCH body — features,
 * merge options, description, homepage, and the two security_and_analysis
 * toggles, which GitHub nests inside the same PATCH rather than exposing
 * separately — goes in a single request. Enabling five such settings costs
 * one API call, not five. Topics, vulnerability alerts and code scanning
 * default setup each have their own endpoint and are called on their own.
 *
 * Each group succeeds or fails together: if the one PATCH request for a
 * repository's settings fails, every change bundled into it is reported as
 * failed with the same reason, since none of them actually happened.
 */
export async function applyRepoChanges(
  octokit: Octokit,
  owner: string,
  repo: string,
  changes: Change[],
): Promise<AppliedChange[]> {
  const results: AppliedChange[] = [];

  const patchBody: Record<string, unknown> = {};
  const securityAndAnalysis: Record<string, { status: 'enabled' | 'disabled' }> = {};
  const bundled: Change[] = [];

  for (const change of changes) {
    const field = PATCH_FIELDS[change.key];
    if (field) {
      patchBody[field] = change.to;
      bundled.push(change);
      continue;
    }
    const secField = SECURITY_AND_ANALYSIS_FIELDS[change.key];
    if (secField) {
      securityAndAnalysis[secField] = { status: change.to ? 'enabled' : 'disabled' };
      bundled.push(change);
    }
  }

  if (Object.keys(securityAndAnalysis).length > 0) {
    patchBody.security_and_analysis = securityAndAnalysis;
  }

  if (bundled.length > 0) {
    try {
      // security_and_analysis is a real, documented field of this endpoint's
      // request body, but is missing from the locally installed
      // @octokit/openapi-types — request()'s route-specific typing would
      // reject it on a fresh object literal. Building the body as a plain
      // record first and spreading it sidesteps that gap without losing type
      // checking on owner/repo, which stay explicit.
      await octokit.request('PATCH /repos/{owner}/{repo}', { owner, repo, ...patchBody });
      for (const change of bundled) results.push({ ...change, outcome: 'applied' });
    } catch (error) {
      const message = describeError(error);
      for (const change of bundled) results.push({ ...change, outcome: 'failed', error: message });
    }
  }

  const topics = changes.find((c) => c.key === 'repo.topics');
  if (topics) {
    results.push(
      await attempt(topics, () =>
        octokit.request('PUT /repos/{owner}/{repo}/topics', {
          owner,
          repo,
          names: Array.isArray(topics.to) ? (topics.to as string[]) : [],
        }),
      ),
    );
  }

  const alerts = changes.find((c) => c.key === 'security.vulnerability_alerts');
  if (alerts) {
    results.push(
      await attempt(alerts, () =>
        alerts.to
          ? octokit.request('PUT /repos/{owner}/{repo}/vulnerability-alerts', { owner, repo })
          : octokit.request('DELETE /repos/{owner}/{repo}/vulnerability-alerts', { owner, repo }),
      ),
    );
  }

  const codeScanning = changes.find((c) => c.key === 'security.code_scanning_default_setup');
  if (codeScanning) {
    results.push(
      await attempt(codeScanning, () =>
        octokit.request('PATCH /repos/{owner}/{repo}/code-scanning/default-setup', {
          owner,
          repo,
          state: codeScanning.to ? 'configured' : 'not-configured',
        }),
      ),
    );
  }

  return results;
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
