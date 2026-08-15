import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dueDate,
  dueTimestamp,
  isCleared,
  matchByName,
  normalizeColor,
  sameLabel,
  sameMilestone,
  samePropertyValue,
} from '../src/core/collections.js';
import type { ExistingLabel, ExistingMilestone } from '../src/types/index.js';

const label = (over: Partial<ExistingLabel> = {}): ExistingLabel => ({
  name: 'bug',
  color: 'd73a4a',
  description: 'Something is broken',
  default: true,
  ...over,
});

const milestone = (over: Partial<ExistingMilestone> = {}): ExistingMilestone => ({
  number: 4,
  title: 'v1.0',
  description: 'First stable release',
  state: 'open',
  due: '2026-03-01',
  ...over,
});

test('a colour compares the way GitHub stores it, however it was written', () => {
  assert.equal(normalizeColor('#D73A4A'), 'd73a4a');
  assert.equal(normalizeColor('d73a4a'), 'd73a4a');
  assert.ok(sameLabel(label(), { name: 'bug', color: '#D73A4A' }));
});

test('only what a label declares is compared', () => {
  assert.ok(sameLabel(label(), { name: 'bug' }));
  assert.equal(sameLabel(label(), { name: 'bug', description: 'Other' }), false);
  assert.equal(sameLabel(label({ description: null }), { name: 'bug', description: '' }), true);
});

test('a due date is compared as a day, not as the timestamp GitHub chose', () => {
  assert.equal(dueDate('2026-03-01T07:00:00Z'), '2026-03-01');
  assert.equal(dueDate(null), undefined);
  assert.equal(dueTimestamp('2026-03-01'), '2026-03-01T00:00:00Z');
  assert.ok(
    sameMilestone(milestone(), { title: 'v1.0', due: '2026-03-01' }),
    'so a time nobody asked for is not a difference',
  );
  assert.equal(sameMilestone(milestone(), { title: 'v1.0', due: '2026-03-02' }), false);
});

test('a milestone compares only what it declares, state included', () => {
  assert.ok(sameMilestone(milestone(), { title: 'v1.0' }));
  assert.equal(sameMilestone(milestone(), { title: 'v1.0', state: 'closed' }), false);
});

test('the declared name wins, and rename_from is only consulted when nothing has it', () => {
  const existing = new Map([
    ['defect', label({ name: 'defect' })],
    ['bug', label()],
  ]);

  assert.deepEqual(matchByName(existing, 'bug', ['defect']), { entry: label() });
  assert.deepEqual(
    matchByName(new Map([['defect', label({ name: 'defect' })]]), 'bug', ['defect']),
    {
      entry: label({ name: 'defect' }),
      renamedFrom: 'defect',
    },
  );
  assert.equal(matchByName(new Map(), 'bug', ['defect']), undefined);
});

test('a multi-select property is a set, not an ordered list', () => {
  assert.ok(samePropertyValue(['b', 'a'], ['a', 'b']));
  assert.equal(samePropertyValue(['a'], ['a', 'b']), false);
  assert.ok(samePropertyValue('platform', 'platform'));
  assert.equal(samePropertyValue(undefined, 'platform'), false);
});

test('an empty value asks for the property to be unset, the way an empty description does', () => {
  assert.ok(isCleared(''));
  assert.ok(isCleared([]));
  assert.equal(isCleared('platform'), false);
  assert.ok(samePropertyValue(undefined, ''), 'already unset, so nothing to do');
  assert.equal(samePropertyValue('platform', ''), false);
});
