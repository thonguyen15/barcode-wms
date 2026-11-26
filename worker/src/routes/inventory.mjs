import { Hono } from "hono";
import { requireAuth } from "../auth.mjs";
import { getDb } from "../db.mjs";
import { tgFetch } from "../telegram.mjs";
import { csvCell, nowTokyoISO, tokyoDateKey } from "../format_utils.mjs";


const MISSING_SQL = `
  SELECT package_id, name, serial_clean as serial, mvd, '-' as scanned_at, '-' as actor, 'MISSING' as audit_status, category
  FROM items
  WHERE inventory_status = 'UNKNOWN'
    AND is_deleted = 0
    AND status NOT IN ('SHIPPED', 'RETURN', 'RETURNED', 'HENBIN', 'REQUEST_RETURN')
  ORDER BY category ASC, name ASC
`;

function requireStaff(c) {
  if (c.get("role") !== "admin" && c.get("role") !== "staff") {
    return c.json({ error: "Staff/Admin only" }, 403);
  }
  return null;
}

function requireAdmin(c) {
  if (c.get("role") !== "admin") return c.json({ error: "Admin only" }, 403);
  return null;
}

function requireSuperAdmin(c) {
  const superAdmin = c.env.SUPER_ADMIN_USER || c.env.ADMIN_USER;
  if (c.get("role") !== "admin" || c.get("user") !== superAdmin) {
    return c.json({ error: "Tho Admin only" }, 403);
  }
  return null;
}

async function sendInventoryDocument(env, filename, csv, caption) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("document", new Blob([csv], { type: "text/csv" }), filename);
  try {
    const res = await tgFetch(env, `https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
    if (!res.ok) console.error("sendInventoryDocument failed:", await res.text());
  } catch (err) {
    console.error("sendInventoryDocument Error:", err.message);
  }
}

export const inventoryRoutes = new Hono()
  .post("/inventory/add", requireAuth, async (c) => {
    const denied = requireStaff(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => ({}));
    const { token, serial } = body;
    if (!token && !serial) {
      console.warn(`[SCAN-REJECT] user=${c.get("user")} thiếu token/serial`);
      return c.json({ error: "Thiếu token hoặc serial" }, 400);
    }

    let item;
    if (token) {
      const { rows } = await getDb(c.env).execute({ sql: "SELECT * FROM items WHERE token = ?", args: [token] });
      item = rows[0];
    } else {
      const cleanSerial = serial.trim();
      const { rows } = await getDb(c.env).execute({
        sql: "SELECT * FROM items WHERE (LOWER(serial_clean) = LOWER(?) OR serial_raw = ? OR package_id = ?) AND is_deleted = 0",
        args: [cleanSerial, cleanSerial, cleanSerial],
      });
      if (rows.length === 0) {
        console.warn(`[SCAN-REJECT] user=${c.get("user")} serial="${serial}" không tìm thấy sản phẩm`);
        return c.json({ error: "Không tìm thấy sản phẩm" }, 404);
      }
      const activeItems = rows.filter((x) => x.status !== "SHIPPED");
      item = activeItems.length > 0 ? activeItems[0] : rows[0];
    }

    if (!item) {
      console.warn(`[SCAN-REJECT] user=${c.get("user")} token="${token}" không tìm thấy sản phẩm`);
      return c.json({ error: "Không tìm thấy sản phẩm" }, 404);
    }
    if (item.is_deleted === 1 || item.status === "DELETED") {
      console.warn(`[SCAN-REJECT] user=${c.get("user")} ${item.package_id} đã bị xóa`);
      return c.json({ error: "Sản phẩm đã bị xóa" }, 400);
    }
    if (item.status === "SHIPPED") {
      console.warn(`[SCAN-REJECT] user=${c.get("user")} ${item.package_id} đã giao, không thể kiểm kho lại`);
      return c.json({ error: `Hàng đã giao (${item.package_id}), không thể kiểm kho lại.` }, 400);
    }

    const date_key = tokyoDateKey();
    const scanned_at = nowTokyoISO();
    try {
      await getDb(c.env).batch(
        [
          {
            sql: `
              INSERT INTO inventory_work(date_key, token, item_id, package_id, name, mvd, serial, actor, scanned_at)
              VALUES(?,?,?,?,?,?,?,?,?)
            `,
            args: [
              date_key,
              item.token,
              item.id,
              item.package_id || "",
              item.name || "",
              item.mvd || "",
              item.serial_clean || item.serial_raw || "",
              c.get("user"),
              scanned_at,
            ],
          },
          {
            sql: "UPDATE items SET inventory_status = 'IN_STOCK', last_inventory_at = ?, updated_at = ? WHERE id = ?",
            args: [scanned_at, scanned_at, item.id],
          },
          {
            sql: "INSERT INTO inventory_logs(item_id, action, actor, created_at) VALUES(?,?,?,?)",
            args: [item.id, "IN_STOCK", c.get("user"), scanned_at],
          },
        ],
        "write",
      );
      return c.json({ ok: true, item });
    } catch (err) {
      if (String(err.message).includes("UNIQUE constraint failed")) {
        console.warn(`[SCAN-REJECT] user=${c.get("user")} ${item.package_id} đã được kiểm kê hôm nay (scan trùng)`);
        return c.json({ error: `Sản phẩm "${item.name}" đã được kiểm kê hôm nay rồi.`, item }, 400);
      }
      console.error(`[SCAN-ERROR] user=${c.get("user")} ${item.package_id}:`, err.message);
      return c.json({ error: err.message || "DB error" }, 500);
    }
  })
  .get("/inventory/today", requireAuth, async (c) => {
    const date_key = tokyoDateKey();
    const { rows } = await getDb(c.env).execute({
      sql: `
        SELECT w.package_id, w.name, w.serial, w.mvd, w.scanned_at, w.actor, w.token, i.category
        FROM inventory_work w
        LEFT JOIN items i ON w.item_id = i.id
        WHERE w.date_key = ?
        ORDER BY datetime(w.scanned_at) DESC
      `,
      args: [date_key],
    });
    return c.json({ date_key, rows });
  })
  .delete("/inventory/exports/:id", requireAuth, async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const id = Number(c.req.param("id"));
    const { rows } = await getDb(c.env).execute({
      sql: "SELECT id, filename FROM inventory_exports WHERE id = ?",
      args: [id],
    });
    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);

    try {
      await c.env.EXPORTS.delete(row.filename);
    } catch {
      return c.json({ error: "Delete file failed" }, 500);
    }
    await getDb(c.env).execute({ sql: "DELETE FROM inventory_exports WHERE id = ?", args: [id] });
    return c.json({ ok: true });
  })
  .post("/inventory/reset", requireAuth, async (c) => {
    const denied = requireSuperAdmin(c);
    if (denied) return denied;
    try {
      await getDb(c.env).execute({
        sql: "UPDATE items SET inventory_status = 'UNKNOWN', last_inventory_at = NULL WHERE is_deleted = 0",
        args: [],
      });
      return c.json({ ok: true, message: "Đã reset toàn bộ trạng thái kiểm kho về UNKNOWN." });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  })
  .post("/inventory/export", requireAuth, async (c) => {
    const denied = requireStaff(c);
    if (denied) return denied;
    const date_key = tokyoDateKey();
    let csv;
    let rowCount;
    try {
      const db = getDb(c.env);
      const { rows: scanned } = await db.execute({
        sql: `
          SELECT w.package_id, w.name, w.serial, w.mvd, w.scanned_at, w.actor, 'OK' as audit_status, i.category
          FROM inventory_work w
          LEFT JOIN items i ON w.item_id = i.id
          WHERE w.date_key = ?
          ORDER BY datetime(w.scanned_at) DESC
        `,
        args: [date_key],
      });
      const { rows: missing } = await db.execute({ sql: MISSING_SQL, args: [] });
      const allRows = [...scanned, ...missing];
      if (allRows.length === 0) {
        return c.json({ ok: true, url: null, count: 0, message: "No data" });
      }

      const header = ["status", "category", "time", "package_id", "mvd", "serial", "name", "actor"];
      csv = [header.join(",")];
      for (const r of allRows) {
        csv.push(
          [
            csvCell(r.audit_status),
            csvCell(r.category || "unknown"),
            csvCell(r.scanned_at),
            csvCell(r.package_id),
            csvCell(r.mvd),
            csvCell(r.serial),
            csvCell(r.name),
            csvCell(r.actor),
          ].join(","),
        );
      }
      rowCount = allRows.length;

      const filename = `inventory_audit_${date_key}_${Date.now()}.csv`;
      await c.env.EXPORTS.put(filename, csv.join("\n"));

      const insert = await db.execute({
        sql: `
          INSERT INTO inventory_exports(date_key, actor, filename, url, row_count, created_at)
          VALUES(?,?,?,?,?,?)
        `,
        args: [date_key, c.get("user"), filename, "", rowCount, nowTokyoISO()],
      });
      const id = Number(insert.lastInsertRowid);
      const url = `/api/exports/${id}`;
      await db.batch(
        [
          { sql: "UPDATE inventory_exports SET url = ? WHERE id = ?", args: [url, id] },
          { sql: "DELETE FROM inventory_work WHERE date_key = ?", args: [date_key] },
        ],
        "write",
      );

      c.executionCtx.waitUntil(
        sendInventoryDocument(
          c.env,
          filename,
          csv.join("\n"),
          `Báo cáo Kiểm kê Kho (Audit)\nNgày: ${date_key}\nSố lượng: ${rowCount} món\nNgười xuất: ${c.get("user")}`,
        ),
      );
      return c.json({ ok: true, url, count: rowCount, filename });
    } catch (err) {
      console.error("[EXPORT-ERROR]", err.message);
      return c.json({ error: "Export failed" }, 500);
    }
  })
  .get("/inventory/exports", requireAuth, async (c) => {
    const { rows } = await getDb(c.env).execute({
      sql: `
        SELECT id, date_key, actor, filename, url, row_count, created_at
        FROM inventory_exports
        ORDER BY datetime(created_at) DESC
        LIMIT 200
      `,
    });
    return c.json({ rows });
  })
  .get("/exports/:id", requireAuth, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.text("File not found", 404);
    const { rows } = await getDb(c.env).execute({
      sql: "SELECT filename FROM inventory_exports WHERE id = ?",
      args: [id],
    });
    const row = rows[0];
    if (!row) return c.text("File not found", 404);
    const obj = await c.env.EXPORTS.get(row.filename);
    if (!obj) return c.text("File not found", 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Content-Type", "text/csv; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="${row.filename}"`);
    return new Response(obj.body, { headers });
  });
