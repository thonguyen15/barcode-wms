import { Hono } from "hono";
import { getDb } from "../db.mjs";
import { escapeTelegramHtml as escTg } from "../format_utils.mjs";
import { detectCategory, genToken, nextPackageId, nowISO } from "../items_common.mjs";
import { renderLabel, renderQrBuffer } from "../label.mjs";
import { sendTelegramMessage, sendTelegramPhoto, tgApi } from "../telegram.mjs";
import { syncTelegramButtons } from "../telegram_callbacks.mjs";

function buildCaption(captionData, linkSuffix, noteText) {
  const data = { ...captionData, note: noteText };
  return `<code>${escTg(JSON.stringify(data))}</code>${linkSuffix}`;
}

function trimCaption(captionData, linkSuffix, note) {
  let captionNote = note || "";
  let caption = buildCaption(captionData, linkSuffix, captionNote);
  for (let i = 0; i < 60 && caption.length > 1024 && captionNote.length > 0; i++) {
    captionNote = captionNote.slice(0, Math.max(0, captionNote.length - (caption.length - 1024) - 8));
    caption = buildCaption(captionData, linkSuffix, captionNote);
  }
  if (caption.length > 1024) caption = caption.slice(0, 1021) + "...";
  return caption;
}

export const externalRoutes = new Hono();

externalRoutes.post("/external/create", async (c) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey || apiKey !== c.env.SHORTCUT_API_KEY) {
    return c.json({ error: "Unauthorized. Missing or invalid x-api-key header." }, 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const fields = {
      name: (body.name ?? "").trim(),
      serial_raw: (body.serial ?? "").trim(),
      condition: (body.condition ?? "Unknown").trim(),
      mvd: (body.mvd ?? "").trim(),
      note: (body.note ?? "").trim(),
      battery: (body.battery ?? "").trim(),
      coverage: (body.coverage ?? "").trim(),
    };
    fields.serial_clean = (fields.serial_raw.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim().toUpperCase();

    const db = getDb(c.env);
    if (fields.serial_clean) {
      const { rows: existRows } = await db.execute({
        sql: "SELECT package_id FROM items WHERE LOWER(serial_clean) = LOWER(?) AND is_deleted = 0 LIMIT 1",
        args: [fields.serial_clean],
      });
      if (existRows[0]) {
        return c.json({ error: "Sản phẩm đã tồn tại.", package_id: existRows[0].package_id }, 409);
      }
    }

    const package_id = await nextPackageId(c.env);
    const token = genToken();
    const t = nowISO();
    const category = await detectCategory(c.env, fields.name);

    try {
      await db.execute({
        sql: "INSERT INTO items (package_id, token, name, serial_raw, serial_clean, condition, mvd, note, battery, coverage, status, inventory_status, created_at, updated_at, is_deleted, created_by, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 'UNKNOWN', ?, ?, 0, 'shortcut', ?)",
        args: [
          package_id,
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
          category,
        ],
      });
    } catch (err) {
      if (String(err.message || "").toLowerCase().includes("unique")) {
        return c.json({ error: "Sản phẩm đã tồn tại." }, 409);
      }
      throw err;
    }

    const { rows: itemRows } = await db.execute({ sql: "SELECT id FROM items WHERE token = ?", args: [token] });
    const newItem = itemRows[0];

    const qrBuffer = await renderQrBuffer(token);
    const labelBuffer = await renderLabel(fields, qrBuffer);

    const linkSuffix = c.env.APP_URL ? `\n\n🔗 <a href="${c.env.APP_URL}/scan.html?token=${token}">Xem chi tiết</a>` : "";
    const captionData = {
      mvd: fields.mvd || "",
      name: fields.name || "",
      serial: fields.serial_clean || "",
      condition: fields.condition || "",
      battery: fields.battery || "",
      coverage: fields.coverage || "",
      note: fields.note || "",
    };
    const caption = trimCaption(captionData, linkSuffix, fields.note);

    console.log(`[SHORTCUT] Caption length: ${caption.length} (max 1024)`);

    const firstRow = [
      { text: `⬜ CREATED`, callback_data: "none" },
      { text: "↩️", callback_data: `request_return_tg:${newItem.id}` },
    ];
    const replyMarkup = {
      inline_keyboard: [
        firstRow,
        [
          { text: "🔴 Post", callback_data: `posted:${newItem.id}` },
          { text: "🗑️", callback_data: `request_delete_tg:${newItem.id}` },
          { text: "🔴 Log", callback_data: `meru:${newItem.id}` },
        ],
      ],
    };

    const tgMsg = await sendTelegramPhoto(c.env, labelBuffer, caption, replyMarkup).catch((err) => {
      console.error("Shortcut Telegram notify failed:", err);
      return null;
    });
    if (!tgMsg) {
      console.error("[SHORTCUT] Failed to send Telegram photo for token:", token);
      await sendTelegramMessage(
        c.env,
        `⚠️ <b>[SHORTCUT] Gửi tem nhãn thất bại</b>\n📦 ID: <code>${package_id}</code>\n<code>${escTg(JSON.stringify(captionData))}</code>`,
        c.env.TELEGRAM_CHAT_ID,
      );
    } else {
      console.log("[SHORTCUT] Telegram photo sent successfully, message_id:", tgMsg.message_id);
    }

    if (tgMsg) {
      await db.execute({
        sql: "UPDATE items SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
        args: [String(tgMsg.chat.id), String(tgMsg.message_id), newItem.id],
      });
    }

    return c.json({ ok: true, package_id, token });
  } catch (err) {
    console.error("Shortcut API failed:", err);
    return c.json({ error: err.message || "Shortcut processing failed" }, 500);
  }
});

externalRoutes.post("/external/mark-posted", async (c) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey || apiKey !== c.env.SHORTCUT_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const serial = (body.serial ?? "").trim();
  if (!serial || serial.length < 4) {
    return c.json({ error: "Missing or too short serial" }, 400);
  }

  try {
    const { rows } = await getDb(c.env).execute({
      sql: "SELECT * FROM items WHERE (LOWER(serial_clean) = LOWER(?) OR serial_raw = ?) AND is_deleted = 0 LIMIT 1",
      args: [serial, serial],
    });
    const item = rows[0];
    if (!item) {
      return c.json({ ok: false, error: `Serial not found: ${serial}` });
    }
    if (item.is_posted) {
      return c.json({ ok: true, already: true, message: `Already posted: ${item.package_id} (${item.serial_clean})` });
    }

    const updated_at = nowISO();
    await getDb(c.env).batch([
      { sql: "UPDATE items SET is_posted = 1, updated_at = ? WHERE id = ?", args: [updated_at, item.id] },
      {
        sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
        args: [item.id, "Shortcut", JSON.stringify({ is_posted: 1, method: "shortcut" }), updated_at],
      },
    ]);

    c.executionCtx.waitUntil(syncTelegramButtons(c.env, item.id).catch((e) => console.error("Sync TG mark-posted failed:", e)));

    try {
      const msg = `✅ <b>Đã đăng (Shortcut)</b>\n📦 ID: <code>${item.package_id}</code>\n🏷️ ${escTg(item.name)}\n🔢 Serial: <code>${item.serial_clean || "-"}</code>`;
      await tgApi(c.env, "sendMessage", { chat_id: c.env.DELETE_GROUP_CHAT_ID, text: msg, parse_mode: "HTML" });
    } catch (err) {
      console.error("TG notify mark-posted failed:", err);
    }

    return c.json({ ok: true, message: `Marked as posted: ${item.package_id} — ${item.name} (${item.serial_clean})` });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});
