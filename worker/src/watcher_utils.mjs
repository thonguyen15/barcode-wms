const SORT_MAP = { created_time: "SORT_CREATED_TIME" };
const ORDER_MAP = { asc: "ORDER_ASC", desc: "ORDER_DESC" };
const ITEM_TYPE_MAP = { mercari: "ITEM_TYPE_MERCARI", beyond: "ITEM_TYPE_BEYOND" };

/** Parse a Mercari search URL into the search condition the watcher service stores. */
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

/** Build the Mercari item page URL from an item id like m12345678901. */
export function mercariItemUrl(itemId) {
  return `https://jp.mercari.com/item/${itemId}`;
}

/** Mask a secret so only its last four characters stay visible. */
export function maskSecret(value) {
  if (!value) return "";
  const tail = value.slice(-4);
  return `••••${tail}`;
}
