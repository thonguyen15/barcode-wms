import { Hono } from "hono";
import { requireAuth } from "../auth.mjs";
import { getDb } from "../db.mjs";
import { nowISO } from "../item_utils.mjs";
import { syncTelegramButtons } from "../tg_sync.mjs";

const PUBLIC_FIELDS = ["name", "serial_raw", "serial_clean", "condition", "mvd", "note", "battery", "coverage"];

async function findPublicItem(env, token) {
  const { rows } = await getDb(env).execute({
    sql: "SELECT * FROM items WHERE token = ? AND is_deleted = 0",
    args: [token],
  });
  return rows[0];
}

export const publicRoutes = new Hono();

publicRoutes.get("/public/item", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "Missing token" }, 400);
  try {
    const item = await findPublicItem(c.env, token);
    if (!item) return c.json({ error: "Item not found" }, 404);
    return c.json({
      mvd: item.mvd || "",
      name: item.name || "",
      serial: item.serial_clean || "",
      condition: item.condition || "",
      battery: item.battery || "",
      coverage: item.coverage || "",
      note: item.note || "",
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

publicRoutes.post("/public/item", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "Missing token" }, 400);
  try {
    const item = await findPublicItem(c.env, token);
    if (!item) return c.json({ error: "Item not found" }, 404);

    const fields = await c.req.json().catch(() => ({}));
    const updates = {};
    const rawSerial = fields.serial !== undefined ? fields.serial : fields.serial_raw !== undefined ? fields.serial_raw : item.serial_raw;
    updates.name = (fields.name !== undefined ? fields.name : item.name) || "";
    updates.serial_raw = (rawSerial !== undefined ? rawSerial : item.serial_raw) || "";
    updates.condition = (fields.condition !== undefined ? fields.condition : item.condition) || "";
    updates.mvd = (fields.mvd !== undefined ? fields.mvd : item.mvd) || "";
    updates.note = (fields.note !== undefined ? fields.note : item.note) || "";
    updates.battery = (fields.battery !== undefined ? fields.battery : item.battery) || "";
    updates.coverage = (fields.coverage !== undefined ? fields.coverage : item.coverage) || "";
    updates.serial_clean = (updates.serial_raw.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim();

    const changes = {};
    for (const k of PUBLIC_FIELDS) {
      const oldValue = item[k] ?? "";
      const newValue = String(updates[k] ?? "").trim();
      if (oldValue !== newValue) changes[k] = { from: oldValue, to: newValue };
    }

    if (Object.keys(changes).length > 0) {
      const updatedAt = nowISO();
      const actor = "TelegramWebApp";
      await getDb(c.env).execute({
        sql: `UPDATE items SET
          name = ?,
          serial_raw = ?,
          serial_clean = ?,
          condition = ?,
          mvd = ?,
          note = ?,
          battery = ?,
          coverage = ?,
          updated_at = ?
        WHERE id = ?`,
        args: [
          updates.name,
          updates.serial_raw,
          updates.serial_clean,
          updates.condition,
          updates.mvd,
          updates.note,
          updates.battery,
          updates.coverage,
          updatedAt,
          item.id,
        ],
      });
      await getDb(c.env).execute({
        sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
        args: [item.id, actor, JSON.stringify(changes), updatedAt],
      });
      await syncTelegramButtons(c.env, item.id);
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

publicRoutes.get("/scan/:token", requireAuth, async (c) => {
  const token = c.req.param("token");
  const { rows } = await getDb(c.env).execute({ sql: "SELECT * FROM items WHERE token = ?", args: [token] });
  const item = rows[0];
  if (!item) {
    console.warn(`[SCAN-REJECT] user=${c.get("user")} token="${token}" không tồn tại (QR cũ hoặc sai mã)`);
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ item });
});
