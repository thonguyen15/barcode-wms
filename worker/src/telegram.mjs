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
