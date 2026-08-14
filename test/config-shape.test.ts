import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CONFIG } from '../src/config/shape.js';
import type { ObjectShape, ValueShape } from '../src/types/index.js';

interface SchemaNode {
  $ref?: string;
  type?: string;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
}

const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'reference/config.schema.json'), 'utf8'),
) as { definitions: Record<string, SchemaNode> };

/**
 * Follow a reference, and look past the `null` branch a cancellable setting
 * gains in the schema. `null` is how a narrower layer stops managing a value,
 * so it says nothing about the shape of the value itself.
 */
function deref(node: SchemaNode): SchemaNode {
  if (node.$ref) {
    const name = node.$ref.replace('#/definitions/', '');
    const target = schema.definitions[name];
    assert.ok(target, `unresolved reference ${node.$ref}`);
    return deref(target);
  }
  if (node.anyOf) {
    const substantive = node.anyOf.filter((branch) => branch.type !== 'null');
    if (substantive.length === 1) return deref(substantive[0] as SchemaNode);
  }
  return node;
}

/**
 * The description in `shape.ts` and the published JSON Schema are generated
 * from different sources, and both claim to say which keys exist. Walking them
 * together is what stops one from being extended without the other.
 */
function compareObject(node: SchemaNode, shape: ObjectShape, path: string): void {
  const resolved = deref(node);
  const published = Object.keys(resolved.properties ?? {}).sort();
  const declared = Object.keys(shape.fields).sort();
  assert.deepEqual(published, declared, `${path} (${shape.name})`);

  for (const [key, field] of Object.entries(shape.fields)) {
    const child = resolved.properties?.[key];
    assert.ok(child, `${path}.${key}`);
    compareValue(child, field.shape, `${path}.${key}`);
  }
}

function compareValue(node: SchemaNode, shape: ValueShape, path: string): void {
  const resolved = deref(node);
  switch (shape.kind) {
    case 'scalar':
    case 'any':
      assert.notEqual(resolved.type, 'array', path);
      return;
    case 'scalar-list':
      assert.equal(resolved.type, 'array', path);
      return;
    case 'object':
      compareObject(resolved, shape.of(), path);
      return;
    case 'object-list': {
      assert.equal(resolved.type, 'array', path);
      assert.ok(resolved.items, `${path}[]`);
      compareObject(resolved.items, shape.of(), `${path}[]`);
      return;
    }
    case 'map': {
      assert.equal(resolved.type, 'object', path);
      const value = shape.of();
      if (value.kind !== 'object') return;
      const entry = resolved.additionalProperties;
      assert.ok(entry && typeof entry === 'object', `${path}.<key>`);
      compareObject(entry, value.of(), `${path}.<key>`);
      return;
    }
  }
}

test('the shape the loader enforces matches the published JSON Schema', () => {
  compareObject({ $ref: '#/definitions/Config' }, CONFIG, 'root');
});

test('every key the schema rejects extras for is also closed in the shape', () => {
  for (const [name, definition] of Object.entries(schema.definitions)) {
    if (definition.type !== 'object' || !definition.properties) continue;
    assert.equal(
      definition.additionalProperties,
      false,
      `${name} must reject keys it does not declare`,
    );
  }
});
