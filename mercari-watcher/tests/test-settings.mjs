import { test } from "node:test";
import assert from "node:assert/strict";
import { createSettings } from "../src/settings.mjs";

function fakeStore(initial = {}) {
  const rows = { ...initial };
  return {
    async getAllSettings() {
      return { ...rows };
    },
    async setSetting(key, value) {
      rows[key] = value;
    },
    rows,
  };
}

test("seeds missing keys from env and defaults, never overwrites existing rows", async () => {
  const store = fakeStore({ alert_chat_id: "123", telegram_bot_token: "db-token" });
  const settings = createSettings({
    store,
    env: { MERCARI_BOT_TOKEN: "env-token", MERCARI_ALERT_CHAT_ID: "ignored", MERCARI_COUNTRY_CODE: "JP" },
  });
  await settings.load();
  assert.equal(store.rows.telegram_bot_token, "db-token");
  assert.equal(store.rows.alert_chat_id, "123");
  assert.equal(store.rows.country_code, "JP");
  assert.equal(store.rows.admin_user_ids, undefined);
  assert.equal(store.rows.budget_per_minute, "36");
  assert.equal(store.rows.fresh_window_min, "15");
});

test("get falls back to env then default when key absent", async () => {
  const settings = createSettings({ store: fakeStore({}), env: { MERCARI_BOT_TOKEN: "tok" } });
  await settings.load();
  assert.equal(settings.get("telegram_bot_token"), "tok");
  assert.equal(settings.get("country_code"), "VN");
  assert.equal(settings.get("budget_per_minute"), "36");
});

test("hot reload applies chat id, admin ids, budget and token changes", async () => {
  const store = fakeStore({});
  const settings = createSettings({ store, env: {}, refreshMs: 10 });
  await settings.load();
  const changes = [];
  settings.onChange("alert_chat_id", (next) => changes.push(["alert_chat_id", next]));
  settings.onChange("admin_user_ids", (next) => changes.push(["admin_user_ids", next]));
  settings.onChange("budget_per_minute", (next) => changes.push(["budget_per_minute", next]));
  settings.onChange("telegram_bot_token", (next) => changes.push(["telegram_bot_token", next]));
  await store.setSetting("alert_chat_id", "-100999");
  await store.setSetting("admin_user_ids", "11,22");
  await store.setSetting("budget_per_minute", "5");
  await store.setSetting("telegram_bot_token", "new-token");
  await settings.refresh();
  assert.deepEqual(changes, [
    ["telegram_bot_token", "new-token"],
    ["alert_chat_id", "-100999"],
    ["admin_user_ids", "11,22"],
    ["budget_per_minute", "5"],
  ]);
  assert.equal(settings.get("budget_per_minute"), "5");
});

test("unchanged keys do not fire handlers", async () => {
  const store = fakeStore({ alert_chat_id: "1" });
  const settings = createSettings({ store, env: {} });
  await settings.load();
  let fired = 0;
  settings.onChange("alert_chat_id", () => {
    fired += 1;
  });
  await settings.refresh();
  await settings.refresh();
  assert.equal(fired, 0);
});
