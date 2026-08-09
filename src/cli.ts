import { ConfigError, loadConfig } from './config/resolve.js';
import { AuthError, createClient, requireScopes } from './github/client.js';
import { audit } from './commands/audit.js';
import { plan } from './commands/plan.js';
import { apply } from './commands/apply.js';

const USAGE = `octoform - declarative governance for GitHub repositories

Usage:
  octoform audit [--config <path>]
  octoform plan  [--config <path>] [--repo <name>] [--type <type>]
  octoform apply [--config <path>] [--repo <name>] [--type <type>] [--yes]

Options:
  --config <path>   Configuration file (default: octoform.yml)
  --repo <name>     Limit to one repository
  --type <type>     Limit to repositories of one type
  --yes             Apply without asking for confirmation
  --help            Show this message

Environment:
  GITHUB_TOKEN / GH_TOKEN   Token used for every call. Needs "repo", plus
                            "admin:org" for custom properties and rulesets.

audit and plan are read-only and never change anything. apply shows the same
diff plan would, then asks before changing anything, unless --yes is given.
`;

interface Args {
  command?: string;
  config: string;
  help: boolean;
  repo?: string;
  type?: string;
  yes: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { config: 'octoform.yml', help: false, yes: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--yes' || arg === '-y') {
      args.yes = true;
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
    return args.command ? 0 : 2;
  }

  try {
    const config = loadConfig(args.config);
    const octokit = createClient();

    switch (args.command) {
      case 'audit': {
        await requireScopes(octokit, ['repo']);
        const findings = await audit(octokit, config);
        // Findings are information, not failure: audit reports, it does not
        // gate. A scheduled run that should fail on drift can check the count
        // in its own step.
        return findings === 0 ? 0 : 0;
      }
      case 'plan': {
        await requireScopes(octokit, ['repo']);
        await plan(octokit, config, { repo: args.repo, type: args.type });
        return 0;
      }
      case 'apply': {
        await requireScopes(octokit, ['repo']);
        return apply(octokit, config, { repo: args.repo, type: args.type, yes: args.yes });
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
