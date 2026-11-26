import { getDb } from "./db.mjs";
import { escapeTelegramHtml as escTg } from "./format_utils.mjs";
import { formatTokyoHHMM, getTgActorName, nowISO } from "./items_common.mjs";
import { sendTelegramMessage, sendTelegramMessageResult, tgApi } from "./telegram.mjs";
import { ephemeralMessage, syncTelegramButtons } from "./telegram_callbacks.mjs";

/** Parse "nhắc:/remind:/task:" text into { title, dueMs }, Vietnam-style time suffixes. */
export function parseTaskInput(raw) {
  let dueMs = null;
  let title = raw;
  const VN_OFFSET = 7 * 3600000;
  const nowVN = () => Date.now() + VN_OFFSET;

  const relMatch = raw.match(/(\d+h)?(\d+p)?\s*$/i);
  const clockMatch = raw.match(/(?:lúc\s*)?(\d{1,2})[h:](\d{2})/i);
  const hOnly = raw.match(/(\d+)h\s*$/i);
  const mOnly = raw.match(/(\d+)p\s*$/i);

  if (clockMatch) {
    const hh = parseInt(clockMatch[1], 10);
    const mm = parseInt(clockMatch[2], 10);
    const todayVN = new Date(nowVN());
    let due = new Date(Date.UTC(todayVN.getUTCFullYear(), todayVN.getUTCMonth(), todayVN.getUTCDate(), hh - 7, mm));
    if (due.getTime() <= Date.now()) due = new Date(due.getTime() + 86400000);
    dueMs = due.getTime();
    title = raw.replace(clockMatch[0], "").replace(/\s*(lúc)?\s*$/, "").trim();
  } else if (hOnly && mOnly && relMatch[1] && relMatch[2]) {
    const h = parseInt(relMatch[1], 10);
    const m = parseInt(relMatch[2], 10);
    dueMs = Date.now() + (h * 3600 + m * 60) * 1000;
    title = raw.replace(relMatch[0].trim(), "").trim();
  } else if (hOnly) {
    dueMs = Date.now() + parseInt(hOnly[1], 10) * 3600000;
    title = raw.replace(hOnly[0].trim(), "").trim();
  } else if (mOnly) {
    dueMs = Date.now() + parseInt(mOnly[1], 10) * 60000;
    title = raw.replace(mOnly[0].trim(), "").trim();
  }
  return { dueMs, title };
}

/** Find the item a reply targets, healing tg_msg_id from the caption JSON when unlinked. */
async function resolveReplyTarget(env, msg, chatId) {
  let item = null;
  let helperMsgId = null;
  const reply = msg.reply_to_message;
  const editMatch = reply.text ? reply.text.match(/Sửa JSON sản phẩm \(ID:\s*(\d+)\)/i) : null;
  if (editMatch) {
    const itemId = parseInt(editMatch[1], 10);
    const { rows } = await getDb(env).execute({ sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0", args: [itemId] });
    item = rows[0];
    helperMsgId = reply.message_id;
    return { item, helperMsgId };
  }
  const replyMsgId = String(reply.message_id);
  const { rows } = await getDb(env).execute({
    sql: "SELECT * FROM items WHERE tg_msg_id = ? AND tg_chat_id = ? AND is_deleted = 0 LIMIT 1",
    args: [replyMsgId, chatId],
  });
  item = rows[0];
  if (!item && reply.caption) {
    const jsonMatch = reply.caption.match(/\{.*\}/s);
    if (jsonMatch) {
      try {
        const capObj = JSON.parse(jsonMatch[0].trim());
        const serial = capObj.serial || capObj.serial_clean;
        if (serial) {
          const clean = (serial.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim();
          if (clean) {
            const { rows: fallbackRows } = await getDb(env).execute({
              sql: "SELECT * FROM items WHERE LOWER(serial_clean) = LOWER(?) AND is_deleted = 0 LIMIT 1",
              args: [clean],
            });
            item = fallbackRows[0];
            if (item) {
              await getDb(env).execute({
                sql: "UPDATE items SET tg_msg_id = ?, tg_chat_id = ? WHERE id = ?",
                args: [replyMsgId, chatId, item.id],
              });
              console.log(`[SELF-HEAL] Linked item ID ${item.id} with tg_msg_id: ${replyMsgId}`);
            }
          }
        }
      } catch (err) {
        console.error("Caption JSON parse fallback failed:", err);
      }
    }
  }
  return { item, helperMsgId };
}

function extractUpdates(obj, item) {
  const rawSerial = obj.serial !== undefined ? obj.serial : obj.serial_raw !== undefined ? obj.serial_raw : item.serial_raw;
  return {
    name: (obj.name !== undefined ? obj.name : item.name) || "",
    serial_raw: (rawSerial !== undefined ? rawSerial : item.serial_raw) || "",
    condition: (obj.condition !== undefined ? obj.condition : item.condition) || "",
    mvd: (obj.mvd !== undefined ? obj.mvd : item.mvd) || "",
    note: (obj.note !== undefined ? obj.note : item.note) || "",
    battery: (obj.battery !== undefined ? obj.battery : item.battery) || "",
    coverage: (obj.coverage !== undefined ? obj.coverage : item.coverage) || "",
  };
}

async function applyItemEdit(env, ctx, item, obj, chatId, msg, helperMsgId) {
  const aaronId = String(env.TELEGRAM_AARON || "").trim();
  const adminId = env.TELEGRAM_ADMIN_ID
    ? String(env.TELEGRAM_ADMIN_ID).trim()
    : String(env.AUTHORIZED_TELEGRAM_USER_IDS || "").split(",")[0].trim();
  const userId = String(msg.from.id);
  const isAuthorized = userId === adminId || (aaronId && userId === aaronId);

  if (!isAuthorized) {
    await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    ephemeralMessage(env, chatId, "❌ Bạn không có quyền sửa sản phẩm!", ctx, 5000);
    return;
  }

  const updates = extractUpdates(obj, item);
  if (updates.serial_raw !== undefined && updates.serial_clean === undefined) {
    updates.serial_clean = (updates.serial_raw.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim().toUpperCase();
  }
  const allowed = ["name", "serial_raw", "serial_clean", "condition", "mvd", "note", "battery", "coverage"];
  const changes = {};
  for (const k of allowed) {
    if (updates[k] === undefined) updates[k] = item[k] ?? "";
    const oldValue = item[k] ?? "";
    const newValue = String(updates[k]).trim();
    if (oldValue !== newValue) changes[k] = { from: oldValue, to: newValue };
  }

  try {
    if (Object.keys(changes).length > 0) {
      const updated_at = nowISO();
      const actor = getTgActorName(msg.from);
      await getDb(env).batch([
        {
          sql: "UPDATE items SET name = ?, serial_raw = ?, serial_clean = ?, condition = ?, mvd = ?, note = ?, battery = ?, coverage = ?, updated_at = ? WHERE id = ?",
          args: [
            updates.name,
            updates.serial_raw,
            updates.serial_clean,
            updates.condition,
            updates.mvd,
            updates.note,
            updates.battery,
            updates.coverage,
            updated_at,
            item.id,
          ],
        },
        {
          sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
          args: [item.id, actor, JSON.stringify(changes), updated_at],
        },
      ]);
      await syncTelegramButtons(env, item.id);
    }

    await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch((e) =>
      console.error("Failed to delete user reply message:", e),
    );
    if (helperMsgId) {
      await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: helperMsgId }).catch((e) =>
        console.error("Failed to delete helper message:", e),
      );
    }
    ephemeralMessage(env, chatId, `✅ Đã cập nhật sản phẩm <code>${item.package_id}</code>!`, ctx, 3000);
  } catch (err) {
    console.error("Edit reply processing failed:", err);
    ephemeralMessage(env, chatId, `❌ Lỗi: ${err.message}`, ctx, 5000);
  }
}

async function createTask(env, msg, raw) {
  const { dueMs, title } = parseTaskInput(raw);
  if (!dueMs || !title) {
    await sendTelegramMessage(
      env,
      `⚠️ Không hiểu thời gian. Ví dụ:\n<code>nhắc: Kiểm hàng 30p</code>\n<code>nhắc: Gọi khách 1h30p</code>\n<code>nhắc: Meeting 14:30</code>`,
    );
    return;
  }
  const due_at = new Date(dueMs).toISOString();
  const created_at = nowISO();
  const from = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || "TG";
  const chatId = String(msg.chat.id);

  const result = await getDb(env).execute({
    sql: "INSERT INTO tasks (title, due_at, chat_id, created_by, status, created_at) VALUES (?,?,?,?,?,?)",
    args: [title, due_at, chatId, from, "PENDING", created_at],
  });
  const taskId = Number(result.lastInsertRowid);
  const dueStr = formatTokyoHHMM(dueMs);

  await sendTelegramMessage(env, `⏰ <b>Đã đặt nhắc:</b> ${escTg(title)}\n🕐 Nhắc lúc: <b>${dueStr}</b>`, {
    inline_keyboard: [[{ text: "❌ Huỷ nhắc", callback_data: `task_cancel:${taskId}` }]],
  });
}

/** Handle one authorized Telegram text message: JSON reply edits and reminder creation. */
export async function handleTextMessage(env, ctx, msg) {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = String(msg.chat.id);

  if (msg.reply_to_message) {
    const { item, helperMsgId } = await resolveReplyTarget(env, msg, chatId);
    if (item) {
      let obj = null;
      try {
        obj = JSON.parse(text);
      } catch {
        obj = null;
      }
      if (obj) {
        await applyItemEdit(env, ctx, item, obj, chatId, msg, helperMsgId);
        return;
      }
    }
  }

  if (/^(nhắc|remind|task)\s*:/i.test(text)) {
    try {
      await createTask(env, msg, text.replace(/^(nhắc|remind|task)\s*:/i, "").trim());
    } catch (err) {
      console.error("Task creation failed:", err);
    }
  }
}
