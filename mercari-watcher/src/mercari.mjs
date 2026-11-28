import { webcrypto as crypto } from "node:crypto";

const SEARCH_URL = "https://api.mercari.jp/v2/entities:search";
const SERVICE_FROM = "suruga";
const SESSION_TTL_MS = 30 * 60 * 1000;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

const SORT_MAP = { created_time: "SORT_CREATED_TIME" };
const ORDER_MAP = { asc: "ORDER_ASC", desc: "ORDER_DESC" };
const ITEM_TYPE_MAP = { mercari: "ITEM_TYPE_MERCARI", beyond: "ITEM_TYPE_BEYOND" };

const keyPairPromise = crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const { alg: _alg, ext: _ext, key_ops: _keyOps, ...dpopJwk } = await crypto.subtle.exportKey(
  "jwk",
  (await keyPairPromise).publicKey,
);

const deviceUuid = crypto.randomUUID();
const cookieJar = new Map();

let searchSessionId = crypto.randomUUID();
let sessionStartedAt = Date.now();

const dpopJwkJson = JSON.stringify(dpopJwk);

async function buildDpopProof(htu, htm, nowMs) {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: dpopJwk })));
  const payload = b64u(
    Buffer.from(
      JSON.stringify({
        iat: Math.floor(nowMs / 1000),
        jti: crypto.randomUUID(),
        htu,
        htm,
        uuid: deviceUuid,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    (await keyPairPromise).privateKey,
    Buffer.from(signingInput),
  );
  return `${signingInput}.${b64u(signature)}`;
}

function captureCookies(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const [kv] = sc.split(";");
    const eq = kv.indexOf("=");
    if (eq > 0) cookieJar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
}

export function rotateSessionIfNeeded(nowMs = Date.now()) {
  if (nowMs - sessionStartedAt > SESSION_TTL_MS) {
    searchSessionId = crypto.randomUUID();
    sessionStartedAt = nowMs;
  }
}

export function parseMercariSearchUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const p = parsed.searchParams;
  const condition = {
    keyword: p.get("keyword") || "",
    excludeKeyword: "",
    sort: SORT_MAP[p.get("sort")] || "SORT_CREATED_TIME",
    order: ORDER_MAP[p.get("order")] || "ORDER_DESC",
    status: [],
    sizeId: [],
    categoryId: [],
    brandId: [],
    sellerId: [],
    priceMin: p.has("price_min") ? Number(p.get("price_min")) : 0,
    priceMax: p.has("price_max") ? Number(p.get("price_max")) : 0,
    itemConditionId: (p.get("item_condition_id") || "")
      .split(",")
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    shippingPayerId: [],
    shippingFromArea: [],
    shippingMethod: [],
    colorId: [],
    hasCoupon: false,
    attributes: [],
    itemTypes: (p.get("item_types") || "")
      .split(",")
      .filter((t) => ITEM_TYPE_MAP[t])
      .map((t) => ITEM_TYPE_MAP[t]),
    skuIds: [],
    shopIds: [],
    excludeShippingMethodIds: [],
  };
  if (!condition.keyword) {
    throw new Error("URL search Mercari phải có ?keyword=...");
  }
  return condition;
}

export function buildSearchBody(condition, { pageSize = 60 } = {}) {
  return JSON.stringify({
    userId: "",
    config: { responseToggles: ["QUERY_SUGGESTION_WEB_1"] },
    pageSize,
    pageToken: "",
    searchSessionId,
    source: "BaseSerp",
    indexRouting: "INDEX_ROUTING_UNSPECIFIED",
    thumbnailTypes: [],
    searchCondition: {
      keyword: condition.keyword,
      excludeKeyword: condition.excludeKeyword,
      sort: condition.sort,
      order: condition.order,
      status: condition.status,
      sizeId: condition.sizeId,
      categoryId: condition.categoryId,
      brandId: condition.brandId,
      sellerId: condition.sellerId,
      priceMin: condition.priceMin,
      priceMax: condition.priceMax,
      itemConditionId: condition.itemConditionId,
      shippingPayerId: condition.shippingPayerId,
      shippingFromArea: condition.shippingFromArea,
      shippingMethod: condition.shippingMethod,
      colorId: condition.colorId,
      hasCoupon: condition.hasCoupon,
      attributes: condition.attributes,
      itemTypes: condition.itemTypes,
      skuIds: condition.skuIds,
      shopIds: condition.shopIds,
      excludeShippingMethodIds: condition.excludeShippingMethodIds,
    },
    serviceFrom: SERVICE_FROM,
    withItemBrand: true,
    withItemSize: false,
    withItemPromotions: true,
    withItemSizes: true,
    withShopname: false,
    useDynamicAttribute: true,
    withSuggestedItems: true,
    withOfferPricePromotion: true,
    withProductSuggest: true,
    withParentProducts: false,
    withProductArticles: true,
    withSearchConditionId: false,
    withAuction: true,
    laplaceDeviceUuid: deviceUuid,
  });
}

export async function searchMercari(condition, { pageSize = 60, fetchImpl = fetch, countryCode } = {}) {
  rotateSessionIfNeeded();
  const nowMs = Date.now();
  const dpop = await buildDpopProof(SEARCH_URL, "POST", nowMs);
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    "X-Platform": "web",
    "X-Country-Code": countryCode || process.env.MERCARI_COUNTRY_CODE || "VN",
    DPoP: dpop,
    origin: "https://jp.mercari.com",
    referer: "https://jp.mercari.com/",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36",
    "accept-language": "ja",
    ...(cookieJar.size ? { cookie: [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
  };
  const res = await fetchImpl(SEARCH_URL, {
    method: "POST",
    headers,
    body: buildSearchBody(condition, { pageSize }),
    signal: AbortSignal.timeout(10000),
  });
  captureCookies(res);
  const status = res.status;
  const text = await res.text();
  if (status !== 200) {
    const err = new Error(`Mercari HTTP ${status}: ${text.slice(0, 200)}`);
    err.status = status;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const err = new Error("Mercari trả về JSON không hợp lệ");
    err.status = 200;
    throw err;
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return { items, numFound: Number(parsed.meta?.numFound ?? items.length) };
}
