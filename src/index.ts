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
  loadConfigWithSources,
  resolvePolicy,
  repoType,
  isExcluded,
  isManaged,
  ConfigError,
} from './config/resolve.js';
export { UNREADABLE } from './config/sentinels.js';
export { APPLICABILITY, notApplicable, describeNotApplicable } from './config/applicability.js';
export { PRECEDENCE, collectionSemantics, configModel } from './config/shape.js';
export { sourceDigest, structuralDigest } from './config/digest.js';
export { findCredentialShapedValue } from './config/credential-scan.js';
export {
  DEFAULT_PLAN_EXPIRY_MINUTES,
  buildPlanArtifact,
  readPlanArtifact,
  verifyPlanArtifact,
} from './config/plan-artifact.js';
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
  authenticatedLogin,
  detectRulesetCapability,
  REST_API_VERSION,
  AuthError,
} from './github/client.js';
export { capability } from './github/capabilities.js';
export { planRepo } from './core/plan.js';
export { classifyRepo, pathsUsedBy } from './core/classify.js';
export { applyRepoChanges } from './github/apply.js';
export { formatChange, groupByRepo, printable } from './report/format.js';
export { audit } from './commands/audit.js';
export { plan, summarizePlan } from './commands/plan.js';
export { apply, summarizeApply } from './commands/apply.js';
export { classify } from './commands/classify.js';
export { propertiesSync } from './commands/properties.js';
export { validateConfig, migrateConfig } from './commands/config.js';
export { selectOwners, parseRepoSelector, narrowToQualifiedRepo } from './config/selectors.js';
export { migrateToMultiOwner } from './config/migrate.js';
export {
  inspectConfig,
  inspectCapabilities,
  reportInspectedConfig,
  reportInspectedCapabilities,
} from './commands/inspect.js';
export {
  EXIT_AUTH_ERROR,
  EXIT_BLOCKED,
  EXIT_CHANGES_PENDING,
  EXIT_FAILED,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from './cli-exit-codes.js';

export type {
  Actor,
  Applicability,
  AppliedChange,
  ApplyOptions,
  ApplyRunResult,
  ApplySummary,
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
  InspectedCapabilities,
  InspectedOwner,
  Managed,
  MergePolicy,
  MergeSemantics,
  MigratedConfig,
  MigrateOptions,
  NotApplicable,
  OperationKind,
  OutputEnvelope,
  OwnerBlock,
  OwnerDiscovery,
  OwnerKind,
  OwnerScope,
  PlanArtifact,
  PlanArtifactOwner,
  PlanArtifactSchemaVersion,
  PlanError,
  PlanLimits,
  PlanOptions,
  PlanRejectionReason,
  PlanResult,
  PlanSelector,
  PlanSummary,
  PlanVerification,
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
  Risk,
  RulesetPolicy,
  SecurityPolicy,
  SemanticsEntry,
  SettingValue,
  Toggle,
  TokenProvider,
} from './types/index.js';
