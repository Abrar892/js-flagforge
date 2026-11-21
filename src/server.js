'use strict';

const http = require('node:http');
const { evaluateAll, evaluateFlag } = require('./engine');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** Read and parse a JSON request body. Rejects on bad JSON or oversize. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large (max 1 MiB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function decodeKey(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Build an HTTP server around a FlagStore.
 *
 *   GET  /health              — liveness probe (no auth)
 *   GET  /flags               — list all flags
 *   GET  /flags/:key          — one flag (404 when unknown)
 *   POST /flags               — create a flag (409 on duplicate key)
 *   PATCH /flags/:key         — update a flag
 *   DELETE /flags/:key        — delete a flag
 *   POST /evaluate            — { key, context } -> { key, value, reason }
 *   POST /evaluate/batch      — { requests: [{ key, context }] } -> { key: result }
 *   GET  /audit?limit=100     — audit entries, newest last
 *
 * When options.token is set, every route except /health requires
 * `Authorization: Bearer <token>` and answers 401 otherwise. The token is
 * normally read from the FLAGFORGE_TOKEN environment variable by the CLI.
 */
function createServer(store, options = {}) {
  const token = options.token || null;
  const actor = options.actor || 'api';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', flags: store.list().length });
        return;
      }

      if (token) {
        const header = req.headers.authorization || '';
        if (header !== `Bearer ${token}`) {
          sendError(res, 401, 'missing or invalid bearer token');
          return;
        }
      }

      // GET /flags
      if (req.method === 'GET' && segments.length === 1 && segments[0] === 'flags') {
        sendJson(res, 200, { flags: store.list() });
        return;
      }

      // GET /flags/:key
      if (req.method === 'GET' && segments.length === 2 && segments[0] === 'flags') {
        const key = decodeKey(segments[1]);
        const flag = key === null ? null : store.get(key);
        if (!flag) {
          sendError(res, 404, `flag '${segments[1]}' not found`);
          return;
        }
        sendJson(res, 200, { flag });
        return;
      }

      // POST /flags
      if (req.method === 'POST' && segments.length === 1 && segments[0] === 'flags') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendError(res, 400, 'request body must be a flag object');
          return;
        }
        try {
          const flag = store.add(body, actor);
          sendJson(res, 201, { flag });
        } catch (err) {
          sendError(res, err.message.includes('already exists') ? 409 : 400, err.message);
        }
        return;
      }

      // PATCH /flags/:key
      if (req.method === 'PATCH' && segments.length === 2 && segments[0] === 'flags') {
        const key = decodeKey(segments[1]);
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendError(res, 400, 'request body must be a flag patch object');
          return;
        }
        try {
          const flag = store.update(key, body, actor);
          sendJson(res, 200, { flag });
        } catch (err) {
          sendError(res, err.message.includes('does not exist') ? 404 : 400, err.message);
        }
        return;
      }

      // DELETE /flags/:key
      if (req.method === 'DELETE' && segments.length === 2 && segments[0] === 'flags') {
        const key = decodeKey(segments[1]);
        try {
          const flag = store.remove(key, actor);
          sendJson(res, 200, { flag });
        } catch (err) {
          sendError(res, 404, err.message);
        }
        return;
      }

      // POST /evaluate
      if (req.method === 'POST' && segments.length === 1 && segments[0] === 'evaluate') {
        const body = await readJsonBody(req);
        if (!body || typeof body.key !== 'string') {
          sendError(res, 400, 'request body must include a flag key');
          return;
        }
        const flag = store.get(body.key);
        if (!flag) {
          sendError(res, 404, `flag '${body.key}' not found`);
          return;
        }
        sendJson(res, 200, evaluateFlag(flag, body.context || {}));
        return;
      }

      // POST /evaluate/batch
      if (req.method === 'POST' && segments.length === 2
        && segments[0] === 'evaluate' && segments[1] === 'batch') {
        const body = await readJsonBody(req);
        if (!body || !Array.isArray(body.requests)) {
          sendError(res, 400, 'request body must include a requests array');
          return;
        }
        const flags = store.list();
        const byKey = new Map(flags.map((f) => [f.key, f]));
        const results = {};
        const missing = [];
        for (const request of body.requests) {
          if (!request || typeof request.key !== 'string') {
            sendError(res, 400, 'each request must include a flag key');
            return;
          }
          const flag = byKey.get(request.key);
          if (!flag) {
            missing.push(request.key);
            continue;
          }
          results[request.key] = evaluateFlag(flag, request.context || {});
        }
        if (missing.length > 0) {
          sendError(res, 404, `unknown flag(s): ${missing.join(', ')}`);
          return;
        }
        sendJson(res, 200, { results });
        return;
      }

      // GET /audit
      if (req.method === 'GET' && segments.length === 1 && segments[0] === 'audit') {
        const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
        sendJson(res, 200, {
          entries: store.readAudit(Number.isNaN(limit) ? 100 : limit),
        });
        return;
      }

      sendError(res, 404, `no such route: ${req.method} ${url.pathname}`);
    } catch (err) {
      if (!res.headersSent) {
        sendError(res, 400, err.message);
      }
    }
  });

  return server;
}

/** Start the server; resolves with the listening server. Port 0 picks a free port. */
function startServer(store, { port = 3000, host = '127.0.0.1', ...options } = {}) {
  const server = createServer(store, options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { createServer, evaluateAll, startServer };
