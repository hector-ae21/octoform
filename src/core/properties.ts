/**
 * Custom properties: the definitions an organisation writes, and the values
 * its repositories answer with.
 *
 * The two are one subject because GitHub keeps them on one feature, but they
 * behave nothing alike. A value is a field on a repository. A definition is
 * replaced wholesale on every write — GitHub's own words are that missing
 * optional values "will fall back to default values, previous values will be
 * overwritten" — so sending only the field a policy mentions is how a
 * corrected description silently resets who may edit the values.
 *
 * Everything here exists to make that not happen: the current definition is
 * read, the declared fields are laid over it, and the union is what goes back.
 * A definition that could not be read is a definition that cannot be written,
 * because there would be nothing to carry forward.
 */

import type {
  Change,
  ExistingProperty,
  PropertyDefinition,
  PropertyValue,
} from '../types/index.js';

/** How many repositories the organisation-wide value endpoint takes at once. */
export const MAX_REPOSITORIES_PER_BATCH = 30;

/** How many values a select may offer, as GitHub documents the field. */
export const MAX_ALLOWED_VALUES = 200;

/** The fields of a definition, in the order the report reads them out. */
const DEFINITION_FIELDS = [
  'value_type',
  'description',
  'required',
  'default_value',
  'allowed_values',
  'values_editable_by',
  'require_explicit_values',
] as const;

/**
 * A definition as GitHub returns it, reduced to what octoform compares.
 *
 * `source_type` is kept although nothing is compared against it: a property an
 * enterprise defined is visible to the organisation and refuses to be changed
 * by it, and the difference is not otherwise in the payload.
 */
export function readDefinition(raw: {
  property_name?: string;
  value_type?: string;
  description?: string | null;
  required?: boolean;
  default_value?: string | string[] | null;
  allowed_values?: string[] | null;
  values_editable_by?: string | null;
  require_explicit_values?: boolean;
  source_type?: string;
}): ExistingProperty | undefined {
  if (!raw.property_name || !raw.value_type) return undefined;
  return {
    name: raw.property_name,
    value_type: raw.value_type as ExistingProperty['value_type'],
    description: raw.description ?? null,
    required: raw.required === true,
    default_value: raw.default_value ?? null,
    allowed_values: raw.allowed_values ?? null,
    values_editable_by: (raw.values_editable_by ?? null) as ExistingProperty['values_editable_by'],
    require_explicit_values: raw.require_explicit_values === true,
    source_type: raw.source_type === 'enterprise' ? 'enterprise' : 'organization',
  };
}

/**
 * The body that creates or replaces a definition.
 *
 * A field the policy does not state takes the value the organisation already
 * has, which is the whole point: the endpoint replaces, so anything left out
 * of the body is not left alone, it is reset.
 *
 * @param declared - The definition as the configuration states it.
 * @param current - The definition as it stands, absent when creating.
 */
export function definitionBody(
  declared: PropertyDefinition,
  current: ExistingProperty | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { value_type: declared.value_type };

  /**
   * An empty value is left out rather than sent. On an endpoint that replaces,
   * leaving a field out is how it is cleared, so "unset it" and "do not send
   * it" are the same request and there is no second spelling to get wrong.
   */
  const carry = <T>(field: string, stated: T | undefined, held: T | undefined): void => {
    const value = stated !== undefined ? stated : held;
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && value.length === 0) return;
    body[field] = value;
  };

  carry('description', declared.description, current?.description ?? undefined);
  carry('required', declared.required ?? current?.required, undefined);
  carry('default_value', declared.default_value, current?.default_value ?? undefined);
  carry('allowed_values', declared.allowed_values, current?.allowed_values ?? undefined);
  carry(
    'values_editable_by',
    declared.values_editable_by,
    current?.values_editable_by ?? undefined,
  );
  carry(
    'require_explicit_values',
    declared.require_explicit_values ?? current?.require_explicit_values,
    undefined,
  );

  return body;
}

/**
 * Whether writing the declared definition would change anything.
 *
 * The comparison is between what stands and what the write would produce, not
 * between what stands and what the file mentions. Those differ precisely
 * because the write replaces: a field nobody declared can still be about to
 * change, and a run that compared only the declared fields would not say so.
 */
export function sameDefinition(current: ExistingProperty, declared: PropertyDefinition): boolean {
  return canonical(definitionBody(declared, current)) === canonical(asBody(current));
}

/** A definition in one line, for the report. */
export function describeDefinition(
  definition: PropertyDefinition | ExistingProperty | Record<string, unknown>,
): string {
  const source = definition as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of DEFINITION_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null || value === '') continue;
    if (field === 'value_type') {
      parts.push(String(value));
      continue;
    }
    if (typeof value === 'boolean') {
      if (value) parts.push(field);
      continue;
    }
    parts.push(`${field}=${Array.isArray(value) ? value.join('|') : String(value)}`);
  }
  return parts.join('; ');
}

/**
 * What is wrong with a declared definition on its own terms.
 *
 * Both checks read the file against itself rather than against GitHub. A
 * default outside the allowed values is a contradiction whatever the API would
 * do with it, and a list longer than the documented maximum is a request the
 * endpoint has already said it will not store.
 */
export function definitionProblems(declared: PropertyDefinition): string[] {
  const problems: string[] = [];

  if (declared.allowed_values && declared.allowed_values.length > MAX_ALLOWED_VALUES) {
    problems.push(
      `declares ${declared.allowed_values.length} allowed values, and a property stores at most ${MAX_ALLOWED_VALUES}`,
    );
  }

  const allowed = declared.allowed_values;
  const fallback = declared.default_value;
  if (allowed && fallback !== undefined) {
    const missing = (Array.isArray(fallback) ? fallback : [fallback]).filter(
      (value) => value !== '' && !allowed.includes(value),
    );
    if (missing.length > 0) {
      problems.push(`its default value ${missing.join(', ')} is not one of its allowed values`);
    }
  }

  return problems;
}

/**
 * Split repository changes into the property values that can travel together
 * and everything that has to stay in its repository's own sequence.
 *
 * A value change joins the shared request only when nothing in its repository
 * waits for it and it waits for nothing. That sounds like a technicality and
 * is the whole safety argument: the dependency graph makes a repository being
 * unarchived a prerequisite of everything else it plans, and makes archiving
 * wait for all of them. A value lifted out of that sequence would be sent to a
 * repository that is still archived, or would let a repository be archived
 * over a value that failed.
 *
 * @param planned - Every change that belongs to a repository.
 */
export function separateValues(planned: Change[]): { shared: Change[]; sequential: Change[] } {
  const shared: Change[] = [];
  const sequential: Change[] = [];

  const byRepository = new Map<string, Change[]>();
  for (const change of planned) {
    const list = byRepository.get(change.repo ?? '') ?? [];
    list.push(change);
    byRepository.set(change.repo ?? '', list);
  }

  for (const group of byRepository.values()) {
    const waitedFor = new Set(group.flatMap((change) => change.prerequisites));
    for (const change of group) {
      const free =
        change.key.startsWith('properties.') &&
        change.prerequisites.length === 0 &&
        !waitedFor.has(change.id);
      (free ? shared : sequential).push(change);
    }
  }

  return { shared, sequential };
}

/** One organisation-wide write: the repositories it covers and why. */
export interface ValueBatch {
  repositories: string[];
  properties: Array<{ property_name: string; value: PropertyValue | null }>;
  changes: Change[];
}

/**
 * Group repository value changes into as few writes as the endpoint allows.
 *
 * Repositories travel together only when they are asking for exactly the same
 * values, because the request carries one list of properties for the whole
 * group. That makes a run over a hundred repositories of the same type cost
 * one request instead of a hundred.
 *
 * It also makes the outcome shared. GitHub does not say which repository it
 * objected to, so a failed batch is reported as a failure for every repository
 * in it — the alternative is guessing which one, and a governance tool that
 * guessed would be reporting fiction.
 *
 * @param changes - Planned changes whose key begins with `properties.`.
 * @param limit - Repositories per request; the documented maximum by default.
 */
export function batchPropertyValues(
  changes: Change[],
  limit: number = MAX_REPOSITORIES_PER_BATCH,
): ValueBatch[] {
  const perRepository = new Map<string, Change[]>();
  for (const change of changes) {
    if (change.repo === undefined) continue;
    const list = perRepository.get(change.repo) ?? [];
    list.push(change);
    perRepository.set(change.repo, list);
  }

  const groups = new Map<string, ValueBatch>();
  for (const [repository, held] of perRepository) {
    const properties = held
      .map((change) => {
        const payload = change.payload as { property: string; value: PropertyValue | null };
        return { property_name: payload.property, value: payload.value };
      })
      .sort((a, b) => a.property_name.localeCompare(b.property_name));

    const signature = canonical(properties);
    const group = groups.get(signature) ?? { repositories: [], properties, changes: [] };
    group.repositories.push(repository);
    group.changes.push(...held);
    groups.set(signature, group);
  }

  const batches: ValueBatch[] = [];
  for (const group of groups.values()) {
    for (let start = 0; start < group.repositories.length; start += limit) {
      const repositories = group.repositories.slice(start, start + limit);
      const covered = new Set(repositories);
      batches.push({
        repositories,
        properties: group.properties,
        changes: group.changes.filter((change) => covered.has(change.repo ?? '')),
      });
    }
  }
  return batches;
}

/**
 * A read definition in the shape a write takes.
 *
 * It goes through {@link definitionBody} rather than building the record
 * itself, so that whatever that function decides to leave out it leaves out of
 * both sides. A comparison whose two halves were assembled by different code
 * is a comparison that reports differences nobody can act on.
 */
export function asBody(current: ExistingProperty): Record<string, unknown> {
  return definitionBody(
    {
      value_type: current.value_type,
      ...(current.description === null ? {} : { description: current.description }),
      required: current.required,
      ...(current.default_value === null ? {} : { default_value: current.default_value }),
      ...(current.allowed_values === null ? {} : { allowed_values: current.allowed_values }),
      ...(current.values_editable_by === null
        ? {}
        : { values_editable_by: current.values_editable_by }),
      require_explicit_values: current.require_explicit_values,
    },
    undefined,
  );
}

/** A stable rendering of a value, so two structures compare as their contents. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, held]) => `${key}:${canonical(held)}`).join(',')}}`;
}
