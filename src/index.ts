/**
 * Programmatic entry point.
 *
 * The CLI is the intended way to use octoform, but the pieces it is built from
 * are exported so that a repository can be planned from a script, a test, or
 * another tool without shelling out and parsing text.
 */

export {
  CONFIG_VERSION,
  loadConfig,
  resolvePolicy,
  repoType,
  isExcluded,
  isManaged,
  ConfigError,
} from './config/resolve.js';
export { UNREADABLE } from './config/sentinels.js';
export { APPLICABILITY, notApplicable, describeNotApplicable } from './config/applicability.js';
export { PRECEDENCE, collectionSemantics, configModel } from './config/shape.js';
export {
  createClient,
  requireScopes,
  rateLimitWarning,
  listRepos,
  getRepoDetail,
  readRepoFile,
  readPropertyValues,
  putPropertySchema,
  setPropertyValues,
  detectLimits,
  detectOwnerKind,
  discoverOwner,
  detectRulesetCapability,
  REST_API_VERSION,
  AuthError,
} from './github/client.js';
export { capability } from './github/capabilities.js';
export { planRepo } from './core/plan.js';
export { classifyRepo, pathsUsedBy } from './core/classify.js';
export { applyRepoChanges } from './github/apply.js';
export { formatChange, groupByRepo } from './report/format.js';
export { audit } from './commands/audit.js';
export { plan } from './commands/plan.js';
export { apply } from './commands/apply.js';
export { classify } from './commands/classify.js';
export { propertiesSync } from './commands/properties.js';
export { validateConfig, migrateConfig } from './commands/config.js';
export { selectOwners, parseRepoSelector, narrowToQualifiedRepo } from './config/selectors.js';
export { migrateToMultiOwner } from './config/migrate.js';

export type {
  Actor,
  Applicability,
  AppliedChange,
  ApplyOptions,
  AuditConfig,
  CapabilityResult,
  CapabilitySource,
  CapabilityStatus,
  Change,
  ClassifyConfig,
  ClassifyOptions,
  ClassifyRule,
  Config,
  ConfigVersion,
  DefaultBranchPolicy,
  EnvironmentPolicy,
  ExcludeConfig,
  ExistingEnvironment,
  ExistingRuleset,
  FeaturePolicy,
  FileMode,
  FilePolicy,
  Managed,
  MergePolicy,
  MergeSemantics,
  MigratedConfig,
  MigrateOptions,
  NotApplicable,
  OwnerBlock,
  OwnerDiscovery,
  OwnerKind,
  OwnerScope,
  PlanLimits,
  PlanOptions,
  PlanResult,
  PolicySet,
  RateLimitStatus,
  RepoDetail,
  RepoEntry,
  RepoFacts,
  RepoPolicy,
  RepoSelector,
  RepoState,
  RepoStructure,
  ResolvedConfig,
  RulesetPolicy,
  SecurityPolicy,
  SemanticsEntry,
  SettingValue,
  Toggle,
} from './types/index.js';
