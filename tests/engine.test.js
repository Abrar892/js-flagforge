'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bucketFor,
  evaluateAll,
  evaluateFlag,
  validateFlag,
} = require('../src/engine');

test('kill switch forces OFF even when the default is true', () => {
  const result = evaluateFlag(
    { key: 'x', enabled: false, defaultValue: true },
    {},
  );
  assert.deepEqual(result, { key: 'x', value: false, reason: 'disabled' });
});

test('default value is used when nothing else matches', () => {
  assert.equal(evaluateFlag({ key: 'x', defaultValue: true }, {}).value, true);
  assert.equal(evaluateFlag({ key: 'x' }, {}).value, false);
  assert.equal(evaluateFlag({ key: 'x' }, {}).reason, 'default');
});

test('first matching rule wins, in order', () => {
  const flag = {
    key: 'x',
    defaultValue: false,
    rules: [
      { when: { attribute: 'plan', operator: 'eq', value: 'free' }, value: false },
      { when: { attribute: 'plan', operator: 'eq', value: 'pro' }, value: true },
    ],
  };
  assert.equal(evaluateFlag(flag, { plan: 'pro' }).reason, 'rule:1');
  assert.equal(evaluateFlag(flag, { plan: 'free' }).value, false);
  assert.equal(evaluateFlag(flag, { plan: 'team' }).reason, 'default');
});

test('comparison and string operators', () => {
  const cases = [
    [{ attribute: 'age', operator: 'gt', value: 18 }, { age: 21 }, true],
    [{ attribute: 'age', operator: 'gte', value: 18 }, { age: 18 }, true],
    [{ attribute: 'age', operator: 'lt', value: 18 }, { age: 18 }, false],
    [{ attribute: 'age', operator: 'lte', value: 18 }, { age: 17 }, true],
    [{ attribute: 'age', operator: 'gt', value: 18 }, { age: 'old' }, false],
    [{ attribute: 'role', operator: 'in', value: ['admin', 'mod'] }, { role: 'mod' }, true],
    [{ attribute: 'role', operator: 'notIn', value: ['banned'] }, { role: 'mod' }, true],
    [{ attribute: 'role', operator: 'ne', value: 'banned' }, { role: 'mod' }, true],
    [{ attribute: 'email', operator: 'contains', value: '@acme' }, { email: 'a@acme.co' }, true],
    [{ attribute: 'email', operator: 'startsWith', value: 'ops' }, { email: 'ops@acme.co' }, true],
    [{ attribute: 'email', operator: 'endsWith', value: '.co' }, { email: 'a@acme.co' }, true],
    [{ attribute: 'tags', operator: 'contains', value: 'beta' }, { tags: ['beta'] }, true],
    [{ attribute: 'missing', operator: 'eq', value: 1 }, {}, false],
  ];
  for (const [condition, attrs, expected] of cases) {
    const flag = {
      key: 'x',
      defaultValue: false,
      rules: [{ when: condition, value: true }],
    };
    assert.equal(evaluateFlag(flag, attrs).value, expected, JSON.stringify(condition));
  }
});

test('percentage rollout is deterministic per subject', () => {
  const flag = {
    key: 'rollout-flag',
    defaultValue: false,
    rollout: { percentage: 50, attribute: 'userId' },
  };
  for (const subject of ['user-1', 'user-2', 'alice', 'bob-123']) {
    const first = evaluateFlag(flag, { userId: subject });
    const second = evaluateFlag(flag, { userId: subject });
    assert.equal(first.value, second.value);
    assert.equal(first.reason, 'rollout');
    assert.equal(first.value, bucketFor('rollout-flag', subject) < 50);
  }
});

test('rollout distribution roughly matches the percentage', () => {
  const flag = {
    key: 'dist-flag',
    defaultValue: false,
    rollout: { percentage: 25, attribute: 'userId' },
  };
  let on = 0;
  const total = 2000;
  for (let i = 0; i < total; i += 1) {
    if (evaluateFlag(flag, { userId: `user-${i}` }).value) on += 1;
  }
  const share = on / total;
  assert.ok(share > 0.18 && share < 0.32, `expected ~25% on, got ${(share * 100).toFixed(1)}%`);
});

test('rollout without a subject falls back to the default value', () => {
  const flag = {
    key: 'x',
    defaultValue: true,
    rollout: { percentage: 10, attribute: 'userId' },
  };
  assert.deepEqual(evaluateFlag(flag, {}), { key: 'x', value: true, reason: 'default' });
});

test('environment overrides replace rules, rollout and kill switch', () => {
  const flag = {
    key: 'x',
    enabled: true,
    defaultValue: false,
    rules: [{ when: { attribute: 'plan', operator: 'eq', value: 'pro' }, value: true }],
    environments: {
      production: { enabled: false },
      staging: { defaultValue: true, rules: [] },
    },
  };
  assert.equal(evaluateFlag(flag, { environment: 'production', plan: 'pro' }).value, false);
  assert.equal(evaluateFlag(flag, { environment: 'staging' }).value, true);
  assert.equal(evaluateFlag(flag, { environment: 'development', plan: 'pro' }).value, true);
});

test('attributes may be nested under `attributes` or flat on the context', () => {
  const flag = {
    key: 'x',
    defaultValue: false,
    rules: [{ when: { attribute: 'plan', operator: 'eq', value: 'pro' }, value: true }],
  };
  assert.equal(evaluateFlag(flag, { attributes: { plan: 'pro' } }).value, true);
  assert.equal(evaluateFlag(flag, { plan: 'pro' }).value, true);
});

test('validateFlag rejects bad keys, operators and rollouts', () => {
  assert.throws(() => validateFlag({ key: 'Bad Key' }), /flag\.key/);
  assert.throws(() => validateFlag({ key: 'ok', rules: [{ when: { attribute: 'a', operator: 'like', value: 1 }, value: true }] }), /unknown operator/);
  assert.throws(() => validateFlag({ key: 'ok', rollout: { percentage: 101, attribute: 'userId' } }), /percentage/);
  assert.throws(() => validateFlag({ key: 'ok', rollout: { percentage: 50 } }), /rollout\.attribute/);
  assert.throws(() => validateFlag({ key: 'ok', rules: [{ when: { attribute: 'a', operator: 'in', value: 'x' }, value: true }] }), /array value/);
  assert.doesNotThrow(() => validateFlag({ key: 'ok-1_x', enabled: true, defaultValue: false }));
});

test('evaluateAll evaluates every flag against one context', () => {
  const results = evaluateAll([
    { key: 'a', defaultValue: true },
    { key: 'b', enabled: false, defaultValue: true },
  ], {});
  assert.equal(results.a.value, true);
  assert.equal(results.b.value, false);
  assert.throws(() => evaluateAll({}), /array/);
});
