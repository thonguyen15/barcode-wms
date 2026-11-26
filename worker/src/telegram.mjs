const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const SAFE_RETRY_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Call the Telegram Bot API, retrying only when the request surely was not processed. */
export async function tgFetch(env, url, options = {}) {
  if (env.TG_DRY_RUN === "1") return dryRun(url, options);
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        console.error(`[TELEGRAM] HTTP ${res.status} (lần ${attempt}/${MAX_ATTEMPTS}), retry...`);
        await delay(600 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      const code = err.cause?.code || err.name;
      const safeToRetry = SAFE_RETRY_CODES.has(code);
      console.error(
        `[TELEGRAM] fetch fail (lần ${attempt}/${MAX_ATTEMPTS}): ${code} - ${err.message}` +
          (safeToRetry ? "" : " | Request có thể đã gửi thành công -> không retry để tránh tin trùng"),
      );
      if (!safeToRetry) throw err;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await delay(600 * attempt);
    }
  }
  throw lastErr;
}

/** Send an HTML message, doing nothing when Telegram is not configured; never throws. */
export async function sendTelegramMessage(env, text, targetChatId = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = targetChatId || env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await tgFetch(env, `https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err);
  }
}

/** Call a Telegram Bot API method by name and return the parsed JSON body; never throws. */
export async function tgApi(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await tgFetch(env, `https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram ${method} failed:`, err);
    return null;
  }
}

/** Call a Telegram Bot API method once, without the retry wrapper. */
export async function tgApiNoRetry(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = env.TG_DRY_RUN === "1" ? dryRun(url, { method: "POST", body: JSON.stringify(payload) }) : await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram ${method} failed:`, err);
    return null;
  }
}

/** Answer a callback query so Telegram stops showing the loading spinner. */
export function answerCallbackQuery(env, callbackQueryId, text = undefined, showAlert = undefined) {
  const payload = { callback_query_id: callbackQueryId };
  if (text !== undefined) payload.text = text;
  if (showAlert !== undefined) payload.show_alert = showAlert;
  return tgApi(env, "answerCallbackQuery", payload);
}

/** Send an HTML message and return the message result, or null on failure. */
export async function sendTelegramMessageResult(env, text, targetChatId = null, extra = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = targetChatId || env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  const data = await tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
  return data?.ok ? data.result : null;
}

/** Send a photo from a buffer with HTML caption and inline keyboard, returning the message result. */
export async function sendTelegramPhoto(env, imageBuffer, caption = "", replyMarkup = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("[TELEGRAM] Missing token or chatId");
    return null;
  }
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
    form.append("photo", new Blob([imageBuffer], { type: "image/png" }), "qr_code.png");
    const res = await tgFetch(env, `https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
    if (!res.ok) {
      console.error("[TELEGRAM] Photo send failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    if (!data.ok) {
      console.error("[TELEGRAM] API returned error:", data);
      return null;
    }
    return data.result;
  } catch (err) {
    console.error("[TELEGRAM] sendTelegramPhoto Error:", err.message);
    return null;
  }
}

function dryRun(url, options) {
  const method = url.slice(url.lastIndexOf("/") + 1);
  console.log(`[TELEGRAM dry-run] ${method} ${options.body ?? ""}`);
  return new Response('{"ok":true,"result":{}}', {
    headers: { "Content-Type": "application/json" },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
