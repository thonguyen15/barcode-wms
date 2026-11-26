import { getDb } from "./db.mjs";

const TOKYO_TIME_ZONE = "Asia/Tokyo";
const CATEGORY_CACHE_TTL_MS = 5_000;
const TOKEN_BYTES = 24;

let categoryCache = { rules: [], loadedAt: 0 };
let categoryLoad;

/** Return the category rules, refetched at most once per TTL window. */
export async function loadCategories(env) {
  if (categoryCache.rules.length > 0 && Date.now() - categoryCache.loadedAt < CATEGORY_CACHE_TTL_MS) {
    return categoryCache.rules;
  }
  if (!categoryLoad) {
    categoryLoad = getDb(env)
      .execute("SELECT name, keywords FROM category_rules ORDER BY priority DESC, id ASC")
      .then(({ rows }) => {
        categoryCache = {
          loadedAt: Date.now(),
          rules: rows.map((r) => ({
            name: r.name,
            keywords: String(r.keywords).split(",").map((k) => k.trim().toLowerCase()).filter(Boolean),
          })),
        };
        return categoryCache.rules;
      })
      .catch((err) => {
        console.error("Failed to load categories:", err);
        return categoryCache.rules;
      })
      .finally(() => {
        categoryLoad = undefined;
      });
  }
  return categoryLoad;
}

/** Detect the category of an item name from the loaded rules. */
export function detectCategory(rules, name) {
  const n = (name || "").toLowerCase();
  for (const cat of rules) {
    if (cat.keywords.some((kw) => n.includes(kw))) return cat.name;
  }
  return "else";
}

/** Return the current Tokyo time as an ISO string with +09:00 offset. */
export function nowISO() {
  const jst = new Date().toLocaleString("sv-SE", { timeZone: TOKYO_TIME_ZONE }).replace(" ", "T");
  return `${jst}+09:00`;
}

/** Return the Tokyo date as yyyymmdd. */
export function todayKey(d = new Date()) {
  return d.toLocaleDateString("sv-SE", { timeZone: TOKYO_TIME_ZONE }).replace(/-/g, "");
}

/** Generate a random scan token. */
export function genToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse pasted JSON payload text into item fields. */
export function parsePayload(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("Không parse được JSON. Hãy dán đúng format JSON.");
  }
  const serialRaw = obj.serial ?? "";
  const serialClean = (serialRaw.match(/[A-Z0-9]{6,}/i)?.[0] ?? "").trim().toUpperCase();
  return {
    name: (obj.name ?? "").trim(),
    serial_raw: String(serialRaw).trim(),
    serial_clean: serialClean,
    condition: (obj.condition ?? "").trim(),
    mvd: (obj.mvd ?? "").trim(),
    note: (obj.note ?? "").trim(),
    battery: (obj.battery ?? "").trim(),
    coverage: (obj.coverage ?? "").trim(),
  };
}

/** Build the WHERE clauses and params for the item list filters. */
export function buildItemQuery(query) {
  const { q, status, inventory, tab, posted } = query;
  const where = ["is_deleted = 0"];
  const params = [];
  const like = `%${q}%`;

  if (q) {
    where.push("(package_id LIKE ? OR name LIKE ? OR serial_clean LIKE ? OR tracking_code LIKE ?)");
    params.push(like, like, like, like);
  }
  if (tab === "stock") {
    where.push("status = 'CREATED'");
  } else if (tab === "shipped") {
    where.push("status = 'SHIPPED'");
  } else if (tab === "return") {
    where.push("status IN ('HENBIN', 'RETURNED', 'RETURN', 'REQUEST_RETURN')");
  } else if (tab === "not_logged") {
    where.push("is_meru_logged = 0 AND status NOT IN ('SHIPPED', 'RETURNED', 'HENBIN', 'RETURN', 'REQUEST_RETURN')");
  } else if (tab === "not_posted") {
    where.push("is_posted = 0 AND status NOT IN ('SHIPPED', 'RETURNED', 'HENBIN', 'RETURN', 'REQUEST_RETURN')");
  } else if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (inventory) {
    where.push("inventory_status = ?");
    params.push(inventory);
  }
  if (posted === "1") {
    where.push("is_posted = 1");
  } else if (posted === "0") {
    where.push("is_posted = 0");
  }
  return { where, params };
}

/** Compute the next sequential package id for today. */
export async function nextPackageId(env) {
  const key = todayKey();
  const { rows } = await getDb(env).execute({
    sql: "SELECT package_id FROM items WHERE package_id LIKE ? ORDER BY package_id DESC LIMIT 1",
    args: [`${key}%`],
  });
  let nextSeq = 1;
  const m = rows[0]?.package_id?.match(/(\d{2})$/);
  if (m) nextSeq = Number.parseInt(m[1], 10) + 1;
  if (nextSeq > 99) throw new Error("Hết số thứ tự trong ngày (01-99).");
  return `${key}${String(nextSeq).padStart(2, "0")}`;
}
