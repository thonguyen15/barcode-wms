import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../auth.mjs";
import { getDb } from "../db.mjs";
import { tgFetch } from "../telegram.mjs";
import { WATCHER_PAGE_HTML } from "../watcher_page.mjs";
import { mercariItemUrl, maskSecret, parseMercariSearchUrl } from "../watcher_utils.mjs";

const SETTINGS_DEFAULTS = {
  alert_chat_id: "",
  admin_user_ids: "",
  country_code: "VN",
  budget_per_minute: "36",
  fresh_window_min: "15",
  poll_min_sec: "5",
  poll_max_sec: "15",
  quiet_hours_start: "1",
  quiet_hours_end: "6",
  quiet_timezone: "Asia/Ho_Chi_Minh",
};

export const watcherRoutes = new Hono();

watcherRoutes.use("*", requireAuth, requireAdmin);

export const watcherPageRoute = new Hono();

watcherPageRoute.use("*", requireAuth, requireAdmin);

watcherPageRoute.get("/watcher.html", (c) =>
  c.html(WATCHER_PAGE_HTML),
);

function isIntIn(v, min, max) {
  return Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
}

const SETTINGS_VALIDATORS = {
  alertChatId: (v) => /^-?\d{3,}$/.test(v),
  adminUserIds: (v) => /^\d+(,\d+)*$/.test(v),
  countryCode: (v) => /^[A-Z]{2}$/.test(v),
  budgetPerMinute: (v) => isIntIn(v, 1, 600),
  freshWindowMin: (v) => isIntIn(v, 1, 120),
  pollMinSec: (v) => isIntIn(v, 2, 300),
  pollMaxSec: (v) => isIntIn(v, 2, 600),
  quietHoursStart: (v) => isIntIn(v, 0, 23),
  quietHoursEnd: (v) => isIntIn(v, 0, 24),
  quietTimezone: (v) => {
    if (!/^[A-Za-z_]+\/[A-Za-z_+\/-]+$/.test(v)) return false;
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  },
};

/** Read the settings rows into a keyed map of values. */
async function readSettings(env) {
  const { rows } = await getDb(env).execute("SELECT key, value FROM mercari_settings");
  const values = { ...SETTINGS_DEFAULTS };
  for (const row of rows) {
    if (row.key === "telegram_bot_token") values.botToken = row.value;
    else values[row.key] = row.value;
  }
  return values;
}

/** Shape the settings map into the API response, token masked. */
function settingsResponse(values) {
  return {
    botTokenMasked: maskSecret(values.botToken),
    botTokenSet: Boolean(values.botToken),
    alertChatId: values.alert_chat_id,
    adminUserIds: values.admin_user_ids,
    countryCode: values.country_code,
    budgetPerMinute: values.budget_per_minute,
    freshWindowMin: values.fresh_window_min,
    pollMinSec: values.poll_min_sec,
    pollMaxSec: values.poll_max_sec,
    quietHoursStart: values.quiet_hours_start,
    quietHoursEnd: values.quiet_hours_end,
    quietTimezone: values.quiet_timezone,
  };
}

watcherRoutes.get("/watcher/settings", async (c) => {
  const values = await readSettings(c.env);
  return c.json(settingsResponse(values));
});

watcherRoutes.put("/watcher/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const values = await readSettings(c.env);
  const updates = [];
  if (typeof body.botToken === "string" && body.botToken) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(body.botToken)) {
      return c.json({ error: "botToken" }, 400);
    }
    updates.push(["telegram_bot_token", body.botToken]);
  }
  for (const [camel, isValid] of Object.entries(SETTINGS_VALIDATORS)) {
    const key = camel.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    if (typeof body[camel] !== "string") continue;
    if (!isValid(body[camel])) return c.json({ error: camel }, 400);
    updates.push([key, body[camel]]);
  }
  if (!updates.length) return c.json({ error: "Không có trường nào để cập nhật" }, 400);
  const applied = { ...values, ...Object.fromEntries(updates) };
  if (Number(applied.poll_min_sec) > Number(applied.poll_max_sec)) {
    return c.json({ error: "pollMaxSec" }, 400);
  }
  const now = new Date().toISOString();
  await getDb(c.env).batch(
    updates.map(([key, value]) => ({
      sql: `INSERT INTO mercari_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
      args: [key, value, now, c.get("user")],
    })),
  );
  const fresh = await readSettings(c.env);
  return c.json(settingsResponse(fresh));
});

watcherRoutes.post("/watcher/settings/test", async (c) => {
  const values = await readSettings(c.env);
  if (!values.botToken) return c.json({ ok: false, description: "Chưa cấu hình bot token" }, 400);
  if (!values.alert_chat_id) return c.json({ ok: false, description: "Chưa cấu hình alert chat id" }, 400);
  try {
    const res = await tgFetch(c.env, `https://api.telegram.org/bot${values.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: values.alert_chat_id, text: "Test từ watcher UI" }),
    });
    const data = await res.json();
    return c.json({ ok: data.ok === true, description: data.description || "" });
  } catch (err) {
    return c.json({ ok: false, description: err.message });
  }
});

watcherRoutes.get("/watcher/status", async (c) => {
  const { rows } = await getDb(c.env).execute(
    "SELECT value_json FROM mercari_status WHERE key = 'snapshot'",
  );
  if (!rows.length) return c.json({ watches: [], updatedAt: null });
  try {
    return c.json(JSON.parse(rows[0].value_json));
  } catch {
    return c.json({ watches: [], updatedAt: null });
  }
});

watcherRoutes.get("/watcher/watches", async (c) => {
  const { rows } = await getDb(c.env).execute(
    "SELECT id, name, url, params_json, enabled, interval_sec, last_run_at, last_error, created_at FROM mercari_watches ORDER BY id",
  );
  return c.json({
    rows: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      url: row.url,
      paramsJson: row.params_json,
      enabled: Number(row.enabled) === 1,
      intervalSec: Number(row.interval_sec),
      lastRunAt: row.last_run_at || null,
      lastError: row.last_error || null,
      createdAt: row.created_at,
    })),
  });
});

watcherRoutes.post("/watcher/watches", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.url !== "string" || !body.url) return c.json({ error: "Thiếu url" }, 400);
  let parsed;
  try {
    parsed = new URL(body.url);
  } catch {
    return c.json({ error: "URL không hợp lệ" }, 400);
  }
  if (parsed.protocol !== "https:" || parsed.host !== "jp.mercari.com") {
    return c.json({ error: "URL phải là https://jp.mercari.com/..." }, 400);
  }
  let condition;
  try {
    condition = parseMercariSearchUrl(body.url);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
  const paramsJson = JSON.stringify(condition);
  const existing = await getDb(c.env).execute({
    sql: "SELECT id FROM mercari_watches WHERE url = ?",
    args: [body.url],
  });
  if (existing.rows.length) return c.json({ error: "URL đã tồn tại" }, 409);
  const now = new Date().toISOString();
  const rs = await getDb(c.env).execute({
    sql: "INSERT INTO mercari_watches (name, url, params_json, enabled, interval_sec, created_at) VALUES (?, ?, ?, 1, 5, ?)",
    args: [condition.keyword, body.url, paramsJson, now],
  });
  return c.json({ ok: true, id: Number(rs.lastInsertRowid) });
});

watcherRoutes.patch("/watcher/watches/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const sets = [];
  const args = [];
  for (const key of Object.keys(body)) {
    if (!["enabled", "intervalSec", "name"].includes(key)) {
      return c.json({ error: `Trường không hợp lệ: ${key}` }, 400);
    }
  }
  if (typeof body.enabled === "boolean") {
    sets.push("enabled = ?");
    args.push(body.enabled ? 1 : 0);
  }
  if (body.intervalSec !== undefined && body.intervalSec !== null) {
    if (!Number.isInteger(body.intervalSec) || body.intervalSec < 1 || body.intervalSec > 3600) {
      return c.json({ error: "intervalSec phải là số nguyên từ 1 đến 3600" }, 400);
    }
    sets.push("interval_sec = ?");
    args.push(body.intervalSec);
  }
  if (typeof body.name === "string" && body.name) {
    sets.push("name = ?");
    args.push(body.name);
  }
  if (!sets.length) return c.json({ error: "Không có trường nào để cập nhật" }, 400);
  args.push(id);
  const rs = await getDb(c.env).execute({
    sql: `UPDATE mercari_watches SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
  if (rs.rowsAffected === 0) return c.json({ error: "Không tìm thấy watch" }, 404);
  return c.json({ ok: true });
});

watcherRoutes.delete("/watcher/watches/:id", async (c) => {
  const id = c.req.param("id");
  const rs = await getDb(c.env).execute({ sql: "SELECT id FROM mercari_watches WHERE id = ?", args: [id] });
  if (!rs.rows.length) return c.json({ error: "Không tìm thấy watch" }, 404);
  await getDb(c.env).batch([
    { sql: "DELETE FROM mercari_watches WHERE id = ?", args: [id] },
    { sql: "DELETE FROM mercari_seen_items WHERE watch_id = ?", args: [id] },
  ]);
  return c.json({ ok: true });
});

watcherRoutes.get("/watcher/alerts", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const { rows } = await getDb(c.env).execute({
    sql: "SELECT id, watch_id, item_id, name, price, created_unix, sent_at, mode FROM mercari_alerts ORDER BY id DESC LIMIT ?",
    args: [limit],
  });
  return c.json({
    rows: rows.map((row) => ({
      id: Number(row.id),
      watchId: Number(row.watch_id),
      itemId: row.item_id,
      name: row.name,
      price: row.price,
      createdUnix: Number(row.created_unix),
      sentAt: row.sent_at,
      mode: row.mode,
      itemUrl: mercariItemUrl(row.item_id),
    })),
  });
});
