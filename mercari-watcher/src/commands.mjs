import { parseMercariSearchUrl } from "./mercari.mjs";

const CONDITION_NAMES = {
  1: "新品・未使用",
  2: "目立った傷や汚れなし",
  3: "やや傷や汚れあり",
  4: "傷や汚れあり",
};

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function conditionName(itemConditionId) {
  const key = Number(itemConditionId);
  return CONDITION_NAMES[key] || String(itemConditionId);
}

export function formatAlert(item, watchName) {
  const name = escapeHtml(item.name || "");
  const price = `¥${Number(item.price || 0).toLocaleString("ja-JP")}`;
  const ageMin = Math.max(0, Math.round((Date.now() / 1000 - Number(item.created)) / 60));
  const cond = conditionName(item.itemConditionId);
  const itemUrl = `https://jp.mercari.com/item/${item.id}`;
  return (
    `🔔 <b>${watchName}</b>\n` +
    `${name}\n` +
    `💰 ${price} ｜ 🏷 ${cond}\n` +
    `⏱ đăng ${ageMin} phút trước\n` +
    itemUrl
  );
}

export function alertKeyboard(item) {
  const httpsUrl = `https://jp.mercari.com/item/${item.id}`;
  const intentUrl =
    `intent://jp.mercari.com/item/${item.id}#Intent;scheme=https;package=jp.mercari.android;` +
    `S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`;
  return [
    [
      { text: "📱 iPhone — mở app", url: httpsUrl },
      { text: "🤖 Android — mở app", url: intentUrl },
    ],
  ];
}

export function buildAuthorizedChecker(authorizedIdsEnv) {
  const allowed = new Set(
    (authorizedIdsEnv || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return (userId) => allowed.has(String(userId));
}

export async function handleCommand({ text, userId, store, searchMercari, pollerStatus = null }) {
  const parts = (text || "").trim().split(/\s+/);
  const cmd = parts[0];
  if (cmd === "/watch") {
    const url = parts[1];
    if (!url) return { reply: "Cú pháp: /watch <url tìm kiếm Mercari>" };
    let condition;
    try {
      condition = parseMercariSearchUrl(url);
    } catch (err) {
      return { reply: `URL không hợp lệ: ${err.message}` };
    }
    let result;
    try {
      result = await searchMercari(condition);
    } catch (err) {
      return { reply: `Mercari API lỗi: ${err.message}` };
    }
    if (!result.items.length) {
      return { reply: "Search hợp lệ nhưng trả về 0 item — không tạo watch." };
    }
    const created = await store.createWatch({
      name: condition.keyword,
      url,
      paramsJson: JSON.stringify(condition),
    });
    if (!created.created) {
      return { reply: `Watch này đã tồn tại (id ${created.id}).` };
    }
    return {
      reply: `✅ Đã thêm watch #${created.id}: ${condition.keyword} (numFound ${result.numFound}). Lần chạy đầu là baseline, sau đó sẽ alert item mới.`,
    };
  }
  if (cmd === "/watches") {
    const watches = await store.listWatches();
    if (!watches.length) return { reply: "Chưa có watch nào. Thêm bằng /watch <url>." };
    const lines = watches.map(
      (w) =>
        `#${w.id} "${w.name}" ${w.enabled ? "ON" : "OFF"} every ${w.intervalSec}s | last run ${w.lastRunAt || "chưa chạy"}${w.lastError ? ` | lỗi: ${w.lastError}` : ""}`,
    );
    return { reply: lines.join("\n") };
  }
  if (cmd === "/unwatch") {
    const id = Number(parts[1]);
    if (!Number.isInteger(id)) return { reply: "Cú pháp: /unwatch <id>" };
    const ok = await store.disableWatch(id);
    return { reply: ok ? `Đã tắt watch #${id}.` : `Không tìm thấy watch #${id}.` };
  }
  if (cmd === "/status") {
    const watches = await store.listWatches();
    const alertedToday = pollerStatus ? pollerStatus.alertedToday : await store.countSeenToday();
    const lines = [`Đã alert hôm nay: ${alertedToday}`];
    for (const w of watches) {
      const live = pollerStatus ? pollerStatus.watches.find((s) => s.id === w.id) || {} : {};
      const paused = live.pausedUntil ? ` | PAUSED tới ${live.pausedUntil}` : "";
      const empty = live.consecutiveEmpty ? ` | empty x${live.consecutiveEmpty}` : "";
      lines.push(
        `#${w.id} "${w.name}" ${w.enabled ? "ON" : "OFF"} | interval ${w.intervalSec}s | last poll ${w.lastRunAt || "chưa chạy"}${empty}${paused}${w.lastError ? ` | last error: ${w.lastError}` : ""}`,
      );
    }
    return { reply: lines.join("\n") };
  }
  return { reply: "Lệnh hỗ trợ: /watch <url>, /watches, /unwatch <id>, /status" };
}
