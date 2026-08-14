import { ConfigError, loadConfig } from './config/resolve.js';
import { describeNotApplicable, notApplicable } from './config/applicability.js';
import { AuthError, createClient, detectOwnerKind, requireScopes } from './github/client.js';
import { audit } from './commands/audit.js';
import { plan } from './commands/plan.js';
import { apply } from './commands/apply.js';
import { classify } from './commands/classify.js';
import { propertiesSync } from './commands/properties.js';
import { renderUsage } from './cli-contract.js';
import type { OwnerScope, ResolvedConfig } from './config/types.js';
import type { Octokit } from '@octokit/rest';

const USAGE = renderUsage();

interface Args {
  command?: string;
  subcommand?: string;
  config: string;
  help: boolean;
  repo?: string;
  type?: string;
  yes: boolean;
  apply: boolean;
  strict: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    config: 'octoform.yml',
    help: false,
    yes: false,
    apply: false,
    strict: false,
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

  try {
    const config = loadConfig(args.config);
    const octokit = createClient();
    const each = async (run: (scope: OwnerScope) => Promise<number>): Promise<number> =>
      await forEachOwner(octokit, config, args.strict, run);

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
          await plan(octokit, scope, { repo: args.repo, type: args.type });
          return 0;
        });
      }
      case 'apply': {
        await requireScopes(octokit, ['repo']);
        return await each((scope) =>
          apply(octokit, scope, { repo: args.repo, type: args.type, yes: args.yes }),
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

/**
 * Run one command against every owner the configuration names, in the order it
 * named them.
 *
 * Owners are headed only when there is more than one, so a single-owner file
 * still produces the output it always has. The worst exit status wins: a run
 * that succeeded for two accounts and failed for a third did not succeed.
 */
async function forEachOwner(
  octokit: Octokit,
  config: ResolvedConfig,
  strict: boolean,
  run: (scope: OwnerScope) => Promise<number>,
): Promise<number> {
  const notes = await preflight(octokit, config, strict);
  const heading = config.owners.length > 1;
  let status = 0;

  for (const [index, scope] of config.owners.entries()) {
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
 * Resolve every owner's kind and applicability before running anything.
 *
 * Checked up front rather than owner by owner so that a configuration strict
 * validation would reject is rejected before the first account is touched. A
 * run that changed two accounts and then refused the third would be the worst
 * of both answers.
 */
async function preflight(
  octokit: Octokit,
  config: ResolvedConfig,
  strict: boolean,
): Promise<Map<string, string[]>> {
  const notes = new Map<string, string[]>();
  const rejected: string[] = [];

  for (const scope of config.owners) {
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
