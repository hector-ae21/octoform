import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { confirm } from './cli-prompt.js';
import { ConfigError, loadConfigWithSources } from './config/resolve.js';
import { describeNotApplicable, notApplicable } from './config/applicability.js';
import { narrowToQualifiedRepo, parseRepoSelector, selectOwners } from './config/selectors.js';
import { validateConfig, migrateConfig } from './commands/config.js';
import {
  buildPlanArtifact,
  readPlanArtifact,
  verifyPlanArtifact,
} from './config/plan-artifact.js';
import {
  AuthError,
  createClient,
  detectOwnerKind,
  discoverOwner,
  listRepos,
  rateLimitWarning,
  requireScopes,
} from './github/client.js';
import { applyRepoChanges } from './github/apply.js';
import { audit } from './commands/audit.js';
import { plan, summarizePlan } from './commands/plan.js';
import { apply } from './commands/apply.js';
import { classify } from './commands/classify.js';
import { propertiesSync } from './commands/properties.js';
import { formatChange, groupByRepo } from './report/format.js';
import { renderUsage } from './cli-contract.js';
import type {
  AppliedChange,
  OwnerScope,
  PlanResult,
  RepoSelector,
  ResolvedConfig,
} from './types/index.js';
import type { Octokit } from '@octokit/rest';

const USAGE = renderUsage();

/**
 * The running package's own version, read from `package.json` relative to
 * this compiled file rather than imported, so it resolves correctly whether
 * this is a local build or an installed npm package — both keep `package.json`
 * one directory above `dist/`.
 */
function packageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

interface Args {
  command?: string;
  subcommand?: string;
  config: string;
  help: boolean;
  owners: string[];
  repo?: string;
  type?: string;
  yes: boolean;
  apply: boolean;
  strict: boolean;
  write: boolean;
  failFast: boolean;
  concurrency?: number;
  out?: string;
  planFile?: string;
  expiresIn?: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    config: 'octoform.yml',
    help: false,
    owners: [],
    yes: false,
    apply: false,
    strict: false,
    write: false,
    failFast: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--yes' || arg === '-y') {
      args.yes = true;
    } else if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--strict') {
      args.strict = true;
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '--fail-fast') {
      args.failFast = true;
    } else if (arg === '--owner') {
      const value = argv[++i];
      if (!value) throw new ConfigError(`${arg} needs a value`);
      args.owners.push(value);
    } else if (arg === '--concurrency') {
      const value = argv[++i];
      if (!value) throw new ConfigError(`${arg} needs a value`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new ConfigError(`--concurrency must be a positive integer, got "${value}"`);
      }
      args.concurrency = parsed;
    } else if (arg === '--expires-in') {
      const value = argv[++i];
      if (!value) throw new ConfigError(`${arg} needs a value`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new ConfigError(`--expires-in must be a positive integer number of minutes, got "${value}"`);
      }
      args.expiresIn = parsed;
    } else if (
      arg === '--config' ||
      arg === '--repo' ||
      arg === '--type' ||
      arg === '--out' ||
      arg === '--plan'
    ) {
      const value = argv[++i];
      if (!value) throw new ConfigError(`${arg} needs a value`);
      if (arg === '--config') args.config = value;
      else if (arg === '--repo') args.repo = value;
      else if (arg === '--out') args.out = value;
      else if (arg === '--plan') args.planFile = value;
      else args.type = value;
    } else if (arg.startsWith('-')) {
      throw new ConfigError(`Unknown option: ${arg}`);
    } else if (!args.command) {
      args.command = arg;
    } else if (!args.subcommand) {
      args.subcommand = arg;
    } else {
      throw new ConfigError(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n`);
    console.error(USAGE);
    return 2;
  }

  if (args.help || !args.command) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }

  if (args.command === 'config') {
    return runConfigCommand(args);
  }

  if (args.command === 'apply' && args.planFile) {
    return await runApplyPlanCommand(args.planFile, args.yes);
  }

  try {
    const { config, sourceDigests } = loadConfigWithSources(args.config);
    const octokit = createClient();
    const selection = await resolveSelection(octokit, config, args);
    printScopeSummary(config, selection, args);
    const each = async (run: (scope: OwnerScope) => Promise<CommandOutcome>): Promise<number> =>
      await forEachOwner(octokit, selection, args.strict, args.failFast, run);
    const enter = async (scopes: string[]): Promise<void> => {
      const note = rateLimitWarning(await requireScopes(octokit, scopes));
      if (note) console.error(`Note: ${note}.`);
    };

    switch (args.command) {
      case 'audit': {
        await enter(['repo']);
        return await each(async (scope) => {
          await audit(octokit, scope);
          return { status: 0 };
        });
      }
      case 'plan': {
        await enter(['repo']);
        const planResults = new Map<string, PlanResult>();
        const ownerIds = new Map<string, number>();
        const status = await each(async (scope) => {
          const result = await plan(octokit, scope, {
            repo: selection.repoName,
            type: args.type,
            concurrency: args.concurrency,
          });
          if (args.out) {
            planResults.set(scope.owner, result);
            ownerIds.set(scope.owner, (await discoverOwner(octokit, scope.owner)).id);
          }
          return { status: 0, summary: toRecord(summarizePlan(result)) };
        });
        if (args.out) {
          const artifact = await buildPlanArtifact(
            octokit,
            args.config,
            sourceDigests,
            selection.owners,
            planResults,
            ownerIds,
            packageVersion(),
            args.expiresIn,
          );
          writeFileSync(resolvePath(args.out), `${JSON.stringify(artifact, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
          console.log(`\nSaved plan to ${args.out} (expires ${artifact.expiresAt}).`);
        }
        return status;
      }
      case 'apply': {
        await enter(['repo']);
        return await each(async (scope) => {
          const result = await apply(octokit, scope, {
            repo: selection.repoName,
            type: args.type,
            yes: args.yes,
            concurrency: args.concurrency,
          });
          return { status: result.status, summary: toRecord(result.summary) };
        });
      }
      case 'classify': {
        await enter(args.apply ? ['repo', 'admin:org'] : ['repo']);
        return await each(async (scope) => ({
          status: await classify(octokit, scope, { apply: args.apply }),
        }));
      }
      case 'properties': {
        if (args.subcommand !== 'sync') {
          console.error(
            args.subcommand
              ? `Unknown subcommand: properties ${args.subcommand}\n`
              : 'properties needs a subcommand: properties sync\n',
          );
          console.error(USAGE);
          return 2;
        }
        await enter(['repo', 'admin:org']);
        return await each(async (scope) => ({ status: await propertiesSync(octokit, scope) }));
      }
      default:
        console.error(`Unknown command: ${args.command}\n`);
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof AuthError) {
      console.error(`${error.message}`);
      return 1;
    }
    const status = (error as { status?: number }).status;
    if (status) {
      console.error(`GitHub API error ${status}: ${(error as Error).message}`);
      return 1;
    }
    throw error;
  }
}

/**
 * Apply exactly a saved plan: no re-planning, no owner selection beyond what
 * the file itself recorded. Every check in {@link verifyPlanArtifact} must
 * pass before anything is touched, and a failed check names which one.
 */
async function runApplyPlanCommand(planFile: string, skipConfirm: boolean): Promise<number> {
  try {
    const artifact = readPlanArtifact(planFile);
    const octokit = createClient();

    const verification = await verifyPlanArtifact(octokit, artifact);
    if (!verification.valid) {
      console.error(`Refusing to apply ${planFile}: ${verification.detail} (${verification.reason}).`);
      return 1;
    }

    const changeCount = artifact.owners.reduce((sum, owner) => sum + owner.changes.length, 0);
    if (changeCount === 0) {
      console.log('Nothing to apply. The saved plan has no unblocked changes.');
      return 0;
    }

    console.log(`${changeCount} change(s) to apply from ${planFile}:\n`);
    for (const owner of artifact.owners) {
      if (owner.changes.length === 0) continue;
      console.log(`=== ${owner.login} ===`);
      for (const [repoName, group] of groupByRepo(owner.changes)) {
        console.log(`  ${repoName}`);
        for (const change of group) console.log(`    ${formatChange(change)}`);
      }
      console.log('');
    }

    if (!skipConfirm && !(await confirm(`Apply ${changeCount} change(s)?`))) {
      console.log('Aborted. Nothing was changed.');
      return 1;
    }

    console.log('');
    let failures = 0;
    let applied = 0;
    for (const owner of artifact.owners) {
      for (const [repoName, group] of groupByRepo(owner.changes)) {
        const results: AppliedChange[] = await applyRepoChanges(octokit, owner.login, repoName, group);
        for (const result of results) {
          if (result.outcome === 'applied') applied++;
          else failures++;
          const outcome = result.outcome === 'applied' ? 'done' : `FAILED — ${result.error}`;
          console.log(`  ${owner.login}/${repoName}  ${result.key}: ${outcome}`);
        }
      }
    }

    console.log('');
    console.log(
      failures === 0 ? 'All changes applied.' : `${failures} change(s) failed — see above.`,
    );
    console.log(`Total — applied: ${applied}, failed: ${failures}`);
    return failures === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof AuthError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

function runConfigCommand(args: Args): number {
  try {
    if (args.subcommand === 'validate') return validateConfig(args.config);
    if (args.subcommand === 'migrate') return migrateConfig(args.config, { write: args.write });

    console.error(
      args.subcommand
        ? `Unknown subcommand: config ${args.subcommand}\n`
        : 'config needs a subcommand: config validate | config migrate\n',
    );
    console.error(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

/** The owners and, when narrowed, the single repository name a run should touch. */
interface Selection {
  owners: OwnerScope[];
  repoName?: string;
}

/** What one owner's run of a command reported, for isolation and the cross-owner summary. */
interface CommandOutcome {
  status: number;
  /** Present for plan and apply, whose results reduce to stable named counts. */
  summary?: Record<string, number>;
}

function toRecord(value: object): Record<string, number> {
  return Object.fromEntries(Object.entries(value)) as Record<string, number>;
}

/**
 * Resolve `--owner`/`--repo` against the loaded configuration.
 *
 * A bare `--repo` name is checked for ambiguity across the selected owners
 * only when there is more than one of them — the common single-owner run
 * never pays for a listing it does not need.
 */
async function resolveSelection(
  octokit: Octokit,
  config: ResolvedConfig,
  args: Args,
): Promise<Selection> {
  let owners = selectOwners(config, args.owners);
  let repoName: string | undefined;

  if (args.repo) {
    const selector = parseRepoSelector(args.repo);
    if (selector.owner) {
      owners = narrowToQualifiedRepo(
        config,
        owners,
        selector as RepoSelector & { owner: string },
        args.owners.length > 0,
      );
    } else if (owners.length > 1) {
      owners = await disambiguateRepo(octokit, owners, selector.name);
    }
    repoName = selector.name;
  }

  return { owners, repoName };
}

/**
 * Narrow to the owners that actually have a repository by this name.
 *
 * More than one match is an error, not a guess: applying a change to two
 * different repositories because they happen to share a name is exactly the
 * kind of scope expansion a selector exists to prevent.
 */
async function disambiguateRepo(
  octokit: Octokit,
  owners: OwnerScope[],
  name: string,
): Promise<OwnerScope[]> {
  const matches: OwnerScope[] = [];
  for (const scope of owners) {
    const kind = await detectOwnerKind(octokit, scope.owner);
    const repos = await listRepos(octokit, scope.owner, kind);
    if (repos.some((repo) => repo.name === name)) matches.push(scope);
  }

  if (matches.length > 1) {
    throw new ConfigError(
      `--repo "${name}" matches more than one selected owner: ${matches
        .map((scope) => `${scope.owner}/${name}`)
        .join(', ')}. Use one of those qualified forms instead.`,
    );
  }
  return matches;
}

/**
 * Print which owners a run actually touches, when that is not obvious from
 * running the command with no selector at all.
 *
 * Silent for the common case — one declared owner, no selector — because a
 * line that never says anything but "everything, as declared" is noise, not
 * information.
 */
function printScopeSummary(config: ResolvedConfig, selection: Selection, args: Args): void {
  const narrowed = args.owners.length > 0 || args.repo !== undefined || args.type !== undefined;
  if (config.owners.length <= 1 && !narrowed) return;

  const selected = selection.owners.map((scope) => scope.owner);
  const excluded = config.owners
    .map((scope) => scope.owner)
    .filter((owner) => !selected.includes(owner));

  const repo = selection.repoName ? `, repo "${selection.repoName}"` : '';
  const type = args.type ? `, type "${args.type}"` : '';
  console.log(
    `Scope: ${selected.length} of ${config.owners.length} declared owner(s): ` +
      `${selected.join(', ') || '(none)'}${repo}${type}` +
      (excluded.length > 0 ? ` — excluded: ${excluded.join(', ')}` : ''),
  );
  console.log('');
}

/**
 * Run one command against every selected owner, in the order the
 * configuration named them.
 *
 * Owners are headed only when there is more than one, so a single-owner file
 * still produces the output it always has. An empty selection is reported as
 * such rather than silently doing nothing.
 *
 * A failure inside one owner never stops another: by default this continues
 * to the rest of the selection and reports every owner's outcome, isolated
 * from the others, at the end. `--fail-fast` stops at the first one instead.
 * Either way, the worst status among the owners actually run wins.
 */
async function forEachOwner(
  octokit: Octokit,
  selection: Selection,
  strict: boolean,
  failFast: boolean,
  run: (scope: OwnerScope) => Promise<CommandOutcome>,
): Promise<number> {
  if (selection.owners.length === 0) {
    console.error('No owner matches the current selection. Nothing was done.');
    return 1;
  }

  const notes = await preflight(octokit, selection.owners, strict);
  const heading = selection.owners.length > 1;
  let status = 0;
  const totals: Record<string, number> = {};
  let ownerFailures = 0;

  for (const [index, scope] of selection.owners.entries()) {
    if (heading) {
      if (index > 0) console.log('');
      console.log(`=== ${scope.owner} ===\n`);
    }
    for (const note of notes.get(scope.owner) ?? []) console.log(`Note: ${note}`);
    if (notes.get(scope.owner)?.length) console.log('');

    try {
      const outcome = await run(scope);
      status = Math.max(status, outcome.status);
      if (outcome.summary) mergeInto(totals, outcome.summary);
    } catch (error) {
      ownerFailures++;
      status = Math.max(status, 1);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${scope.owner}: FAILED — ${message}`);
      if (failFast) break;
    }
  }

  if (heading) printTotals(totals, ownerFailures);
  return status;
}

function mergeInto(totals: Record<string, number>, summary: Record<string, number>): void {
  for (const [key, value] of Object.entries(summary)) {
    totals[key] = (totals[key] ?? 0) + value;
  }
}

function printTotals(totals: Record<string, number>, ownerFailures: number): void {
  const parts = Object.entries(totals).map(([key, value]) => `${key}: ${value}`);
  if (ownerFailures > 0) parts.push(`owners unreachable: ${ownerFailures}`);
  if (parts.length === 0) return;
  console.log(`\nTotal — ${parts.join(', ')}`);
}

/**
 * Resolve every selected owner's kind and applicability before running
 * anything.
 *
 * Checked up front rather than owner by owner so that a configuration strict
 * validation would reject is rejected before the first account is touched. A
 * run that changed two accounts and then refused the third would be the worst
 * of both answers. Only the owners actually selected are checked: an
 * unselected owner's declarations are none of this run's business.
 *
 * An owner whose kind cannot even be discovered here is left out of `notes`
 * rather than aborting the whole preflight: the main loop calls the same
 * discovery again for that owner and reports the failure there, isolated from
 * the rest of the selection exactly like any other per-owner failure.
 */
async function preflight(
  octokit: Octokit,
  owners: OwnerScope[],
  strict: boolean,
): Promise<Map<string, string[]>> {
  const notes = new Map<string, string[]>();
  const rejected: string[] = [];

  for (const scope of owners) {
    let kind;
    try {
      kind = await detectOwnerKind(octokit, scope.owner);
    } catch {
      continue;
    }
    const lines = notApplicable(scope, kind).map((finding) =>
      describeNotApplicable(finding, kind),
    );
    if (lines.length === 0) continue;
    if (strict) rejected.push(...lines);
    notes.set(scope.owner, lines);
  }

  if (rejected.length > 0) {
    throw new ConfigError(
      'Strict validation rejected declarations that do not apply to their owner:\n' +
        rejected.map((line) => `  ${line}`).join('\n'),
    );
  }
  return notes;
}
