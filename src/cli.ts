import { ConfigError, loadConfig } from './config/resolve.js';
import { describeNotApplicable, notApplicable } from './config/applicability.js';
import { narrowToQualifiedRepo, parseRepoSelector, selectOwners } from './config/selectors.js';
import { validateConfig, migrateConfig } from './commands/config.js';
import {
  AuthError,
  createClient,
  detectOwnerKind,
  listRepos,
  requireScopes,
} from './github/client.js';
import { audit } from './commands/audit.js';
import { plan } from './commands/plan.js';
import { apply } from './commands/apply.js';
import { classify } from './commands/classify.js';
import { propertiesSync } from './commands/properties.js';
import { renderUsage } from './cli-contract.js';
import type { OwnerScope, RepoSelector, ResolvedConfig } from './types/index.js';
import type { Octokit } from '@octokit/rest';

const USAGE = renderUsage();

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
    } else if (arg === '--owner') {
      const value = argv[++i];
      if (!value) throw new ConfigError(`${arg} needs a value`);
      args.owners.push(value);
    } else if (arg === '--config' || arg === '--repo' || arg === '--type') {
      const value = argv[++i];
      if (!value) throw new ConfigError(`${arg} needs a value`);
      if (arg === '--config') args.config = value;
      else if (arg === '--repo') args.repo = value;
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

  try {
    const config = loadConfig(args.config);
    const octokit = createClient();
    const selection = await resolveSelection(octokit, config, args);
    printScopeSummary(config, selection, args);
    const each = async (run: (scope: OwnerScope) => Promise<number>): Promise<number> =>
      await forEachOwner(octokit, selection, args.strict, run);

    switch (args.command) {
      case 'audit': {
        await requireScopes(octokit, ['repo']);
        return await each(async (scope) => {
          await audit(octokit, scope);
          return 0;
        });
      }
      case 'plan': {
        await requireScopes(octokit, ['repo']);
        return await each(async (scope) => {
          await plan(octokit, scope, { repo: selection.repoName, type: args.type });
          return 0;
        });
      }
      case 'apply': {
        await requireScopes(octokit, ['repo']);
        return await each((scope) =>
          apply(octokit, scope, { repo: selection.repoName, type: args.type, yes: args.yes }),
        );
      }
      case 'classify': {
        await requireScopes(octokit, args.apply ? ['repo', 'admin:org'] : ['repo']);
        return await each((scope) => classify(octokit, scope, { apply: args.apply }));
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
        await requireScopes(octokit, ['repo', 'admin:org']);
        return await each((scope) => propertiesSync(octokit, scope));
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
 * still produces the output it always has. The worst exit status wins: a run
 * that succeeded for two accounts and failed for a third did not succeed. An
 * empty selection is reported as such rather than silently doing nothing.
 */
async function forEachOwner(
  octokit: Octokit,
  selection: Selection,
  strict: boolean,
  run: (scope: OwnerScope) => Promise<number>,
): Promise<number> {
  if (selection.owners.length === 0) {
    console.error('No owner matches the current selection. Nothing was done.');
    return 1;
  }

  const notes = await preflight(octokit, selection.owners, strict);
  const heading = selection.owners.length > 1;
  let status = 0;

  for (const [index, scope] of selection.owners.entries()) {
    if (heading) {
      if (index > 0) console.log('');
      console.log(`=== ${scope.owner} ===\n`);
    }
    for (const note of notes.get(scope.owner) ?? []) console.log(`Note: ${note}`);
    if (notes.get(scope.owner)?.length) console.log('');
    status = Math.max(status, await run(scope));
  }

  return status;
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
 */
async function preflight(
  octokit: Octokit,
  owners: OwnerScope[],
  strict: boolean,
): Promise<Map<string, string[]>> {
  const notes = new Map<string, string[]>();
  const rejected: string[] = [];

  for (const scope of owners) {
    const kind = await detectOwnerKind(octokit, scope.owner);
    const lines = notApplicable(scope, kind).map((finding) => describeNotApplicable(finding, kind));
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
