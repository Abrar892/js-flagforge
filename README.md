# FlagForge

A zero-dependency feature flag service in Node.js: rule-based evaluation,
deterministic percentage rollouts, an HTTP API, and a CLI — everything a
small team needs to ship behind flags without paying for a hosted service.

## The problem

Rolling out a feature to everyone at once is how a bad deploy becomes an
incident. Feature flags let you turn a feature on for a slice of users, a
specific plan, or one email domain — and turn it off again in seconds when
something goes wrong. Most flag services are hosted SaaS with a monthly
bill; FlagForge is a single JSON file plus a tiny server you run yourself.

## How it works

A flag is a JSON object with a kill switch, an ordered rule list, an
optional percentage rollout, and optional per-environment overrides:

```json
{
  "key": "new-checkout",
  "name": "New checkout flow",
  "enabled": true,
  "defaultValue": false,
  "rules": [
    { "when": { "attribute": "plan", "operator": "eq", "value": "enterprise" }, "value": true },
    { "when": { "attribute": "email", "operator": "endsWith", "value": "@example.com" }, "value": true }
  ],
  "rollout": { "percentage": 25, "attribute": "userId" }
}
```

Evaluation order, in plain terms:

1. **Kill switch** — `enabled: false` always returns `false`.
2. **Environment override** — `environments.production` replaces the flag's
   rules, rollout, and kill switch for that environment only.
3. **Rules** — first matching rule wins. Operators: `eq`, `ne`, `in`,
   `notIn`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`.
4. **Rollout** — the subject (usually `userId`) is hashed into a bucket
   0–99; buckets below the percentage get `true`.
5. **Default value** — the fallback when nothing else matched.

Every evaluation returns a `reason` (`disabled`, `rule:0`, `rollout`,
`default`) so you can explain exactly why a user saw what they saw.

## Design decisions

- **Deterministic hashing, not randomness.** Rollout buckets use FNV-1a
  over `flagKey:subject`, so a user stays in the same bucket on every
  server and every deploy — no sticky-session storage needed.
- **One JSON file as the source of truth.** The CLI edits the same
  `flags.json` the server reads, so there is no database to run and no
  sync step. Writes are atomic (temp file + rename) so a crash can never
  leave a half-written file.
- **The API is a thin shell over the engine.** Evaluation logic lives in
  `src/engine.js` with no I/O, which is why it is easy to test and safe
  to call from anywhere. The server only handles HTTP and auth.
- **Audit log by default.** Every create, update, and delete appends a
  line to `flags.json.audit.jsonl` — who changed what, and when. Flags
  are production config; silent changes are a bug.

## Quick start

```bash
# Create a flags file with two sample flags
node src/cli.js init

# See what a user gets
node src/cli.js eval new-checkout --user user-42 --attr plan=enterprise
# new-checkout: ON (rule:0)

# Serve the flags over HTTP
node src/cli.js serve --port 3000
```

Or install it globally and use the `flagforge` command:

```bash
npm install -g .
flagforge list
flagforge create dark-mode --default on
flagforge disable dark-mode
flagforge audit
```

Set `FLAGFORGE_TOKEN` to require a bearer token on every API route
except `/health`:

```bash
FLAGFORGE_TOKEN=s3cret flagforge serve
curl -H "Authorization: Bearer s3cret" http://localhost:3000/flags
```

## HTTP API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe, no auth |
| `GET` | `/flags` | List all flags |
| `GET` | `/flags/:key` | One flag |
| `POST` | `/flags` | Create a flag |
| `PATCH` | `/flags/:key` | Update a flag |
| `DELETE` | `/flags/:key` | Delete a flag |
| `POST` | `/evaluate` | `{ key, context }` → `{ key, value, reason }` |
| `POST` | `/evaluate/batch` | Evaluate many flags in one call |
| `GET` | `/audit?limit=100` | Recent audit entries |

```bash
curl -X POST http://localhost:3000/evaluate \
  -H 'content-type: application/json' \
  -d '{"key": "new-checkout", "context": {"userId": "user-42", "plan": "free"}}'
# {"key":"new-checkout","value":false,"reason":"rollout"}
```

## Using it as a library

```js
const { evaluateFlag, FlagStore, startServer } = require('flagforge');

const store = new FlagStore('./flags.json');
const flag = store.get('new-checkout');

evaluateFlag(flag, { userId: 'user-42', plan: 'enterprise' });
// { key: 'new-checkout', value: true, reason: 'rule:0' }
```

See `examples/demo.js` for a runnable version.

## Running the tests

```bash
npm test
```

28 tests cover the engine (rules, operators, rollout distribution,
environment overrides), the store (atomic writes, corrupt-file handling,
audit log), the HTTP API (CRUD, auth, error paths), and the CLI
(end-to-end via child processes).

## Tech stack

- Node.js 18+ (built-ins only — `node:http`, `node:fs`, `node:test`)
- Zero runtime dependencies

## License

MIT — see [LICENSE](LICENSE).
