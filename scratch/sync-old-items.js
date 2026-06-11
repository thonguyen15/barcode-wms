const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../db");

// Simple helper to sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resyncOldItems() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("❌ TELEGRAM_BOT_TOKEN is not set in environment.");
    process.exit(1);
  }

  if (!process.env.APP_URL) {
    console.warn("⚠️ Warning: APP_URL is not set in environment. The 'Sửa' button will be omitted since Telegram Web Apps require a valid HTTPS URL.");
  }

  console.log("🔄 Fetching items with Telegram references from database...");
  try {
    const { rows: items } = await db.execute({
      sql: `
        SELECT id, package_id, token, name, serial_clean, condition, status, is_posted, is_meru_logged, tg_chat_id, tg_msg_id, created_at, mvd, battery, coverage, note
        FROM items
        WHERE tg_chat_id IS NOT NULL 
          AND tg_msg_id IS NOT NULL 
          AND is_deleted = 0
      `,
      args: []
    });

    console.log(`📋 Found ${items.length} items to update on Telegram.`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`[${i + 1}/${items.length}] Syncing item ID: ${item.id} (Package: ${item.package_id}, Name: ${item.name})...`);

      const captionData = {
        mvd: item.mvd || "",
        name: item.name || "",
        serial: item.serial_clean || "",
        condition: item.condition || "",
        battery: item.battery || "",
        coverage: item.coverage || "",
        note: item.note || ""
      };
      let caption = `<code>${JSON.stringify(captionData)}</code>`;

      if (process.env.APP_URL) {
        caption += `\n\n🔗 <a href="${process.env.APP_URL}/item.html?id=${item.id}">Xem chi tiết trên Web</a>`;
      }

      const firstRow = [
        { text: `${{ SHIPPED: '🟢', RETURN: '⚫', RETURNED: '⚫', CREATED: '🟡', REQUEST_RETURN: '🟠' }[item.status] || '⬜'} ${item.status}`, callback_data: "none" }
      ];
      if (process.env.APP_URL) {
        firstRow.push({ text: "Sửa", url: `${process.env.APP_URL}/telegram-edit.html?token=${item.token}` });
      }
      firstRow.push({ text: "↩️", callback_data: `request_return_tg:${item.id}` });

      const replyMarkup = {
        inline_keyboard: [
          firstRow,
          [
            item.is_posted
              ? { text: "🟢 Posted", callback_data: `posted:${item.id}` }
              : { text: "🔴 Post", callback_data: `posted:${item.id}` },
            { text: "🗑️", callback_data: `request_delete_tg:${item.id}` },
            item.is_meru_logged
              ? { text: "🟢 Logged", callback_data: `meru:${item.id}` }
              : { text: "🔴 Log", callback_data: `meru:${item.id}` }
          ]
        ]
      };

      const url = `https://api.telegram.org/bot${token}/editMessageCaption`;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: item.tg_chat_id,
            message_id: Number(item.tg_msg_id),
            caption: caption,
            parse_mode: "HTML",
            reply_markup: replyMarkup
          })
        });

        const resData = await response.json();
        if (resData.ok) {
          console.log(`✅ Success for item ID: ${item.id}`);
        } else if (resData.error_code === 429 || (resData.parameters && resData.parameters.retry_after)) {
          const waitSecs = (resData.parameters && resData.parameters.retry_after) || 10;
          console.log(`⚠️ Rate limited for item ID: ${item.id}. Waiting for ${waitSecs} seconds before retrying...`);
          await sleep(waitSecs * 1000 + 1000);
          i--; // Retry the same item
          continue;
        } else if (resData.description && resData.description.includes("message is not modified")) {
          console.log(`ℹ️ Already up-to-date for item ID: ${item.id}`);
        } else {
          console.error(`❌ Telegram edit failed for item ID: ${item.id}. Error: ${resData.description}`);
        }
      } catch (err) {
        console.error(`❌ Request error for item ID: ${item.id}:`, err.message);
      }

      // Avoid hitting Telegram rate limits (approx 1-2 seconds between edits is safe)
      await sleep(1500);
    }

    console.log("🎉 All items have been processed!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Database or execution error:", err);
    process.exit(1);
  }
}

resyncOldItems();
