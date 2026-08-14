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
export { applyRepoChanges } from './github/apply.js';
export { formatChange, groupByRepo } from './report/format.js';
export { audit } from './commands/audit.js';
export { plan } from './commands/plan.js';
export { apply } from './commands/apply.js';
export { classify } from './commands/classify.js';
export { propertiesSync } from './commands/properties.js';

export type {
  Applicability,
  AppliedChange,
  ApplyOptions,
  AuditConfig,
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
  NotApplicable,
  OwnerBlock,
  OwnerKind,
  OwnerScope,
  PlanLimits,
  PlanOptions,
  PlanResult,
  PolicySet,
  RepoDetail,
  RepoEntry,
  RepoFacts,
  RepoPolicy,
  RepoState,
  RepoStructure,
  ResolvedConfig,
  RulesetPolicy,
  SecurityPolicy,
  SemanticsEntry,
  SettingValue,
  Toggle,
} from './types/index.js';
