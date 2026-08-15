import type { Octokit } from '@octokit/rest';
import {
  detectOwnerKind,
  putPropertySchema,
  readPropertyDefinitions,
  readPropertyValues,
  setPropertyValues,
} from '../github/client.js';
import { MAX_REPOSITORIES_PER_BATCH, definitionBody } from '../core/properties.js';
import type { OwnerScope } from '../types/index.js';

/**
 * Bring the custom property that stores each repository's type into line with
 * the configuration: define it if it does not exist, and record the types the
 * file declares under `repos.<name>.type`.
 *
 * The set of allowed values is `Object.keys(types)`, not a separate list. A
 * configuration that declares a policy for `npm-package` has already said
 * `npm-package` is a type; asking for it twice only creates somewhere for the
 * two answers to differ.
 *
 * Organisations only, and not because of an oversight: custom properties are
 * an organisation-level feature and a personal account has no such API. There,
 * `repos.<name>.type` in the configuration file is the only store there is,
 * and it already works without this command.
 */
export async function propertiesSync(octokit: Octokit, scope: OwnerScope): Promise<number> {
  const property = scope.classify?.property;
  if (!property) {
    console.error('No classify.property declared in the configuration — nothing to sync.');
    return 1;
  }

  const kind = await detectOwnerKind(octokit, scope.owner);
  if (kind !== 'org') {
    console.error(
      `"${scope.owner}" is a personal account. Custom properties are an organisation-only ` +
        `feature, so there is nothing to sync — declare types under repos.<name>.type instead.`,
    );
    return 1;
  }

  const allowedValues = Object.keys(scope.types ?? {});
  if (allowedValues.length === 0) {
    console.error(
      'No types declared under "types" — the allowed values of the property are taken from ' +
        'there, so there would be nothing to allow.',
    );
    return 1;
  }

  console.log(`Property "${property}" on ${scope.owner}`);
  console.log(`  allowed values: ${allowedValues.join(', ')}`);

  /**
   * The definition is read before it is written, because the endpoint replaces
   * rather than patches. Sending the allowed values alone would clear the
   * description, the default and who may edit the values — none of which this
   * command has an opinion about, and all of which somebody chose.
   */
  const definitions = await readPropertyDefinitions(octokit, scope.owner);
  if (definitions === undefined) {
    console.error(
      '  schema: FAILED — could not read the current property definitions, and writing one ' +
        'replaces every field of it.',
    );
    return 1;
  }

  try {
    const body = definitionBody(
      { value_type: 'single_select', allowed_values: allowedValues },
      definitions[property],
    );
    await putPropertySchema(octokit, scope.owner, property, body);
    console.log('  schema: up to date');
  } catch (error) {
    console.error(`  schema: FAILED — ${(error as Error).message}`);
    return 1;
  }

  const declared = new Map<string, string>();
  for (const [name, entry] of Object.entries(scope.repos ?? {})) {
    if (entry?.type) declared.set(name, entry.type);
  }

  if (declared.size === 0) {
    console.log('\nNo repos.<name>.type declared, so no values to record.');
    return 0;
  }

  const current = await readPropertyValues(octokit, scope.owner, property);
  const byType = new Map<string, string[]>();
  for (const [repo, type] of declared) {
    if (current.get(repo) === type) continue;
    const list = byType.get(type) ?? [];
    list.push(repo);
    byType.set(type, list);
  }

  if (byType.size === 0) {
    console.log('\nEvery declared type is already recorded. Nothing to do.');
    return 0;
  }

  console.log('');
  let failures = 0;
  for (const [type, repos] of byType) {
    /**
     * The endpoint takes thirty repositories at a time, and an organisation
     * with more than thirty of one type is the ordinary case rather than the
     * edge one — sending them all in a single request would fail for the
     * organisations that most need this command.
     */
    for (let start = 0; start < repos.length; start += MAX_REPOSITORIES_PER_BATCH) {
      const batch = repos.slice(start, start + MAX_REPOSITORIES_PER_BATCH);
      try {
        await setPropertyValues(octokit, scope.owner, batch, [
          { property_name: property, value: type },
        ]);
        console.log(`  ${type}: ${batch.join(', ')}`);
      } catch (error) {
        failures++;
        console.log(`  ${type}: FAILED — ${(error as Error).message}`);
      }
    }
  }

  console.log('');
  console.log(failures === 0 ? 'Property values recorded.' : `${failures} failed — see above.`);
  return failures === 0 ? 0 : 1;
}
