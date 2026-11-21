'use strict';

/**
 * Runnable demo: evaluate the sample flags from examples/flags.json
 * against a few different users, no server needed.
 *
 *   node examples/demo.js
 */
const path = require('node:path');
const { evaluateAll } = require('../src/engine');
const { FlagStore } = require('../src/store');

const store = new FlagStore(path.join(__dirname, 'flags.json'));
const flags = store.list();

const users = [
  { userId: 'user-1', plan: 'free', email: 'a@other.com' },
  { userId: 'user-2', plan: 'enterprise', email: 'b@other.com' },
  { userId: 'user-3', plan: 'free', email: 'c@example.com' },
];

for (const user of users) {
  const results = evaluateAll(flags, user);
  console.log(`\n${user.userId} (${user.plan}, ${user.email}):`);
  for (const result of Object.values(results)) {
    console.log(`  ${result.key}: ${result.value ? 'ON ' : 'OFF'} (${result.reason})`);
  }
}
