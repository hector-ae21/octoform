/**
 * Programmatic entry point.
 *
 * The CLI is the intended way to use octoform, but the pieces it is built from
 * are exported so that a repository can be planned from a script, a test, or
 * another tool without shelling out and parsing text.
 */

export { loadConfig, resolvePolicy, repoType, isExcluded, isManaged, ConfigError } from './config/resolve.js';
export {
  createClient,
  requireScopes,
  listRepos,
  getRepoDetail,
  readRepoFile,
  readPropertyValues,
  putPropertySchema,
  setPropertyValues,
  detectLimits,
  detectPrivateRulesetCapability,
  AuthError,
} from './github/client.js';
export { planRepo } from './core/plan.js';
export { classifyRepo, pathsUsedBy } from './core/classify.js';
export type { RepoFacts } from './core/classify.js';
export { applyRepoChanges } from './github/apply.js';
export type { AppliedChange } from './github/apply.js';
export { formatChange, groupByRepo } from './report/format.js';
export { audit } from './commands/audit.js';
export { plan } from './commands/plan.js';
export { apply } from './commands/apply.js';
export { classify } from './commands/classify.js';
export { propertiesSync } from './commands/properties.js';

export { UNREADABLE } from './config/types.js';
export type {
  Config,
  PolicySet,
  RepoState,
  RepoDetail,
  Change,
  Toggle,
  Managed,
  OwnerKind,
  AuditConfig,
  ClassifyConfig,
  ClassifyRule,
  FeaturePolicy,
  MergePolicy,
  SecurityPolicy,
  RepoPolicy,
  RulesetPolicy,
  EnvironmentPolicy,
  FilePolicy,
  ExistingRuleset,
  ExistingEnvironment,
  RepoStructure,
  DefaultBranchPolicy,
} from './config/types.js';
