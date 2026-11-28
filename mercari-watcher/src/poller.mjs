const DEFAULT_INTERVAL_MS = 5000;
const JITTER_MS = 1000;
const BACKOFF_CAP_MS = 300 * 1000;
const EMPTY_PAUSE_MS = 15 * 60 * 1000;
const EMPTY_PAUSE_THRESHOLD = 3;
const ERROR_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_ALERT_ITEMS = 5;

export function createPoller({
  store,
  searchMercari,
  alert,
  alertError,
  log = () => {},
  now = () => Date.now(),
  random = Math.random,
  getBudgetPerMinute = () => 36,
  getFreshWindowMin = () => 15,
  getTelegramLastError = () => null,
}) {
  const state = new Map();
  const requestTimes = [];
  let alertedTodayCount = 0;
  let alertedTodayDate = new Date().toISOString().slice(0, 10);

  function rollDailyCounter() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== alertedTodayDate) {
      alertedTodayDate = today;
      alertedTodayCount = 0;
    }
  }

  function getState(watch) {
    let s = state.get(watch.id);
    if (!s) {
      s = {
        intervalMs: watch.intervalSec * 1000,
        nextRunAt: 0,
        consecutiveEmpty: 0,
        pausedUntil: 0,
        lastErrorAlertAt: 0,
        lastNumFound: 0,
        baselineDone: false,
      };
      state.set(watch.id, s);
    }
    return s;
  }

  function underBudget(ts) {
    const cutoff = ts - 60000;
    while (requestTimes.length && requestTimes[0] <= cutoff) requestTimes.shift();
    return requestTimes.length < getBudgetPerMinute();
  }

  async function pollWatch(watch, ts) {
    const s = getState(watch);
    requestTimes.push(ts);
    const runAtIso = new Date(ts).toISOString();
    const condition = JSON.parse(watch.paramsJson);
    let result;
    try {
      result = await searchMercari(condition);
    } catch (err) {
      s.intervalMs = Math.min(Math.max(s.intervalMs * 2, DEFAULT_INTERVAL_MS * 2), BACKOFF_CAP_MS);
      s.consecutiveEmpty = 0;
      await store.updateWatchRun(watch.id, {
        intervalSec: Math.round(s.intervalMs / 1000),
        lastRunAt: runAtIso,
        lastError: err.message.slice(0, 200),
      });
      log({ level: "warn", msg: "poll_error", watchId: watch.id, err: err.message, intervalMs: s.intervalMs });
      const transient = !err.status || err.status === 403 || err.status === 429 || err.status >= 500;
      if (transient && ts - s.lastErrorAlertAt > ERROR_ALERT_COOLDOWN_MS) {
        s.lastErrorAlertAt = ts;
        await alertError(watch, err);
      }
      return;
    }
    s.intervalMs = DEFAULT_INTERVAL_MS;
    s.lastNumFound = result.numFound;
    s.baselineDone = true;
    const isBaseline = watch.lastRunAt === null;
    const freshWindowStart = Math.floor((ts - getFreshWindowMin() * 60000) / 1000);
    const pageIds = result.items.map((it) => String(it.id));
    const seenIds = await store.filterSeenIds(pageIds);
    const newRows = result.items.filter((it) => !seenIds.has(String(it.id)));
    await store.insertSeenMany(
      newRows.map((it) => ({
        itemId: it.id,
        watchId: watch.id,
        name: it.name,
        price: it.price,
        createdUnix: Number(it.created),
        firstSeenAt: runAtIso,
      })),
    );
    const fresh = isBaseline ? [] : newRows.filter((it) => Number(it.created) >= freshWindowStart);
    if (result.items.length === 0) {
      s.consecutiveEmpty += 1;
      if (s.consecutiveEmpty >= EMPTY_PAUSE_THRESHOLD) {
        s.consecutiveEmpty = 0;
        s.pausedUntil = ts + EMPTY_PAUSE_MS;
        log({ level: "warn", msg: "soft_block_pause", watchId: watch.id, until: new Date(s.pausedUntil).toISOString() });
        if (ts - s.lastErrorAlertAt > ERROR_ALERT_COOLDOWN_MS) {
          s.lastErrorAlertAt = ts;
          await alertError(watch, new Error("Mercari trả về rỗng liên tục — pause 15 phút"));
        }
      }
    } else {
      s.consecutiveEmpty = 0;
    }
    log({
      level: "info",
      msg: "polled",
      watchId: watch.id,
      numFound: result.numFound,
      items: result.items.length,
      fresh: fresh.length,
      baseline: isBaseline,
    });
    if (fresh.length) {
      const head = fresh.slice(0, MAX_ALERT_ITEMS);
      const tail = fresh.slice(MAX_ALERT_ITEMS);
      const failedIds = [];
      const recordSent = async (items, res) => {
        const sentAt = new Date().toISOString();
        for (const item of items) {
          await store.insertAlert({
            watchId: watch.id,
            itemId: item.id,
            name: item.name,
            price: item.price,
            createdUnix: Number(item.created),
            sentAt,
            mode: res.mode,
          });
        }
      };
      const trySend = async (items) => {
        try {
          const res = await alert(watch, items);
          if (res && res.ok) {
            alertedTodayCount += items.length;
            await recordSent(items, res);
          } else {
            failedIds.push(...items.map((it) => it.id));
            log({ level: "warn", msg: "alert_failed", watchId: watch.id, count: items.length, mode: res?.mode, description: res?.description });
          }
        } catch (err) {
          failedIds.push(...items.map((it) => it.id));
          log({ level: "warn", msg: "alert_failed", watchId: watch.id, count: items.length, err: err.message });
        }
      };
      for (const item of head) {
        await trySend([item]);
      }
      if (tail.length) {
        await trySend(tail);
      }
      if (failedIds.length) {
        await store.deleteSeen(failedIds);
      }
    }
    await store.updateWatchRun(watch.id, {
      intervalSec: Math.round(s.intervalMs / 1000),
      lastRunAt: runAtIso,
      lastError: null,
    });
  }

  function budgetUsedLastMinute(ts) {
    const cutoff = ts - 60000;
    while (requestTimes.length && requestTimes[0] <= cutoff) requestTimes.shift();
    return requestTimes.length;
  }

  async function writeSnapshot() {
    const ts = now();
    const watches = await store.listWatches();
    const snapshot = {
      updatedAt: new Date().toISOString(),
      alertedToday: alertedTodayCount,
      budgetUsedLastMinute: budgetUsedLastMinute(ts),
      telegramLastError: getTelegramLastError(),
      watches: watches.map((w) => {
        const s = state.get(w.id);
        return {
          id: w.id,
          name: w.name,
          enabled: w.enabled,
          intervalMs: s ? s.intervalMs : w.intervalSec * 1000,
          lastRunAt: w.lastRunAt,
          lastError: w.lastError,
          pausedUntil: s && s.pausedUntil ? new Date(s.pausedUntil).toISOString() : null,
          consecutiveEmpty: s ? s.consecutiveEmpty : 0,
          lastNumFound: s ? s.lastNumFound : 0,
          baselineDone: s ? s.baselineDone : false,
        };
      }),
    };
    await store.setStatus("snapshot", JSON.stringify(snapshot));
    return snapshot;
  }

  async function tick() {
    rollDailyCounter();
    const ts = now();
    const watches = await store.listWatches();
    for (const watch of watches) {
      if (!watch.enabled) continue;
      const s = getState(watch);
      if (ts < s.pausedUntil) continue;
      if (ts < s.nextRunAt) continue;
      if (!underBudget(ts)) {
        s.nextRunAt = ts + 1000;
        continue;
      }
      await pollWatch(watch, ts);
      s.nextRunAt = now() + s.intervalMs + Math.round(random() * JITTER_MS);
    }
    await writeSnapshot();
  }

  async function loop() {
    for (;;) {
      try {
        await tick();
      } catch (err) {
        log({ level: "error", msg: "tick_error", err: err.message });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  function getStatus() {
    rollDailyCounter();
    return {
      alertedToday: alertedTodayCount,
      watches: [...state.entries()].map(([id, s]) => ({
        id,
        intervalSec: Math.round(s.intervalMs / 1000),
        pausedUntil: s.pausedUntil ? new Date(s.pausedUntil).toISOString() : null,
        consecutiveEmpty: s.consecutiveEmpty,
      })),
    };
  }

  return { tick, loop, getStatus };
}
