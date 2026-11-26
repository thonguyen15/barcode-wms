import { escapeTelegramHtml } from "./format_utils.mjs";
import { getDb } from "./db.mjs";
import { tgFetch } from "./telegram.mjs";

const STATUS_DOT = { SHIPPED: "🟢", RETURN: "⚫", RETURNED: "⚫", CREATED: "🟡", REQUEST_RETURN: "🟠" };

/** Re-render the Telegram photo caption and inline buttons of an item; never throws. */
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
    let caption = `<code>${escapeTelegramHtml(JSON.stringify(captionData))}</code>`;
    if (env.APP_URL) {
      caption += `\n\n🔗 <a href="${env.APP_URL}/item.html?id=${item.id}">Xem chi tiết trên Web</a>`;
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: `${STATUS_DOT[item.status] || "⬜"} ${item.status}`, callback_data: "none" },
          { text: "↩️", callback_data: `request_return_tg:${item.id}` },
        ],
        [
          { text: item.is_posted ? "🟢 Posted" : "🔴 Post", callback_data: `posted:${item.id}` },
          { text: "🗑️", callback_data: `request_delete_tg:${item.id}` },
          { text: item.is_meru_logged ? "🟢 Logged" : "🔴 Log", callback_data: `meru:${item.id}` },
        ],
      ],
    };

    await tgFetch(env, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageCaption`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: item.tg_chat_id,
        message_id: Number(item.tg_msg_id),
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });
  } catch (err) {
    console.error("syncTelegramButtons error:", err);
  }
}

/** Send a document built from an in-memory string; throws on Telegram rejection. */
export async function sendTelegramDocument(env, filename, content, caption, targetChatId = null) {
  const chatId = targetChatId || env.TELEGRAM_CHAT_ID;
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/csv" }), filename);
  const res = await tgFetch(env, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Telegram rejected (Status ${res.status}): ${errBody}`);
  }
}

/** Send an inline-button message and return the Telegram API result, or null on failure. */
export async function sendTelegramButtonsMessage(env, chatId, text, buttons) {
  try {
    const res = await tgFetch(env, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: [buttons] } }),
    });
    const data = await res.json();
    return data.ok && data.result ? data.result : null;
  } catch (err) {
    console.error("Request notify error:", err);
    return null;
  }
}

/** Delete a Telegram message; never throws. */
export async function deleteTelegramMessage(env, chatId, messageId) {
  try {
    await tgFetch(env, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) }),
    });
  } catch (err) {
    console.error("Delete TG message error:", err.message);
  }
}
