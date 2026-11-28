export const SETTINGS_KEYS = [
  "telegram_bot_token",
  "alert_chat_id",
  "admin_user_ids",
  "country_code",
  "budget_per_minute",
  "fresh_window_min",
];

const DEFAULTS = {
  country_code: "VN",
  budget_per_minute: "36",
  fresh_window_min: "15",
};

const ENV_SOURCES = {
  telegram_bot_token: ["MERCARI_BOT_TOKEN"],
  alert_chat_id: ["MERCARI_ALERT_CHAT_ID"],
  admin_user_ids: ["MERCARI_ADMIN_USER_IDS", "AUTHORIZED_TELEGRAM_USER_IDS"],
  country_code: ["MERCARI_COUNTRY_CODE"],
  budget_per_minute: [],
  fresh_window_min: [],
};

export function createSettings({ store, env = process.env, log = () => {}, refreshMs = 10000 }) {
  let cache = {};
  const changeHandlers = new Map();

  function envValueFor(key) {
    for (const name of ENV_SOURCES[key] || []) {
      const v = env[name];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  }

  async function seedMissing(all) {
    for (const key of SETTINGS_KEYS) {
      if (key in all) continue;
      const value = envValueFor(key) ?? DEFAULTS[key] ?? null;
      if (value === null) continue;
      await store.setSetting(key, value, "env-seed");
      log({ level: "info", msg: "setting_seeded", key, from: value === DEFAULTS[key] ? "default" : "env" });
    }
  }

  async function load() {
    await seedMissing(await store.getAllSettings());
    cache = await store.getAllSettings();
  }

  function get(key) {
    if (key in cache && cache[key] !== undefined && cache[key] !== null) return cache[key];
    const fromEnv = envValueFor(key);
    if (fromEnv !== null) return fromEnv;
    return DEFAULTS[key] ?? null;
  }

  function getAll() {
    const out = { ...DEFAULTS };
    for (const key of SETTINGS_KEYS) out[key] = get(key);
    return out;
  }

  function onChange(key, fn) {
    if (!changeHandlers.has(key)) changeHandlers.set(key, []);
    changeHandlers.get(key).push(fn);
  }

  async function refresh() {
    const all = await store.getAllSettings();
    for (const key of SETTINGS_KEYS) {
      const next = key in all ? all[key] : null;
      const prev = key in cache && cache[key] !== null ? cache[key] : null;
      if (next !== prev) {
        cache[key] = next;
        for (const fn of changeHandlers.get(key) || []) {
          try {
            await fn(next, prev);
          } catch (err) {
            log({ level: "error", msg: "settings_change_handler_failed", key, err: err.message });
          }
        }
      }
    }
  }

  function start() {
    const timer = setInterval(() => {
      refresh().catch((err) => log({ level: "error", msg: "settings_refresh_failed", err: err.message }));
    }, refreshMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  return { load, get, getAll, onChange, refresh, start };
}
