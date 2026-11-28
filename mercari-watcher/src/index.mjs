import { createServer } from "node:http";
import { createTursoClient, createStore } from "./store.mjs";
import { searchMercari, parseMercariSearchUrl } from "./mercari.mjs";
import { createPoller } from "./poller.mjs";
import { createTelegram, sendAlertMessage } from "./telegram.mjs";
import { handleCommand, buildAuthorizedChecker, formatAlert, alertKeyboard } from "./commands.mjs";

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
  if (items.length > 1) {
    const lines = items.map((it) => `${it.name} — ¥${Number(it.price)} https://jp.mercari.com/item/${it.id}`);
    await sendAlertMessage(telegram, { text: `🔔 ${watch.name}: ${items.length} item mới\n${lines.join("\n")}` });
    return;
  }
  const item = items[0];
  await sendAlertMessage(telegram, {
    text: formatAlert(item, watch.name),
    keyboard: alertKeyboard(item),
    photoUrl: Array.isArray(item.thumbnails) && item.thumbnails.length ? item.thumbnails[0] : undefined,
  });
}

async function alertError(watch, err) {
  await sendAlertMessage(telegram, {
    text: `⚠️ Watch "${watch.name}" lỗi: ${String(err.message).slice(0, 200)}`,
  });
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

async function buildStatusJson() {
  const status = poller.getStatus();
  return {
    alertedToday: status.alertedToday,
    watches: (await store.listWatches()).map((w) => {
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

function startHealthServer() {
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/status") {
      if (!apiKey || req.headers["x-api-key"] !== apiKey) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await buildStatusJson()));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(healthPort, "127.0.0.1");
}

async function main() {
  await store.init();
  await seedEnvWatches();
  startHealthServer();
  pollTelegram();
  poller.loop();
  pruneLoop();
  log({ level: "info", msg: "started", healthPort });
}

async function pruneOnce() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const removed = await store.pruneSeen(cutoff);
  log({ level: "info", msg: "prune_seen", removed, cutoff });
}

async function pruneLoop() {
  await pruneOnce();
  for (;;) {
    await new Promise((r) => setTimeout(r, 24 * 60 * 60 * 1000));
    await pruneOnce();
  }
}

main();
