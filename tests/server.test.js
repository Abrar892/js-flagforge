'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FlagStore } = require('../src/store');
const { startServer } = require('../src/server');

async function runningServer(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flagforge-server-'));
  const store = new FlagStore(path.join(dir, 'flags.json'));
  store.add({
    key: 'beta',
    name: 'Beta',
    defaultValue: false,
    rules: [{ when: { attribute: 'plan', operator: 'eq', value: 'pro' }, value: true }],
  });
  const server = await startServer(store, { port: 0, ...options });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store };
}

async function json(res) {
  return res.json();
}

test('health reports the flag count', async (t) => {
  const { base } = await runningServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { status: 'ok', flags: 1 });
});

test('CRUD over the API', async (t) => {
  const { base } = await runningServer(t);

  const created = await fetch(`${base}/flags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'dark-mode', defaultValue: true }),
  });
  assert.equal(created.status, 201);
  assert.equal((await json(created)).flag.key, 'dark-mode');

  const duplicate = await fetch(`${base}/flags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'dark-mode' }),
  });
  assert.equal(duplicate.status, 409);

  const listed = await json(await fetch(`${base}/flags`));
  assert.equal(listed.flags.length, 2);

  const one = await json(await fetch(`${base}/flags/dark-mode`));
  assert.equal(one.flag.defaultValue, true);

  const patched = await fetch(`${base}/flags/dark-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await json(patched)).flag.enabled, false);

  const missing = await fetch(`${base}/flags/nope`);
  assert.equal(missing.status, 404);

  const deleted = await fetch(`${base}/flags/dark-mode`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await json(await fetch(`${base}/flags`))).flags.length, 1);
});

test('evaluate and batch evaluate resolve flags', async (t) => {
  const { base } = await runningServer(t);

  const pro = await fetch(`${base}/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'beta', context: { plan: 'pro' } }),
  });
  assert.deepEqual(await json(pro), { key: 'beta', value: true, reason: 'rule:0' });

  const free = await fetch(`${base}/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'beta', context: { plan: 'free' } }),
  });
  assert.deepEqual(await json(free), { key: 'beta', value: false, reason: 'default' });

  const unknown = await fetch(`${base}/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'nope', context: {} }),
  });
  assert.equal(unknown.status, 404);

  const batch = await fetch(`${base}/evaluate/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ key: 'beta', context: { plan: 'pro' } }] }),
  });
  const batchBody = await json(batch);
  assert.equal(batchBody.results.beta.value, true);

  const badBatch = await fetch(`${base}/evaluate/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ key: 'nope' }] }),
  });
  assert.equal(badBatch.status, 404);
});

test('invalid JSON and unknown routes return 400/404', async (t) => {
  const { base } = await runningServer(t);
  const badJson = await fetch(`${base}/flags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(badJson.status, 400);
  const unknownRoute = await fetch(`${base}/nothing-here`);
  assert.equal(unknownRoute.status, 404);
});

test('bearer token protects every route except /health', async (t) => {
  const { base } = await runningServer(t, { token: 's3cret' });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const noToken = await fetch(`${base}/flags`);
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${base}/flags`, {
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(wrongToken.status, 401);
  const good = await fetch(`${base}/flags`, {
    headers: { authorization: 'Bearer s3cret' },
  });
  assert.equal(good.status, 200);
});

test('audit endpoint lists mutations', async (t) => {
  const { base } = await runningServer(t);
  await fetch(`${base}/flags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'extra' }),
  });
  const audit = await json(await fetch(`${base}/audit`));
  assert.ok(audit.entries.some((e) => e.action === 'create' && e.key === 'extra'));
});
