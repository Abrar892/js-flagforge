'use strict';

/**
 * Flag evaluation engine.
 *
 * A flag is a plain object:
 *
 *   {
 *     key: 'new-checkout',            // required, [a-z0-9][a-z0-9_-]*
 *     name: 'New checkout flow',     // human-readable label
 *     description: '...',             // optional
 *     enabled: true,                  // kill switch; false forces value false
 *     defaultValue: false,            // fallback when nothing else matches
 *     rules: [                        // first matching rule wins
 *       { when: { attribute: 'plan', operator: 'eq', value: 'enterprise' },
 *         value: true }
 *     ],
 *     rollout: { percentage: 25, attribute: 'userId' },  // optional
 *     environments: {                 // per-environment overrides
 *       production: { enabled: true, rules: [...], rollout: {...} }
 *     }
 *   }
 *
 * Evaluation order: kill switch -> environment override -> rules (in
 * order) -> percentage rollout -> default value. Every result carries a
 * `reason` so callers can explain why a flag resolved the way it did.
 */

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const OPERATORS = new Set([
  'eq', 'ne', 'in', 'notIn',
  'gt', 'gte', 'lt', 'lte',
  'contains', 'startsWith', 'endsWith',
]);

/**
 * FNV-1a 32-bit hash. Small, fast and deterministic across processes, so
 * a subject's rollout bucket is stable no matter which server evaluates it.
 */
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    // Math.imul keeps the multiplication in 32-bit integer arithmetic.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Bucket 0-99 a subject falls into for a given flag key. */
function bucketFor(flagKey, subject) {
  return fnv1a32(`${flagKey}:${String(subject)}`) % 100;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCondition(condition, where) {
  if (!isPlainObject(condition)) {
    throw new Error(`${where}: condition must be an object`);
  }
  if (typeof condition.attribute !== 'string' || condition.attribute.length === 0) {
    throw new Error(`${where}: condition.attribute must be a non-empty string`);
  }
  if (!OPERATORS.has(condition.operator)) {
    throw new Error(
      `${where}: unknown operator '${condition.operator}' ` +
      `(expected one of ${[...OPERATORS].join(', ')})`,
    );
  }
  if (!('value' in condition)) {
    throw new Error(`${where}: condition.value is required`);
  }
  if ((condition.operator === 'in' || condition.operator === 'notIn')
    && !Array.isArray(condition.value)) {
    throw new Error(`${where}: operator '${condition.operator}' needs an array value`);
  }
}

function validateRollout(rollout, where) {
  if (!isPlainObject(rollout)) {
    throw new Error(`${where}: rollout must be an object`);
  }
  if (!Number.isInteger(rollout.percentage)
    || rollout.percentage < 0 || rollout.percentage > 100) {
    throw new Error(`${where}: rollout.percentage must be an integer between 0 and 100`);
  }
  if (typeof rollout.attribute !== 'string' || rollout.attribute.length === 0) {
    throw new Error(`${where}: rollout.attribute must be a non-empty string`);
  }
}

function validateFlagConfig(config, where) {
  if (!isPlainObject(config)) {
    throw new Error(`${where}: flag config must be an object`);
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new Error(`${where}: enabled must be a boolean`);
  }
  if (config.defaultValue !== undefined && typeof config.defaultValue !== 'boolean') {
    throw new Error(`${where}: defaultValue must be a boolean`);
  }
  if (config.rules !== undefined) {
    if (!Array.isArray(config.rules)) {
      throw new Error(`${where}: rules must be an array`);
    }
    config.rules.forEach((rule, i) => {
      if (!isPlainObject(rule) || typeof rule.value !== 'boolean') {
        throw new Error(`${where}: rules[${i}] must be an object with a boolean value`);
      }
      validateCondition(rule.when, `${where}: rules[${i}].when`);
    });
  }
  if (config.rollout !== undefined) {
    validateRollout(config.rollout, `${where}: rollout`);
  }
}

/** Validate a whole flag definition; throws an Error describing the problem. */
function validateFlag(flag) {
  if (!isPlainObject(flag)) {
    throw new Error('flag must be an object');
  }
  if (typeof flag.key !== 'string' || !KEY_PATTERN.test(flag.key)) {
    throw new Error(
      "flag.key must be a lowercase slug matching /^[a-z0-9][a-z0-9_-]*$/",
    );
  }
  if (flag.name !== undefined && typeof flag.name !== 'string') {
    throw new Error('flag.name must be a string');
  }
  if (flag.description !== undefined && typeof flag.description !== 'string') {
    throw new Error('flag.description must be a string');
  }
  validateFlagConfig(flag, `flag '${flag.key}'`);
  if (flag.environments !== undefined) {
    if (!isPlainObject(flag.environments)) {
      throw new Error(`flag '${flag.key}': environments must be an object`);
    }
    for (const [env, override] of Object.entries(flag.environments)) {
      validateFlagConfig(override, `flag '${flag.key}' environments.${env}`);
    }
  }
  return flag;
}

function matchCondition(condition, attributes) {
  const actual = attributes[condition.attribute];
  if (actual === undefined) return false;
  const expected = condition.value;

  switch (condition.operator) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'in': return expected.includes(actual);
    case 'notIn': return !expected.includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const b = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (condition.operator === 'gt') return a > b;
      if (condition.operator === 'gte') return a >= b;
      if (condition.operator === 'lt') return a < b;
      return a <= b;
    }
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(expected);
      return false;
    case 'startsWith':
      return typeof actual === 'string' && actual.startsWith(String(expected));
    case 'endsWith':
      return typeof actual === 'string' && actual.endsWith(String(expected));
    default: return false;
  }
}

/**
 * Resolve the effective config for a context: the flag's own fields, with
 * the named environment's overrides applied on top (when present).
 */
function resolveConfig(flag, context) {
  const base = {
    enabled: flag.enabled !== false,
    defaultValue: flag.defaultValue === true,
    rules: Array.isArray(flag.rules) ? flag.rules : [],
    rollout: flag.rollout || null,
  };
  const envName = context && typeof context.environment === 'string'
    ? context.environment
    : null;
  if (envName && flag.environments && isPlainObject(flag.environments[envName])) {
    const override = flag.environments[envName];
    if (override.enabled !== undefined) base.enabled = override.enabled;
    if (override.defaultValue !== undefined) base.defaultValue = override.defaultValue;
    if (override.rules !== undefined) base.rules = override.rules;
    if (override.rollout !== undefined) base.rollout = override.rollout;
  }
  return base;
}

/**
 * Evaluate one flag against a context.
 * Context: { userId?, environment?, attributes?: { ... } }.
 * Attributes may also be given flat on the context object.
 * Returns { key, value, reason } where reason is one of
 * 'disabled' | 'rule:<n>' | 'rollout' | 'default'.
 */
function evaluateFlag(flag, context = {}) {
  validateFlag(flag);
  const ctx = context || {};
  const attributes = {
    ...(isPlainObject(ctx.attributes) ? ctx.attributes : {}),
  };
  // Convenience: top-level context fields other than the reserved ones
  // count as attributes too, so { userId, plan: 'pro' } just works.
  for (const [k, v] of Object.entries(ctx)) {
    if (k !== 'attributes' && k !== 'environment' && !(k in attributes)) {
      attributes[k] = v;
    }
  }

  const config = resolveConfig(flag, ctx);

  if (!config.enabled) {
    return { key: flag.key, value: false, reason: 'disabled' };
  }

  for (let i = 0; i < config.rules.length; i += 1) {
    if (matchCondition(config.rules[i].when, attributes)) {
      return { key: flag.key, value: config.rules[i].value, reason: `rule:${i}` };
    }
  }

  if (config.rollout) {
    const subject = attributes[config.rollout.attribute];
    if (subject !== undefined) {
      const bucket = bucketFor(flag.key, subject);
      return {
        key: flag.key,
        value: bucket < config.rollout.percentage,
        reason: 'rollout',
      };
    }
    // No subject to hash on: fall through to the default value.
  }

  return { key: flag.key, value: config.defaultValue, reason: 'default' };
}

/** Evaluate every flag in an array against the same context. */
function evaluateAll(flags, context = {}) {
  if (!Array.isArray(flags)) {
    throw new Error('flags must be an array');
  }
  const results = {};
  for (const flag of flags) {
    const result = evaluateFlag(flag, context);
    results[result.key] = result;
  }
  return results;
}

module.exports = {
  OPERATORS: [...OPERATORS],
  bucketFor,
  evaluateAll,
  evaluateFlag,
  fnv1a32,
  matchCondition,
  validateFlag,
};
