import { Hono } from "hono";
import { getDb } from "../db.mjs";
import { escapeTelegramHtml as escTg } from "../format_utils.mjs";
import { detectCategory, genToken, nextPackageId, nowISO } from "../items_common.mjs";
import { detectShipFee, extractProductCode, fetchProductMetaFromLink, parseAndNormalizeDate } from "../order_utils.mjs";
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

/** Shortcut API: create a calendar order from an external POST. */
externalRoutes.post("/external/create-order", async (c) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey || apiKey !== c.env.SHORTCUT_API_KEY) {
    return c.json({ error: "Unauthorized. Missing or invalid x-api-key header." }, 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    let name = String(body.name ?? "").trim();
    const link = String(body.link ?? "").trim();

    const rawBuyPrice = body.buy_price;
    const hasBuyPrice = rawBuyPrice !== undefined && rawBuyPrice !== null && String(rawBuyPrice).trim() !== "";
    let buy_price = hasBuyPrice ? parseFloat(rawBuyPrice) : null;

    const rawSoldPrice = body.sold_price;
    const parsedSoldPrice =
      rawSoldPrice !== undefined && rawSoldPrice !== null && String(rawSoldPrice).trim() !== ""
        ? parseFloat(rawSoldPrice)
        : 0;
    const sold_price = Number.isFinite(parsedSoldPrice) ? parsedSoldPrice : 0;

    if (link && (!name || !hasBuyPrice)) {
      const meta = await fetchProductMetaFromLink(link);
      if (!name && meta.title) name = meta.title;
      if (!hasBuyPrice && meta.price !== null) buy_price = meta.price;
    }

    buy_price = Number.isFinite(buy_price) ? buy_price : 0;

    if (!name) {
      return c.json({ error: "Product name is required (or could not extract title from link)" }, 400);
    }

    const order_date = parseAndNormalizeDate(body.order_date);
    const package_id = await nextPackageId(c.env);
    const token = genToken();
    const t = nowISO();
    const rawShipFee = body.ship_fee;
    const parsedShipFee =
      rawShipFee !== undefined && rawShipFee !== null && String(rawShipFee).trim() !== ""
        ? parseFloat(rawShipFee)
        : null;
    const ship_fee = Number.isFinite(parsedShipFee) ? parsedShipFee : detectShipFee(name);
    const profit = sold_price * 0.9 - buy_price - ship_fee;

    const db = getDb(c.env);
    await db.execute({
      sql: `
        INSERT INTO items (
          package_id, token, name, buy_price, sold_price, ship_fee, profit, link, is_order, order_date,
          status, inventory_status, created_at, updated_at, is_deleted, created_by, category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'ORDERED', 'UNKNOWN', ?, ?, 0, 'shortcut', ?)
      `,
      args: [
        package_id, token, name, buy_price, sold_price, ship_fee, profit, link, order_date,
        t, t, await detectCategory(c.env, name),
      ],
    });

    return c.json({ ok: true, package_id, token, name, buy_price, ship_fee, profit });
  } catch (e) {
    console.error("Create order API failed:", e);
    return c.json({ error: e.message || "Create order failed" }, 500);
  }
});

/** Shortcut API: update the shipping MVD (and optional ship fee) of an order. */
externalRoutes.post("/external/update-order-shipment", async (c) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey || apiKey !== c.env.SHORTCUT_API_KEY) {
    return c.json({ error: "Unauthorized. Missing or invalid x-api-key header." }, 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const { order_id, name, token, mvd, link, product_code, code } = body;
    const rawShipFee = body.ship_fee;
    const parsedShipFee =
      rawShipFee !== undefined && rawShipFee !== null && String(rawShipFee).trim() !== ""
        ? parseFloat(rawShipFee)
        : null;
    const ship_fee = Number.isFinite(parsedShipFee) ? parsedShipFee : null;

    const updated_mvd = String(mvd ?? "").trim();
    if (!updated_mvd) return c.json({ error: "Tracking number (mvd) is required" }, 400);

    const rawCodeInput = String(product_code ?? code ?? "").trim();
    const extractedCode = extractProductCode(rawCodeInput) || extractProductCode(link);

    const db = getDb(c.env);
    let order = null;
    if (order_id) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND id = ? LIMIT 1",
        args: [order_id],
      });
      order = rows[0] || null;
    } else if (token) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND token = ? LIMIT 1",
        args: [token],
      });
      order = rows[0] || null;
    } else if (rawCodeInput || link) {
      if (link && String(link).trim()) {
        const { rows } = await db.execute({
          sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND link = ? ORDER BY created_at DESC LIMIT 1",
          args: [String(link).trim()],
        });
        order = rows[0] || null;
      }
      if (!order && extractedCode) {
        const { rows } = await db.execute({
          sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND LOWER(link) LIKE ? ORDER BY created_at DESC",
          args: [`%${extractedCode}%`],
        });
        order = rows.find((r) => extractProductCode(r.link) === extractedCode) || null;
      }
      if (!order && rawCodeInput) {
        const { rows } = await db.execute({
          sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND LOWER(link) LIKE ? ORDER BY created_at DESC LIMIT 1",
          args: [`%${rawCodeInput.toLowerCase()}%`],
        });
        order = rows[0] || null;
      }
    } else if (name) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND name = ? ORDER BY created_at DESC LIMIT 1",
        args: [name],
      });
      order = rows[0] || null;
    } else {
      const { rows } = await db.execute(
        "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND (mvd IS NULL OR mvd = '') ORDER BY created_at DESC LIMIT 1",
      );
      order = rows[0] || null;
    }

    if (!order) {
      return c.json(
        { error: extractedCode ? `Order not found for product code: ${extractedCode}` : "Order not found" },
        404,
      );
    }

    const existingMvd = String(order.mvd ?? "").trim();
    if (existingMvd) {
      return c.json({
        ok: true,
        already_updated: true,
        message: `Đơn hàng đã được cập nhật MVD trước đó: ${existingMvd}`,
        order_id: order.id,
        package_id: order.package_id,
        name: order.name,
        product_code: extractedCode || extractProductCode(order.link),
        mvd: existingMvd,
      });
    }

    const updated_ship_fee = ship_fee !== null ? ship_fee : order.ship_fee || detectShipFee(order.name);
    const updated_profit = (order.sold_price || 0) * 0.9 - (order.buy_price || 0) - updated_ship_fee;
    const t = nowISO();

    await db.execute({
      sql: "UPDATE items SET mvd = ?, ship_fee = ?, profit = ?, updated_at = ? WHERE id = ?",
      args: [updated_mvd, updated_ship_fee, updated_profit, t, order.id],
    });

    return c.json({
      ok: true,
      already_updated: false,
      message: `Đã cập nhật MVD thành công: ${updated_mvd}`,
      order_id: order.id,
      package_id: order.package_id,
      name: order.name,
      product_code: extractedCode || extractProductCode(order.link),
      mvd: updated_mvd,
      profit: updated_profit,
    });
  } catch (e) {
    console.error("Update shipment API failed:", e);
    return c.json({ error: e.message || "Update shipment failed" }, 500);
  }
});
