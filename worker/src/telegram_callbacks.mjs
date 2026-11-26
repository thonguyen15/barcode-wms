import { getDb } from "./db.mjs";
import { escapeTelegramHtml as escTg } from "./format_utils.mjs";
import { getTgActorName, nowISO, resolveAdminId } from "./items_common.mjs";
import { answerCallbackQuery, sendTelegramMessage, sendTelegramMessageResult, tgApi } from "./telegram.mjs";
import {
  handleApproveDelete,
  handleRejectDelete,
  handleRequestDeleteTg,
  handleRequestReturnTg,
  handleReturnDone,
} from "./telegram_requests.mjs";

/** Re-sync the status/post/meru buttons and caption of an item's Telegram photo message. */
export async function syncTelegramButtons(env, itemId) {
  try {
    const { rows } = await getDb(env).execute({
      sql: "SELECT id, package_id, token, name, serial_clean, condition, status, is_posted, is_meru_logged, tg_chat_id, tg_msg_id, created_at, mvd, battery, coverage, note FROM items WHERE id = ?",
      args: [itemId],
    });
    const item = rows[0];
    if (!item || !item.tg_chat_id || !item.tg_msg_id) return;

    const captionData = {
      mvd: item.mvd || "",
      name: item.name || "",
      serial: item.serial_clean || "",
      condition: item.condition || "",
      battery: item.battery || "",
      coverage: item.coverage || "",
      note: item.note || "",
    };
    let caption = `<code>${escTg(JSON.stringify(captionData))}</code>`;
    if (env.APP_URL) {
      caption += `\n\n🔗 <a href="${env.APP_URL}/item.html?id=${item.id}">Xem chi tiết trên Web</a>`;
    }

    const firstRow = [
      {
        text: `${{ SHIPPED: "🟢", RETURN: "⚫", RETURNED: "⚫", CREATED: "🟡", REQUEST_RETURN: "🟠" }[item.status] || "⬜"} ${item.status}`,
        callback_data: "none",
      },
      { text: "↩️", callback_data: `request_return_tg:${item.id}` },
    ];

    const replyMarkup = {
      inline_keyboard: [
        firstRow,
        [
          item.is_posted
            ? { text: "🟢 Posted", callback_data: `posted:${item.id}` }
            : { text: "🔴 Post", callback_data: `posted:${item.id}` },
          { text: "🗑️", callback_data: `request_delete_tg:${item.id}` },
          item.is_meru_logged
            ? { text: "🟢 Logged", callback_data: `meru:${item.id}` }
            : { text: "🔴 Log", callback_data: `meru:${item.id}` },
        ],
      ],
    };

    await tgApi(env, "editMessageCaption", {
      chat_id: item.tg_chat_id,
      message_id: Number(item.tg_msg_id),
      caption,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  } catch (err) {
    console.error("syncTelegramButtons error:", err);
  }
}

/** Check whether a callback user may run an action under the per-role permission rules. */
function isActionAllowed(env, action, userId) {
  const bongId = String(env.TELEGRAM_BONG || "").trim();
  const aaronId = String(env.TELEGRAM_AARON || "").trim();
  const adminId = resolveAdminId(env);
  const authorizedUserIds = String(env.AUTHORIZED_TELEGRAM_USER_IDS || "")
    .split(",")
    .map((id) => id.trim());
  if (userId === adminId) return true;
  if (bongId && userId === bongId) return action === "posted";
  if (aaronId && userId === aaronId) return action === "request_delete_tg" || action === "return_done";
  if (authorizedUserIds.includes(userId)) return action !== "return_done";
  return false;
}

/** Heal tg_chat_id/tg_msg_id on the item when the clicked message differs. */
async function selfHealReferences(env, cb, itemId) {
  try {
    const { rows } = await getDb(env).execute({
      sql: "SELECT id, tg_chat_id, tg_msg_id FROM items WHERE id = ? AND is_deleted = 0",
      args: [Number(itemId)],
    });
    const dbItem = rows[0];
    if (!dbItem) return;
    const currentChatId = String(cb.message.chat.id);
    const currentMsgId = String(cb.message.message_id);
    if (dbItem.tg_chat_id !== currentChatId || dbItem.tg_msg_id !== currentMsgId) {
      console.log(
        `[SELF-HEALING] Updating TG references for item ${dbItem.id}: chat_id ${dbItem.tg_chat_id} -> ${currentChatId}, msg_id ${dbItem.tg_msg_id} -> ${currentMsgId}`,
      );
      await getDb(env).execute({
        sql: "UPDATE items SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
        args: [currentChatId, currentMsgId, dbItem.id],
      });
    }
  } catch (err) {
    console.error("[SELF-HEALING] Error healing TG references:", err);
  }
}

async function handleCopyItem(env, cb, itemId) {
  const { rows } = await getDb(env).execute({ sql: "SELECT * FROM items WHERE id = ?", args: [itemId] });
  const item = rows[0];
  if (!item) return;
  const textToCopy =
    `Name: ${item.name || "-"}\n` +
    `Serial: ${item.serial_clean || "-"}\n` +
    `Coverage: ${item.coverage || "-"}\n` +
    `Battery: ${item.battery || "-"}\n` +
    `Condition: ${item.condition || "-"}\n` +
    `Note: ${item.note || "-"}`;
  await sendTelegramMessage(env, `📋 <b>Thông tin sản phẩm (Chạm để copy):</b>\n\n<code>${escTg(textToCopy)}</code>`, cb.message.chat.id);
  await answerCallbackQuery(env, cb.id, "✅ Đã gửi thông tin copy!");
}

async function handleMeru(env, cb, itemId) {
  const { rows } = await getDb(env).execute({ sql: "SELECT id, is_meru_logged FROM items WHERE id = ?", args: [itemId] });
  const item = rows[0];
  if (!item) return;
  const updated_at = nowISO();
  const next_val = item.is_meru_logged ? 0 : 1;
  const actor = getTgActorName(cb.from);
  const db = getDb(env);
  await db.batch([
    {
      sql: "UPDATE items SET is_meru_logged = ?, updated_at = ? WHERE id = ?",
      args: [next_val, updated_at, itemId],
    },
    {
      sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
      args: [itemId, actor, JSON.stringify({ is_meru_logged: next_val }), updated_at],
    },
  ]);
  await syncTelegramButtons(env, itemId);
  await answerCallbackQuery(env, cb.id, next_val ? "✅ Đã Log Meru!" : "🔄 Đã Hủy Log Meru", false);
}

async function handlePosted(env, cb, itemId) {
  const { rows } = await getDb(env).execute({ sql: "SELECT id, package_id, is_posted, post_task_msg_id, post_task_chat_id FROM items WHERE id = ?", args: [itemId] });
  const item = rows[0];
  if (!item) return;
  if (item.is_posted) {
    await answerCallbackQuery(env, cb.id, "ℹ️ Sản phẩm này đã được đăng bán rồi.", false);
    return;
  }
  const updated_at = nowISO();
  const actor = getTgActorName(cb.from);
  const db = getDb(env);
  const statements = [
    { sql: "UPDATE items SET is_posted = 1, updated_at = ? WHERE id = ?", args: [updated_at, itemId] },
    {
      sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
      args: [itemId, actor, JSON.stringify({ is_posted: 1 }), updated_at],
    },
  ];
  if (item.post_task_msg_id && item.post_task_chat_id) {
    await tgApi(env, "deleteMessage", { chat_id: item.post_task_chat_id, message_id: item.post_task_msg_id }).catch((e) =>
      console.error("Delete unposted reminder failed:", e),
    );
    statements.push({ sql: "UPDATE items SET post_task_msg_id = NULL, post_task_chat_id = NULL WHERE id = ?", args: [itemId] });
  }
  await db.batch(statements);
  await syncTelegramButtons(env, itemId);
  await answerCallbackQuery(env, cb.id, "✅ Đã đăng bán thành công!", false);
}

async function handleEditJsonTg(env, cb, itemId) {
  const { rows } = await getDb(env).execute({ sql: "SELECT * FROM items WHERE id = ?", args: [itemId] });
  const item = rows[0];
  if (!item) return;
  const captionData = {
    mvd: item.mvd || "",
    name: item.name || "",
    serial: item.serial_clean || "",
    condition: item.condition || "",
    battery: item.battery || "",
    coverage: item.coverage || "",
    note: item.note || "",
  };
  const textMsg =
    `✏️ <b>Sửa JSON sản phẩm (ID: ${item.id})</b>\n` +
    `Hãy copy đoạn JSON bên dưới, chỉnh sửa các giá trị và thực hiện <b>Reply (Phản hồi)</b> trực tiếp lại tin nhắn này:\n\n` +
    `<code>${escTg(JSON.stringify(captionData))}</code>`;
  await sendTelegramMessage(env, textMsg, cb.message.chat.id);
  await answerCallbackQuery(env, cb.id, "✅ Đã gửi mẫu JSON. Hãy reply để sửa!");
}

/** Send a temporary message and delete it once the background task window allows. */
export function ephemeralMessage(env, chatId, text, ctx, deleteAfterMs) {
  const task = (async () => {
    const sent = await sendTelegramMessageResult(env, text, chatId);
    if (!sent) return;
    await new Promise((resolve) => setTimeout(resolve, deleteAfterMs));
    await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
  })();
  ctx.waitUntil(task);
}
/** Dispatch one Telegram callback_query to its action handler. */
export async function handleCallbackQuery(env, cb) {
  const [action, itemId] = cb.data.split(":");
  try {
    const userId = String(cb.from.id);
    if (!isActionAllowed(env, action, userId)) {
      await answerCallbackQuery(env, cb.id, "❌ Bạn không có quyền thực hiện thao tác này!", true);
      return;
    }

    if (itemId && !isNaN(Number(itemId)) && action !== "return_done") {
      await selfHealReferences(env, cb, itemId);
    }

    if (action === "copy_item") return await handleCopyItem(env, cb, itemId);
    if (action === "meru") return await handleMeru(env, cb, itemId);
    if (action === "posted") return await handlePosted(env, cb, itemId);
    if (action === "edit_json_tg") return await handleEditJsonTg(env, cb, itemId);
    if (action === "request_return_tg") return await handleRequestReturnTg(env, cb, itemId);
    if (action === "request_delete_tg") return await handleRequestDeleteTg(env, cb, itemId);
    if (action === "return_done") return await handleReturnDone(env, cb, itemId);
    if (action === "approve_delete") return await handleApproveDelete(env, cb, itemId);
    if (action === "reject_delete") return await handleRejectDelete(env, cb, itemId);

    await answerCallbackQuery(env, cb.id);
  } catch (err) {
    console.error("Telegram callback error:", err);
  }
}

