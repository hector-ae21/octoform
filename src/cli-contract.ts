import type { CliContract } from './types/cli.js';

export type { CliCommandContract, CliContract, CliOptionContract } from './types/cli.js';

/** Canonical metadata used by help output and generated CLI reference data. */
export const CLI_CONTRACT: CliContract = {
  schemaVersion: 1,
  executable: 'octoform',
  summary: 'Declarative governance for GitHub repositories',
  commands: [
    {
      path: ['audit'],
      usage: 'octoform audit      [--config <path>] [--owner <login>]... [--repo <name>] [--fail-fast]',
      summary: 'Inspect repositories and report configured audit findings.',
      mode: 'read-only',
      options: ['config', 'owner', 'repo', 'strict', 'fail-fast', 'help'],
      classicScopes: ['repo'],
    },
    {
      path: ['plan'],
      usage:
        'octoform plan       [--config <path>] [--owner <login>]... [--repo <name>] [--type <type>] [--concurrency <n>] [--fail-fast] [--out <path>] [--expires-in <minutes>]',
      summary: 'Compare desired and observed state without changing GitHub.',
      mode: 'read-only',
      options: [
        'config',
        'owner',
        'repo',
        'type',
        'strict',
        'concurrency',
        'fail-fast',
        'out',
        'expires-in',
        'help',
      ],
      classicScopes: ['repo'],
    },
    {
      path: ['apply'],
      usage:
        'octoform apply      [--config <path>] [--owner <login>]... [--repo <name>] [--type <type>] [--yes] [--concurrency <n>] [--fail-fast] | octoform apply --plan <path> [--yes]',
      summary:
        'Plan again, request confirmation, and apply unblocked changes; or apply exactly a saved plan with --plan.',
      mode: 'confirmed-write',
      options: [
        'config',
        'owner',
        'repo',
        'type',
        'yes',
        'strict',
        'concurrency',
        'fail-fast',
        'plan',
        'help',
      ],
      classicScopes: ['repo'],
    },
    {
      path: ['classify'],
      usage: 'octoform classify   [--config <path>] [--owner <login>]... [--apply] [--fail-fast]',
      summary: 'Propose repository types and optionally write organization property values.',
      mode: 'conditional-write',
      options: ['config', 'owner', 'apply', 'strict', 'fail-fast', 'help'],
      classicScopes: ['repo'],
      mutationClassicScopes: ['repo', 'admin:org'],
    },
    {
      path: ['properties', 'sync'],
      usage: 'octoform properties sync [--config <path>] [--owner <login>]... [--fail-fast]',
      summary: 'Synchronize the organization property schema and declared repository values.',
      mode: 'write',
      options: ['config', 'owner', 'strict', 'fail-fast', 'help'],
      classicScopes: ['repo', 'admin:org'],
    },
    {
      path: ['config', 'validate'],
      usage: 'octoform config validate [--config <path>]',
      summary: 'Load and resolve a configuration, reporting its owners. Never contacts GitHub.',
      mode: 'read-only',
      options: ['config', 'help'],
      classicScopes: [],
    },
    {
      path: ['config', 'migrate'],
      usage: 'octoform config migrate  [--config <path>] [--write]',
      summary:
        'Convert a legacy single-owner file to the multi-owner shape. Never contacts GitHub.',
      mode: 'conditional-write',
      options: ['config', 'write', 'help'],
      classicScopes: [],
      mutationClassicScopes: [],
    },
  ],
  options: [
    {
      id: 'config',
      syntax: '--config <path>',
      description: 'Configuration file',
      default: 'octoform.yml',
    },
    {
      id: 'owner',
      syntax: '--owner <login>',
      description: 'Limit to one declared owner (repeatable)',
    },
    {
      id: 'repo',
      syntax: '--repo <name>',
      description: 'Limit to one repository; accepts "owner/name" to disambiguate',
    },
    { id: 'type', syntax: '--type <type>', description: 'Limit to repositories of one type' },
    { id: 'yes', syntax: '--yes, -y', description: 'Apply without asking for confirmation' },
    {
      id: 'apply',
      syntax: '--apply',
      description: 'Classify: record proposals instead of only printing them',
    },
    {
      id: 'strict',
      syntax: '--strict',
      description: 'Fail when a declaration does not apply to the owner that declared it',
    },
    {
      id: 'write',
      syntax: '--write',
      description: 'config migrate: update the file in place instead of only printing it',
    },
    {
      id: 'concurrency',
      syntax: '--concurrency <n>',
      description: 'Repositories planned or applied to at once',
      default: '4',
    },
    {
      id: 'fail-fast',
      syntax: '--fail-fast',
      description: 'Stop at the first owner that fails instead of continuing to the rest',
    },
    {
      id: 'out',
      syntax: '--out <path>',
      description: 'plan: also save the plan as a signed-evidence JSON file apply --plan can consume',
    },
    {
      id: 'plan',
      syntax: '--plan <path>',
      description: 'apply: perform exactly the saved plan instead of planning again',
    },
    {
      id: 'expires-in',
      syntax: '--expires-in <minutes>',
      description: 'plan --out: how long the saved plan remains valid',
      default: '60',
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
    'A configuration that names several owners runs each of them in turn, in the order it names them.',
    'config validate and config migrate never contact GitHub.',
    'By default a failed owner is reported and the rest of the selection continues; --fail-fast stops at the first one.',
    'A run against more than one owner prints a total across every owner it reached.',
    'apply --plan verifies actor, owner identity, source and configuration digests, and expiry before applying anything; a stale or altered plan is refused, never repaired.',
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
