import { Hono } from "hono";
import { requireAuth, requireStaff } from "../auth.mjs";
import { batch, getDb } from "../db.mjs";
import {
  buildItemQuery,
  detectCategory,
  genToken,
  loadCategories,
  nextPackageId,
  nowISO,
  parsePayload,
} from "../item_utils.mjs";
import { tokenToQrDataUrl } from "../qr_png.mjs";
import { sendTelegramButtonsMessage, syncTelegramButtons } from "../tg_sync.mjs";

const CHUNK_SIZE = 40;
const ALLOWED_STATUSES = new Set(["SHIPPED", "RETURN", "RETURNED", "HENBIN", "CREATED", "REQUEST_RETURN"]);
const RETURN_STATUSES = new Set(["RETURN", "RETURNED", "HENBIN", "REQUEST_RETURN"]);
const ALLOWED_INVENTORY = new Set(["IN_STOCK", "NOT_IN_STOCK", "UNKNOWN"]);
const EDITABLE_FIELDS = ["name", "serial_raw", "serial_clean", "condition", "mvd", "note", "battery", "coverage"];

export async function getItem(env, id) {
  const { rows } = await getDb(env).execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] });
  return rows[0];
}

export async function pendingRequest(env, id) {
  const { rows } = await getDb(env).execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING'",
    args: [id],
  });
  return rows[0];
}

export const itemRoutes = new Hono();

itemRoutes.post("/items", requireAuth, requireStaff, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const fields = parsePayload(body.raw_text);
    if (!fields.serial_clean) {
      return c.json({ error: "Thiếu/không nhận diện được serial trong JSON." }, 400);
    }

    const { rows: existRows } = await getDb(c.env).execute({
      sql: "SELECT id, package_id, name, serial_clean FROM items WHERE LOWER(serial_clean) = LOWER(?) AND is_deleted = 0 LIMIT 1",
      args: [fields.serial_clean],
    });
    if (existRows[0]) {
      return c.json({ error: "Đã có item này (serial trùng) và đang tồn tại.", existed: existRows[0] }, 409);
    }

    const packageId = await nextPackageId(c.env);
    const token = genToken();
    const t = nowISO();
    const rules = await loadCategories(c.env);
    try {
      await getDb(c.env).execute({
        sql: `INSERT INTO items (
          package_id, token,
          name, serial_raw, serial_clean, condition, mvd, note, battery, coverage,
          status, inventory_status,
          created_at, updated_at,
          is_deleted, created_by, category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 'UNKNOWN', ?, ?, 0, ?, ?)`,
        args: [
          packageId,
          token,
          fields.name,
          fields.serial_raw,
          fields.serial_clean,
          fields.condition,
          fields.mvd,
          fields.note,
          fields.battery,
          fields.coverage,
          t,
          t,
          c.get("user"),
          detectCategory(rules, fields.name),
        ],
      });
    } catch (err) {
      if (String(err.message || "").toLowerCase().includes("unique")) {
        return c.json({ error: "Đã có item này (serial trùng) và đang tồn tại." }, 409);
      }
      throw err;
    }

    const { rows: itemRows } = await getDb(c.env).execute({ sql: "SELECT * FROM items WHERE token = ?", args: [token] });
    const origin = new URL(c.req.url).origin;
    const scanUrl = `${origin}/scan.html?token=${encodeURIComponent(token)}`;
    const qrDataUrl = await tokenToQrDataUrl(token);
    return c.json({ item: itemRows[0], scanUrl, qrDataUrl });
  } catch (err) {
    return c.json({ error: err.message || "Create failed" }, 400);
  }
});

itemRoutes.get("/items", requireAuth, async (c) => {
  const { where, params } = buildItemQuery(c.req.query());
  const clause = where.join(" AND ");
  const [listResult, summaryResult] = await batch(c.env, [
    {
      sql: `SELECT id, package_id, name, serial_clean, mvd, status, inventory_status, is_posted, last_inventory_at, created_at, updated_at, category
        FROM items WHERE ${clause} ORDER BY datetime(updated_at) DESC LIMIT 1000`,
      args: params,
    },
    {
      sql: `SELECT coalesce(category, 'else') as category, COUNT(*) as count FROM items WHERE ${clause} GROUP BY category`,
      args: params,
    },
  ]);
  return c.json({ rows: listResult.rows, summary: summaryResult.rows });
});

itemRoutes.get("/items/:id", requireAuth, async (c) => {
  const item = await getItem(c.env, c.req.param("id"));
  if (!item) return c.json({ error: "Not found" }, 404);
  const origin = new URL(c.req.url).origin;
  const scanUrl = `${origin}/scan.html?token=${encodeURIComponent(item.token)}`;
  const qrDataUrl = await tokenToQrDataUrl(item.token);
  return c.json({ item, scanUrl, qrDataUrl });
});

itemRoutes.get("/items/:id/history", requireAuth, async (c) => {
  const id = c.req.param("id");
  const [itemResult, statusLogs, invLogs, editLogs] = await batch(c.env, [
    { sql: "SELECT created_at, created_by FROM items WHERE id = ?", args: [id] },
    { sql: "SELECT 'status' as type, from_status, to_status, actor, created_at FROM status_logs WHERE item_id = ? ORDER BY created_at ASC", args: [id] },
    { sql: "SELECT 'inventory' as type, action, actor, created_at FROM inventory_logs WHERE item_id = ? ORDER BY created_at ASC", args: [id] },
    { sql: "SELECT 'edit' as type, changes_json, actor, created_at FROM edit_logs WHERE item_id = ? ORDER BY created_at ASC", args: [id] },
  ]);
  const item = itemResult.rows[0];
  if (!item) return c.json({ error: "Not found" }, 404);
  const history = [
    { type: "created", actor: item.created_by || "System", created_at: item.created_at },
    ...statusLogs.rows,
    ...invLogs.rows,
    ...editLogs.rows,
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return c.json({ history });
});

itemRoutes.post("/items/batch-posted", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { serials_text } = body;
  if (!serials_text) return c.json({ error: "Missing serials_text" }, 400);

  const serials = serials_text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (serials.length === 0) return c.json({ error: "No valid serials found" }, 400);

  try {
    const updatedAt = nowISO();
    const updates = [];
    let totalUpdated = 0;
    const notFound = [];
    const alreadyPosted = [];
    const updatedIds = new Set();

    const rowsBySerial = [];
    for (let i = 0; i < serials.length; i += 25) {
      const chunk = serials.slice(i, i + 25);
      const lowerPlaceholders = chunk.map(() => "LOWER(?)").join(",");
      const placeholders = chunk.map(() => "?").join(",");
      const { rows } = await getDb(c.env).execute({
        sql: `SELECT id, serial_clean, serial_raw, is_posted FROM items
          WHERE (LOWER(serial_clean) IN (${lowerPlaceholders}) OR serial_raw IN (${placeholders})) AND is_deleted = 0`,
        args: [...chunk, ...chunk],
      });
      rowsBySerial.push(...rows);
    }

    for (const sn of serials) {
      const lower = sn.toLowerCase();
      const matched = rowsBySerial.filter((r) => r.serial_clean?.toLowerCase() === lower || r.serial_raw === sn);
      if (matched.length === 0) {
        notFound.push(sn);
        continue;
      }
      let updatedAny = false;
      for (const item of matched) {
        if (!item.is_posted && !updatedIds.has(item.id)) {
          updatedIds.add(item.id);
          updates.push({ sql: "UPDATE items SET is_posted = 1, updated_at = ? WHERE id = ?", args: [updatedAt, item.id] });
          updates.push({
            sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
            args: [item.id, c.get("user"), JSON.stringify({ is_posted: 1, method: "batch" }), updatedAt],
          });
          totalUpdated += 1;
          updatedAny = true;
        }
      }
      if (!updatedAny && !alreadyPosted.includes(sn)) alreadyPosted.push(sn);
    }

    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      await batch(c.env, updates.slice(i, i + CHUNK_SIZE));
    }

    return c.json({ ok: true, count: totalUpdated, notFound, alreadyPosted });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

itemRoutes.post("/items/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const it = await getItem(c.env, id);
  if (!it) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const updates = {};
  for (const k of EDITABLE_FIELDS) if (k in body) updates[k] = String(body[k] ?? "").trim();

  const changes = {};
  for (const k of Object.keys(updates)) {
    if ((it[k] ?? "") !== updates[k]) changes[k] = { from: it[k] ?? "", to: updates[k] };
  }

  const updatedAt = nowISO();
  await getDb(c.env).execute({
    sql: `UPDATE items SET name=?, serial_raw=?, serial_clean=?, condition=?, mvd=?, note=?, battery=?, coverage=?, updated_at=? WHERE id=?`,
    args: [
      updates.name ?? it.name,
      updates.serial_raw ?? it.serial_raw,
      updates.serial_clean ?? it.serial_clean,
      updates.condition ?? it.condition,
      updates.mvd ?? it.mvd,
      updates.note ?? it.note,
      updates.battery ?? it.battery,
      updates.coverage ?? it.coverage,
      updatedAt,
      id,
    ],
  });

  if (Object.keys(changes).length) {
    await getDb(c.env).execute({
      sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
      args: [id, c.get("user"), JSON.stringify(changes), updatedAt],
    });
  }
  return c.json({ ok: true });
});

itemRoutes.post("/items/:id/status", requireAuth, requireStaff, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { to_status } = body;
  if (!ALLOWED_STATUSES.has(to_status)) return c.json({ error: "Invalid status" }, 400);

  const item = await getItem(c.env, id);
  if (!item) {
    console.warn(`[STATUS-REJECT] user=${c.get("user")} item=${id} không tồn tại`);
    return c.json({ error: "Not found" }, 404);
  }
  if (item.is_deleted === 1 || item.status === "DELETED") {
    console.warn(`[STATUS-REJECT] user=${c.get("user")} ${item.package_id} đã bị xóa, không đổi được trạng thái`);
    return c.json({ error: "Item is deleted" }, 400);
  }

  const fromStatus = item.status;
  const updatedAt = nowISO();
  let inventoryStatus = item.inventory_status;
  let shippedAt = item.shipped_at;
  let createdAt = item.created_at;
  if (to_status === "SHIPPED") {
    inventoryStatus = "NOT_IN_STOCK";
    shippedAt = updatedAt;
  } else if (RETURN_STATUSES.has(to_status)) {
    inventoryStatus = "NOT_IN_STOCK";
    createdAt = updatedAt;
  }

  await getDb(c.env).execute({
    sql: "UPDATE items SET status = ?, inventory_status = ?, shipped_at = ?, created_at = ?, updated_at = ? WHERE id = ?",
    args: [to_status, inventoryStatus, shippedAt, createdAt, updatedAt, id],
  });

  if (fromStatus !== to_status) {
    await getDb(c.env).execute({
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?, ?, ?, ?, ?)",
      args: [id, fromStatus, to_status, c.get("user"), updatedAt],
    });
    c.executionCtx.waitUntil(syncTelegramButtons(c.env, id));
  }
  return c.json({ ok: true });
});

itemRoutes.post("/items/:id/inventory", requireAuth, requireStaff, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { inventory_status } = body;
  if (!ALLOWED_INVENTORY.has(inventory_status)) return c.json({ error: "Invalid inventory_status" }, 400);

  const item = await getItem(c.env, id);
  if (!item) return c.json({ error: "Not found" }, 404);
  if (item.is_deleted === 1 || item.status === "DELETED") return c.json({ error: "Item is deleted" }, 400);

  const fromInv = item.inventory_status;
  const t = nowISO();
  await batch(c.env, [
    {
      sql: "UPDATE items SET inventory_status = ?, last_inventory_at = ?, last_inventory_by = ?, updated_at = ? WHERE id = ?",
      args: [inventory_status, t, c.get("user"), t, id],
    },
    ...(fromInv !== inventory_status
      ? [{ sql: "INSERT INTO inventory_logs(item_id, action, actor, created_at) VALUES(?, ?, ?, ?)", args: [id, inventory_status, c.get("user"), t] }]
      : []),
  ]);
  return c.json({ ok: true });
});

itemRoutes.post("/items/:id/posted", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const item = await getItem(c.env, id);
  if (!item) return c.json({ error: "Not found" }, 404);

  const updatedAt = nowISO();
  const nextVal = body.is_posted ? 1 : 0;
  await getDb(c.env).execute({
    sql: "UPDATE items SET is_posted = ?, updated_at = ? WHERE id = ?",
    args: [nextVal, updatedAt, id],
  });

  if (item.is_posted !== nextVal) {
    await getDb(c.env).execute({
      sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
      args: [id, c.get("user"), JSON.stringify({ is_posted: nextVal }), updatedAt],
    });
    c.executionCtx.waitUntil(syncTelegramButtons(c.env, id));
  }
  return c.json({ ok: true });
});

itemRoutes.post("/items/:id/meru-logged", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const item = await getItem(c.env, id);
  if (!item) return c.json({ error: "Not found" }, 404);

  const updatedAt = nowISO();
  const nextVal = body.is_meru_logged ? 1 : 0;
  await getDb(c.env).execute({
    sql: "UPDATE items SET is_meru_logged = ?, updated_at = ? WHERE id = ?",
    args: [nextVal, updatedAt, id],
  });

  if (item.is_meru_logged !== nextVal) {
    await getDb(c.env).execute({
      sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
      args: [id, c.get("user"), JSON.stringify({ is_meru_logged: nextVal }), updatedAt],
    });
    c.executionCtx.waitUntil(syncTelegramButtons(c.env, id));
  }
  return c.json({ ok: true });
});
