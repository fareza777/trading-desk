import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AdaptiveStore } from "./store.js";
import { HERE } from "./config.js";

const sha256 = text => createHash("sha256").update(text).digest("hex");
const event = (ts = 1000, kind = "status", data = {}) => ({ ts, kind, data });

function memory(t) {
  const store = new AdaptiveStore(":memory:");
  t.after(() => store.close());
  return store;
}

// Every persistent test gets a unique, owned directory inside the allowed root.
// Never open or remove the real adaptive-state.db, adaptive-replay.db, or ledgers.
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(HERE), ".store-test-"));
  const owned = new Set();
  const stores = [];
  t.after(() => {
    for (const store of stores.reverse()) store.close();
    for (const file of owned) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    fs.rmdirSync(directory);
  });
  return {
    directory,
    own(name) {
      const file = path.join(directory, name);
      owned.add(file);
      return file;
    },
    database(name = "adaptive-state.db") {
      const file = this.own(name);
      fs.closeSync(fs.openSync(file, "wx", 0o600));
      for (const suffix of ["-journal", "-wal", "-shm"]) owned.add(file + suffix);
      return file;
    },
    open(file, options) {
      const store = new AdaptiveStore(file, options);
      stores.push(store);
      return store;
    },
  };
}

function unchanged(store, checkpoint, summary) {
  assert.deepEqual(store.load(), checkpoint);
  assert.deepEqual(store.verify(), summary);
  assert.equal(store.db.isTransaction, false);
}

test("new stores have no checkpoint or audit events", t => {
  const store = memory(t);
  assert.equal(store.load(), null);
  assert.deepEqual(store.events(), []);
  assert.deepEqual(store.verify(), { events: 0, lastHash: "", revision: 0 });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get().count, 0);
  assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
});

test("commits produce exact chained hashes and state hashes", t => {
  const store = memory(t);
  const first = { nextTime: 123.5, learner: { champion: "a" }, samples: [null, true, "x"] };
  const second = { nextTime: -1.25, learner: { champion: "b" } };
  assert.equal(store.commit(0, first, event(100, "learn", { score: 1, candidates: ["a", "b"] })), 1);
  assert.equal(store.commit(1, second, event(100, "status", null)), 2);
  assert.equal(store.commit(2, {}, event(101, "status", [1, false])), 3);
  const rows = store.db.prepare("SELECT * FROM events ORDER BY revision").all();
  let previousHash = "";
  for (const [index, row] of rows.entries()) {
    const payload = JSON.parse(row.payload_json);
    assert.equal(row.revision, index + 1);
    assert.equal(row.previous_hash, previousHash);
    assert.equal(row.payload_json, JSON.stringify(payload));
    assert.equal(payload.stateHash, sha256(JSON.stringify([first, second, {}][index])));
    assert.equal(row.hash, sha256(JSON.stringify({
      revision: row.revision, ts: row.ts, kind: row.kind,
      previousHash, payloadJson: row.payload_json,
    })));
    previousHash = row.hash;
  }
  assert.deepEqual(store.events()[0], {
    revision: 1, ts: 100, kind: "learn", previousHash: "", hash: rows[0].hash,
    data: { score: 1, candidates: ["a", "b"] }, stateHash: sha256(JSON.stringify(first)),
  });
  assert.deepEqual(store.load(), { revision: 3, state: {} });
  assert.deepEqual(store.verify(), { events: 3, lastHash: previousHash, revision: 3 });
});

test("returned data and caller objects cannot mutate stored snapshots", t => {
  const store = memory(t);
  const state = { nextTime: 1, nested: { value: 2 } };
  const data = { nested: { value: 3 } };
  store.commit(0, state, event(1, "learn", data));
  state.nested.value = 99;
  data.nested.value = 99;
  store.load().state.nested.value = 99;
  store.events()[0].data.nested.value = 99;
  assert.equal(store.load().state.nested.value, 2);
  assert.equal(store.events()[0].data.nested.value, 3);
  assert.equal(store.verify().events, 1);
});

test("duplicate and stale revisions roll back without advancing state", t => {
  const store = memory(t);
  store.commit(0, { nextTime: 1 }, event());
  const checkpoint = store.load();
  const summary = store.verify();
  for (const expected of [0, 2]) {
    assert.throws(() => store.commit(expected, { nextTime: 2 }, event(2000)), /revision conflict/);
    unchanged(store, checkpoint, summary);
  }
  assert.throws(() => store.db.exec("INSERT INTO events SELECT * FROM events WHERE revision = 1"), /duplicate revision|UNIQUE/);
  unchanged(store, checkpoint, summary);
  assert.equal(store.commit(1, { nextTime: 3 }, event(2000)), 2);
});

test("timestamps may be equal but cannot move backward", t => {
  const store = memory(t);
  store.commit(0, {}, event(20));
  store.commit(1, {}, event(20));
  const checkpoint = store.load();
  const summary = store.verify();
  assert.throws(() => store.commit(2, { nextTime: 7 }, event(19)), /nondecreasing/);
  unchanged(store, checkpoint, summary);
  assert.equal(store.commit(2, {}, event(21)), 3);
});

test("event UPDATE, DELETE, and replacement are blocked", t => {
  const store = memory(t);
  store.commit(0, {}, event());
  const checkpoint = store.load();
  const summary = store.verify();
  for (const sql of [
    "UPDATE events SET kind = 'changed' WHERE revision = 1",
    "DELETE FROM events WHERE revision = 1",
    "INSERT OR REPLACE INTO events SELECT * FROM events WHERE revision = 1",
  ]) {
    assert.throws(() => store.db.exec(sql), /immutable audit events/);
    unchanged(store, checkpoint, summary);
  }
});

test("checkpoint changes are detected by load and verify, not returned as null", async t => {
  for (const [name, sql] of [
    ["state hash", "UPDATE checkpoints SET state_json = '{\"nextTime\":999}' WHERE id = 1"],
    ["revision", "UPDATE checkpoints SET revision = 10 WHERE id = 1"],
    ["malformed JSON", "UPDATE checkpoints SET state_json = '{' WHERE id = 1"],
    ["missing checkpoint", "DELETE FROM checkpoints"],
  ]) {
    await t.test(name, t => {
      const store = memory(t);
      store.commit(0, { nextTime: 1 }, event());
      store.db.exec(sql);
      assert.throws(() => store.load(), /corruption/);
      assert.throws(() => store.verify(), /corruption/);
      assert.throws(() => store.commit(1, {}, event(2000)), /corruption/);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
      assert.equal(store.db.isTransaction, false);
    });
  }
});

test("orphan checkpoint is corruption, not an empty store", t => {
  const store = memory(t);
  store.db.exec("INSERT INTO checkpoints VALUES (1, 1, '{}')");
  assert.throws(() => store.load(), /corruption/);
  assert.throws(() => store.verify(), /corruption/);
});

test("verify checks the entire history, not only the latest event", async t => {
  for (const [name, sql] of [
    ["old payload", "UPDATE events SET payload_json = '{}' WHERE revision = 1"],
    ["old kind", "UPDATE events SET kind = 'tampered' WHERE revision = 1"],
    ["old timestamp", "UPDATE events SET ts = 9 WHERE revision = 1"],
    ["previous hash", "UPDATE events SET previous_hash = 'bad' WHERE revision = 2"],
    ["hash", "UPDATE events SET hash = 'bad' WHERE revision = 1"],
    ["gap", "DELETE FROM events WHERE revision = 2"],
  ]) {
    await t.test(name, t => {
      const store = memory(t);
      for (let i = 0; i < 3; i++) store.commit(i, { nextTime: i }, event(i));
      // Only this owned in-memory fixture bypasses triggers to simulate corruption.
      store.db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete");
      store.db.exec(sql);
      assert.throws(() => store.verify(), /corruption/);
      assert.throws(() => store.load(), /corruption/);
      assert.equal(store.db.isTransaction, false);
    });
  }
});

test("invalid JSON is rejected losslessly in both state and event data", t => {
  const store = memory(t);
  const cyclic = {};
  cyclic.self = cyclic;
  const extraArray = [1];
  extraArray.extra = true;
  const symbolKey = { [Symbol("hidden")]: 1 };
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  let getterCalls = 0;
  const accessor = { get value() { getterCalls++; return 1; } };
  const values = [
    NaN, Infinity, -Infinity, undefined, () => 1, Symbol("x"), 1n, -0,
    cyclic, new Date(), new Map(), new Set(), new Uint8Array([1]),
    new Array(2), extraArray, symbolKey, hidden, accessor, { toJSON() { return 1; } },
    { nested: [undefined] }, { nested: { value: Infinity } },
  ];
  for (const value of values) {
    assert.throws(() => store.commit(0, { value }, event()), /JSON|finite|lossless|cyclic/);
    assert.throws(() => store.commit(0, {}, { ts: 1, kind: "learn", data: value }), /JSON|finite|lossless|cyclic/);
    assert.equal(store.load(), null);
    assert.equal(store.verify().events, 0);
    assert.equal(store.db.isTransaction, false);
  }
  assert.equal(getterCalls, 0);
});

test("plain JSON, shared references, and optional finite nextTime round-trip", t => {
  const store = memory(t);
  const shared = { valid: true };
  const state = Object.assign(Object.create(null), {
    nextTime: -123.75, left: shared, right: shared,
    json: JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}'),
  });
  assert.equal(store.commit(0, state, event(0, "", "primitive data")), 1);
  assert.deepEqual(store.load().state, JSON.parse(JSON.stringify(state)));
  assert.equal(store.commit(1, {}, event(0, "status", false)), 2);
});

test("invalid revision, state, event metadata, and nextTime fail without writes", t => {
  const store = memory(t);
  for (const revision of [-1, 0.5, NaN, Infinity, "0", Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => store.commit(revision, {}, event()), /expectedRevision/);
  }
  for (const state of [null, [], "state", 1, new Date(), { nextTime: "1" }, { nextTime: null }]) {
    assert.throws(() => store.commit(0, state, event()), /state|JSON/);
  }
  for (const value of [null, [], {}, event(NaN), event(Infinity), event(0.5), event(2 ** 53), event(1, 2)]) {
    assert.throws(() => store.commit(0, {}, value), /event|JSON/);
  }
  assert.throws(() => store.commit(0, {}, { ts: 1, kind: "status" }), /JSON/);
  unchanged(store, null, { events: 0, lastHash: "", revision: 0 });
});

test("injected insert failures roll back checkpoint and event atomically", async t => {
  for (const action of ["ABORT, 'injected insert failure'", "ROLLBACK, 'injected insert failure'", "IGNORE"]) {
    await t.test(action, t => {
      const store = memory(t);
      store.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON events
        WHEN NEW.kind = 'fail' BEGIN SELECT RAISE(${action}); END`);
      assert.throws(() => store.commit(0, { nextTime: 1 }, event(1, "fail")), /injected|insert failed/);
      unchanged(store, null, { events: 0, lastHash: "", revision: 0 });
      store.commit(0, { nextTime: 2 }, event(2));
      const checkpoint = store.load();
      const summary = store.verify();
      assert.throws(() => store.commit(1, { nextTime: 3 }, event(3, "fail")), /injected|insert failed/);
      unchanged(store, checkpoint, summary);
      assert.equal(store.commit(1, { nextTime: 4 }, event(4)), 2);
    });
  }
});

test("file paths must be explicit, correctly named, and inside real adaptive HERE", () => {
  for (const file of [
    undefined, null, "", "\0", ":memory:other",
    path.join(HERE, "other.db"), path.join(HERE, "adaptive-state.sqlite"),
    path.join(HERE, "ADAPTIVE-STATE.db"),
    path.join(HERE, "..", "ledger.db"), path.join(HERE, "..", "candidate-ledger.db"),
    path.join(HERE, "..", "adaptive-state.db"),
    path.join(`${HERE}-escape`, "adaptive-state.db"),
  ]) {
    assert.throws(() => new AdaptiveStore(file), /explicit|strictly inside/);
  }
  assert.throws(() => new AdaptiveStore(":memory:", { readOnly: true }), /read-only.*memory/);
  assert.throws(() => new AdaptiveStore(":memory:", { readOnly: "true" }), /boolean/);
});

test("the store never creates parent directories", t => {
  const temp = temporary(t);
  const parent = path.join(temp.directory, "missing");
  assert.throws(() => new AdaptiveStore(path.join(parent, "adaptive-state.db")), /ENOENT/);
  assert.equal(fs.existsSync(parent), false);
});

test("separate persistent writers use revision CAS and preserve audit triggers on reopen", t => {
  const temp = temporary(t);
  const file = temp.database();
  const first = temp.open(file);
  const second = temp.open(file);
  assert.equal(first.commit(0, { nextTime: 1 }, event(1)), 1);
  const summary = first.verify();
  assert.throws(() => second.commit(0, { nextTime: 9 }, event(2)), /revision conflict/);
  unchanged(second, { revision: 1, state: { nextTime: 1 } }, summary);
  assert.equal(second.commit(1, { nextTime: 2 }, event(2)), 2);
  assert.deepEqual(first.load(), { revision: 2, state: { nextTime: 2 } });
  first.close();
  second.close();
  const reopened = temp.open(file);
  assert.equal(reopened.verify().events, 2);
  assert.throws(() => reopened.db.exec("UPDATE events SET kind = 'tampered'"), /immutable/);
  assert.throws(() => reopened.db.exec("DELETE FROM events"), /immutable/);
});

test("read-only disk stores read snapshots without DDL or writable access", t => {
  const temp = temporary(t);
  const file = temp.database("adaptive-replay.db");
  const writer = temp.open(file);
  writer.commit(0, { nextTime: 12 }, event(10, "learn", { value: 2 }));
  const schema = writer.db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
  const summary = writer.verify();
  writer.close();
  const reader = temp.open(file, { readOnly: true });
  assert.deepEqual(reader.load(), { revision: 1, state: { nextTime: 12 } });
  assert.deepEqual(reader.verify(), summary);
  assert.deepEqual(reader.events()[0].data, { value: 2 });
  assert.throws(() => reader.commit(1, {}, event(11)), /read-only/);
  assert.throws(() => reader.db.exec("UPDATE checkpoints SET state_json = '{}'"), /readonly|read-only/i);
  assert.throws(() => reader.db.exec("CREATE TABLE forbidden (id INTEGER)"), /readonly|read-only/i);
  assert.deepEqual(reader.db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(), schema);
});

test("read-only opening neither initializes an empty file nor creates a missing file", t => {
  const temp = temporary(t);
  const file = temp.database();
  const reader = temp.open(file, { readOnly: true });
  assert.deepEqual(reader.db.prepare("SELECT name FROM sqlite_schema").all(), []);
  assert.throws(() => reader.load(), /no such table/);
  reader.close();
  assert.equal(fs.statSync(file).size, 0);
  const missing = path.join(temp.directory, "adaptive-replay.db");
  assert.throws(() => new AdaptiveStore(missing, { readOnly: true }), /unable to open/);
  assert.equal(fs.existsSync(missing), false);
});

test("existing file symlinks and hard links cannot alias a database", async t => {
  await t.test("hard link", t => {
    const temp = temporary(t);
    const original = temp.database();
    const linked = temp.own("adaptive-replay.db");
    fs.linkSync(original, linked);
    assert.throws(() => new AdaptiveStore(linked), /hard link/);
    assert.throws(() => new AdaptiveStore(original), /hard link/);
    assert.equal(fs.statSync(original).size, 0);
  });
  await t.test("file symlink", t => {
    const temp = temporary(t);
    const original = temp.database();
    const linked = temp.own("adaptive-replay.db");
    try {
      fs.symlinkSync(original, linked, "file");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("file symlink creation requires OS privileges");
        return;
      }
      throw error;
    }
    assert.throws(() => new AdaptiveStore(linked), /symlink/);
    assert.throws(() => new AdaptiveStore(linked, { readOnly: true }), /symlink/);
    assert.equal(fs.statSync(original).size, 0);
  });
});

test("directory symlinks and junctions are rejected even when pointing inside HERE", t => {
  const temp = temporary(t);
  for (const [name, target] of [["inside", fs.realpathSync(HERE)], ["outside", path.dirname(HERE)]]) {
    const link = temp.own(name);
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    const file = path.join(link, "adaptive-state.db");
    assert.throws(() => new AdaptiveStore(file), /symlink|junction/);
    assert.throws(() => new AdaptiveStore(file, { readOnly: true }), /symlink|junction/);
  }
});

test("close releases the database and is safe to repeat", () => {
  const store = new AdaptiveStore(":memory:");
  store.close();
  store.close();
  assert.equal(store.db.isOpen, false);
  assert.throws(() => store.load(), /not open|closed/);
});
