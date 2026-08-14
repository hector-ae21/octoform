/** A command-line option exposed by Octoform. */
export interface CliOptionContract {
  id: string;
  syntax: string;
  description: string;
  default?: string;
}

/** A supported command or command path. */
export interface CliCommandContract {
  path: string[];
  usage: string;
  summary: string;
  mode: 'read-only' | 'confirmed-write' | 'conditional-write' | 'write';
  options: string[];
  classicScopes: string[];
  mutationClassicScopes?: string[];
}

/** Stable customer-facing command-line contract. */
export interface CliContract {
  schemaVersion: number;
  executable: string;
  summary: string;
  commands: CliCommandContract[];
  options: CliOptionContract[];
  credentials: Array<{
    names: string[];
    sensitive: true;
    description: string;
  }>;
  exitCodes: Array<{
    code: number;
    meaning: string;
  }>;
  notes: string[];
}

/** Canonical metadata used by help output and generated CLI reference data. */
export const CLI_CONTRACT: CliContract = {
  schemaVersion: 1,
  executable: 'octoform',
  summary: 'Declarative governance for GitHub repositories',
  commands: [
    {
      path: ['audit'],
      usage: 'octoform audit      [--config <path>]',
      summary: 'Inspect repositories and report configured audit findings.',
      mode: 'read-only',
      options: ['config', 'help'],
      classicScopes: ['repo'],
    },
    {
      path: ['plan'],
      usage: 'octoform plan       [--config <path>] [--repo <name>] [--type <type>]',
      summary: 'Compare desired and observed state without changing GitHub.',
      mode: 'read-only',
      options: ['config', 'repo', 'type', 'help'],
      classicScopes: ['repo'],
    },
    {
      path: ['apply'],
      usage: 'octoform apply      [--config <path>] [--repo <name>] [--type <type>] [--yes]',
      summary: 'Plan again, request confirmation, and apply unblocked changes.',
      mode: 'confirmed-write',
      options: ['config', 'repo', 'type', 'yes', 'help'],
      classicScopes: ['repo'],
    },
    {
      path: ['classify'],
      usage: 'octoform classify   [--config <path>] [--apply]',
      summary: 'Propose repository types and optionally write organization property values.',
      mode: 'conditional-write',
      options: ['config', 'apply', 'help'],
      classicScopes: ['repo'],
      mutationClassicScopes: ['repo', 'admin:org'],
    },
    {
      path: ['properties', 'sync'],
      usage: 'octoform properties sync [--config <path>]',
      summary: 'Synchronize the organization property schema and declared repository values.',
      mode: 'write',
      options: ['config', 'help'],
      classicScopes: ['repo', 'admin:org'],
    },
  ],
  options: [
    {
      id: 'config',
      syntax: '--config <path>',
      description: 'Configuration file',
      default: 'octoform.yml',
    },
    { id: 'repo', syntax: '--repo <name>', description: 'Limit to one repository' },
    { id: 'type', syntax: '--type <type>', description: 'Limit to repositories of one type' },
    { id: 'yes', syntax: '--yes, -y', description: 'Apply without asking for confirmation' },
    {
      id: 'apply',
      syntax: '--apply',
      description: 'Classify: record proposals instead of only printing them',
    },
    { id: 'help', syntax: '--help, -h', description: 'Show this message' },
  ],
  credentials: [
    {
      names: ['GITHUB_TOKEN', 'GH_TOKEN'],
      sensitive: true,
      description: 'Token used for GitHub API calls. The first defined variable wins.',
    },
  ],
  exitCodes: [
    { code: 0, meaning: 'The command or help request completed successfully.' },
    {
      code: 1,
      meaning: 'Configuration, authentication, capability, or GitHub API execution failed.',
    },
    { code: 2, meaning: 'The command line is missing or invalid.' },
  ],
  notes: [
    'audit, plan, and classify without --apply are read-only.',
    'apply displays the current plan and requests confirmation unless --yes is present.',
    'Fine-grained tokens are authorized by GitHub per endpoint because they do not expose classic scope headers.',
  ],
};

/** Render terminal help from the same contract used by generated reference data. */
export function renderUsage(contract: CliContract = CLI_CONTRACT): string {
  const optionWidth = Math.max(...contract.options.map((option) => option.syntax.length)) + 3;
  const options = contract.options
    .map((option) => {
      const suffix = option.default ? ` (default: ${option.default})` : '';
      return `  ${option.syntax.padEnd(optionWidth)}${option.description}${suffix}`;
    })
    .join('\n');
  const credentials = contract.credentials
    .map((credential) => `  ${credential.names.join(' / ')}   ${credential.description}`)
    .join('\n');

  const summary = `${contract.summary.slice(0, 1).toLowerCase()}${contract.summary.slice(1)}`;

  return `${contract.executable} - ${summary}

Usage:
${contract.commands.map((command) => `  ${command.usage}`).join('\n')}

Options:
${options}

Environment:
${credentials}

${contract.notes.join('\n')}
`;
}
