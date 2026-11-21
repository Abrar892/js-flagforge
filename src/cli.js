#!/usr/bin/env node
'use strict';

/**
 * flagforge CLI — manage flags in a local flags file and serve them over HTTP.
 *
 *   flagforge init [--file flags.json]                 create a sample flags file
 *   flagforge list [--file flags.json] [--json]        list flags
 *   flagforge create <key> [--name N] [--default on|off] [--desc D]
 *   flagforge enable <key> | disable <key>            flip the kill switch
 *   flagforge remove <key>                             delete a flag
 *   flagforge eval <key> [--user ID] [--env ENV] [--attr k=v ...] [--json]
 *   flagforge serve [--file flags.json] [--port 3000] [--host 127.0.0.1]
 *   flagforge audit [--file flags.json] [--limit 20]  show recent audit entries
 *   flagforge export [--file flags.json]               print flags as JSON
 *
 * The flags file defaults to ./flags.json, or FLAGFORGE_FILE when set.
 * The server's bearer token comes from FLAGFORGE_TOKEN when set.
 */

const fs = require('node:fs');
const path = require('node:path');
const { evaluateFlag } = require('./engine');
const { FlagStore } = require('./store');
const { startServer } = require('./server');

const VERSION = '1.0.0';

const USAGE = `flagforge ${VERSION} — feature flags without the SaaS

Usage:
  flagforge init [--file <path>]                  create a sample flags file
  flagforge list [--file <path>] [--json]          list all flags
  flagforge create <key> [--name <n>] [--default on|off] [--desc <d>]
  flagforge enable <key> | disable <key>          flip a flag's kill switch
  flagforge remove <key>                           delete a flag
  flagforge eval <key> [--user <id>] [--env <env>] [--attr k=v ...] [--json]
  flagforge serve [--file <path>] [--port <n>] [--host <addr>]
  flagforge audit [--file <path>] [--limit <n>]   show recent audit entries
  flagforge export [--file <path>]                 print flags as JSON

The flags file defaults to ./flags.json (or FLAGFORGE_FILE).
The server token comes from FLAGFORGE_TOKEN when set.
`;

function defaultFile() {
  return process.env.FLAGFORGE_FILE || path.join(process.cwd(), 'flags.json');
}

/** Minimal --flag value / --flag=value parser. Returns { opts, args }. */
function parseArgs(argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        opts[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        const key = token.slice(2);
        const value = argv[i + 1];
        if (key in opts) {
          opts[key] = Array.isArray(opts[key]) ? [...opts[key], value] : [opts[key], value];
        } else {
          opts[key] = value;
        }
        i += 1;
      } else {
        opts[token.slice(2)] = true;
      }
    } else {
      args.push(token);
    }
  }
  return { opts, args };
}

function fail(message) {
  console.error(`flagforge: ${message}`);
  process.exitCode = 1;
}

function storeFor(opts) {
  return new FlagStore(opts.file || defaultFile());
}

function printFlag(flag) {
  const state = flag.enabled === false ? 'OFF' : 'ON';
  const rules = Array.isArray(flag.rules) ? flag.rules.length : 0;
  const rollout = flag.rollout ? ` rollout ${flag.rollout.percentage}% on ${flag.rollout.attribute}` : '';
  console.log(`  ${flag.key.padEnd(24)} ${state}  default=${flag.defaultValue === true}  rules=${rules}${rollout}`);
  if (flag.name) console.log(`  ${''.padEnd(24)} ${flag.name}`);
}

function cmdInit(opts) {
  const store = storeFor(opts);
  if (fs.existsSync(store.filePath)) {
    fail(`flags file already exists: ${store.filePath}`);
    return;
  }
  store.save([
    {
      key: 'new-checkout',
      name: 'New checkout flow',
      description: 'Gradual rollout of the redesigned checkout page.',
      enabled: true,
      defaultValue: false,
      rules: [
        { when: { attribute: 'plan', operator: 'eq', value: 'enterprise' }, value: true },
        { when: { attribute: 'email', operator: 'endsWith', value: '@example.com' }, value: true },
      ],
      rollout: { percentage: 25, attribute: 'userId' },
    },
    {
      key: 'dark-mode',
      name: 'Dark mode',
      description: 'Opt-in dark theme for the dashboard.',
      enabled: true,
      defaultValue: true,
    },
  ]);
  store.audit('init', '-', { file: store.filePath });
  console.log(`created ${store.filePath} with 2 sample flags`);
}

function cmdList(opts) {
  const store = storeFor(opts);
  const flags = store.list();
  if (opts.json) {
    console.log(JSON.stringify({ flags }, null, 2));
    return;
  }
  if (flags.length === 0) {
    console.log('no flags yet — run `flagforge init` or `flagforge create <key>`');
    return;
  }
  console.log(`${flags.length} flag(s) in ${store.filePath}:`);
  for (const flag of flags) printFlag(flag);
}

function cmdCreate(opts, args) {
  const key = args[0];
  if (!key) {
    fail('create needs a flag key: flagforge create <key>');
    return;
  }
  const def = opts.default;
  const flag = { key };
  if (opts.name) flag.name = opts.name;
  if (opts.desc) flag.description = opts.desc;
  if (def === 'on') flag.defaultValue = true;
  else if (def === 'off') flag.defaultValue = false;
  else if (def !== undefined) {
    fail("--default must be 'on' or 'off'");
    return;
  }
  try {
    const created = storeFor(opts).add(flag, 'cli');
    console.log(`created flag '${created.key}' (default=${created.defaultValue === true})`);
  } catch (err) {
    fail(err.message);
  }
}

function cmdSetEnabled(opts, args, enabled) {
  const key = args[0];
  if (!key) {
    fail(`${enabled ? 'enable' : 'disable'} needs a flag key`);
    return;
  }
  try {
    storeFor(opts).update(key, { enabled }, 'cli');
    console.log(`flag '${key}' is now ${enabled ? 'ON' : 'OFF'}`);
  } catch (err) {
    fail(err.message);
  }
}

function cmdRemove(opts, args) {
  const key = args[0];
  if (!key) {
    fail('remove needs a flag key');
    return;
  }
  try {
    storeFor(opts).remove(key, 'cli');
    console.log(`removed flag '${key}'`);
  } catch (err) {
    fail(err.message);
  }
}

function parseAttributes(optValues) {
  const attributes = {};
  const list = Array.isArray(optValues) ? optValues : [optValues];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const eq = item.indexOf('=');
    if (eq === -1) {
      fail(`--attr needs k=v, got '${item}'`);
      return null;
    }
    const key = item.slice(0, eq);
    const raw = item.slice(eq + 1);
    // Light type coercion: numbers and booleans stay typed for gt/lt/eq.
    let value = raw;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) value = Number(raw);
    attributes[key] = value;
  }
  return attributes;
}

function cmdEval(opts, args) {
  const key = args[0];
  if (!key) {
    fail('eval needs a flag key: flagforge eval <key> [--user <id>] [--attr k=v]');
    return;
  }
  const attributes = parseAttributes(opts.attr || []);
  if (attributes === null) return;
  if (opts.user) attributes.userId = opts.user;
  const context = { attributes };
  if (opts.env) context.environment = opts.env;
  const store = storeFor(opts);
  const flag = store.get(key);
  if (!flag) {
    fail(`flag '${key}' not found`);
    return;
  }
  const result = evaluateFlag(flag, context);
  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`${result.key}: ${result.value ? 'ON' : 'OFF'} (${result.reason})`);
}

async function cmdServe(opts) {
  const store = storeFor(opts);
  const port = Number.parseInt(opts.port || '3000', 10);
  const host = opts.host || '127.0.0.1';
  const token = process.env.FLAGFORGE_TOKEN || null;
  try {
    const server = await startServer(store, { port, host, token, actor: 'api' });
    const address = server.address();
    console.log(`flagforge serving ${store.list().length} flag(s) on http://${address.address}:${address.port}`);
    if (token) console.log('bearer auth enabled (FLAGFORGE_TOKEN)');
    console.log('press Ctrl+C to stop');
  } catch (err) {
    fail(`could not start server: ${err.message}`);
  }
}

function cmdAudit(opts) {
  const store = storeFor(opts);
  const limit = Number.parseInt(opts.limit || '20', 10);
  const entries = store.readAudit(Number.isNaN(limit) ? 20 : limit);
  if (entries.length === 0) {
    console.log('no audit entries yet');
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.ts}  ${entry.action.padEnd(7)} ${entry.key}  (${entry.actor})`);
  }
}

function cmdExport(opts) {
  const store = storeFor(opts);
  console.log(JSON.stringify({ version: 1, flags: store.list() }, null, 2));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { opts, args } = parseArgs(rest);

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE);
      break;
    case '--version':
    case '-v':
      console.log(`flagforge ${VERSION}`);
      break;
    case 'init': cmdInit(opts); break;
    case 'list': cmdList(opts); break;
    case 'create': cmdCreate(opts, args); break;
    case 'enable': cmdSetEnabled(opts, args, true); break;
    case 'disable': cmdSetEnabled(opts, args, false); break;
    case 'remove': cmdRemove(opts, args); break;
    case 'eval': cmdEval(opts, args); break;
    case 'serve': await cmdServe(opts); break;
    case 'audit': cmdAudit(opts); break;
    case 'export': cmdExport(opts); break;
    default:
      fail(`unknown command '${command}' — run \`flagforge --help\``);
      break;
  }
}

main(process.argv.slice(2)).catch((err) => {
  fail(err.message);
});
