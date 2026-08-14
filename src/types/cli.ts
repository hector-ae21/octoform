/** Types describing the stable customer-facing command-line contract. */

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
