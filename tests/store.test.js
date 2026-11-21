'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FlagStore } = require('../src/store');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flagforge-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new FlagStore(path.join(dir, 'flags.json')) };
}

test('missing file loads as an empty store', (t) => {
  const { store } = tempStore(t);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('nope'), null);
});

test('add / get / update / remove round-trip through disk', (t) => {
  const { dir, store } = tempStore(t);
  store.add({ key: 'a', name: 'A', defaultValue: true });
  store.add({ key: 'b', defaultValue: false });

  // A fresh store instance sees the same data: it really was persisted.
  const reopened = new FlagStore(path.join(dir, 'flags.json'));
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.get('a').name, 'A');

  const updated = store.update('a', { defaultValue: false });
  assert.equal(updated.defaultValue, false);
  assert.equal(reopened.get('a').defaultValue, false);

  const removed = store.remove('b');
  assert.equal(removed.key, 'b');
  assert.deepEqual(store.list().map((f) => f.key), ['a']);
});

test('duplicate keys and unknown keys fail with clear errors', (t) => {
  const { store } = tempStore(t);
  store.add({ key: 'a' });
  assert.throws(() => store.add({ key: 'a' }), /already exists/);
  assert.throws(() => store.update('missing', { enabled: false }), /does not exist/);
  assert.throws(() => store.remove('missing'), /does not exist/);
});

test('save is atomic: no temp files left behind, file stays valid JSON', (t) => {
  const { dir, store } = tempStore(t);
  for (let i = 0; i < 5; i += 1) {
    store.add({ key: `flag-${i}` });
  }
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'flags.json'), 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.flags.length, 5);
});

test('corrupt flags file fails loudly instead of silently emptying', (t) => {
  const { dir, store } = tempStore(t);
  fs.writeFileSync(path.join(dir, 'flags.json'), '{not json');
  assert.throws(() => store.list(), /corrupt flags file/);
  fs.writeFileSync(path.join(dir, 'flags.json'), JSON.stringify({ flags: 'nope' }));
  assert.throws(() => store.list(), /corrupt flags file/);
});

test('audit log records every mutation in order', (t) => {
  const { store } = tempStore(t);
  assert.deepEqual(store.readAudit(), []);
  store.add({ key: 'a' }, 'alice');
  store.update('a', { enabled: false }, 'bob');
  store.remove('a', 'alice');
  const entries = store.readAudit();
  assert.deepEqual(entries.map((e) => e.action), ['create', 'update', 'delete']);
  assert.deepEqual(entries.map((e) => e.actor), ['alice', 'bob', 'alice']);
  assert.ok(entries.every((e) => typeof e.ts === 'string'));
  assert.equal(store.readAudit(2).length, 2);
});
