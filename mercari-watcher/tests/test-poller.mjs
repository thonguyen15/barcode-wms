import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../src/poller.mjs";

function fakeStore() {
  return {
    watches: [
      {
        id: 1,
        name: "keyboard",
        url: "https://jp.mercari.com/search?keyword=keyboard",
        paramsJson: JSON.stringify({ keyword: "keyboard" }),
        enabled: true,
        intervalSec: 5,
        lastRunAt: new Date(1000).toISOString(),
        lastError: null,
        createdAt: new Date(1000).toISOString(),
      },
    ],
    seen: new Set(),
    statusRows: {},
    alertRows: [],
    async listWatches() {
      return this.watches;
    },
    async filterSeenIds(ids) {
      return new Set(ids.filter((id) => this.seen.has(String(id))));
    },
    async insertSeenMany(rows) {
      for (const r of rows) this.seen.add(String(r.itemId));
    },
    async deleteSeen(ids) {
      for (const id of ids) this.seen.delete(String(id));
    },
    async updateWatchRun(id, patch) {
      const w = this.watches.find((x) => x.id === id);
      Object.assign(w, patch);
    },
    async setStatus(key, valueJson) {
      this.statusRows[key] = valueJson;
    },
    async insertAlert(row) {
      this.alertRows.push(row);
    },
  };
}

const freshItem = (id, created) => ({ id: String(id), name: `item ${id}`, price: "1000", created, thumbnails: [] });

test("tick writes contract snapshot and alert rows only for sent alerts", async () => {
  const store = fakeStore();
  const baseTs = 10_000_000;
  let ts = baseTs;
  const sent = [];
  const poller = createPoller({
    store,
    searchMercari: async () => ({
      items: [freshItem(101, baseTs / 1000 - 30), freshItem(102, baseTs / 1000 - 30), freshItem(103, baseTs / 1000 - 30)],
      numFound: 3,
    }),
    alert: async (watch, items) => {
      sent.push(items.map((it) => it.id));
      return items[0].id === "102" ? { ok: true, mode: "plain" } : { ok: false, mode: "failed", description: "rejected" };
    },
    alertError: async () => {},
    now: () => ts,
    random: () => 0,
    getBudgetPerMinute: () => 36,
    getFreshWindowMin: () => 15,
    getTelegramLastError: () => "stale-token",
  });

  await poller.tick();

  assert.deepEqual(sent, [["101"], ["102"], ["103"]]);
  const sentOnly = store.alertRows.map((r) => r.itemId);
  assert.deepEqual(sentOnly, ["102"]);
  assert.equal(store.alertRows[0].mode, "plain");
  assert.equal(store.alertRows[0].watchId, 1);
  assert.equal(store.alertRows[0].name, "item 102");
  assert.equal(store.alertRows[0].price, "1000");
  assert.equal(store.alertRows[0].createdUnix, baseTs / 1000 - 30);
  assert.match(store.alertRows[0].sentAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.seen.has("102"), true);
  assert.equal(store.seen.has("101"), false);
  assert.equal(store.seen.has("103"), false);

  const snapshot = JSON.parse(store.statusRows.snapshot);
  assert.match(snapshot.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snapshot.alertedToday, 1);
  assert.equal(snapshot.budgetUsedLastMinute, 1);
  assert.equal(snapshot.telegramLastError, "stale-token");
  assert.equal(snapshot.watches.length, 1);
  const w = snapshot.watches[0];
  assert.deepEqual(
    [w.id, w.name, w.enabled, w.intervalMs, w.consecutiveEmpty, w.lastNumFound, w.baselineDone],
    [1, "keyboard", true, 5000, 0, 3, true],
  );
  assert.equal(w.pausedUntil, null);
  assert.match(w.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(w.lastError, null);
});

test("baseline run sends no alerts", async () => {
  const store = fakeStore();
  store.watches[0].lastRunAt = null;
  let alertCalls = 0;
  const poller = createPoller({
    store,
    searchMercari: async () => ({ items: [freshItem(201, 9)], numFound: 1 }),
    alert: async () => {
      alertCalls += 1;
      return { ok: true, mode: "plain" };
    },
    alertError: async () => {},
    now: () => 10_000_000,
  });
  await poller.tick();
  assert.equal(alertCalls, 0);
  assert.deepEqual(store.alertRows, []);
  const snapshot = JSON.parse(store.statusRows.snapshot);
  assert.equal(snapshot.watches[0].baselineDone, true);
});

test("budget change takes effect on next tick", async () => {
  const store = fakeStore();
  let budget = 2;
  let ts = 10_000_000;
  let polls = 0;
  const poller = createPoller({
    store,
    searchMercari: async () => {
      polls += 1;
      return { items: [], numFound: 0 };
    },
    alert: async () => ({ ok: true, mode: "plain" }),
    alertError: async () => {},
    now: () => ts,
    getBudgetPerMinute: () => budget,
  });
  await poller.tick();
  assert.equal(polls, 1);
  assert.equal(JSON.parse(store.statusRows.snapshot).budgetUsedLastMinute, 1);
  budget = 1;
  ts += 1000;
  await poller.tick();
  assert.equal(polls, 1);
  const snapshot = JSON.parse(store.statusRows.snapshot);
  assert.equal(snapshot.budgetUsedLastMinute, 1);
  assert.equal(snapshot.watches[0].lastNumFound, 0);
});
