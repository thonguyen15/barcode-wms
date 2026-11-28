export function createTelegram(token, { fetchImpl = fetch } = {}) {
  async function apiCall(method, payload) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((payload.timeout || 0) + 15000),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, description: text.slice(0, 200) };
    }
    return { status: res.status, ...body };
  }

  async function getUpdates(offset, timeoutSec = 30) {
    return apiCall("getUpdates", {
      offset,
      timeout: timeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
  }

  async function sendMessage(payload) {
    return apiCall("sendMessage", payload);
  }

  async function sendPhoto(payload) {
    return apiCall("sendPhoto", payload);
  }

  return { getUpdates, sendMessage, sendPhoto };
}

export async function sendAlertMessage(telegram, { text, keyboard, photoUrl, plain = false, chatId }) {
  if (!chatId) return { ok: false, mode: "failed", description: "alert_chat_id is not set" };
  const parseMode = plain ? undefined : "HTML";
  const base = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    link_preview_options: { is_disabled: true },
  };
  const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
  if (photoUrl && keyboard) {
    const photo = await telegram.sendPhoto({
      chat_id: chatId,
      photo: photoUrl,
      caption: text.slice(0, 1024),
      parse_mode: parseMode,
      ...markup,
    });
    if (photo.ok) return { ok: true, mode: "photo" };
  }
  const withKb = await telegram.sendMessage({ ...base, ...markup });
  if (withKb.ok) return { ok: true, mode: keyboard ? "keyboard" : "plain" };
  const fallbackPlain = await telegram.sendMessage(base);
  return fallbackPlain.ok
    ? { ok: true, mode: "plain" }
    : { ok: false, mode: "failed", description: fallbackPlain.description };
}
