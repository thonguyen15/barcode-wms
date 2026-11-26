import { getDb } from "./db.mjs";

const TOKYO_OFFSET_MS = 9 * 3600000;
const PAD2 = (n) => String(n).padStart(2, "0");

/** Return the current instant formatted as an ISO string with Tokyo offset. */
export function nowISO() {
  const d = new Date(Date.now() + TOKYO_OFFSET_MS);
  return d.toISOString().slice(0, 19) + "+09:00";
}

/** Return today's date in Tokyo as yyyymmdd. */
export function tokyoDateKey(d = new Date()) {
  return new Date(d.getTime() + TOKYO_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

/** Format an epoch ms in Tokyo HH:mm. */
export function formatTokyoHHMM(ms) {
  return new Date(ms + TOKYO_OFFSET_MS).toISOString().slice(11, 16);
}

/** Generate a 48-character hex item token. */
export function genToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Return the next package_id for today in Tokyo time (01-99 per day). */
export async function nextPackageId(env) {
  const key = tokyoDateKey();
  const { rows } = await getDb(env).execute({
    sql: "SELECT package_id FROM items WHERE package_id LIKE ? ORDER BY package_id DESC LIMIT 1",
    args: [`${key}%`],
  });
  let nextSeq = 1;
  const row = rows[0];
  if (row?.package_id) {
    const m = row.package_id.match(/(\d{2})$/);
    if (m) nextSeq = parseInt(m[1], 10) + 1;
  }
  if (nextSeq > 99) throw new Error("Hết số thứ tự trong ngày (01-99).");
  return `${key}${PAD2(nextSeq)}`;
}

/** Resolve the category of an item name against category_rules (1 subrequest). */
export async function detectCategory(env, name) {
  const n = (name || "").toLowerCase();
  try {
    const { rows } = await getDb(env).execute("SELECT name, keywords FROM category_rules ORDER BY priority DESC, id ASC");
    for (const r of rows) {
      const keywords = r.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
      if (keywords.some((kw) => n.includes(kw))) return r.name;
    }
  } catch (err) {
    console.error("Failed to load categories:", err);
  }
  return "else";
}

/** Describe a Telegram user as the audit actor name. */
export function getTgActorName(from) {
  if (!from) return "Unknown (TG)";
  const firstName = from.first_name || "User";
  const username = from.username ? ` (@${from.username})` : "";
  return `${firstName}${username} (Telegram)`;
}
