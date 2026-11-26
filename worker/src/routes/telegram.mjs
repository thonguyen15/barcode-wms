import { Hono } from "hono";
import { handleCallbackQuery } from "../telegram_callbacks.mjs";
import { handleTextMessage } from "../telegram_messages.mjs";

const CHAT_ENV_KEYS = ["TELEGRAM_CHAT_ID", "DELETE_GROUP_CHAT_ID", "RETURN_GROUP_CHAT_ID", "TASK_GROUP_CHAT_ID"];
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Check whether the webhook update came from an authorized chat. */
function isFromAuthorizedChat(env, chatId) {
  return CHAT_ENV_KEYS.some((key) => env[key] && chatId === String(env[key]));
}

export const telegramRoutes = new Hono();

telegramRoutes.post("/telegram/webhook", async (c) => {
  if (c.env.TELEGRAM_WEBHOOK_SECRET && c.req.header(SECRET_HEADER) !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text("Unauthorized", 401);
  }

  const update = await c.req.json().catch(() => null);
  if (!update) return c.body(null, 200);

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = String(cb.message?.chat?.id ?? "");
    if (!isFromAuthorizedChat(c.env, chatId)) return c.body(null, 200);
    await handleCallbackQuery(c.env, cb);
    return c.body(null, 200);
  }

  const msg = update.message;
  if (!msg || !msg.chat) return c.body(null, 200);
  const chatId = String(msg.chat.id);
  if (!isFromAuthorizedChat(c.env, chatId)) return c.body(null, 200);
  await handleTextMessage(c.env, c.executionCtx, msg);
  return c.body(null, 200);
});
