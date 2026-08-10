import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRepo, pathsUsedBy } from '../src/core/classify.js';
import type { ClassifyRule } from '../src/config/types.js';

const facts = (files: Record<string, string | null>, visibility = 'public') => ({
  visibility,
  files,
});

test('every path any rule needs is collected once, without duplicates', () => {
  const rules: ClassifyRule[] = [
    { when: { file_exists: 'package.json', json: { private: true } }, type: 'app' },
    { when: { file_exists: 'package.json' }, type: 'library' },
    { when: { file_exists: 'version.php' }, type: 'plugin' },
  ];
  assert.deepEqual(pathsUsedBy(rules).sort(), ['package.json', 'version.php']);
});

test('a file that is not there does not match', () => {
  const rules: ClassifyRule[] = [{ when: { file_exists: 'version.php' }, type: 'plugin' }];
  assert.equal(classifyRepo(rules, facts({ 'version.php': null })), undefined);
});

test('a file that is there matches when nothing else is asked', () => {
  const rules: ClassifyRule[] = [{ when: { file_exists: 'version.php' }, type: 'plugin' }];
  assert.equal(classifyRepo(rules, facts({ 'version.php': '<?php' })), 'plugin');
});

test('the first matching rule wins, so order in the file decides', () => {
  const rules: ClassifyRule[] = [
    { when: { file_exists: 'package.json', json: { private: true } }, type: 'app' },
    { when: { file_exists: 'package.json' }, type: 'library' },
  ];
  assert.equal(classifyRepo(rules, facts({ 'package.json': '{"private":true}' })), 'app');
  assert.equal(classifyRepo(rules, facts({ 'package.json': '{"name":"x"}' })), 'library');
});

test('a json condition that does not hold falls through to the next rule', () => {
  const rules: ClassifyRule[] = [
    { when: { file_exists: 'package.json', json: { private: true } }, type: 'app' },
    { when: { file_exists: 'package.json' }, type: 'library' },
  ];
  assert.equal(classifyRepo(rules, facts({ 'package.json': '{"private":false}' })), 'library');
});

test('a file that exists but is not valid json is not an error, just not a match', () => {
  const rules: ClassifyRule[] = [
    { when: { file_exists: 'package.json', json: { private: true } }, type: 'app' },
  ];
  assert.equal(classifyRepo(rules, facts({ 'package.json': 'not json at all' })), undefined);
});

test('visibility narrows a rule that would otherwise match', () => {
  const rules: ClassifyRule[] = [
    { when: { file_exists: 'package.json', visibility: 'private' }, type: 'internal' },
  ];
  assert.equal(classifyRepo(rules, facts({ 'package.json': '{}' }, 'public')), undefined);
  assert.equal(classifyRepo(rules, facts({ 'package.json': '{}' }, 'private')), 'internal');
});

test('a rule with an empty condition is a catch-all', () => {
  const rules: ClassifyRule[] = [
    { when: { file_exists: 'version.php' }, type: 'plugin' },
    { when: {}, type: 'other' },
  ];
  assert.equal(classifyRepo(rules, facts({ 'version.php': null })), 'other');
});

test('no rule matching leaves the repository unclassified rather than guessing', () => {
  const rules: ClassifyRule[] = [{ when: { file_exists: 'version.php' }, type: 'plugin' }];
  assert.equal(classifyRepo(rules, facts({})), undefined);
});
