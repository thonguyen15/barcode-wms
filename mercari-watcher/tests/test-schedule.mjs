import assert from "node:assert/strict";
import { createPoller } from "../src/poller.mjs";
import { createQuietHoursChecker } from "../src/settings.mjs";

const BASE_TS = Date.UTC(2026, 10, 28, 12, 0, 0);
const BASE_SEC = Math.floor(BASE_TS / 1000);

function memoryStore() {
  const watches = [{ id: 1, name: "w", url: "u", paramsJson: "{}", enabled: true, intervalSec: 5, lastRunAt: null, lastError: null, createdAt: "" }];
  const seen = new Set();
  const state = { lastSnapshot: null };
  return {
    state,
    async listWatches() { return watches.map((w) => ({ ...w })); },
    async updateWatchRun(id, patch) { Object.assign(watches[0], patch); },
    async filterSeenIds(ids) { return new Set(ids.filter((i) => seen.has(i))); },
    async insertSeenMany(rows) { for (const r of rows) seen.add(r.itemId); },
    async setStatus(key, json) { state.lastSnapshot = JSON.parse(json); },
    async insertAlert() {},
  };
}

function harness({ search, quiet, min = 5, max = 15, random = () => 0.5 }) {
  let ts = BASE_TS;
  const polls = [];
  const alerts = [];
  const errors = [];
  const store = memoryStore();
  const poller = createPoller({
    store,
    searchMercari: async () => { polls.push(ts); return search(ts, polls.length); },
    alert: async (w, items) => { alerts.push(items.map((i) => i.id)); return { ok: true, mode: "photo" }; },
    alertError: async () => { errors.push(1); return { ok: true, mode: "plain" }; },
    now: () => ts,
    random,
    getPollMinSec: () => min,
    getPollMaxSec: () => max,
    isQuietHour: (t) => quiet(t),
  });
  const snap = () => store.state.lastSnapshot.watches[0];
  return { poller, advance: (ms) => { ts += ms; }, polls, alerts, errors, snap };
}

const item = (id, createdOffsetSec) => ({ id, name: id, price: "1", created: String(BASE_SEC + createdOffsetSec), thumbnails: [] });
const empty = () => ({ items: [], numFound: 0 });

{
  const randoms = [0, 0.25, 0.5, 0.999, 1 - 1e-9];
  for (const r of randoms) {
    const h = harness({ search: empty, quiet: () => false, random: () => r });
    await h.poller.tick();
    await h.poller.tick();
    await h.poller.tick();
    const interval = h.snap().intervalMs;
    assert.ok(interval >= 5000 && interval <= 15000, `interval ${interval} in [5000,15000]`);
  }
  console.log("PASS interval always within [5s,15s] for random in {0,.25,.5,.999,~1}");
}
{
  const lo = harness({ search: empty, quiet: () => false, random: () => 0 });
  await lo.poller.tick();
  assert.equal(lo.snap().intervalMs, 5000);
  const hi = harness({ search: empty, quiet: () => false, random: () => 0.999999 });
  await hi.poller.tick();
  assert.ok(hi.snap().intervalMs > 14900, `got ${hi.snap().intervalMs}`);
  console.log("PASS bounds: random 0 -> 5000ms, random ~1 -> ~15000ms");
}
{
  let fail = true;
  const h = harness({ search: () => { if (fail) { const e = new Error("429"); e.status = 429; throw e; } return empty(); }, quiet: () => false, random: () => 0 });
  await h.poller.tick();
  const i1 = h.snap().intervalMs;
  h.advance(10 * 1000);
  await h.poller.tick();
  const i2 = h.snap().intervalMs;
  h.advance(20 * 1000);
  await h.poller.tick();
  const i3 = h.snap().intervalMs;
  assert.deepEqual([i1, i2, i3], [10000, 20000, 40000], `backoff ${[i1, i2, i3]}`);
  fail = false;
  h.advance(40 * 1000);
  await h.poller.tick();
  assert.equal(h.snap().intervalMs, 5000, "success resets to base interval");
  console.log("PASS backoff doubles from the random base (10s,20s,40s) and resets on success");
}
{
  let quietFlag = true;
  const h = harness({ search: () => ({ items: [item("a", -60000)], numFound: 1 }), quiet: () => quietFlag });
  for (let i = 0; i < 30; i++) { h.advance(60 * 1000); await h.poller.tick(); }
  assert.equal(h.polls.length, 0, "no Mercari call during quiet hours");
  assert.equal(h.alerts.length, 0);
  assert.equal(h.snap().consecutiveEmpty, 0, "quiet ticks must not count as empty results");
  assert.equal(h.snap().pausedUntil, null, "quiet ticks must not trigger soft-block pause");
  quietFlag = false;
  h.advance(30 * 1000);
  await h.poller.tick();
  assert.equal(h.polls.length, 0, "still waiting for the minute re-check");
  h.advance(30 * 1000);
  await h.poller.tick();
  assert.equal(h.polls.length, 1, "polls again within a minute after quiet hours end");
  console.log("PASS quiet hours: 30 min with zero Mercari calls, no soft-block, resumes <=60s after quiet ends");
}
{
  const h = harness({ search: empty, quiet: () => false, random: () => 0.5 });
  await h.poller.tick();
  const n1 = h.polls.length;
  h.advance(3000);
  await h.poller.tick();
  assert.equal(h.polls.length, n1, "no poll before the interval elapsed");
  h.advance(10 * 1000);
  await h.poller.tick();
  assert.equal(h.polls.length, n1 + 1, "polls once the interval elapsed");
  console.log("PASS no poll before the scheduled interval elapses");
}
{
  const h = harness({ search: (t, n) => (n === 1 ? { items: [item("m1", -60)], numFound: 1 } : { items: [item("m3", -30), item("m2", -50), item("m1", -60), item("old", -86400 * 18)], numFound: 4 }), quiet: () => false });
  await h.poller.tick();
  assert.equal(h.alerts.length, 0, "baseline alerts nothing");
  h.advance(15 * 1000);
  await h.poller.tick();
  assert.deepEqual(h.alerts.flat().sort(), ["m2", "m3"], `alerts ${JSON.stringify(h.alerts)}`);
  console.log("PASS dedup scenario 1,2,3: poll 2 sees 3,2,1 -> alerts 2 and 3, not 1, not the 18-day-old item");
}
{
  const h = harness({ search: (t, n) => (n === 1 ? { items: [item("m1", -60), item("m2", -70)], numFound: 2 } : { items: [item("m3", -20), item("m2", -70)], numFound: 2 }), quiet: () => false });
  await h.poller.tick();
  h.advance(15 * 1000);
  await h.poller.tick();
  assert.deepEqual(h.alerts.flat(), ["m3"]);
  console.log("PASS an item that left page 1 is not re-announced; the new one is");
}
{
  let n = 0;
  const h = harness({ search: () => { n += 1; return empty(); }, quiet: () => false, random: () => 0 });
  await h.poller.tick();
  h.advance(10 * 1000); await h.poller.tick();
  h.advance(20 * 1000); await h.poller.tick();
  assert.equal(h.polls.length, 3);
  assert.ok(h.snap().pausedUntil, "soft-block pause set after 3 empty results outside quiet hours");
  console.log("PASS soft-block pause still triggers on 3 real empty results");
}
{
  const get = (o) => (k) => o[k];
  const quiet = createQuietHoursChecker(get({ quiet_hours_start: "1", quiet_hours_end: "6", quiet_timezone: "Asia/Ho_Chi_Minh" }));
  const at = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi) - 7 * 3600 * 1000;
  assert.equal(quiet(at(2026, 11, 28, 0, 59)), false, "00:59 ICT not quiet");
  assert.equal(quiet(at(2026, 11, 28, 1, 0)), true, "01:00 ICT quiet");
  assert.equal(quiet(at(2026, 11, 28, 3, 30)), true, "03:30 ICT quiet");
  assert.equal(quiet(at(2026, 11, 28, 5, 59)), true, "05:59 ICT quiet");
  assert.equal(quiet(at(2026, 11, 28, 6, 0)), false, "06:00 ICT not quiet");
  assert.equal(quiet(at(2026, 11, 28, 23, 0)), false, "23:00 ICT not quiet");
  console.log("PASS quiet hours in Asia/Ho_Chi_Minh: quiet 01:00-05:59, not quiet 00:59 / 06:00 / 23:00");
  const wrap = createQuietHoursChecker(get({ quiet_hours_start: "23", quiet_hours_end: "6", quiet_timezone: "Asia/Tokyo" }));
  assert.equal(wrap(Date.UTC(2026, 10, 28, 15, 0)), true, "00:00 JST inside 23-06 window");
  assert.equal(wrap(Date.UTC(2026, 10, 28, 13, 59)), false, "22:59 JST before the window");
  assert.equal(wrap(Date.UTC(2026, 10, 28, 14, 0)), true, "23:00 JST is the start of the window");
  assert.equal(wrap(Date.UTC(2026, 10, 28, 20, 59)), true, "05:59 JST inside the window");
  assert.equal(wrap(Date.UTC(2026, 10, 28, 21, 0)), false, "06:00 JST is the end of the window");
  console.log("PASS wrap-around window 23-06 in Asia/Tokyo");
  assert.equal(createQuietHoursChecker(get({ quiet_hours_start: "3", quiet_hours_end: "3", quiet_timezone: "UTC" }))(Date.now()), false, "start == end never quiet");
  assert.equal(createQuietHoursChecker(get({ quiet_hours_start: "x", quiet_hours_end: "6", quiet_timezone: "UTC" }))(Date.now()), false, "non-integer start never quiet");
  assert.equal(createQuietHoursChecker(get({ quiet_hours_start: "1", quiet_hours_end: "6", quiet_timezone: "Mars/Olympus" }))(Date.now()), false, "invalid time zone never quiet");
  assert.equal(createQuietHoursChecker(get({ quiet_hours_start: "1", quiet_hours_end: "6", quiet_timezone: "" }))(Date.UTC(2026, 10, 28, 2, 0)), true, "empty time zone falls back to UTC");
  console.log("PASS degenerate inputs: start==end, non-integer, invalid tz -> never quiet; empty tz -> UTC");
}
console.log("ALL SCHEDULE TESTS PASS");
