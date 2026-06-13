const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../db");

async function checkQuery() {
  const tg_msg_id = "572";
  const tg_chat_id = "-1003934391428";
  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM items WHERE tg_msg_id = ? AND tg_chat_id = ? AND is_deleted = 0 LIMIT 1",
      args: [tg_msg_id, tg_chat_id]
    });
    console.log("Result of tg_msg_id + tg_chat_id query:", rows);
  } catch (err) {
    console.error("DB error:", err);
  }
}

checkQuery();
