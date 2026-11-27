/** Ship fee heuristics by product name keywords, JPY. */
export function detectShipFee(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("watch")) return 210;
  if (n.includes("ipad")) return 780;
  if (n.includes("pencil")) return 210;
  if (n.includes("keyboard") || n.includes("magic keyboard")) return 780;
  if (n.includes("macbook") || n.includes("mac mini") || n.includes("mac studio") || n.includes("imac")) return 1200;
  return 1200;
}

function tokyoSvSeDate(d) {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

/** Normalize any date-ish input to a YYYY-MM-DD Tokyo-local calendar day. */
export function parseAndNormalizeDate(input) {
  const fallback = tokyoSvSeDate(new Date());
  if (!input) return fallback;

  const cleaned = String(input).trim().replace(/\bat\b/gi, " ");
  let parsed = new Date(cleaned);

  if (isNaN(parsed.getTime())) {
    const m = cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) parsed = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  if (isNaN(parsed.getTime())) {
    const m = cleaned.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (m) parsed = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  }
  if (isNaN(parsed.getTime())) return fallback;

  return tokyoSvSeDate(parsed);
}

/** Extract product codes like m52146527465 / z123456789 from a code or URL. */
export function extractProductCode(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const match = s.match(/(?:^|[^a-z0-9])([mz]\d{5,})(?=$|[^a-z0-9])/i);
  return match ? match[1].toLowerCase() : null;
}

function decodeBasicHtmlEntities(str) {
  return String(str ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function cleanProductTitle(raw) {
  let title = decodeBasicHtmlEntities(raw);
  title = title
    .replace(/\s+(?:by|[-|｜])\s*メルカリ\s*$/i, "")
    .replace(/\s*(?:[-|｜])\s*(?:Yahoo!フリマ(?:（旧PayPayフリマ）)?|PayPayフリマ)\s*$/i, "")
    .trim();
  if (/^(?:メルカリ|Yahoo!フリマ(?:（旧PayPayフリマ）)?|PayPayフリマ)$/i.test(title)) {
    return null;
  }
  return title || null;
}

function parseJsonStringLiteral(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/** Best-effort scrape of product title and price from a marketplace listing URL. */
export async function fetchProductMetaFromLink(rawUrl) {
  const result = { title: null, price: null };
  let parsedUrl;
  try {
    parsedUrl = new URL(String(rawUrl || "").trim());
  } catch {
    return result;
  }
  if (!/^https?:$/i.test(parsedUrl.protocol)) return result;

  const host = parsedUrl.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return result;
  }

  try {
    const resp = await fetch(parsedUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept-Language": "ja,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return result;

    const html = await resp.text();

    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nd = JSON.parse(nextDataMatch[1]);
        const byId = nd?.props?.initialState?.itemsState?.items?.byId;
        const itemObj =
          (byId && typeof byId === "object" ? Object.values(byId)[0] : null) ||
          nd?.props?.pageProps?.item ||
          null;
        if (itemObj) {
          if (itemObj.title) result.title = cleanProductTitle(itemObj.title);
          if (itemObj.price !== undefined && itemObj.price !== null) {
            const p = parseFloat(itemObj.price);
            if (Number.isFinite(p) && p >= 0) result.price = p;
          }
        }
      } catch {}
    }

    if (!result.title) {
      const nextOgTitle = html.match(/"og:title"[^}]{0,200}?"content":"((?:\\.|[^"\\])+)"/);
      const nextTitle = html.match(/"title","0",\{"children":"((?:\\.|[^"\\])+)"\}/);
      const metaOgTitle =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      const htmlTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);

      const rawTitle =
        (nextOgTitle && parseJsonStringLiteral(nextOgTitle[1])) ||
        (nextTitle && parseJsonStringLiteral(nextTitle[1])) ||
        (metaOgTitle && metaOgTitle[1]) ||
        (htmlTitle && htmlTitle[1]) ||
        null;

      if (rawTitle) {
        result.title = cleanProductTitle(rawTitle);
      }
    }

    if (result.price === null) {
      const nextPrice = html.match(/"product:price:amount"[^}]{0,200}?"content":"(\d+(?:\.\d+)?)"/);
      const metaPrice =
        html.match(/<meta[^>]+(?:name|property)=["']product:price:amount["'][^>]+content=["'](\d+(?:\.\d+)?)["']/i) ||
        html.match(/<meta[^>]+content=["'](\d+(?:\.\d+)?)["'][^>]+(?:name|property)=["']product:price:amount["']/i);
      const jsonPrice = html.match(/"price"\s*:\s*"?(\d{2,9})"?/);

      const rawPrice = (nextPrice && nextPrice[1]) || (metaPrice && metaPrice[1]) || (jsonPrice && jsonPrice[1]) || null;
      if (rawPrice !== null) {
        const num = parseFloat(rawPrice);
        if (Number.isFinite(num) && num >= 0) result.price = num;
      }
    }
  } catch (e) {
    console.warn("fetchProductMetaFromLink failed:", e.message);
  }

  return result;
}
