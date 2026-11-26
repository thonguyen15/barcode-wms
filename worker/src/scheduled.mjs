import { getDb } from "./db.mjs";
import { escapeTelegramHtml as escTg, formatTokyoTime as fmtTimeLocal } from "./format_utils.mjs";
import { nowISO } from "./items_common.mjs";
import { tgApi } from "./telegram.mjs";

const REMINDER_LIMIT = 15;
const MAX_SUBREQUESTS = 45;

/** Fire due task reminders and the daily unposted-items check. */
export async function scheduled(event, env, ctx) {
  let budget = MAX_SUBREQUESTS;
  try {
    await fireDueReminders(env, () => --budget > 0);
    await checkUnpostedItems(env, () => --budget > 0);
  } catch (err) {
    console.error("Scheduler error:", err);
  }
}

async function fireDueReminders(env, hasBudget) {
  const now = nowISO();
  const { rows } = await getDb(env).execute({
    sql: "SELECT * FROM tasks WHERE status = 'PENDING' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
    args: [now, REMINDER_LIMIT],
  });
  const updates = [];

  for (const task of rows) {
    if (!hasBudget()) break;
    const count = (task.remind_count || 0) + 1;
    const prefix = count > 1 ? `🔔×${count} ` : "🔔 ";
    try {
      const data = await tgApi(env, "sendMessage", {
        chat_id: task.chat_id,
        text: `${prefix}<b>Nhắc nhở:</b> ${escTg(task.title)}`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Xong", callback_data: `task_done:${task.id}` },
            { text: "⏰ +15p", callback_data: `task_snooze15:${task.id}` },
            { text: "⏰ +1h", callback_data: `task_snooze60:${task.id}` },
          ]],
        },
      });
      const newMsgId = data?.ok ? String(data.result.message_id) : null;
      const nextDue = new Date(Date.now() + 5 * 60000).toISOString();
      updates.push({ sql: "UPDATE tasks SET status='PENDING', due_at=?, remind_count=?, tg_msg_id=? WHERE id=?", args: [nextDue, count, newMsgId, task.id] });
    } catch (err) {
      console.error("Reminder send failed:", err);
    }
  }
  if (updates.length > 0) await getDb(env).batch(updates);
}

async function checkUnpostedItems(env, hasBudget) {

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const { rows: staleItems } = await getDb(env).execute({
    sql: "SELECT * FROM items WHERE is_posted = 0 AND is_deleted = 0 AND status = 'CREATED' AND post_task_msg_id IS NULL AND created_at <= ? LIMIT 15",
    args: [twoDaysAgo],
  });

  const taskChatId = env.TASK_GROUP_CHAT_ID || env.RETURN_GROUP_CHAT_ID;
  if (!env.TELEGRAM_BOT_TOKEN || !taskChatId) return;

  const updates = [];
  for (const item of staleItems) {
    if (!hasBudget()) break;
    const msg =
      `⚠️ <b>NHẮC NHỞ: CHƯA ĐĂNG BÁN (QUÁ 2 NGÀY)</b>\n\n` +
      `🔔 Tag: <a href="tg://user?id=${env.TELEGRAM_BONG || ""}">@BONG</a>\n\n` +
      `📦 ID: <code>${item.package_id}</code>\n` +
      `🏷 Tên: <b>${escTg(item.name)}</b>\n` +
      `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
      `📅 Ngày nhập: ${fmtTimeLocal(item.created_at)}\n\n` +
      `👉 <i>Vui lòng kiểm tra và đăng bán sản phẩm này!</i>`;
    try {
      const data = await tgApi(env, "sendMessage", {
        chat_id: taskChatId,
        text: msg,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🔴 Post Ngay", callback_data: `posted:${item.id}` }]] },
      });
      if (data?.ok) {
        updates.push({
          sql: "UPDATE items SET post_task_msg_id = ?, post_task_chat_id = ? WHERE id = ?",
          args: [String(data.result.message_id), String(taskChatId), item.id],
        });
      }
    } catch (err) {
      console.error("Unposted reminder send failed:", err);
    }
  }
  if (updates.length > 0) await getDb(env).batch(updates);
}
