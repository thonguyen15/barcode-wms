import { createClient } from "@libsql/client";

export function createStore(client) {
  async function init() {
    await client.execute(`CREATE TABLE IF NOT EXISTS mercari_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      params_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_sec INTEGER NOT NULL DEFAULT 5,
      last_run_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    )`);
    await client.execute(`CREATE TABLE IF NOT EXISTS mercari_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    )`);
    await client.execute(`CREATE TABLE IF NOT EXISTS mercari_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      name TEXT,
      price TEXT,
      created_unix INTEGER,
      sent_at TEXT NOT NULL,
      mode TEXT
    )`);
    await client.execute(`CREATE TABLE IF NOT EXISTS mercari_status (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    await client.execute(`CREATE TABLE IF NOT EXISTS mercari_seen_items (
      item_id TEXT PRIMARY KEY,
      watch_id INTEGER NOT NULL,
      name TEXT,
      price TEXT,
      created_unix INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL
    )`);
  }

  async function listWatches() {
    const rs = await client.execute("SELECT * FROM mercari_watches ORDER BY id");
    return rs.rows.map(rowToWatch);
  }

  async function getWatch(id) {
    const rs = await client.execute({ sql: "SELECT * FROM mercari_watches WHERE id = ?", args: [id] });
    return rs.rows.length ? rowToWatch(rs.rows[0]) : null;
  }

  async function createWatch({ name, url, paramsJson, intervalSec = 5 }) {
    const now = new Date().toISOString();
    const existing = await client.execute({ sql: "SELECT id FROM mercari_watches WHERE url = ?", args: [url] });
    if (existing.rows.length) {
      return { created: false, id: Number(existing.rows[0].id) };
    }
    const rs = await client.execute({
      sql: "INSERT INTO mercari_watches (name, url, params_json, interval_sec, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [name, url, paramsJson, intervalSec, now],
    });
    return { created: true, id: Number(rs.lastInsertRowid) };
  }

  async function disableWatch(id) {
    const rs = await client.execute({
      sql: "UPDATE mercari_watches SET enabled = 0 WHERE id = ?",
      args: [id],
    });
    return rs.rowsAffected > 0;
  }

  async function updateWatchRun(id, { intervalSec, lastRunAt, lastError }) {
    await client.execute(
      "UPDATE mercari_watches SET interval_sec = ?, last_run_at = ?, last_error = ? WHERE id = ?",
      [intervalSec, lastRunAt, lastError, id],
    );
  }

  async function filterSeenIds(itemIds) {
    const seen = new Set();
    for (let i = 0; i < itemIds.length; i += 50) {
      const chunk = itemIds.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(", ");
      const rs = await client.execute({
        sql: `SELECT item_id FROM mercari_seen_items WHERE item_id IN (${placeholders})`,
        args: chunk,
      });
      for (const row of rs.rows) seen.add(String(row.item_id));
    }
    return seen;
  }

  async function insertSeenMany(rows) {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const args = chunk.flatMap((r) => [r.itemId, r.watchId, r.name, r.price, r.createdUnix, r.firstSeenAt]);
      await client.execute(
        `INSERT INTO mercari_seen_items (item_id, watch_id, name, price, created_unix, first_seen_at)
         VALUES ${placeholders}
         ON CONFLICT(item_id) DO NOTHING`,
        args,
      );
    }
  }

  async function deleteSeen(itemIds) {
    if (!itemIds.length) return;
    for (let i = 0; i < itemIds.length; i += 50) {
      const chunk = itemIds.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(", ");
      await client.execute({
        sql: `DELETE FROM mercari_seen_items WHERE item_id IN (${placeholders})`,
        args: chunk,
      });
    }
  }

  async function countSeenToday() {
    const today = new Date().toISOString().slice(0, 10);
    const rs = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM mercari_seen_items WHERE first_seen_at >= ?",
      args: [`${today}T00:00:00.000Z`],
    });
    return Number(rs.rows[0].n);
  }

  async function pruneSeen(beforeIso) {
    const rs = await client.execute({
      sql: "DELETE FROM mercari_seen_items WHERE first_seen_at < ?",
      args: [beforeIso],
    });
    return rs.rowsAffected;
  }

  async function getSetting(key) {
    const rs = await client.execute({ sql: "SELECT value FROM mercari_settings WHERE key = ?", args: [key] });
    return rs.rows.length ? String(rs.rows[0].value) : null;
  }

  async function setSetting(key, value, by = null) {
    const now = new Date().toISOString();
    await client.execute(
      `INSERT INTO mercari_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [key, String(value), now, by],
    );
  }

  async function getAllSettings() {
    const rs = await client.execute("SELECT key, value FROM mercari_settings");
    const out = {};
    for (const row of rs.rows) out[String(row.key)] = String(row.value);
    return out;
  }

  async function insertAlert({ watchId, itemId, name = null, price = null, createdUnix = null, sentAt, mode = null }) {
    await client.execute(
      `INSERT INTO mercari_alerts (watch_id, item_id, name, price, created_unix, sent_at, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [watchId, itemId, name, price, createdUnix, sentAt, mode],
    );
  }

  async function setStatus(key, valueJson) {
    await client.execute(
      `INSERT INTO mercari_status (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, valueJson, new Date().toISOString()],
    );
  }

  async function pruneAlerts(beforeIso) {
    const rs = await client.execute({
      sql: "DELETE FROM mercari_alerts WHERE sent_at < ?",
      args: [beforeIso],
    });
    return rs.rowsAffected;
  }

  return {
    init,
    listWatches,
    getWatch,
    createWatch,
    disableWatch,
    updateWatchRun,
    filterSeenIds,
    insertSeenMany,
    deleteSeen,
    countSeenToday,
    pruneSeen,
    getSetting,
    setSetting,
    getAllSettings,
    insertAlert,
    setStatus,
    pruneAlerts,
  };
}

function rowToWatch(row) {
  return {
    id: Number(row.id),
    name: String(row.name),
    url: String(row.url),
    paramsJson: String(row.params_json),
    enabled: Number(row.enabled) === 1,
    intervalSec: Number(row.interval_sec),
    lastRunAt: row.last_run_at === null ? null : String(row.last_run_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
  };
}

export function createTursoClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}
