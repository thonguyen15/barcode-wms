import { getDb } from "./db.mjs";
import { escapeTelegramHtml as escTg, formatTokyoTime as fmtTimeLocal } from "./format_utils.mjs";
import { getTgActorName, nowISO, resolveAdminId } from "./items_common.mjs";

import { answerCallbackQuery, sendTelegramMessage, tgApi } from "./telegram.mjs";
import { syncTelegramButtons } from "./telegram_callbacks.mjs";

export async function handleRequestReturnTg(env, cb, itemId2) {
  const userId = String(cb.from.id);
  if (userId !== resolveAdminId(env)) {
    await answerCallbackQuery(env, cb.id, "❌ Chỉ admin mới có quyền yêu cầu Return!", true);
    return;
  }
  const { rows: iRows } = await getDb(env).execute({
    sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0",
    args: [itemId2],
  });
  const itemData = iRows[0];
  if (!itemData) {
    await answerCallbackQuery(env, cb.id, "❌ Không tìm thấy sản phẩm.", true);
    return;
  }
  const { rows: pendingRows } = await getDb(env).execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING'",
    args: [itemId2],
  });
  if (pendingRows[0]) {
    await answerCallbackQuery(env, cb.id, "⚠️ Đã có yêu cầu đang chờ duyệt!", true);
    return;
  }

  const t = nowISO();
  const requester = getTgActorName(cb.from);
  const db = getDb(env);
  await db.batch([
    { sql: "UPDATE items SET status = 'REQUEST_RETURN', updated_at = ? WHERE id = ?", args: [t, itemId2] },
    {
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
      args: [itemId2, itemData.status, "REQUEST_RETURN", requester, t],
    },
    { sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)", args: [itemId2, requester, t] },
  ]);
  const { rows: newReqRows } = await getDb(env).execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
    args: [itemId2],
  });
  const newReqId = newReqRows[0].id;

  const returnGroupId = env.RETURN_GROUP_CHAT_ID;
  const taskGroupId = env.TASK_GROUP_CHAT_ID || returnGroupId;
  const tagAaron = env.TELEGRAM_AARON ? `\n🔔 Tag: <a href="tg://user?id=${env.TELEGRAM_AARON}">@AARON</a>` : "";
  const retMsg =
    `📦 <b>YÊU CẦU RETURN & XÓA</b>\n\n` +
    `📦 ID: <code>${itemData.package_id}</code>\n` +
    `🏷️ Tên: <b>${escTg(itemData.name)}</b>\n` +
    `🔢 Serial: <code>${itemData.serial_clean || "-"}</code>\n` +
    `📍 Trạng thái: ${itemData.status} ➔ <b>REQUEST_RETURN</b>\n` +
    `👤 Yêu cầu bởi: <b>${escTg(requester)}</b>${tagAaron}\n` +
    `⏰ Thời gian: ${fmtTimeLocal(t)}`;

  const buttons = [
    { text: "✅ Done", callback_data: `return_done:${newReqId}` },
    { text: `📍 REQUEST_RETURN`, callback_data: "none" },
  ];
  if (itemData.tg_chat_id && itemData.tg_msg_id) {
    const cleanChatId = String(itemData.tg_chat_id).replace("-100", "");
    buttons.push({ text: "🔗 Xem tin gốc", url: `https://t.me/c/${cleanChatId}/${itemData.tg_msg_id}` });
  }

  try {
    const tgData = await tgApi(env, "sendMessage", {
      chat_id: returnGroupId,
      text: retMsg,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [buttons] },
    });
    let adminMsgId = null;
    if (tgData?.ok && tgData.result) adminMsgId = String(tgData.result.message_id);

    const taskMsg =
      `📝 <b>TASK: KIỂM TRA HÀNG RETURN</b>\n\n` +
      `📦 ID: <code>${itemData.package_id}</code>\n` +
      `🏷 Tên: <b>${escTg(itemData.name)}</b>\n` +
      `🔢 Serial: <code>${itemData.serial_clean || "-"}</code>\n` +
      `👤 Người yêu cầu: ${escTg(requester)}` +
      (env.TELEGRAM_AARON ? `\n🔔 Tag: <a href="tg://user?id=${env.TELEGRAM_AARON}">@AARON</a>` : "");
    const taskData = await tgApi(env, "sendMessage", { chat_id: taskGroupId, text: taskMsg, parse_mode: "HTML" });
    let taskMsgId = null;
    if (taskData?.ok && taskData.result) taskMsgId = String(taskData.result.message_id);

    await getDb(env).execute({
      sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ?, task_chat_id = ?, task_msg_id = ? WHERE id = ?",
      args: [returnGroupId, adminMsgId, taskGroupId, taskMsgId, newReqId],
    });
  } catch (err) {
    console.error("Telegram request return failed:", err);
  }

  await answerCallbackQuery(env, cb.id, "✅ Đã gửi yêu cầu Return tới admin!", true);
}

export async function handleRequestDeleteTg(env, cb, itemId2) {
  const { rows: iRows } = await getDb(env).execute({
    sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0",
    args: [itemId2],
  });
  const itemData = iRows[0];
  if (!itemData) {
    await answerCallbackQuery(env, cb.id, "❌ Không tìm thấy sản phẩm.", true);
    return;
  }
  const { rows: pendingRows } = await getDb(env).execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING'",
    args: [itemId2],
  });
  if (pendingRows[0]) {
    await answerCallbackQuery(env, cb.id, "⚠️ Đã có yêu cầu xóa đang chờ duyệt!", true);
    return;
  }

  const t = nowISO();
  const requester = getTgActorName(cb.from);
  await getDb(env).batch([
    {
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
      args: [itemId2, itemData.status, "REQUEST_DELETE", requester, t],
    },
    { sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)", args: [itemId2, requester, t] },
  ]);
  const { rows: newReqRows } = await getDb(env).execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
    args: [itemId2],
  });
  const newReqId = newReqRows[0].id;

  const delMsg =
    `🗑️ <b>YÊU CẦU XÓA SẢN PHẨM</b>\n\n` +
    `📦 ID: <code>${itemData.package_id}</code>\n` +
    `🏷️ Tên: <b>${escTg(itemData.name)}</b>\n` +
    `🔢 Serial: <code>${itemData.serial_clean || "-"}</code>\n` +
    `📍 Trạng thái: ${itemData.status}\n` +
    `👤 Yêu cầu bởi: <b>${escTg(requester)}</b>\n` +
    `⏰ Thời gian: ${fmtTimeLocal(t)}`;

  try {
    console.log(`[DELETE REQUEST] Sending to chat_id: ${env.DELETE_GROUP_CHAT_ID}`);
    const tgData = await tgApi(env, "sendMessage", {
      chat_id: env.DELETE_GROUP_CHAT_ID,
      text: delMsg,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Duyệt xóa", callback_data: `approve_delete:${newReqId}` },
            { text: "❌ Từ chối", callback_data: `reject_delete:${newReqId}` },
          ],
        ],
      },
    });
    console.log("[DELETE REQUEST] Telegram response:", tgData);
    if (tgData?.ok && tgData.result) {
      await getDb(env).execute({
        sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
        args: [String(tgData.result.chat.id), String(tgData.result.message_id), newReqId],
      });
    } else if (tgData && !tgData.ok) {
      console.error(`[DELETE REQUEST] Telegram error: ${tgData.description}`);
    }
  } catch (err) {
    console.error("Telegram delete request from TG button failed:", err);
  }

  await answerCallbackQuery(env, cb.id, "✅ Đã gửi yêu cầu xóa tới admin!", true);
}

export async function handleReturnDone(env, cb, reqId) {
  const { rows: reqRows } = await getDb(env).execute({ sql: "SELECT * FROM delete_requests WHERE id = ?", args: [reqId] });
  const request = reqRows[0];
  if (!request) return;
  const { rows: itemRows } = await getDb(env).execute({ sql: "SELECT * FROM items WHERE id = ?", args: [request.item_id] });
  const item = itemRows[0];
  if (!item) return;

  const t = nowISO();
  const actor = getTgActorName(cb.from);
  await getDb(env).batch([
    { sql: "UPDATE items SET status = 'RETURN', updated_at = ? WHERE id = ?", args: [t, item.id] },
    {
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
      args: [item.id, item.status, "RETURN", actor, t],
    },
    { sql: "UPDATE delete_requests SET status = 'DONE', resolved_at = ? WHERE id = ?", args: [t, reqId] },
  ]);

  if (request.task_chat_id && request.task_msg_id) {
    await tgApi(env, "deleteMessage", { chat_id: request.task_chat_id, message_id: request.task_msg_id }).catch((e) =>
      console.error("Xóa task message thất bại:", e),
    );
  }

  const newText = cb.message.text.replace("YÊU CẦU RETURN & XÓA", "✅ ĐÃ HOÀN TẤT RETURN") + `\n\n✅ Đã xử lý bởi: <b>${escTg(cb.from.first_name)}</b>`;
  await tgApi(env, "editMessageText", {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: newText,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "📍 RETURN", callback_data: "none" }]] },
  });

  await syncTelegramButtons(env, item.id);
  await answerCallbackQuery(env, cb.id, "✅ Đã xác nhận hoàn tất Return!");
}

export async function handleApproveDelete(env, cb, reqId) {
  const { rows: reqRows } = await getDb(env).execute({
    sql: "SELECT dr.*, i.package_id, i.name, i.tg_chat_id as item_tg_chat, i.tg_msg_id as item_tg_msg FROM delete_requests dr JOIN items i ON dr.item_id = i.id WHERE dr.id = ?",
    args: [reqId],
  });
  const reqData = reqRows[0];
  if (!reqData || reqData.status !== "PENDING") {
    await answerCallbackQuery(env, cb.id, "⚠️ Yêu cầu này đã được xử lý rồi.", true);
    return;
  }

  const t = nowISO();
  const actor = getTgActorName(cb.from);
  await getDb(env).batch([
    {
      sql: "UPDATE items SET is_deleted=1, status='DELETED', deleted_at=?, deleted_by=?, updated_at=? WHERE id=?",
      args: [t, actor, t, reqData.item_id],
    },
    {
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
      args: [reqData.item_id, "PENDING_DELETE", "DELETED", actor, t],
    },
    { sql: "UPDATE delete_requests SET status='APPROVED', resolved_at=? WHERE id=?", args: [t, reqId] },
  ]);

  const notifyMsg =
    `🔔 <b>HỆ THỐNG: ĐÃ XÓA SẢN PHẨM</b>\n\n` +
    `📦 ID: <code>${reqData.package_id}</code>\n` +
    `🏷 Tên: <b>${escTg(reqData.name)}</b>\n` +
    `👤 Duyệt bởi: <b>${escTg(actor)}</b>\n` +
    `⏰ Thời gian: ${fmtTimeLocal(t)}`;
  await sendTelegramMessage(env, notifyMsg, env.NOTIFICATION_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID);

  if (reqData.item_tg_chat && reqData.item_tg_msg) {
    try {
      await tgApi(env, "deleteMessage", { chat_id: reqData.item_tg_chat, message_id: Number(reqData.item_tg_msg) });
    } catch (err) {
      console.error("Delete item TG msg failed:", err);
    }
  }
  if (reqData.tg_chat_id && reqData.tg_msg_id) {
    try {
      await tgApi(env, "deleteMessage", { chat_id: reqData.tg_chat_id, message_id: Number(reqData.tg_msg_id) });
    } catch (err) {
      console.error("Delete request TG msg failed:", err);
    }
  }

  await answerCallbackQuery(env, cb.id, `✅ Đã duyệt xóa: ${reqData.package_id}`, true);
}

export async function handleRejectDelete(env, cb, reqId) {
  const { rows: reqRows } = await getDb(env).execute({ sql: "SELECT * FROM delete_requests WHERE id = ?", args: [reqId] });
  const reqData = reqRows[0];
  if (!reqData || reqData.status !== "PENDING") {
    await answerCallbackQuery(env, cb.id, "⚠️ Yêu cầu này đã được xử lý rồi.", true);
    return;
  }

  const t = nowISO();
  const actor = getTgActorName(cb.from);
  await getDb(env).batch([
    {
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
      args: [reqData.item_id, "REQUEST_DELETE", "CREATED", actor, t],
    },
    { sql: "UPDATE delete_requests SET status='REJECTED', resolved_at=? WHERE id=?", args: [t, reqId] },
  ]);

  if (reqData.tg_chat_id && reqData.tg_msg_id) {
    try {
      await tgApi(env, "deleteMessage", { chat_id: reqData.tg_chat_id, message_id: Number(reqData.tg_msg_id) });
    } catch (err) {
      console.error("Delete reject TG msg failed:", err);
    }
  }

  await answerCallbackQuery(env, cb.id, "❌ Đã từ chối yêu cầu xóa.", false);
}

