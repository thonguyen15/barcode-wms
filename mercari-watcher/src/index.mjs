import { createServer } from "node:http";
import { createTursoClient, createStore } from "./store.mjs";
import { searchMercari, parseMercariSearchUrl } from "./mercari.mjs";
import { createPoller } from "./poller.mjs";
import { createTelegram, sendAlertMessage } from "./telegram.mjs";
import { handleCommand, buildAuthorizedChecker, formatAlert, alertKeyboard, escapeHtml } from "./commands.mjs";

const REQUIRED = ["MERCARI_BOT_TOKEN", "MERCARI_ALERT_CHAT_ID", "TURSO_DATABASE_URL"];

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
const isAuthorizedUser = buildAuthorizedChecker(process.env.AUTHORIZED_TELEGRAM_USER_IDS);
const telegram = createTelegram(process.env.MERCARI_BOT_TOKEN);
const store = createStore(createTursoClient());

async function alert(watch, items) {
  let res;
  if (items.length > 1) {
    const lines = items.map(
      (it) => `${escapeHtml(it.name)} — ¥${Number(it.price)} https://jp.mercari.com/item/${it.id}`,
    );
    res = await sendAlertMessage(telegram, {
      text: `🔔 ${escapeHtml(watch.name)}: ${items.length} item mới\n${lines.join("\n")}`,
    });
  } else {
    const item = items[0];
    res = await sendAlertMessage(telegram, {
      text: formatAlert(item, watch.name),
      keyboard: alertKeyboard(item),
      photoUrl: Array.isArray(item.thumbnails) && item.thumbnails.length ? item.thumbnails[0] : undefined,
    });
  }
  if (!res.ok) {
    log({ level: "warn", msg: "alert_send_rejected", watchId: watch.id, mode: res.mode, description: res.description });
  }
}

async function alertError(watch, err) {
  const res = await sendAlertMessage(telegram, {
    text: `⚠️ Watch "${watch.name}" lỗi: ${String(err.message).slice(0, 200)}`,
    plain: true,
  });
  if (!res.ok) {
    log({ level: "warn", msg: "alert_error_rejected", watchId: watch.id, mode: res.mode, description: res.description });
  }
}

const poller = createPoller({ store, searchMercari, alert, alertError, log });

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

async function pollTelegram() {
  let offset = 0;
  for (;;) {
    try {
      const res = await telegram.getUpdates(offset || undefined, 30);
      if (!res.ok || !Array.isArray(res.result)) {
        log({ level: "warn", msg: "getUpdates_failed", description: res.description });
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
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
          searchMercari,
          pollerStatus: poller.getStatus(),
        });
        const sent = await telegram.sendMessage({ chat_id: chatId, text: reply });
        if (!sent.ok) log({ level: "warn", msg: "reply_failed", description: sent.description });
      }
    } catch (err) {
      log({ level: "error", msg: "telegram_loop_error", err: err.message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
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
  await seedEnvWatches();
  startHealthServer({ buildStatus: () => buildStatusJson(store, poller) });
  pollTelegram();
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
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

import { pathToFileURL } from "node:url";

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main();
}

