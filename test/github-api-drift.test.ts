import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const script = resolve(process.cwd(), 'scripts/check-github-api-drift.mjs');

test('an unchanged REST and GraphQL contract passes without rewriting evidence', async () => {
  const result = await runAudit(baselineRest(), [graphqlField('updateRepository')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.report, /REST \| 1 \| 1 \| 0 \| 0 \| 0/);
  assert.match(result.report, /GraphQL mutations \| 1 \| 1 \| 0 \| 0 \| 0/);
  assert.match(result.report, /No contract drift detected/);
});

test('new operations and structural contract changes require review', async () => {
  const current = baselineRest();
  const repositoryPath = current.paths['/repos/{owner}/{repo}'];
  assert.ok(repositoryPath);
  repositoryPath.post = {
    operationId: 'repos/update',
    responses: { '200': { description: 'Updated' } },
  };
  current.components.schemas.Repository.properties.id.type = 'string';
  const result = await runAudit(current, [
    {
      ...graphqlField('updateRepository'),
      isDeprecated: true,
      deprecationReason: 'Use updateRepo',
    },
    graphqlField('createRepository'),
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.report, /REST \| 1 \| 2 \| 1 \| 0 \| 1/);
  assert.match(result.report, /GraphQL mutations \| 1 \| 2 \| 1 \| 0 \| 1/);
  assert.match(result.report, /POST \/repos\/\{owner\}\/\{repo\}/);
  assert.match(result.report, /createRepository/);
});

async function runAudit(currentRest: RestDescription, graphql: GraphqlField[]) {
  const directory = await mkdtemp(resolve(tmpdir(), 'octoform-api-drift-'));
  try {
    const baselinePath = resolve(directory, 'baseline.json');
    const currentPath = resolve(directory, 'current.json');
    const graphqlPath = resolve(directory, 'graphql.json');
    const configPath = resolve(directory, 'config.json');
    const reportPath = resolve(directory, 'report.md');
    const baseline = Buffer.from(JSON.stringify(baselineRest()));
    await writeFile(baselinePath, baseline);
    await writeFile(currentPath, JSON.stringify(currentRest));
    await writeFile(graphqlPath, JSON.stringify(graphql));
    await writeFile(
      configPath,
      JSON.stringify({
        rest: {
          source: {
            apiVersion: '2026-03-10',
            url: baselinePath,
            driftUrl: currentPath,
            sha256: createHash('sha256').update(baseline).digest('hex'),
          },
          scopePrefixes: ['/repos/{owner}/{repo}'],
        },
        graphql: {
          endpoint: 'https://api.github.com/graphql',
          mutations: [{ name: 'updateRepository', deprecated: false, deprecationReason: null }],
        },
      }),
    );
    const execution = spawnSync(
      process.execPath,
      [
        script,
        '--config',
        configPath,
        '--rest-current',
        currentPath,
        '--graphql-current',
        graphqlPath,
        '--report',
        reportPath,
      ],
      { encoding: 'utf8' },
    );
    return {
      status: execution.status,
      stderr: execution.stderr,
      report: await readFile(reportPath, 'utf8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function baselineRest(): RestDescription {
  return {
    paths: {
      '/repos/{owner}/{repo}': {
        get: {
          operationId: 'repos/get',
          responses: {
            '200': {
              description: 'Repository',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Repository' } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Repository: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer' } },
        },
      },
    },
  };
}

function graphqlField(name: string): GraphqlField {
  return { name, isDeprecated: false, deprecationReason: null };
}

interface GraphqlField {
  name: string;
  isDeprecated: boolean;
  deprecationReason: string | null;
}

interface RestOperation {
  operationId: string;
  responses: Record<string, unknown>;
}

interface RestDescription {
  paths: Record<string, { get: RestOperation; post?: RestOperation }>;
  components: {
    schemas: {
      Repository: {
        type: string;
        required: string[];
        properties: { id: { type: string } };
      };
    };
  };
}
