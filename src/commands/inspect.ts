import type { Octokit } from '@octokit/rest';
import { detectLimits, discoverOwner } from '../github/client.js';
import { describeNotApplicable, notApplicable } from '../config/applicability.js';
import type { InspectedCapabilities, InspectedOwner, OwnerScope } from '../types/index.js';

/**
 * The fully resolved policy for one owner, with nothing left to imports,
 * types, or policy references to explain: this is what `plan` would actually
 * compare a repository against.
 *
 * Read-only and offline — it never contacts GitHub, the same as
 * `config validate`. What it cannot yet show is which layer contributed each
 * value; today it shows only the final, resolved shape.
 */
export function inspectConfig(scopes: OwnerScope[]): InspectedOwner[] {
  return scopes.map((scope) => ({ owner: scope.owner, resolved: scope }));
}

/**
 * What octoform determined this owner supports, and the evidence behind it —
 * the same discovery and applicability checks every command already runs,
 * surfaced directly instead of inferred from a plan's side effects.
 */
export async function inspectCapabilities(
  octokit: Octokit,
  scope: OwnerScope,
): Promise<InspectedCapabilities> {
  const discovery = await discoverOwner(octokit, scope.owner);
  const limits = await detectLimits(octokit, scope.owner, discovery.kind);
  const findings = notApplicable(scope, discovery.kind).map((finding) => ({
    path: finding.path,
    reason: describeNotApplicable(finding, discovery.kind),
  }));

  return {
    discovery,
    plan: limits.plan,
    organizationRulesets: limits.orgRulesets,
    notApplicable: findings,
  };
}

/** Print one owner's resolved configuration as text. */
export function reportInspectedConfig(entries: InspectedOwner[]): void {
  for (const entry of entries) {
    console.log(`=== ${entry.owner} ===`);
    console.log(JSON.stringify(entry.resolved, null, 2));
    console.log('');
  }
}

/** Print one owner's capability report as text. */
export function reportInspectedCapabilities(owner: string, report: InspectedCapabilities): void {
  const label = report.discovery.kind === 'org' ? 'Organisation' : 'Personal account';
  console.log(
    `${label}: ${owner} (id ${report.discovery.id})${report.plan ? ` — ${report.plan} plan` : ''}`,
  );
  console.log(
    `  organisation-wide rulesets: ${report.organizationRulesets ? 'available' : 'not available'}`,
  );
  if (report.notApplicable.length === 0) {
    console.log('  no declarations that do not apply to this owner');
  } else {
    console.log('  declarations that do not apply to this owner:');
    for (const finding of report.notApplicable)
      console.log(`    ${finding.path}: ${finding.reason}`);
  }
  console.log('');
}
