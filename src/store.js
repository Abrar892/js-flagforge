'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateFlag } = require('./engine');

/**
 * FlagStore — JSON-file persistence for flags plus an append-only audit log.
 *
 * File layout for a store rooted at `<dir>/flags.json`:
 *   flags.json        — { version: 1, flags: [ ... ] }
 *   flags.audit.jsonl — one JSON object per line: { ts, action, key, actor, detail }
 *
 * Writes are atomic: the new content is written to a temp file in the same
 * directory and then renamed over the old file, so a crash mid-write can
 * never leave a half-written flags file behind.
 */
class FlagStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('FlagStore needs a flags file path');
    }
    this.filePath = path.resolve(filePath);
    this.auditPath = `${this.filePath}.audit.jsonl`;
  }

  /** Load flags from disk. A missing file means an empty store. */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`corrupt flags file ${this.filePath}: ${err.message}`);
    }
    if (!parsed || !Array.isArray(parsed.flags)) {
      throw new Error(`corrupt flags file ${this.filePath}: expected { flags: [...] }`);
    }
    for (const flag of parsed.flags) validateFlag(flag);
    return parsed.flags;
  }

  /** Persist the given flag array atomically. */
  save(flags) {
    for (const flag of flags) validateFlag(flag);
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = `${JSON.stringify({ version: 1, flags }, null, 2)}\n`;
    const tmpPath = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, payload, 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* temp file already gone */ }
      throw err;
    }
  }

  /** Append one audit entry (best-effort: audit failure never blocks a save). */
  audit(action, key, detail = {}, actor = 'local') {
    const entry = {
      ts: new Date().toISOString(),
      action,
      key,
      actor,
      detail,
    };
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      fs.appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Audit is observability, not the operation itself; never fail the
      // caller because the log could not be written.
    }
    return entry;
  }

  /** Read audit entries, newest last. `limit` caps how many are returned. */
  readAudit(limit = 100) {
    let raw;
    try {
      raw = fs.readFileSync(this.auditPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const entries = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    return limit ? entries.slice(-limit) : entries;
  }

  list() {
    return this.load();
  }

  get(key) {
    return this.load().find((flag) => flag.key === key) || null;
  }

  add(flag, actor) {
    validateFlag(flag);
    const flags = this.load();
    if (flags.some((f) => f.key === flag.key)) {
      throw new Error(`flag '${flag.key}' already exists`);
    }
    const stored = {
      enabled: true,
      defaultValue: false,
      ...flag,
    };
    flags.push(stored);
    this.save(flags);
    this.audit('create', flag.key, { flag: stored }, actor);
    return stored;
  }

  update(key, patch, actor) {
    const flags = this.load();
    const index = flags.findIndex((f) => f.key === key);
    if (index === -1) {
      throw new Error(`flag '${key}' does not exist`);
    }
    const updated = { ...flags[index], ...patch, key };
    validateFlag(updated);
    flags[index] = updated;
    this.save(flags);
    this.audit('update', key, { patch }, actor);
    return updated;
  }

  remove(key, actor) {
    const flags = this.load();
    const index = flags.findIndex((f) => f.key === key);
    if (index === -1) {
      throw new Error(`flag '${key}' does not exist`);
    }
    const [removed] = flags.splice(index, 1);
    this.save(flags);
    this.audit('delete', key, {}, actor);
    return removed;
  }
}

module.exports = { FlagStore };
