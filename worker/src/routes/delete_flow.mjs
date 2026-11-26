import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../auth.mjs";
import { batch, getDb } from "../db.mjs";
import { escapeTelegramHtml, formatTokyoTime } from "../format_utils.mjs";
import { nowISO } from "../item_utils.mjs";
import { sendTelegramMessage } from "../telegram.mjs";
import { deleteTelegramMessage, sendTelegramButtonsMessage } from "../tg_sync.mjs";
import { getItem, pendingRequest } from "./items.mjs";

export const deleteFlowRoutes = new Hono();

deleteFlowRoutes.post("/items/:id/request-delete", requireAuth, async (c) => {
  const id = c.req.param("id");
  const item = await getItem(c.env, id);
  if (!item || item.is_deleted === 1) return c.json({ error: "Không tìm thấy sản phẩm" }, 404);
  if (await pendingRequest(c.env, id)) {
    return c.json({ error: "Đã có yêu cầu xóa đang chờ duyệt cho sản phẩm này" }, 409);
  }

  const t = nowISO();
  const insert = {
    sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)",
    args: [id, c.get("user"), t],
  };
  const select = {
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
    args: [id],
  };
  const [insertResult, selectResult] = await batch(c.env, [insert, select]);
  const reqId = insertResult.meta?.last_row_id ?? selectResult.rows[0].id;

  if (c.env.TELEGRAM_BOT_TOKEN && c.env.DELETE_GROUP_CHAT_ID) {
    const user = c.get("user");
    const msg =
      `🗑️ <b>YÊU CẦU XÓA SẢN PHẨM</b>\n\n` +
      `📦 ID: <code>${item.package_id}</code>\n` +
      `🏷️ Tên: <b>${escapeTelegramHtml(item.name)}</b>\n` +
      `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
      `📍 Trạng thái: ${item.status}\n` +
      `👤 Yêu cầu bởi: <b>${escapeTelegramHtml(user)}</b>\n` +
      `⏰ Thời gian: ${formatTokyoTime(t)}`;
    const result = await sendTelegramButtonsMessage(c.env, c.env.DELETE_GROUP_CHAT_ID, msg, [
      { text: "✅ Duyệt xóa", callback_data: `approve_delete:${reqId}` },
      { text: "❌ Từ chối", callback_data: `reject_delete:${reqId}` },
    ]);
    if (result) {
      c.executionCtx.waitUntil(
        batch(c.env, [
          {
            sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
            args: [String(result.chat.id), String(result.message_id), reqId],
          },
        ]),
      );
    }
  }
  return c.json({ ok: true });
});

deleteFlowRoutes.post("/items/:id/request-return", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id");
  const item = await getItem(c.env, id);
  if (!item || item.is_deleted === 1) return c.json({ error: "Không tìm thấy sản phẩm" }, 404);
  if (await pendingRequest(c.env, id)) {
    return c.json({ error: "Đã có yêu cầu đang chờ duyệt cho sản phẩm này" }, 409);
  }

  const t = nowISO();
  const updateStatus = {
    sql: "UPDATE items SET status = 'REQUEST_RETURN', updated_at = ? WHERE id = ?",
    args: [t, id],
  };
  const insert = {
    sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)",
    args: [id, c.get("user"), t],
  };
  const select = {
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
    args: [id],
  };
  const [insertResult, selectResult] = await batch(c.env, [updateStatus, insert, select]);
  const reqId = insertResult.meta?.last_row_id ?? selectResult.rows[0].id;

  if (c.env.TELEGRAM_BOT_TOKEN && c.env.RETURN_GROUP_CHAT_ID) {
    const user = c.get("user");
    const buttons = [
      { text: "✅ Duyệt xóa", callback_data: `approve_delete:${reqId}` },
      { text: "❌ Từ chối", callback_data: `reject_delete:${reqId}` },
    ];
    if (item.tg_chat_id && item.tg_msg_id) {
      const cleanChatId = String(item.tg_chat_id).replace("-100", "");
      buttons.push({ text: "🔗 Xem tin gốc", url: `https://t.me/c/${cleanChatId}/${item.tg_msg_id}` });
    }

    const msg =
      `📦 <b>YÊU CẦU RETURN & XÓA</b>\n\n` +
      `📦 ID: <code>${item.package_id}</code>\n` +
      `🏷️ Tên: <b>${escapeTelegramHtml(item.name)}</b>\n` +
      `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
      `📍 Trạng thái: ${item.status} ➔ <b>REQUEST_RETURN</b>\n` +
      `👤 Yêu cầu bởi: <b>${escapeTelegramHtml(user)}</b>` +
      (c.env.TELEGRAM_AARON ? `\n🔔 Tag: <a href="tg://user?id=${c.env.TELEGRAM_AARON}">@AARON</a>` : "") +
      `\n` +
      `⏰ Thời gian: ${formatTokyoTime(t)}`;

    const result = await sendTelegramButtonsMessage(c.env, c.env.RETURN_GROUP_CHAT_ID, msg, buttons);
    if (result) {
      c.executionCtx.waitUntil(
        batch(c.env, [
          {
            sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
            args: [String(result.chat.id), String(result.message_id), reqId],
          },
        ]),
      );
    }

    const taskChatId = c.env.TASK_GROUP_CHAT_ID || c.env.RETURN_GROUP_CHAT_ID;
    const taskMsg =
      `📝 <b>TASK: KIỂM TRA HÀNG RETURN</b>\n\n` +
      `📦 ID: <code>${item.package_id}</code>\n` +
      `🏷️ Tên: <b>${escapeTelegramHtml(item.name)}</b>\n` +
      `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
      `👤 Người yêu cầu: ${escapeTelegramHtml(user)}`;
    c.executionCtx.waitUntil(sendTelegramButtonsMessage(c.env, taskChatId, taskMsg, []));
  }
  return c.json({ ok: true });
});

deleteFlowRoutes.post("/items/:id/delete", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id");
  const { rows } = await getDb(c.env).execute({
    sql: "SELECT id, package_id, name, tg_chat_id, tg_msg_id, post_task_msg_id FROM items WHERE id=?",
    args: [id],
  });
  const item = rows[0];
  if (!item) return c.json({ error: "Not found" }, 404);

  const t = nowISO();
  await getDb(c.env).execute({
    sql: `UPDATE items SET is_deleted=1, status='DELETED', deleted_at=?, deleted_by=?, updated_at=? WHERE id=?`,
    args: [t, c.get("user"), t, id],
  });

  const msg =
    `🔔 <b>HỆ THỐNG: ĐÃ XÓA SẢN PHẨM (TỪ WEB)</b>\n\n` +
    `📦 ID: <code>${item.package_id}</code>\n` +
    `🏷️ Tên: <b>${escapeTelegramHtml(item.name)}</b>\n` +
    `👤 Người xóa: <b>${escapeTelegramHtml(c.get("user"))}</b>\n` +
    `⏰ Thời gian: ${formatTokyoTime(t)}`;
  c.executionCtx.waitUntil(sendTelegramMessage(c.env, msg, c.env.NOTIFICATION_GROUP_CHAT_ID));

  if (c.env.TELEGRAM_BOT_TOKEN) {
    if (item.tg_chat_id && item.tg_msg_id) {
      c.executionCtx.waitUntil(deleteTelegramMessage(c.env, item.tg_chat_id, item.tg_msg_id));
    }
    if (item.post_task_msg_id) {
      const taskChatId = c.env.TASK_GROUP_CHAT_ID || c.env.RETURN_GROUP_CHAT_ID;
      if (taskChatId) c.executionCtx.waitUntil(deleteTelegramMessage(c.env, taskChatId, item.post_task_msg_id));
    }
  }
  return c.json({ ok: true });
});
