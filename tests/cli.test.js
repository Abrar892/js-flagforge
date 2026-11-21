'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flagforge-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function cli(dir, args, env = {}) {
  return run(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
  });
}

test('init creates a sample flags file, list shows it', async (t) => {
  const dir = tempDir(t);
  const { stdout } = await cli(dir, ['init', '--file', 'flags.json']);
  assert.match(stdout, /created .*flags\.json with 2 sample flags/);
  const listed = await cli(dir, ['list', '--file', 'flags.json']);
  assert.match(listed.stdout, /new-checkout/);
  assert.match(listed.stdout, /dark-mode/);
  const asJson = await cli(dir, ['list', '--file', 'flags.json', '--json']);
  assert.equal(JSON.parse(asJson.stdout).flags.length, 2);
});

test('create, enable/disable and eval round-trip', async (t) => {
  const dir = tempDir(t);
  await cli(dir, ['init', '--file', 'flags.json']);
  await cli(dir, ['create', 'beta-search', '--file', 'flags.json', '--name', 'Beta search', '--default', 'off']);
  const evalOff = await cli(dir, ['eval', 'beta-search', '--file', 'flags.json']);
  assert.match(evalOff.stdout, /beta-search: OFF \(default\)/);
  await cli(dir, ['enable', 'beta-search', '--file', 'flags.json']);
  // enabled only flips the kill switch; the default is still off.
  const stillOff = await cli(dir, ['eval', 'beta-search', '--file', 'flags.json']);
  assert.match(stillOff.stdout, /OFF/);
});

test('eval honours rules and multiple --attr flags', async (t) => {
  const dir = tempDir(t);
  await cli(dir, ['init', '--file', 'flags.json']);
  const ruleHit = await cli(dir, [
    'eval', 'new-checkout', '--file', 'flags.json',
    '--user', 'user-9', '--attr', 'plan=enterprise', '--attr', 'tier=2',
  ]);
  assert.match(ruleHit.stdout, /ON \(rule:0\)/);
  const emailHit = await cli(dir, [
    'eval', 'new-checkout', '--file', 'flags.json',
    '--user', 'user-9', '--attr', 'email=a@example.com',
  ]);
  assert.match(emailHit.stdout, /ON \(rule:1\)/);
  const jsonOut = await cli(dir, [
    'eval', 'new-checkout', '--file', 'flags.json', '--json',
    '--user', 'user-9', '--attr', 'plan=enterprise',
  ]);
  assert.deepEqual(JSON.parse(jsonOut.stdout), {
    key: 'new-checkout',
    value: true,
    reason: 'rule:0',
  });
});

test('errors exit non-zero with a clear message', async (t) => {
  const dir = tempDir(t);
  await cli(dir, ['init', '--file', 'flags.json']);
  await assert.rejects(
    cli(dir, ['eval', 'missing-flag', '--file', 'flags.json']),
    /flag 'missing-flag' not found/,
  );
  await assert.rejects(
    cli(dir, ['create', 'Bad Key', '--file', 'flags.json']),
    /flag\.key/,
  );
  await assert.rejects(
    cli(dir, ['init', '--file', 'flags.json']),
    /already exists/,
  );
  await assert.rejects(cli(dir, ['nonsense']), /unknown command/);
});

test('export prints the flags file as JSON', async (t) => {
  const dir = tempDir(t);
  await cli(dir, ['init', '--file', 'flags.json']);
  const { stdout } = await cli(dir, ['export', '--file', 'flags.json']);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.flags.length, 2);
});
