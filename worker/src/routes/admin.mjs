import { Hono } from "hono";
import { requireAuth, requireAdmin, requireSuperAdmin } from "../auth.mjs";
import { batch, getDb } from "../db.mjs";
import { detectCategory, loadCategories, nowISO, todayKey } from "../item_utils.mjs";
import { sendTelegramMessage } from "../telegram.mjs";
import { sendTelegramDocument } from "../tg_sync.mjs";

const CHUNK_SIZE = 40;

export const adminRoutes = new Hono();

adminRoutes.get("/categories", requireAuth, requireSuperAdmin, async (c) => {
  const { rows } = await getDb(c.env).execute("SELECT * FROM category_rules ORDER BY id ASC");
  return c.json({ rows });
});

adminRoutes.post("/categories", requireAuth, requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { id, name, keywords, priority } = body;
  if (!name || !keywords) return c.json({ error: "Missing name or keywords" }, 400);
  try {
    if (id) {
      await getDb(c.env).execute({
        sql: "UPDATE category_rules SET name = ?, keywords = ?, priority = ? WHERE id = ?",
        args: [name, keywords, priority || 0, id],
      });
    } else {
      await getDb(c.env).execute({
        sql: "INSERT INTO category_rules (name, keywords, priority) VALUES (?, ?, ?)",
        args: [name, keywords, priority || 0],
      });
    }
    await loadCategories(c.env);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

adminRoutes.delete("/categories/:id", requireAuth, requireAdmin, async (c) => {
  try {
    await getDb(c.env).execute({ sql: "DELETE FROM category_rules WHERE id = ?", args: [c.req.param("id")] });
    await loadCategories(c.env);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

adminRoutes.post("/categories/reclassify", requireAuth, requireAdmin, async (c) => {
  try {
    const { rows: items } = await getDb(c.env).execute("SELECT id, name FROM items WHERE is_deleted = 0");
    const rules = await loadCategories(c.env);
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE).map((item) => ({
        sql: "UPDATE items SET category = ? WHERE id = ?",
        args: [detectCategory(rules, item.name), item.id],
      }));
      await batch(c.env, chunk);
    }
    return c.json({ ok: true, count: items.length });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

adminRoutes.get("/admin/bong-stats", requireAuth, requireAdmin, async (c) => {
  try {
    const bongUser = c.env.BONG_USER || "bong";
    const { rows } = await getDb(c.env).execute({
      sql: `SELECT
        substr(created_at, 1, 7) as month,
        count(distinct item_id) as count
      FROM edit_logs
      WHERE (actor = ? OR lower(actor) = 'bong')
        AND (
          changes_json LIKE '%"is_posted":1%'
          OR changes_json LIKE '%"is_posted":true%'
        )
      GROUP BY month
      ORDER BY month DESC`,
      args: [bongUser],
    });
    return c.json({ rows });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

adminRoutes.get("/admin/debug-edit-logs", requireAuth, requireAdmin, async (c) => {
  try {
    const [actorsResult, sampleResult] = await batch(c.env, [
      "SELECT DISTINCT actor, count(*) as count FROM edit_logs GROUP BY actor",
      `SELECT id, item_id, actor, changes_json, created_at
        FROM edit_logs
        WHERE changes_json LIKE '%is_posted%'
        ORDER BY datetime(created_at) DESC
        LIMIT 50`,
    ]);
    return c.json({ actors: actorsResult.rows, sampleLogs: sampleResult.rows });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

adminRoutes.post("/telegram/test", requireAuth, requireAdmin, async (c) => {
  const isSuperAdmin = c.get("user") === (c.env.SUPER_ADMIN_USER || c.env.ADMIN_USER);
  try {
    if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_CHAT_ID) {
      return c.json({ error: "Thiếu cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trên Render." }, 400);
    }
    if (isSuperAdmin) {
      await sendTelegramMessage(c.env, "🔔 <b>Hệ thống WMS:</b> Đang kiểm tra kết nối Bot...");
      const csv = "ID,Name,Status\n1,Test Item,Success";
      await sendTelegramDocument(c.env, `test_connection_${Date.now()}.csv`, csv, "📄 Đây là tệp tin kiểm tra từ hệ thống WMS.");
      return c.json({ ok: true, message: "Đã gửi tin nhắn và file mẫu tới Telegram. Hãy kiểm tra điện thoại của bạn!" });
    }
    const text = `🚀 <b>KẾT NỐI THÀNH CÔNG!</b>\n\nHệ thống WMS đã kết nối được với Telegram của bạn.\nThời gian: ${nowISO()}`;
    await sendTelegramMessage(c.env, text);
    return c.json({ ok: true, message: "Đã gửi tin nhắn test thành công!" });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

adminRoutes.post("/telegram/notify-stale-manual", requireAuth, requireAdmin, async (c) => {
  try {
    await checkStaleItemsAndNotify(c.env, true);
    return c.json({ ok: true, message: "Đã kích hoạt quét hàng tồn và gửi qua Telegram." });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

/** Scan CREATED items older than 15 days and alert once per day unless manual. */
async function checkStaleItemsAndNotify(env, isManual = false) {
  const today = todayKey();
  if (!isManual) {
    const { rows } = await getDb(env).execute("SELECT value FROM kv_store WHERE key = 'last_stale_alert_date'");
    if (rows[0]?.value === today) return;
  }

  const staleDate = new Date(Date.now() + 9 * 60 * 60 * 1000 - 15 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const { rows: staleItems } = await getDb(env).execute({
    sql: `SELECT package_id, name, created_at
      FROM items
      WHERE is_deleted = 0
        AND status = 'CREATED'
        AND substr(created_at, 1, 10) < ?
      ORDER BY created_at ASC
      LIMIT 20`,
    args: [staleDate],
  });

  if (staleItems.length > 0) {
    let msg = `⚠️ <b>CẢNH BÁO HÀNG TỒN > 15 NGÀY</b>\n\n`;
    staleItems.forEach((it, i) => {
      msg += `${i + 1}. <code>${it.package_id}</code> - ${it.name}\n   (Tồn: ${Math.floor((new Date() - new Date(it.created_at)) / (1000 * 60 * 60 * 24))} ngày)\n`;
    });
    msg += `\n👉 <a href="${env.APP_URL || ""}/list.html">Xem danh sách đầy đủ</a>`;

    await sendTelegramMessage(env, msg, env.NOTIFICATION_GROUP_CHAT_ID);
    await getDb(env).execute({
      sql: "INSERT OR REPLACE INTO kv_store (key, value) VALUES ('last_stale_alert_date', ?)",
      args: [today],
    });
  }
}
