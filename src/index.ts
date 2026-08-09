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
  readPropertyValues,
  detectLimits,
  AuthError,
} from './github/client.js';
export { planRepo } from './core/plan.js';
export { formatChange, groupByRepo } from './report/format.js';
export { audit } from './commands/audit.js';
export { plan } from './commands/plan.js';

export type {
  Config,
  PolicySet,
  RepoState,
  RepoDetail,
  Change,
  Toggle,
  Managed,
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
} from './config/types.js';
