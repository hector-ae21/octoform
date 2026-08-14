import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPLICABILITY,
  describeNotApplicable,
  notApplicable,
} from '../src/config/applicability.js';
import type { OwnerScope } from '../src/config/types.js';

const scope = (over: Partial<OwnerScope> = {}): OwnerScope => ({ owner: 'account', ...over });

test('a scope that declares nothing owner-specific has nothing to report', () => {
  assert.deepEqual(notApplicable(scope(), 'user'), []);
  assert.deepEqual(notApplicable(scope(), 'org'), []);
});

test('an organisation-only declaration is reported for a personal account', () => {
  const findings = notApplicable(scope({ classify: { property: 'kind' } }), 'user');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.owner, 'account');
  assert.equal(findings[0]?.path, 'classify.property');
  assert.match(findings[0]?.reason ?? '', /organisation-only/);
});

test('the same declaration is fine for an organisation', () => {
  assert.deepEqual(notApplicable(scope({ classify: { property: 'kind' } }), 'org'), []);
});

test('a declaration that is present but empty is not treated as declared', () => {
  assert.deepEqual(notApplicable(scope({ classify: { rules: [] } }), 'user'), []);
});

test('every registered path names the owner kinds it applies to', () => {
  assert.ok(APPLICABILITY.length > 0);
  for (const entry of APPLICABILITY) {
    assert.ok(entry.appliesTo.length > 0, entry.path);
    assert.ok(
      entry.appliesTo.length < 2,
      `${entry.path} applies everywhere, so it does not belong`,
    );
    assert.ok(entry.reason.length > 0, entry.path);
  }
});

test('a finding is phrased as a sentence naming owner, path and fallback', () => {
  const [finding] = notApplicable(scope({ classify: { property: 'kind' } }), 'user');
  assert.ok(finding);

  const sentence = describeNotApplicable(finding, 'user');
  assert.match(sentence, /"account" is a personal account/);
  assert.match(sentence, /"classify.property" does not apply/);
});
