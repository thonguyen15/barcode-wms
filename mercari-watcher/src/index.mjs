import { createServer } from "node:http";
import { createTursoClient, createStore } from "./store.mjs";
import { searchMercari, parseMercariSearchUrl } from "./mercari.mjs";
import { createPoller } from "./poller.mjs";
import { createSettings } from "./settings.mjs";
import { createTelegram, sendAlertMessage } from "./telegram.mjs";
import { handleCommand, buildAuthorizedChecker, formatAlert, alertKeyboard, escapeHtml } from "./commands.mjs";

const REQUIRED = ["TURSO_DATABASE_URL"];

function fail(envName) {
  console.log(JSON.stringify({ level: "error", msg: `missing env ${envName}` }));
  process.exit(1);
}

for (const name of REQUIRED) {
  if (!process.env[name]) fail(name);
}

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
const healthPort = Number(process.env.HEALTH_PORT || 8788);
const apiKey = process.env.MERCARI_API_KEY || "";
const store = createStore(createTursoClient());
const settings = createSettings({ store, env: process.env, log });

let telegram = null;
let telegramLastError = null;
let isAuthorizedUser = () => false;
let pollGen = 0;

function rebuildTelegram() {
  const token = settings.get("telegram_bot_token");
  telegram = token ? createTelegram(token) : null;
}

function rebuildAuthorizedChecker() {
  isAuthorizedUser = buildAuthorizedChecker(settings.get("admin_user_ids") || "");
}

function searchMercariWithSettings(condition, opts = {}) {
  return searchMercari(condition, { ...opts, countryCode: settings.get("country_code") || undefined });
}

async function alert(watch, items) {
  const chatId = settings.get("alert_chat_id");
  let res;
  if (items.length > 1) {
    const lines = items.map(
      (it) => `${escapeHtml(it.name)} — ¥${Number(it.price)} https://jp.mercari.com/item/${it.id}`,
    );
    res = await sendAlertMessage(telegram, {
      chatId,
      text: `🔔 ${escapeHtml(watch.name)}: ${items.length} item mới\n${lines.join("\n")}`,
    });
  } else {
    const item = items[0];
    res = await sendAlertMessage(telegram, {
      chatId,
      text: formatAlert(item, watch.name),
      keyboard: alertKeyboard(item),
      photoUrl: Array.isArray(item.thumbnails) && item.thumbnails.length ? item.thumbnails[0] : undefined,
    });
  }
  if (!res.ok) {
    log({ level: "warn", msg: "alert_send_rejected", watchId: watch.id, mode: res.mode, description: res.description });
  }
  return res;
}

async function alertError(watch, err) {
  const res = await sendAlertMessage(telegram, {
    chatId: settings.get("alert_chat_id"),
    text: `⚠️ Watch "${watch.name}" lỗi: ${String(err.message).slice(0, 200)}`,
    plain: true,
  });
  if (!res.ok) {
    log({ level: "warn", msg: "alert_error_rejected", watchId: watch.id, mode: res.mode, description: res.description });
  }
}

const poller = createPoller({
  store,
  searchMercari: searchMercariWithSettings,
  alert,
  alertError,
  log,
  getBudgetPerMinute: () => Number(settings.get("budget_per_minute")) || 36,
  getFreshWindowMin: () => Number(settings.get("fresh_window_min")) || 15,
  getTelegramLastError: () => telegramLastError,
});

async function seedEnvWatches() {
  const raw = process.env.MERCARI_WATCH_URLS || "";
  for (const url of raw.split("|").map((s) => s.trim()).filter(Boolean)) {
    try {
      const condition = parseMercariSearchUrl(url);
      const created = await store.createWatch({
        name: condition.keyword,
        url,
        paramsJson: JSON.stringify(condition),
      });
      log({ level: "info", msg: "seed_watch", url, id: created.id, created: created.created });
    } catch (err) {
      log({ level: "error", msg: "seed_watch_failed", url, err: err.message });
    }
  }
}

async function pollTelegramLoop(gen) {
  let offset = 0;
  for (;;) {
    if (gen !== pollGen) return;
    if (!telegram) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    try {
      const res = await telegram.getUpdates(offset || undefined, 30);
      if (gen !== pollGen) return;
      if (!res.ok || !Array.isArray(res.result)) {
        telegramLastError = res.description || "getUpdates failed";
        log({ level: "warn", msg: "getUpdates_failed", description: res.description });
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      telegramLastError = null;
      for (const update of res.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        const userId = msg.from?.id;
        const chatId = msg.chat?.id;
        if (!isAuthorizedUser(userId)) {
          log({ level: "info", msg: "unauthorized_command", userId, text: msg.text.slice(0, 30) });
          continue;
        }
        const { reply } = await handleCommand({
          text: msg.text,
          userId,
          store,
          searchMercari: searchMercariWithSettings,
          pollerStatus: poller.getStatus(),
        });
        const sent = await telegram.sendMessage({ chat_id: chatId, text: reply });
        if (!sent.ok) log({ level: "warn", msg: "reply_failed", description: sent.description });
      }
    } catch (err) {
      telegramLastError = err.message;
      log({ level: "error", msg: "telegram_loop_error", err: err.message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function startTelegramLoop() {
  pollGen += 1;
  pollTelegramLoop(pollGen);
}

export async function buildStatusJson(store, poller) {
  const status = poller.getStatus();
  const watches = await store.listWatches();
  return {
    alertedToday: status.alertedToday,
    watches: watches.map((w) => {
      const live = status.watches.find((s) => s.id === w.id) || {};
      return {
        id: w.id,
        name: w.name,
        enabled: w.enabled,
        intervalSec: w.intervalSec,
        lastRunAt: w.lastRunAt,
        lastError: w.lastError,
        pausedUntil: live.pausedUntil ?? null,
        consecutiveEmpty: live.consecutiveEmpty ?? 0,
      };
    }),
  };
}

export function startHealthServer({ buildStatus, apiKey: key = apiKey, port = healthPort, logger = log }) {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.url === "/status") {
        if (!key || req.headers["x-api-key"] !== key) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }
        const body = JSON.stringify(await buildStatus());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      logger({ level: "error", msg: "http_handler_error", url: req.url, err: err.message });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end("internal error");
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function main() {
  await store.init();
  await settings.load();
  rebuildTelegram();
  rebuildAuthorizedChecker();
  settings.onChange("telegram_bot_token", () => {
    rebuildTelegram();
    startTelegramLoop();
    log({ level: "info", msg: "telegram_token_changed" });
  });
  settings.onChange("admin_user_ids", () => {
    rebuildAuthorizedChecker();
    log({ level: "info", msg: "admin_user_ids_changed" });
  });
  settings.start();
  await seedEnvWatches();
  const alertCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const removed = await store.pruneAlerts(alertCutoff);
    log({ level: "info", msg: "prune_alerts", removed, cutoff: alertCutoff });
  } catch (err) {
    log({ level: "error", msg: "prune_error", err: err.message });
  }
  startHealthServer({ buildStatus: () => buildStatusJson(store, poller) });
  startTelegramLoop();
  poller.loop();
  pruneLoop();
  log({ level: "info", msg: "started", healthPort });
}

export async function pruneLoop({ store: watchStore = store, logger = log, intervalMs = 24 * 60 * 60 * 1000 } = {}) {
  for (;;) {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const removed = await watchStore.pruneSeen(cutoff);
      logger({ level: "info", msg: "prune_seen", removed, cutoff });
    } catch (err) {
      logger({ level: "error", msg: "prune_error", err: err.message });
    }
    try {
      const alertCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const removedAlerts = await watchStore.pruneAlerts(alertCutoff);
      logger({ level: "info", msg: "prune_alerts", removed: removedAlerts, cutoff: alertCutoff });
    } catch (err) {
      logger({ level: "error", msg: "prune_error", err: err.message });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

import { pathToFileURL } from "node:url";

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main();
}

