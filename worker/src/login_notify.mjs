import { describeUserAgent, escapeTelegramHtml, formatTokyoTime } from "./format_utils.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

/** Send the group the Telegram alert for a web login. */
export async function notifyLogin(env, request, username, role) {
  const ip = request.headers.get("cf-connecting-ip") || "-";
  const userAgent = request.headers.get("user-agent") || "";
  const msg =
    `🔐 <b>THÔNG BÁO ĐĂNG NHẬP WEB</b>\n\n` +
    `👤 Tài khoản: <b>${escapeTelegramHtml(username)}</b> (${escapeTelegramHtml(role)})\n` +
    `🕒 Thời gian: ${formatTokyoTime(new Date().toISOString())}\n` +
    `🌐 IP: <code>${escapeTelegramHtml(ip)}</code>\n` +
    `💻 Thiết bị: ${escapeTelegramHtml(describeUserAgent(userAgent))}`;
  const chatId = env.NOTIFICATION_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
  await sendTelegramMessage(env, msg, chatId);
}
