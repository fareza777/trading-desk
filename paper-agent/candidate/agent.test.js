import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { parseMode, recoveryHours, ensureDayOpen, accountControls, entryControls } from "./agent.js";
import { DB_PATH } from "./config.js";
assert.equal(DB_PATH, ":memory:");
const L = await import("./db.js");
const HOUR = 3_600_000, T = Date.UTC(2026, 9, 28, 1);
beforeEach(() => { L.db.exec("DELETE FROM trades; DELETE FROM positions; DELETE FROM meta; DELETE FROM equity_snapshots;"); L.setCash(10000); });
after(() => L.db.close());

test("conflicting/unknown modes reject before ledger initialization", () => {
  assert.equal(parseMode([]), "check");
  assert.equal(parseMode(["--check"]), "check");
  assert.equal(parseMode(["--paper"]), "paper");
  assert.throws(() => parseMode(["--paper","--check"]));
  assert.throws(() => parseMode(["--check","--check"]));
  assert.throws(() => parseMode(["--unknown"]));
});
test("history recovery spans outages and reloads a gapped cache", () => {
  assert.equal(recoveryHours([], 20*HOUR), 1000);
  assert.ok(recoveryHours([[HOUR],[2*HOUR]], 16*HOUR) >= 15);
  assert.equal(recoveryHours([[HOUR],[3*HOUR]], 16*HOUR), 1000);
  assert.equal(recoveryHours([[HOUR]], 2000*HOUR), 1000);
});
test("day baseline preserves prior closing equity and daily halt survives recovery/restart", () => {
  L.db.prepare("INSERT INTO equity_snapshots(ts,cash,equity,open_positions,deployed_usd) VALUES(?,10000,10000,0,0)").run("2026-10-27T23:59:50.000Z");
  L.setCash(9800);
  assert.equal(ensureDayOpen(L,T),10000);
  assert.match(accountControls(L,{},T).reason,/daily/);
  L.setCash(10050);
  assert.equal(ensureDayOpen(L,T),10000);
  assert.match(accountControls(L,{},T+HOUR).reason,/latched/);
  assert.equal(accountControls(L,{},T+24*HOUR).reason,null);
});
test("new session loss is measured from capital, not post-loss cash", () => {
  L.setCash(9800);
  assert.equal(ensureDayOpen(L,T),10000);
  assert.match(accountControls(L,{},T).reason,/daily/);
});
test("entry recheck sees a third loss realized while quote request was pending", async () => {
  const lose = i => {
    const order = L.openTrade({symbol:`TEST${i}/USDT`,side:"long",qty:1,markPrice:100,stopPrice:95,sizeUsd:100,nowMs:T-1000});
    const p = L.openPosition(`TEST${i}/USDT`);
    L.closePositionQty(p,1,99,"stop",0,undefined,T-500);
    return order;
  };
  lose(1); lose(2);
  assert.equal(entryControls(L,{},"BTC/USDT",T).reason,null);
  const pendingQuote = Promise.resolve().then(() => lose(3));
  await pendingQuote;
  assert.match(entryControls(L,{},"BTC/USDT",T).reason,/consecutive/);
});
test("risk controls refuse unknown marks for open positions", () => {
  L.openTrade({symbol:"BTC/USDT",side:"long",qty:1,markPrice:100,stopPrice:95,sizeUsd:100,nowMs:T});
  assert.throws(() => accountControls(L,{},T),/valuation/);
  const s = {bid:99,ask:100,receivedAt:T};
  assert.equal(accountControls(L,{"BTC/USDT":s},T).reason,null);
});
