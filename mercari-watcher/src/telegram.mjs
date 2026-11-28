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

export async function sendAlertMessage(telegram, { text, keyboard, photoUrl, plain = false }) {
  const chatId = process.env.MERCARI_ALERT_CHAT_ID;
  const parseMode = plain ? undefined : "HTML";
  if (photoUrl && keyboard) {
    const photo = await telegram.sendPhoto({
      chat_id: chatId,
      photo: photoUrl,
      caption: text.slice(0, 1024),
      parse_mode: parseMode,
      reply_markup: { inline_keyboard: keyboard },
    });
    if (photo.ok) return { ok: true, mode: "photo-with-intent" };
  }
  const base = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    link_preview_options: { is_disabled: true },
  };
  if (keyboard) {
    const withKb = await telegram.sendMessage({ ...base, reply_markup: { inline_keyboard: keyboard } });
    if (withKb.ok) return { ok: true, mode: "keyboard-with-intent" };
    const entityKb = await telegram.sendMessage({
      ...base,
      entities: [{ type: "text_link", offset: 0, length: 2, url: keyboard[0][1].url }],
      reply_markup: { inline_keyboard: [[keyboard[0][0]]] },
    });
    if (entityKb.ok) return { ok: true, mode: "text-link-entity" };
    const plain = await telegram.sendMessage({ ...base, reply_markup: { inline_keyboard: [[keyboard[0][0]]] } });
    if (plain.ok) return { ok: true, mode: "https-button-only" };
    const raw = await telegram.sendMessage({ ...base, text: `${text}\n${keyboard[0][1].url}` });
    return raw.ok ? { ok: true, mode: "raw-link" } : { ok: false, mode: "failed", description: raw.description };
  }
  const fallbackPlain = await telegram.sendMessage(base);
  return fallbackPlain.ok ? { ok: true, mode: "plain" } : { ok: false, mode: "failed", description: fallbackPlain.description };
}
