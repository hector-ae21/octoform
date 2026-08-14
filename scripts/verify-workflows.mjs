import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflowDirectory = resolve(root, '.github', 'workflows');
const workflowNames = (await readdir(workflowDirectory))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();
const violations = [];

for (const workflowName of workflowNames) {
  const path = resolve(workflowDirectory, workflowName);
  const source = await readFile(path, 'utf8');
  const workflow = parse(source);
  const label = `.github/workflows/${workflowName}`;

  if (!isObject(workflow)) {
    violations.push(`${label}: workflow root must be a mapping`);
    continue;
  }
  if (!isObject(workflow.permissions) || Object.keys(workflow.permissions).length !== 0) {
    violations.push(`${label}: top-level permissions must be an empty mapping`);
  }
  if (!isObject(workflow.concurrency) || typeof workflow.concurrency.group !== 'string') {
    violations.push(`${label}: concurrency must define a group`);
  }
  if (!isObject(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
    violations.push(`${label}: jobs must be a non-empty mapping`);
    continue;
  }

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const jobLabel = `${label}:${jobName}`;
    if (!isObject(job)) {
      violations.push(`${jobLabel}: job must be a mapping`);
      continue;
    }
    if (!Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] <= 0) {
      violations.push(`${jobLabel}: timeout-minutes must be a positive integer`);
    }
    if (!isObject(job.permissions)) {
      violations.push(`${jobLabel}: permissions must be an explicit mapping`);
    }
    if (!Array.isArray(job.steps)) {
      violations.push(`${jobLabel}: steps must be an array`);
      continue;
    }

    for (const [index, step] of job.steps.entries()) {
      if (!isObject(step) || typeof step.uses !== 'string') continue;
      const stepLabel = `${jobLabel}:step ${index + 1}`;
      const reference = step.uses;
      if (!reference.startsWith('./') && !/@[0-9a-f]{40}$/.test(reference)) {
        violations.push(`${stepLabel}: external action must use a complete commit SHA`);
      }
      if (reference.startsWith('actions/checkout@')) {
        if (!isObject(step.with) || typeof step.with['persist-credentials'] !== 'boolean') {
          violations.push(`${stepLabel}: checkout must set persist-credentials explicitly`);
        }
      }
      if (reference.startsWith('actions/setup-node@') && step.with?.cache === 'npm') {
        if (step.with['cache-dependency-path'] !== 'package-lock.json') {
          violations.push(`${stepLabel}: npm cache must be keyed by package-lock.json`);
        }
      }
    }
  }

  if (workflowName === 'api-contract-drift.yml') {
    verifyContractDriftWorkflow(workflow, label, source, violations);
  }
}

if (violations.length > 0) {
  throw new Error(
    `Workflow policy violations:\n${violations.map((violation) => `- ${violation}`).join('\n')}`,
  );
}

console.log(`${workflowNames.length} workflows satisfy the security and reproducibility policy.`);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verifyContractDriftWorkflow(workflow, label, source, violations) {
  const audit = workflow.jobs?.audit;
  if (!isObject(audit)) return;
  if (audit.permissions?.contents !== 'read' || audit.permissions?.issues !== 'write') {
    violations.push(`${label}:audit must limit permissions to contents:read and issues:write`);
  }

  const compare = audit.steps?.find((step) => step?.id === 'compare');
  if (!isObject(compare) || compare['continue-on-error'] !== true) {
    violations.push(`${label}:audit must preserve the comparison outcome for issue reporting`);
  }

  for (const required of [
    'gh issue create',
    'gh issue edit',
    'gh issue close',
    "steps.compare.outcome == 'failure'",
    'run: exit 1',
  ]) {
    if (!source.includes(required)) {
      violations.push(`${label}:audit is missing actionable drift behavior: ${required}`);
    }
  }
}
