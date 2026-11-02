import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HERE } from "./config.js";

const sha256 = text => createHash("sha256").update(text).digest("hex");
const plainObject = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function databaseFile(file, readOnly) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) {
    throw new TypeError("an explicit adaptive database file is required");
  }
  if (file === ":memory:") {
    if (readOnly) throw new Error("read-only :memory: databases are not supported");
    return file;
  }
  const root = fs.realpathSync(HERE);
  const resolved = path.resolve(file);
  if (path.extname(resolved) !== ".db" ||
      !["adaptive-state.db", "adaptive-replay.db"].includes(path.basename(resolved)) ||
      !inside(root, resolved)) {
    throw new Error("database must be adaptive-state.db or adaptive-replay.db strictly inside adaptive HERE");
  }

  // Inspect every component below the real root, not just the final filename.
  // No directory creation, symlinks, or junction traversal is permitted.
  let current = root;
  for (const component of path.relative(root, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("adaptive database parent must be a real directory, not a symlink or junction");
    }
  }
  const parent = fs.realpathSync(path.dirname(resolved));
  if (path.relative(parent, path.dirname(resolved)) !== "" || !inside(root, path.join(parent, path.basename(resolved)))) {
    throw new Error("adaptive database path escapes its real directory");
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Reject hard links as well: an allowed name must never alias either ledger.
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)) {
    throw new Error("adaptive database must be a regular, unlinked file (no symlink or hard link)");
  }
  return resolved;
}

// Build a JSON-only snapshot before stringify so getters/toJSON cannot silently
// change the data, and JSON's usual omissions/coercions never lose input values.
function jsonString(value) {
  const ancestors = new Set();
  function copy(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0)) throw new TypeError("JSON numbers must be finite and lossless");
      return item;
    }
    if (typeof item !== "object" || (!Array.isArray(item) && !plainObject(item))) {
      throw new TypeError("only plain JSON values are supported");
    }
    if (ancestors.has(item)) throw new TypeError("cyclic JSON is not supported");
    ancestors.add(item);
    const array = Array.isArray(item);
    const keys = Reflect.ownKeys(item);
    if (array && (Object.getPrototypeOf(item) !== Array.prototype || keys.length !== item.length + 1)) {
      throw new TypeError("JSON arrays must be dense and have no extra properties");
    }
    const result = array ? [] : Object.create(null);
    const names = array ? Array.from({ length: item.length }, (_, i) => String(i)) : keys;
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !hasOwn(descriptor, "value")) {
        throw new TypeError("JSON properties must be enumerable string-keyed data properties");
      }
      result[key] = copy(descriptor.value);
    }
    ancestors.delete(item);
    return result;
  }
  return JSON.stringify(copy(value));
}

function stateString(state) {
  if (!plainObject(state)) throw new TypeError("state must be a plain JSON object");
  const serialized = jsonString(state);
  const snapshot = JSON.parse(serialized);
  if (hasOwn(snapshot, "nextTime") && typeof snapshot.nextTime !== "number") {
    throw new TypeError("state.nextTime must be a finite number when present");
  }
  return serialized;
}

function eventHash(revision, ts, kind, previousHash, payloadJson) {
  return sha256(JSON.stringify({ revision, ts, kind, previousHash, payloadJson }));
}

function corrupt(message) {
  return new Error(`adaptive store corruption: ${message}`);
}

export class AdaptiveStore {
  #readOnly;

  constructor(file, { readOnly = false } = {}) {
    if (typeof readOnly !== "boolean") throw new TypeError("readOnly must be a boolean");
    this.#readOnly = readOnly;
    this.db = new DatabaseSync(databaseFile(file, readOnly), { readOnly });
    if (readOnly) return;
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.#transaction("BEGIN IMMEDIATE", () => this.db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL CHECK (revision > 0),
          state_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          revision INTEGER PRIMARY KEY CHECK (revision > 0),
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          previous_hash TEXT NOT NULL,
          hash TEXT NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'immutable audit events: UPDATE forbidden'); END;
        CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'immutable audit events: DELETE forbidden'); END;
        CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON events
        WHEN EXISTS (SELECT 1 FROM events WHERE revision = NEW.revision)
        BEGIN SELECT RAISE(ABORT, 'immutable audit events: duplicate revision'); END;
      `));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #transaction(begin, action) {
    this.db.exec(begin);
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // RAISE(ROLLBACK) can have already ended the transaction; retain the cause.
      }
      throw error;
    }
  }

  #snapshot() {
    const rows = this.db.prepare("SELECT revision, ts, kind, previous_hash, hash, payload_json FROM events ORDER BY revision").all();
    const checkpoints = this.db.prepare("SELECT id, revision, state_json FROM checkpoints").all();
    const events = [];
    let lastHash = "";
    let lastTs = -Infinity;
    for (const row of rows) {
      const { revision, ts, kind, previous_hash: previousHash, hash, payload_json: payloadJson } = row;
      if (!Number.isSafeInteger(revision) || revision !== events.length + 1) throw corrupt("noncontiguous event revisions");
      if (!Number.isSafeInteger(ts) || ts < lastTs || typeof kind !== "string") throw corrupt("invalid event timestamp or kind");
      if (previousHash !== lastHash || typeof payloadJson !== "string" ||
          hash !== eventHash(revision, ts, kind, previousHash, payloadJson)) {
        throw corrupt(`event hash chain mismatch at revision ${revision}`);
      }
      let payload;
      try {
        payload = JSON.parse(payloadJson);
        if (!plainObject(payload) || Object.keys(payload).length !== 2 || !hasOwn(payload, "data") ||
            !hasOwn(payload, "stateHash") || typeof payload.stateHash !== "string" ||
            !/^[a-f0-9]{64}$/.test(payload.stateHash) || jsonString(payload) !== payloadJson) {
          throw new Error("invalid payload");
        }
      } catch {
        throw corrupt(`invalid event payload at revision ${revision}`);
      }
      events.push({ revision, ts, kind, previousHash, hash, data: payload.data, stateHash: payload.stateHash });
      lastHash = hash;
      lastTs = ts;
    }
    const revision = events.length;
    if (revision === 0 && checkpoints.length === 0) {
      return { checkpoint: null, events, lastHash, lastTs, revision };
    }
    if (checkpoints.length !== 1 || checkpoints[0].id !== 1 || revision === 0 ||
        checkpoints[0].revision !== revision) {
      throw corrupt("checkpoint revision does not match audit history");
    }
    const checkpoint = checkpoints[0];
    let state;
    try {
      state = JSON.parse(checkpoint.state_json);
      if (stateString(state) !== checkpoint.state_json) throw new Error("noncanonical state");
    } catch {
      throw corrupt("invalid checkpoint JSON");
    }
    if (sha256(checkpoint.state_json) !== events[revision - 1].stateHash) {
      throw corrupt("checkpoint state hash mismatch");
    }
    return { checkpoint: { revision, state }, events, lastHash, lastTs, revision };
  }

  load() {
    return this.#transaction("BEGIN", () => this.#snapshot().checkpoint);
  }

  commit(expectedRevision, state, event) {
    if (this.#readOnly) throw new Error("cannot commit to a read-only adaptive store");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new TypeError("expectedRevision must be a nonnegative safe integer with room for the next revision");
    }
    if (!plainObject(event)) throw new TypeError("event must contain ts, kind, and JSON data");
    const { ts, kind, data } = event;
    if (!Number.isSafeInteger(ts) || typeof kind !== "string") {
      throw new TypeError("event.ts must be a safe integer and event.kind must be a string");
    }
    const stateJson = stateString(state);
    const payloadJson = JSON.stringify({ data: JSON.parse(jsonString(data)), stateHash: sha256(stateJson) });
    return this.#transaction("BEGIN IMMEDIATE", () => {
      const current = this.#snapshot();
      if (current.revision !== expectedRevision) {
        throw new Error(`revision conflict: expected ${expectedRevision}, current ${current.revision}`);
      }
      if (ts < current.lastTs) throw new Error("event.ts must be nondecreasing");
      const revision = expectedRevision + 1;
      const hash = eventHash(revision, ts, kind, current.lastHash, payloadJson);
      const checkpoint = this.db.prepare(`
        INSERT INTO checkpoints (id, revision, state_json) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state_json = excluded.state_json
      `).run(revision, stateJson);
      if (checkpoint.changes !== 1) throw new Error("checkpoint write failed");
      const inserted = this.db.prepare(`
        INSERT INTO events (revision, ts, kind, previous_hash, hash, payload_json) VALUES (?, ?, ?, ?, ?, ?)
      `).run(revision, ts, kind, current.lastHash, hash, payloadJson);
      if (inserted.changes !== 1) throw new Error("audit event insert failed");
      return revision;
    });
  }

  verify() {
    return this.#transaction("BEGIN", () => {
      const { events, lastHash, revision } = this.#snapshot();
      return { events: events.length, lastHash, revision };
    });
  }

  events() {
    return this.#transaction("BEGIN", () => this.#snapshot().events);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
