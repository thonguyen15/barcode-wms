const TOKYO_TIME_ZONE = "Asia/Tokyo";

/** Escape text for Telegram HTML parse mode. */
export function escapeTelegramHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format an ISO timestamp in Tokyo time, vi-VN locale. */
export function formatTokyoTime(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("vi-VN", { timeZone: TOKYO_TIME_ZONE });
  } catch {
    return iso;
  }
}

/** Describe the browser and OS of a User-Agent header. */
export function describeUserAgent(userAgent) {
  const ua = String(userAgent || "");
  if (!ua) return "Không rõ";
  let os = "Không rõ OS";
  if (/iPhone/i.test(ua)) os = "iPhone";
  else if (/iPad/i.test(ua)) os = "iPad";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/Windows/i.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  let browser = "Không rõ trình duyệt";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  return `${browser} / ${os}`;
}
