// server.js
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const bcrypt = require("bcryptjs");
const express = require("express");
const cookieParser = require("cookie-parser");
const QRCode = require("qrcode");
const crypto = require("crypto");
const FormData = require("form-data");
const { createCanvas, loadImage, registerFont } = require("canvas");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const db = require("./db");

// Đăng ký Font tiếng Nhật và Latin để vẽ Tem nhãn chính xác
try {
  const fontDir = path.join(__dirname, 'fonts');

  // Font tiếng Nhật (Noto Sans JP)
  const notoPath = path.join(fontDir, 'NotoSansJP-Bold.ttf');
  if (fs.existsSync(notoPath)) {
    registerFont(notoPath, { family: 'Noto Sans JP' });
    console.log("✅ Registered: Noto Sans JP");
  }

  // Font Latin (Gill Sans MT Bold)
  const gillPath = path.join(fontDir, 'GillSansMT_Bold.ttf');
  if (fs.existsSync(gillPath)) {
    registerFont(gillPath, { family: 'Gill Sans MT' });
    console.log("✅ Registered: Gill Sans MT");
  }

  // Font Nhật cao cấp (Hiragino Sans GB)
  const hiraPath = path.join(fontDir, 'Hiragino_Sans_GB_W3.ttf');
  if (fs.existsSync(hiraPath)) {
    registerFont(hiraPath, { family: 'Hiragino Sans' });
    console.log("✅ Registered: Hiragino Sans");
  }
} catch (e) {
  console.error("❌ Failed to register fonts:", e);
}

const app = express();

// App chạy sau reverse proxy (Render / Synology / Cloudflare) nên cần trust proxy
// để express-rate-limit lấy đúng client IP từ X-Forwarded-For (nếu không sẽ throw
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR). 1 = tin 1 hop proxy gần nhất.
app.set('trust proxy', 1);

// ====== Security Middleware ======
app.use(helmet({
  contentSecurityPolicy: false, // Disabled CSP to avoid breaking inline scripts/styles
}));
app.disable('x-powered-by');

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 phút
  max: 500, // 500 requests per minute
  message: { error: "Quá nhiều yêu cầu, vui lòng thử lại sau." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 5, // Tối đa 5 lần
  message: { error: "Bạn đã thử sai quá nhiều lần. Vui lòng quay lại sau 15 phút." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ====== body + cookies ======
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ====== Simple auth (đủ dùng nội bộ) ======
const USERS = {
  [process.env.ADMIN_USER]: { passwordHash: process.env.ADMIN_PASS, role: "admin" },
  [process.env.STAFF_USER]: { passwordHash: process.env.STAFF_PASS, role: "staff" }
};
if (process.env.BONG_USER && process.env.BONG_PASS_HASH) {
  USERS[process.env.BONG_USER] = { passwordHash: process.env.BONG_PASS_HASH, role: "entry" };
}

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

// Group nhận yêu cầu xóa
const DELETE_GROUP_CHAT_ID = process.env.DELETE_GROUP_CHAT_ID;
const RETURN_GROUP_CHAT_ID = process.env.RETURN_GROUP_CHAT_ID;
const TASK_GROUP_CHAT_ID = process.env.TASK_GROUP_CHAT_ID || RETURN_GROUP_CHAT_ID;
const NOTIFICATION_GROUP_CHAT_ID = process.env.NOTIFICATION_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

function sign(val) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(val).digest("hex");
}
function makeSessionCookie(username) {
  const payload = JSON.stringify({ u: username, iat: Date.now() });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = sign(b64);
  return `${b64}.${sig}`;
}
function readSessionCookie(cookieVal) {
  if (!cookieVal) return null;
  const [b64, sig] = cookieVal.split(".");
  if (!b64 || !sig) return null;
  if (sign(b64) !== sig) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (process.env.BYPASS_AUTH === "true") {
    req.user = process.env.ADMIN_USER || "tho";
    req.role = "admin";
    return next();
  }
  const sess = readSessionCookie(req.cookies?.wms_auth);
  const u = sess?.u;
  if (!u || !USERS[u]) return res.status(401).json({ error: "Not logged in" });
  req.user = u;
  req.role = USERS[u].role || "staff";
  next();
}
function requireAdmin(req, res, next) {
  if (req.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}
function requireSuperAdmin(req, res, next) {
  if (req.role !== "admin" || req.user !== (process.env.SUPER_ADMIN_USER || process.env.ADMIN_USER)) return res.status(403).json({ error: "Tho Admin only" });
  next();
}
function requireStaff(req, res, next) {
  if (req.role !== "admin" && req.role !== "staff") return res.status(403).json({ error: "Staff/Admin only" });
  next();
}

// ====== Export folder ======
const EXPORT_DIR = path.join(__dirname, "public", "exports");
fs.mkdirSync(EXPORT_DIR, { recursive: true });

// ====== Guard HTML pages: chưa login -> đá về /login.html ======
app.use((req, res, next) => {
  const p = req.path;

  // cho phép login + assets cơ bản + api login/logout
  const allow =
    p === "/" ||
    p === "/login.html" ||
    p === "/styles.css" ||
    p.startsWith("/styles.") ||
    p.startsWith("/favicon") ||
    p.startsWith("/assets/") ||
    p.startsWith("/api/login") ||
    p.startsWith("/api/logout");

  if (allow) return next();

  // nếu request file html mà chưa login -> redirect login
  if (p.endsWith(".html")) {
    if (process.env.BYPASS_AUTH === "true") {
      return next();
    }
    const sess = readSessionCookie(req.cookies?.wms_auth);
    const u = sess?.u;
    if (!u || !USERS[u]) return res.redirect("/login.html");
    if (p === "/reconcile.html" && USERS[u].role !== "admin") {
      return res.redirect("/list.html");
    }
  }

  next();
});

// ====== Guard exports: chưa login -> không tải được CSV ======
app.use("/exports", (req, res, next) => {
  const sess = readSessionCookie(req.cookies?.wms_auth);
  const u = sess?.u;
  if (!u || !USERS[u]) return res.status(401).send("Not logged in");
  next();
});

app.get("/exports/:filename", (req, res) => {
  const filePath = path.join(EXPORT_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("File not found");
  }
});

// ====== Static files (sau guard) ======
app.use(express.static(path.join(__dirname, "public")));

// ====== Root ======
app.get("/api/ping", (req, res) => res.send("pong"));
app.get("/", (req, res) => res.redirect("/login.html"));

// ====== Login/Logout ======
app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  const user = USERS[username];
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(String(password || ""), user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.cookie("wms_auth", makeSessionCookie(username), {
    httpOnly: true,
    sameSite: "strict",
  });

  // Gửi thông báo đăng nhập qua Telegram (không block response)
  notifyLogin(req, username, user.role).catch(e => console.error("Login notify failed:", e));

  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("wms_auth");
  res.json({ ok: true });
});

// ====== Helpers ======
function csvCell(v) {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escTg(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let cachedCategories = [];
async function loadCategories() {
  try {
    const { rows } = await db.execute("SELECT * FROM category_rules ORDER BY priority DESC, id ASC");
    cachedCategories = rows.map(r => ({
      name: r.name,
      keywords: r.keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean)
    }));
  } catch (e) {
    console.error("Failed to load categories:", e);
  }
}
// Load ngay khi khởi động
loadCategories();

function detectCategory(name) {
  const n = (name || "").toLowerCase();
  for (const cat of cachedCategories) {
    if (cat.keywords.some(kw => n.includes(kw))) {
      return cat.name;
    }
  }
  return "else";
}

function detectShipFee(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("watch")) return 210;
  if (n.includes("ipad")) return 780;
  if (n.includes("pencil")) return 210;
  if (n.includes("keyboard") || n.includes("magic keyboard")) return 780;
  if (n.includes("macbook") || n.includes("mac mini") || n.includes("mac studio") || n.includes("imac")) return 1200;
  return 1200; // else
}

function nowISO() {
  const d = new Date();
  const jst = d.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T");
  return jst + "+09:00";
}
function genToken() {
  return crypto.randomBytes(24).toString("hex");
}
function yyyymmddLocal(d = new Date()) {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(/-/g, "");
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function todayKey() {
  return yyyymmddLocal();
}
function fmtTimeLocal(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleString("vi-VN", { timeZone: "Asia/Tokyo" });
  } catch (e) { return iso; }
}

function parseAndNormalizeDate(input) {
  if (!input) return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

  let cleaned = String(input).trim();
  // Replace "at" (common in macOS/iOS locales e.g. "15 Jul 2026 at 09:59")
  cleaned = cleaned.replace(/\bat\b/gi, " ");

  let parsed = new Date(cleaned);

  // If invalid, try to extract YYYY-MM-DD from the string
  if (isNaN(parsed.getTime())) {
    const match = cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) {
      parsed = new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10));
    }
  }

  // If still invalid, try DD-MM-YYYY or DD/MM/YYYY
  if (isNaN(parsed.getTime())) {
    const match = cleaned.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (match) {
      parsed = new Date(parseInt(match[3], 10), parseInt(match[2], 10) - 1, parseInt(match[1], 10));
    }
  }

  // Fallback to today if parsing completely failed
  if (isNaN(parsed.getTime())) {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  }

  return parsed.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
function getTgActorName(from) {
  if (!from) return "Unknown (TG)";
  const firstName = from.first_name || "User";
  const username = from.username ? ` (@${from.username})` : "";
  return `${firstName}${username} (Telegram)`;
}

// ====== Telegram Alerts ======
// Telegram fetch với timeout + retry AN TOÀN.
// Lưu ý: các API send* (sendPhoto/sendMessage/sendDocument) KHÔNG idempotent —
// gửi 2 lần = 2 tin nhắn trùng trong group.
// Trước đây retry mù mọi lỗi network (kể cả timeout) → có lúc Telegram đã nhận
// và đăng ảnh thành công nhưng response bị mất, ta gửi lại → group nhận 2 tin
// trùng trong khi DB chỉ có 1 item.
// Giờ CHỈ retry khi chắc chắn Telegram chưa gửi:
//  - Lỗi kết nối trước khi request rời khỏi máy (DNS, connection refused)
//  - Telegram trả HTTP 429/5xx (từ chối xử lý)
// Timeout / đứt kết nối giữa chừng → request CÓ THỂ đã thành công → không retry.
async function tgFetch(url, options = {}) {
  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 30000;
  const SAFE_RETRY_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      // 429/5xx: Telegram xác nhận chưa xử lý → retry an toàn
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        console.error(`[TELEGRAM] HTTP ${res.status} (lần ${attempt}/${MAX_ATTEMPTS}), retry...`);
        await new Promise(r => setTimeout(r, 600 * attempt)); // backoff 0.6s, 1.2s
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      const code = e.cause?.code || e.name;
      const safeToRetry = SAFE_RETRY_CODES.has(code);
      console.error(`[TELEGRAM] fetch fail (lần ${attempt}/${MAX_ATTEMPTS}): ${code} - ${e.message}` +
        (safeToRetry ? "" : " | Request có thể đã gửi thành công -> không retry để tránh tin trùng"));
      if (!safeToRetry) throw e;
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 600 * attempt));
      }
    }
  }
  throw lastErr;
}

async function sendTelegramMessage(text, targetChatId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = targetChatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await tgFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Telegram send failed:", e);
  }
}

async function sendTelegramDocument(filePath, caption = "", targetChatId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = targetChatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !fs.existsSync(filePath)) return;

  try {
    const url = `https://api.telegram.org/bot${token}/sendDocument`;

    // Sử dụng Native FormData (Node 18+) để đảm bảo tương thích tốt nhất với native fetch
    const form = new globalThis.FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);

    // Đọc file và đóng gói vào Blob
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new globalThis.Blob([fileBuffer], { type: "text/csv" });
    form.append("document", blob, path.basename(filePath));

    const res = await tgFetch(url, {
      method: "POST",
      body: form
      // Lưu ý: KHÔNG set Content-Type header thủ công khi dùng native FormData,
      // fetch sẽ tự động set boundary cho mình.
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("Telegram document send failed:", res.status, errBody);
      throw new Error(`Telegram rejected (Status ${res.status}): ${errBody}`);
    }
  } catch (e) {
    console.error("sendTelegramDocument Error:", e.message);
    throw e;
  }
}

async function sendTelegramPhoto(imageBuffer, caption = "", replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("[TELEGRAM] Missing token or chatId");
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendPhoto`;
    const form = new globalThis.FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    if (replyMarkup) {
      form.append("reply_markup", JSON.stringify(replyMarkup));
    }

    const blob = new globalThis.Blob([imageBuffer], { type: "image/png" });
    form.append("photo", blob, "qr_code.png");

    const res = await tgFetch(url, {
      method: "POST",
      body: form
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("[TELEGRAM] Photo send failed:", res.status, errBody);
      return null;
    }
    const data = await res.json();
    if (!data.ok) {
      console.error("[TELEGRAM] API returned error:", data);
      return null;
    }
    return data.result; // Tra ve thong tin tin nhan (co message_id)
  } catch (e) {
    console.error("[TELEGRAM] sendTelegramPhoto Error:", e.message);
    return null;
  }
}

// ====== Image Label Generation (Mirror Frontend) ======
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  if (!text) return y;

  let lines = 0;
  let currentLine = "";

  // Chia nhỏ text theo ký tự để hỗ trợ tiếng Nhật và xử lý \n
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Nếu gặp ký tự xuống dòng thực sự (\n)
    if (char === '\n') {
      ctx.fillText(currentLine, x, y);
      y += lineHeight;
      lines++;
      currentLine = "";
      if (maxLines && lines >= maxLines) return y;
      continue;
    }

    const testLine = currentLine + char;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine.length > 0) {
      ctx.fillText(currentLine, x, y);
      y += lineHeight;
      lines++;
      if (maxLines && lines >= maxLines) return y;
      currentLine = char;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    ctx.fillText(currentLine, x, y);
    y += lineHeight;
  }
  return y;
}

async function generateLabelBuffer(item, qrBuffer) {
  const LABEL_W = 548;
  const LABEL_H = 338;
  const canvas = createCanvas(LABEL_W, LABEL_H);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, LABEL_W, LABEL_H);

  const pad = 7;
  const qrSize = 326;
  const qrX = LABEL_W - pad - qrSize;
  const qrY = pad;

  // Draw QR
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // Left side text
  const leftX = pad;
  const textW = qrX - 5 - leftX;

  ctx.fillStyle = "#000";

  // MVD
  ctx.font = "bold 34px 'Gill Sans MT'";
  let y = pad + 40;
  ctx.fillText(String(item.mvd || "-").trim(), leftX, y);

  // Serial
  y += 28;
  ctx.font = "bold 18px 'Gill Sans MT'";
  let sn = (item.serial_clean || item.serial_raw || "-").trim();
  while (ctx.measureText(sn).width > textW && sn.length > 4) { sn = sn.slice(0, -2) + "…"; }
  ctx.fillText(sn, leftX, y);

  // Name
  y += 24; // Khoảng cách từ Serial xuống Name
  ctx.font = "bold 20px 'Gill Sans MT', 'Hiragino Sans'";
  wrapText(ctx, (item.name || "-").trim(), leftX, y, textW, 24, 20); // lineHeight 24px

  // Logo
  try {
    const logoRelPath = "public/images/logo.png";
    const logoFull = path.join(__dirname, logoRelPath);
    if (fs.existsSync(logoFull)) {
      const logoImg = await loadImage(logoFull);
      const scale = Math.min(textW / logoImg.width, 140 / logoImg.height);
      const dw = logoImg.width * scale;
      const dh = logoImg.height * scale;
      ctx.drawImage(logoImg, leftX + (textW - dw) / 2, LABEL_H - pad - dh, dw, dh);
    }
  } catch (e) {
    console.error("Logo draw failed:", e);
  }

  return canvas.toBuffer("image/png");
}

function describeUserAgent(ua) {
  ua = String(ua || "");
  if (!ua) return "Không rõ";
  let os = "Không rõ OS";
  if (/iPhone/i.test(ua)) os = "iPhone";
  else if (/iPad/i.test(ua)) os = "iPad";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/Windows/i.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  let browser = "Không rõ trình duyệt";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  return `${browser} / ${os}`;
}

async function notifyLogin(req, username, role) {
  const ip = req.headers["cf-connecting-ip"] || req.ip || "-";
  const ua = req.headers["user-agent"] || "";
  const msg =
    `🔐 <b>THÔNG BÁO ĐĂNG NHẬP WEB</b>\n\n` +
    `👤 Tài khoản: <b>${escTg(username)}</b> (${escTg(role)})\n` +
    `🕒 Thời gian: ${fmtTimeLocal(new Date().toISOString())}\n` +
    `🌐 IP: <code>${escTg(ip)}</code>\n` +
    `💻 Thiết bị: ${escTg(describeUserAgent(ua))}`;
  await sendTelegramMessage(msg, NOTIFICATION_GROUP_CHAT_ID);
}
async function nextPackageId() {
  const key = todayKey();
  const { rows } = await db.execute({
    sql: `
    SELECT package_id
    FROM items
    WHERE package_id LIKE ?
    ORDER BY package_id DESC
    LIMIT 1
  `,
    args: [`${key}%`]
  });

  const row = rows[0];

  let nextSeq = 1;
  if (row?.package_id) {
    const m = row.package_id.match(/(\d{2})$/);
    if (m) nextSeq = parseInt(m[1], 10) + 1;
  }

  if (nextSeq > 99) throw new Error("Hết số thứ tự trong ngày (01-99).");
  return `${key}${pad2(nextSeq)}`;
}

function parsePayload(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("Không parse được JSON. Hãy dán đúng format JSON.");
  }

  const serial_raw = obj.serial ?? "";
  const serial_clean = (serial_raw.match(/[A-Z0-9]{6,}/i)?.[0] ?? "").trim().toUpperCase();

  return {
    name: (obj.name ?? "").trim(),
    serial_raw: serial_raw.trim(),
    serial_clean,
    condition: (obj.condition ?? "").trim(),
    mvd: (obj.mvd ?? "").trim(),
    note: (obj.note ?? "").trim(),
    battery: (obj.battery ?? "").trim(),
    coverage: (obj.coverage ?? "").trim(),
  };
}

// ====== Create item + label ======
app.post("/api/items", requireAuth, requireStaff, async (req, res) => {
  try {
    const { raw_text } = req.body;
    const fields = parsePayload(raw_text);

    if (!fields.serial_clean) {
      return res.status(400).json({ error: "Thiếu/không nhận diện được serial trong JSON." });
    }

    const { rows: existRows } = await db.execute({
      sql: `
      SELECT id, package_id, name, serial_clean
      FROM items
      WHERE LOWER(serial_clean) = LOWER(?)
        AND is_deleted = 0
      LIMIT 1
    `,
      args: [fields.serial_clean]
    });
    const existed = existRows[0];

    if (existed) {
      return res.status(409).json({
        error: "Đã có item này (serial trùng) và đang tồn tại.",
        existed,
      });
    }

    const package_id = await nextPackageId();
    const token = genToken();

    const t = nowISO();
    try {
      await db.execute({
        sql: `
        INSERT INTO items (
          package_id, token,
          name, serial_raw, serial_clean, condition, mvd, note, battery, coverage,
          status, inventory_status,
          created_at, updated_at,
          is_deleted, created_by, category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 'UNKNOWN', ?, ?, 0, ?, ?)
      `,
        args: [
          package_id, token,
          fields.name, fields.serial_raw, fields.serial_clean, fields.condition, fields.mvd, fields.note, fields.battery, fields.coverage,
          t, t, req.user, detectCategory(fields.name)
        ]
      });
    } catch (e) {
      if (String(e.message || "").toLowerCase().includes("unique")) {
        return res.status(409).json({ error: "Đã có item này (serial trùng) và đang tồn tại." });
      }
      throw e;
    }

    const { rows: itemRows } = await db.execute({ sql: "SELECT * FROM items WHERE token = ?", args: [token] });
    const item = itemRows[0];

    const scanUrl = `${req.protocol}://${req.get("host")}/scan.html?token=${encodeURIComponent(token)}`;
    const qrDataUrl = await QRCode.toDataURL(token, { margin: 1, width: 400, errorCorrectionLevel: 'L' });

    res.json({ item, scanUrl, qrDataUrl });
  } catch (e) {
    res.status(400).json({ error: e.message || "Create failed" });
  }
});

// ====== Shortcut API: Create item via external POST ======
app.post("/api/external/create", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.SHORTCUT_API_KEY) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid x-api-key header." });
  }

  try {
    const fields = {
      name: (req.body.name ?? "").trim(),
      serial_raw: (req.body.serial ?? "").trim(),
      condition: (req.body.condition ?? "Unknown").trim(),
      mvd: (req.body.mvd ?? "").trim(),
      note: (req.body.note ?? "").trim(),
      battery: (req.body.battery ?? "").trim(),
      coverage: (req.body.coverage ?? "").trim(),
    };

    fields.serial_clean = (fields.serial_raw.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim().toUpperCase();

    // Loại bỏ kiểm tra điều kiện (validation) theo yêu cầu người dùng
    if (fields.serial_clean) {
      const { rows: existRows } = await db.execute({
        sql: `SELECT package_id FROM items WHERE LOWER(serial_clean) = LOWER(?) AND is_deleted = 0 LIMIT 1`,
        args: [fields.serial_clean]
      });
      if (existRows[0]) {
        return res.status(409).json({ error: "Sản phẩm đã tồn tại.", package_id: existRows[0].package_id });
      }
    }

    const package_id = await nextPackageId();
    const token = genToken();
    const t = nowISO();

    try {
      await db.execute({
        sql: `
          INSERT INTO items (
            package_id, token, name, serial_raw, serial_clean, condition, mvd, note, battery, coverage,
            status, inventory_status, created_at, updated_at, is_deleted, created_by, category
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 'UNKNOWN', ?, ?, 0, 'shortcut', ?)
        `,
        args: [
          package_id, token, fields.name, fields.serial_raw, fields.serial_clean, fields.condition, fields.mvd, fields.note, fields.battery, fields.coverage,
          t, t, detectCategory(fields.name)
        ]
      });
    } catch (e) {
      // Race: 2 request shortcut cùng lúc cùng serial, cùng pass bước check ở trên
      if (String(e.message || "").toLowerCase().includes("unique")) {
        return res.status(409).json({ error: "Sản phẩm đã tồn tại." });
      }
      throw e;
    }

    const { rows: itemRows } = await db.execute({ sql: "SELECT id FROM items WHERE token = ?", args: [token] });
    const newItem = itemRows[0];

    // Notify Telegram with Formatted Label + Button
    const qrBuffer = await QRCode.toBuffer(token, { margin: 1, width: 400, errorCorrectionLevel: 'L' });
    const labelBuffer = await generateLabelBuffer(fields, qrBuffer);

    // Build caption; cắt note nếu tổng vượt giới hạn 1024 ký tự của Telegram
    // (trước đây note dài → caption > 1024 → sendPhoto bị Telegram reject → miss).
    const linkSuffix = process.env.APP_URL
      ? `\n\n🔗 <a href="${process.env.APP_URL}/scan.html?token=${token}">Xem chi tiết</a>`
      : "";
    const captionData = {
      mvd: fields.mvd || "", name: fields.name || "", serial: fields.serial_clean || "",
      condition: fields.condition || "", battery: fields.battery || "",
      coverage: fields.coverage || "", note: fields.note || ""
    };
    const buildCaption = (noteText) => {
      const data = { ...captionData, note: noteText };
      return `<code>${escTg(JSON.stringify(data))}</code>${linkSuffix}`;
    };
    let captionNote = fields.note || "";
    let caption = buildCaption(captionNote);
    for (let i = 0; i < 60 && caption.length > 1024 && captionNote.length > 0; i++) {
      captionNote = captionNote.slice(0, Math.max(0, captionNote.length - (caption.length - 1024) - 8));
      caption = buildCaption(captionNote);
    }
    if (caption.length > 1024) caption = caption.slice(0, 1021) + "...";

    console.log(`[SHORTCUT] Caption length: ${caption.length} (max 1024)`);
    console.log(`[SHORTCUT] Caption: ${caption.substring(0, 200)}...`);

    const firstRow = [
      { text: `⬜ CREATED`, callback_data: "none" },
      { text: "↩️", callback_data: `request_return_tg:${newItem.id}` }
    ];

    const replyMarkup = {
      inline_keyboard: [
        firstRow,
        [
          { text: "🔴 Post", callback_data: `posted:${newItem.id}` },
          { text: "🗑️", callback_data: `request_delete_tg:${newItem.id}` },
          { text: "🔴 Log", callback_data: `meru:${newItem.id}` }
        ]
      ]
    };

    const tgMsg = await sendTelegramPhoto(labelBuffer, caption, replyMarkup).catch(e => {
      console.error("Shortcut Telegram notify failed:", e);
      return null;
    });
    if (!tgMsg) {
      console.error("[SHORTCUT] Failed to send Telegram photo for token:", token);
      // Fallback: gửi text (đúng 1 lần) để group vẫn nhận được thông tin
      // khi ảnh tem nhãn gửi thất bại — thay cho việc retry ảnh (dễ gây tin trùng)
      await sendTelegramMessage(
        `⚠️ <b>[SHORTCUT] Gửi tem nhãn thất bại</b>\n📦 ID: <code>${package_id}</code>\n<code>${escTg(JSON.stringify(captionData))}</code>`,
        process.env.TELEGRAM_CHAT_ID
      );
    } else {
      console.log("[SHORTCUT] Telegram photo sent successfully, message_id:", tgMsg.message_id);
    }

    // Neu gui Telegram thanh cong, luu ID tin nhan de sau nay dong bo nut bam
    if (tgMsg) {
      await db.execute({
        sql: "UPDATE items SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
        args: [String(tgMsg.chat.id), String(tgMsg.message_id), newItem.id]
      });
    }

    res.json({ ok: true, package_id, token });
  } catch (e) {
    console.error("Shortcut API failed:", e);
    res.status(500).json({ error: e.message || "Shortcut processing failed" });
  }
});

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
  // Bỏ hậu tố tên sàn (Mercari / Yahoo! Flea Market / PayPay Flea Market)
  title = title
    .replace(/\s+(?:by|[-|｜])\s*メルカリ\s*$/i, "")
    .replace(/\s*(?:[-|｜])\s*(?:Yahoo!フリマ(?:（旧PayPayフリマ）)?|PayPayフリマ)\s*$/i, "")
    .trim();
  // Tránh lấy nhầm tên trang chung khi sản phẩm lỗi/404
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

async function fetchProductMetaFromLink(rawUrl) {
  const result = { title: null, price: null };
  let parsedUrl;
  try {
    parsedUrl = new URL(String(rawUrl || "").trim());
  } catch {
    return result;
  }
  if (!/^https?:$/i.test(parsedUrl.protocol)) return result;

  // Chặn host nội bộ cơ bản (SSRF)
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

    // 0. Hỗ trợ __NEXT_DATA__ (Yahoo!フリマ / PayPayフリマ)
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

    // 1. Tách tiêu đề (Next.js streaming payload của Mercari + thẻ meta/title chuẩn)
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

    // 2. Tách giá (Mercari meta/streaming + JSON-LD fallback)
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

// ====== Shortcut API: Create order via external POST (Calendar Order) ======
app.post("/api/external/create-order", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.SHORTCUT_API_KEY) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid x-api-key header." });
  }

  try {
    let name = String(req.body.name ?? "").trim();
    const link = String(req.body.link ?? "").trim();

    const rawBuyPrice = req.body.buy_price;
    const hasBuyPrice =
      rawBuyPrice !== undefined && rawBuyPrice !== null && String(rawBuyPrice).trim() !== "";
    let buy_price = hasBuyPrice ? parseFloat(rawBuyPrice) : null;

    const rawSoldPrice = req.body.sold_price;
    const parsedSoldPrice =
      rawSoldPrice !== undefined && rawSoldPrice !== null && String(rawSoldPrice).trim() !== ""
        ? parseFloat(rawSoldPrice)
        : 0;
    const sold_price = Number.isFinite(parsedSoldPrice) ? parsedSoldPrice : 0;

    // Chỉ tự động lấy tên / giá từ link khi input tương ứng bị để trống
    if (link && (!name || !hasBuyPrice)) {
      const meta = await fetchProductMetaFromLink(link);
      if (!name && meta.title) name = meta.title;
      if (!hasBuyPrice && meta.price !== null) buy_price = meta.price;
    }

    buy_price = Number.isFinite(buy_price) ? buy_price : 0;

    if (!name) {
      return res.status(400).json({ error: "Product name is required (or could not extract title from link)" });
    }

    const order_date = parseAndNormalizeDate(req.body.order_date);

    const package_id = await nextPackageId();
    const token = genToken();
    const t = nowISO();
    const rawShipFee = req.body.ship_fee;
    const parsedShipFee =
      rawShipFee !== undefined && rawShipFee !== null && String(rawShipFee).trim() !== ""
        ? parseFloat(rawShipFee)
        : null;
    const ship_fee = Number.isFinite(parsedShipFee) ? parsedShipFee : detectShipFee(name);
    const profit = sold_price * 0.9 - buy_price - ship_fee;

    await db.execute({
      sql: `
        INSERT INTO items (
          package_id, token, name, buy_price, sold_price, ship_fee, profit, link, is_order, order_date,
          status, inventory_status, created_at, updated_at, is_deleted, created_by, category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'ORDERED', 'UNKNOWN', ?, ?, 0, 'shortcut', ?)
      `,
      args: [
        package_id, token, name, buy_price, sold_price, ship_fee, profit, link, order_date,
        t, t, detectCategory(name)
      ]
    });

    res.json({ ok: true, package_id, token, name, buy_price, ship_fee, profit });
  } catch (e) {
    console.error("Create order API failed:", e);
    res.status(500).json({ error: e.message || "Create order failed" });
  }
});

// Trích xuất mã sản phẩm dạng m hoặc z + dãy số (vd: m52146527465, z123456789) từ mã hoặc URL sản phẩm
function extractProductCode(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const match = s.match(/(?:^|[^a-z0-9])([mz]\d{5,})(?=$|[^a-z0-9])/i);
  return match ? match[1].toLowerCase() : null;
}

// ====== Shortcut API: Update order shipment (Tracking MVD and optional ship fee) ======
app.post("/api/external/update-order-shipment", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.SHORTCUT_API_KEY) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid x-api-key header." });
  }

  try {
    const { order_id, name, token, mvd, link, product_code, code } = req.body;
    const rawShipFee = req.body.ship_fee;
    const parsedShipFee =
      rawShipFee !== undefined && rawShipFee !== null && String(rawShipFee).trim() !== ""
        ? parseFloat(rawShipFee)
        : null;
    const ship_fee = Number.isFinite(parsedShipFee) ? parsedShipFee : null;

    const updated_mvd = String(mvd ?? "").trim();
    if (!updated_mvd) {
      return res.status(400).json({ error: "Tracking number (mvd) is required" });
    }

    const rawCodeInput = String(product_code ?? code ?? "").trim();
    const extractedCode = extractProductCode(rawCodeInput) || extractProductCode(link);

    // Find the order
    let order = null;
    if (order_id) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND id = ? LIMIT 1",
        args: [order_id]
      });
      order = rows[0] || null;
    } else if (token) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND token = ? LIMIT 1",
        args: [token]
      });
      order = rows[0] || null;
    } else if (rawCodeInput || link) {
      // 1. Ưu tiên khớp chính xác link nếu người dùng gửi full link
      if (link && String(link).trim()) {
        const { rows } = await db.execute({
          sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND link = ? ORDER BY created_at DESC LIMIT 1",
          args: [String(link).trim()]
        });
        order = rows[0] || null;
      }

      // 2. Tìm theo mã sản phẩm (vd: m52146527465) nằm trong cột link
      if (!order && extractedCode) {
        const { rows } = await db.execute({
          sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND LOWER(link) LIKE ? ORDER BY created_at DESC",
          args: [`%${extractedCode}%`]
        });
        order = rows.find(r => extractProductCode(r.link) === extractedCode) || null;
      }

      // 3. Fallback nếu truyền product_code/code nhưng không theo định dạng m + số
      if (!order && rawCodeInput) {
        const { rows } = await db.execute({
          sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND LOWER(link) LIKE ? ORDER BY created_at DESC LIMIT 1",
          args: [`%${rawCodeInput.toLowerCase()}%`]
        });
        order = rows[0] || null;
      }
    } else if (name) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND name = ? ORDER BY created_at DESC LIMIT 1",
        args: [name]
      });
      order = rows[0] || null;
    } else {
      // Find latest unmerged order (that doesn't have an mvd yet)
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0 AND (mvd IS NULL OR mvd = '') ORDER BY created_at DESC LIMIT 1",
        args: []
      });
      order = rows[0] || null;
    }

    if (!order) {
      return res.status(404).json({
        error: extractedCode
          ? `Order not found for product code: ${extractedCode}`
          : "Order not found"
      });
    }

    const existingMvd = String(order.mvd ?? "").trim();
    if (existingMvd) {
      return res.json({
        ok: true,
        already_updated: true,
        message: `Đơn hàng đã được cập nhật MVD trước đó: ${existingMvd}`,
        order_id: order.id,
        package_id: order.package_id,
        name: order.name,
        product_code: extractedCode || extractProductCode(order.link),
        mvd: existingMvd
      });
    }

    const updated_ship_fee = ship_fee !== null ? ship_fee : (order.ship_fee || detectShipFee(order.name));
    const updated_profit = (order.sold_price || 0) * 0.9 - (order.buy_price || 0) - updated_ship_fee;
    const t = nowISO();

    await db.execute({
      sql: `
        UPDATE items 
        SET mvd = ?, ship_fee = ?, profit = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [updated_mvd, updated_ship_fee, updated_profit, t, order.id]
    });

    res.json({
      ok: true,
      already_updated: false,
      message: `Đã cập nhật MVD thành công: ${updated_mvd}`,
      order_id: order.id,
      package_id: order.package_id,
      name: order.name,
      product_code: extractedCode || extractProductCode(order.link),
      mvd: updated_mvd,
      profit: updated_profit
    });
  } catch (e) {
    console.error("Update shipment API failed:", e);
    res.status(500).json({ error: e.message || "Update shipment failed" });
  }
});

// ====== GET /api/orders (Fetch all orders for calendar) ======
app.get("/api/orders", requireAuth, requireAdmin, async (req, res) => {
  try {
    const month = req.query.month; // YYYY-MM
    let sql = "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0";
    const args = [];

    if (month) {
      sql += " AND order_date LIKE ?";
      args.push(`${month}%`);
    }

    sql += " ORDER BY order_date ASC, id ASC";

    const { rows } = await db.execute({ sql, args });
    res.json({ rows });
  } catch (e) {
    console.error("Get orders failed:", e);
    res.status(500).json({ error: e.message || "Failed to get orders" });
  }
});

// ====== POST /api/orders (Create order via UI) ======
app.post("/api/orders", requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name ?? "").trim();
    const buy_price = parseFloat(req.body.buy_price ?? 0);
    const sold_price = parseFloat(req.body.sold_price ?? 0);
    const ship_fee = req.body.ship_fee !== undefined && parseFloat(req.body.ship_fee) !== 0 ? parseFloat(req.body.ship_fee) : detectShipFee(name);
    const link = (req.body.link ?? "").trim();
    const note = (req.body.note ?? "no").trim();
    const mvd = (req.body.mvd ?? "").trim();

    if (!name) {
      return res.status(400).json({ error: "Product name is required" });
    }

    const order_date = parseAndNormalizeDate(req.body.order_date);

    const package_id = await nextPackageId();
    const token = genToken();
    const t = nowISO();
    const profit = sold_price * 0.9 - buy_price - ship_fee;

    await db.execute({
      sql: `
        INSERT INTO items (
          package_id, token, name, buy_price, sold_price, ship_fee, profit, link, is_order, order_date, note,
          status, inventory_status, created_at, updated_at, is_deleted, created_by, category, mvd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'ORDERED', 'UNKNOWN', ?, ?, 0, ?, ?, ?)
      `,
      args: [
        package_id, token, name, buy_price, sold_price, ship_fee, profit, link, order_date, note,
        t, t, req.user, detectCategory(name), mvd
      ]
    });

    res.json({ ok: true, package_id, token, profit, ship_fee, mvd });
  } catch (e) {
    console.error("Create order failed:", e);
    res.status(500).json({ error: e.message || "Failed to create order" });
  }
});

// ====== GET /api/orders/unmerged-arrived (Fetch arrived physical items that are not merged) ======
app.get("/api/orders/unmerged-arrived", requireAuth, requireAdmin, async (req, res) => {
  try {
    const sql = `
      SELECT * FROM items 
      WHERE is_order = 0 AND is_deleted = 0 AND status = 'CREATED'
      ORDER BY datetime(updated_at) DESC
    `;
    const { rows } = await db.execute(sql);
    res.json({ rows });
  } catch (e) {
    console.error("Get unmerged items failed:", e);
    res.status(500).json({ error: e.message || "Failed to get unmerged items" });
  }
});

// ====== POST /api/orders/merge (Merge calendar order and physical item) ======
app.post("/api/orders/merge", requireAuth, requireAdmin, async (req, res) => {
  const { order_id, arrived_item_id } = req.body;

  if (!order_id || !arrived_item_id) {
    return res.status(400).json({ error: "Missing order_id or arrived_item_id" });
  }

  try {
    const { rows: orderRows } = await db.execute({
      sql: "SELECT * FROM items WHERE id = ? AND is_order = 1 AND is_deleted = 0",
      args: [order_id]
    });
    const { rows: arrivedRows } = await db.execute({
      sql: "SELECT * FROM items WHERE id = ? AND is_order = 0 AND is_deleted = 0",
      args: [arrived_item_id]
    });

    const order = orderRows[0];
    const arrived = arrivedRows[0];

    if (!order) return res.status(404).json({ error: "Calendar order not found" });
    if (order.status !== 'ORDERED') return res.status(400).json({ error: "Calendar order is already merged" });
    if (!arrived) return res.status(404).json({ error: "Arrived physical item not found" });
    if (arrived.merged_from_id) return res.status(400).json({ error: "Arrived physical item is already merged" });

    const t = nowISO();
    const profit = (order.sold_price || 0) * 0.9 - (order.buy_price || 0) - (order.ship_fee || 0);

    await db.execute({
      sql: `
        UPDATE items
        SET 
          name = ?,
          mvd = CASE WHEN mvd IS NULL OR mvd = '' THEN ? ELSE mvd END,
          serial_raw = ?,
          serial_clean = ?,
          condition = ?,
          battery = ?,
          coverage = ?,
          note = ?,
          status = 'CREATED',
          inventory_status = ?,
          category = ?,
          profit = ?,
          merged_from_id = ?,
          updated_at = ?
        WHERE id = ?
      `,
      args: [
        arrived.name,
        arrived.mvd,
        arrived.serial_raw,
        arrived.serial_clean,
        arrived.condition,
        arrived.battery,
        arrived.coverage,
        arrived.note,
        arrived.inventory_status || 'UNKNOWN',
        detectCategory(arrived.name),
        profit,
        arrived.id,
        t,
        order.id
      ]
    });

    await db.execute({
      sql: "UPDATE items SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?",
      args: [t, req.user, arrived.id]
    });

    await db.execute({
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?, ?, ?, ?, ?)",
      args: [order.id, order.status, 'CREATED', req.user, t]
    });

    res.json({ ok: true, merged_order_id: order.id });
  } catch (e) {
    console.error("Merge failed:", e);
    res.status(500).json({ error: e.message || "Merge failed" });
  }
});

// ====== POST /api/orders/unmerge (Unmerge/Unreconcile calendar order and physical item) ======
app.post("/api/orders/unmerge", requireAuth, requireAdmin, async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({ error: "Missing order_id" });
  }

  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM items WHERE id = ? AND is_order = 1 AND is_deleted = 0",
      args: [order_id]
    });
    const order = rows[0];

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.status !== 'CREATED' || !order.merged_from_id) {
      return res.status(400).json({ error: "Order is not currently merged with a package" });
    }

    const t = nowISO();

    const { rows: physicalRows } = await db.execute({
      sql: "SELECT * FROM items WHERE id = ? AND is_order = 0 AND is_deleted = 1",
      args: [order.merged_from_id]
    });
    const physicalItem = physicalRows[0];

    if (physicalItem) {
      await db.execute({
        sql: "UPDATE items SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, status = 'CREATED' WHERE id = ?",
        args: [physicalItem.id]
      });
    }

    const profit = (order.sold_price || 0) * 0.9 - (order.buy_price || 0);

    await db.execute({
      sql: `
        UPDATE items
        SET 
          serial_raw = NULL,
          serial_clean = NULL,
          condition = NULL,
          battery = NULL,
          coverage = NULL,
          note = 'no',
          status = 'ORDERED',
          ship_fee = 0,
          profit = ?,
          merged_from_id = NULL,
          updated_at = ?
        WHERE id = ?
      `,
      args: [profit, t, order.id]
    });

    await db.execute({
      sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?, ?, ?, ?, ?)",
      args: [order.id, order.status, 'ORDERED', req.user, t]
    });

    res.json({ ok: true, unmerged_order_id: order.id });
  } catch (e) {
    console.error("Merge failed:", e);
    res.status(500).json({ error: e.message || "Merge failed" });
  }
});

// ====== PUT /api/orders/:id (Update order details) ======
app.put("/api/orders/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, link, buy_price, sold_price, ship_fee, note, order_date, status, mvd } = req.body;

  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM items WHERE id = ? AND is_order = 1 AND is_deleted = 0",
      args: [id]
    });
    const order = rows[0];

    if (!order) return res.status(404).json({ error: "Order not found" });

    const updated_name = name !== undefined ? name.trim() : order.name;
    const updated_link = link !== undefined ? link.trim() : order.link;
    const updated_buy_price = buy_price !== undefined ? parseFloat(buy_price) : (order.buy_price || 0);
    const updated_sold_price = sold_price !== undefined ? parseFloat(sold_price) : (order.sold_price || 0);
    const updated_ship_fee = ship_fee !== undefined ? parseFloat(ship_fee) : (order.ship_fee || 0);
    const updated_note = note !== undefined ? note.trim() : order.note;
    const updated_order_date = order_date !== undefined ? parseAndNormalizeDate(order_date) : order.order_date;
    const updated_status = status !== undefined ? status.trim() : order.status;
    const updated_mvd = mvd !== undefined ? mvd.trim() : order.mvd;

    const profit = updated_sold_price * 0.9 - updated_buy_price - updated_ship_fee;
    const t = nowISO();

    await db.execute({
      sql: `
        UPDATE items
        SET 
          name = ?,
          link = ?,
          buy_price = ?,
          sold_price = ?,
          ship_fee = ?,
          profit = ?,
          note = ?,
          order_date = ?,
          status = ?,
          mvd = ?,
          updated_at = ?
        WHERE id = ?
      `,
      args: [
        updated_name,
        updated_link,
        updated_buy_price,
        updated_sold_price,
        updated_ship_fee,
        profit,
        updated_note,
        updated_order_date,
        updated_status,
        updated_mvd,
        t,
        id
      ]
    });

    if (updated_status !== order.status) {
      await db.execute({
        sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?, ?, ?, ?, ?)",
        args: [id, order.status, updated_status, req.user, t]
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Update order failed:", e);
    res.status(500).json({ error: e.message || "Failed to update order" });
  }
});

// ====== DELETE /api/orders/:id (Delete calendar order) ======
app.delete("/api/orders/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const t = nowISO();
    await db.execute({
      sql: "UPDATE items SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?",
      args: [t, req.user, id]
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Delete order failed:", e);
    res.status(500).json({ error: e.message || "Failed to delete order" });
  }
});

// ====== Telegram Webhook Handler ======
app.post("/api/telegram/webhook", async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const authorizedChatId = process.env.TELEGRAM_CHAT_ID;

  if (!req.body) return res.sendStatus(200);

  // 1. Handle Button Clicks (Callback Queries)
  if (req.body.callback_query) {
    const cb = req.body.callback_query;
    const chatId = String(cb.message.chat.id);
    const isFromAuthorizedChat =
      chatId === String(authorizedChatId) ||
      chatId === String(DELETE_GROUP_CHAT_ID) ||
      chatId === String(RETURN_GROUP_CHAT_ID) ||
      chatId === String(TASK_GROUP_CHAT_ID);
    if (!isFromAuthorizedChat) return res.sendStatus(200);

    const [action, itemId] = cb.data.split(":");
    try {
      // Kiểm tra quyền hạn người dùng theo rule mới
      const bongId = String(process.env.TELEGRAM_BONG || "").trim();
      const aaronId = String(process.env.TELEGRAM_AARON || "").trim();
      // Nếu không có TELEGRAM_ADMIN_ID riêng, lấy ID đầu tiên trong mảng AUTHORIZED_TELEGRAM_USER_IDS làm Super Admin
      const adminId = process.env.TELEGRAM_ADMIN_ID
        ? String(process.env.TELEGRAM_ADMIN_ID).trim()
        : String(process.env.AUTHORIZED_TELEGRAM_USER_IDS || "").split(',')[0].trim();
      const authorizedUserIds = String(process.env.AUTHORIZED_TELEGRAM_USER_IDS || "").split(',').map(id => id.trim());
      const userId = String(cb.from.id);

      // Phân quyền chi tiết theo yêu cầu mới
      let allowed = false;

      // 1. Super Admin: Toàn quyền
      if (userId === adminId) {
        allowed = true;
      }
      // 2. BONG: Chỉ được Post Meru
      else if (bongId && userId === bongId) {
        allowed = (action === "posted");
      }
      // 3. AARON: Chỉ được Yêu cầu xóa và Hoàn tất Return (Done)
      else if (aaronId && userId === aaronId) {
        allowed = (action === "request_delete_tg" || action === "return_done");
      }
      // 4. Nhóm Admin chung (AUTHORIZED_TELEGRAM_USER_IDS)
      else if (authorizedUserIds.includes(userId)) {
        // Toàn quyền trừ nút Hoàn tất Return (return_done)
        if (action === "return_done") {
          allowed = false;
        } else {
          allowed = true;
        }
      }

      if (!allowed) {
        const answerUrl = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
        await fetch(answerUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: cb.id,
            text: "❌ Bạn không có quyền thực hiện thao tác này!",
            show_alert: true
          })
        });
        return res.sendStatus(200);
      }

      // Tự động sửa lỗi (Self-healing): Đồng bộ lại tg_chat_id và tg_msg_id nếu bị thiếu hoặc sai lệch
      if (itemId && !isNaN(Number(itemId)) && action !== "return_done") {
        try {
          const { rows: itemRows } = await db.execute({
            sql: "SELECT id, tg_chat_id, tg_msg_id FROM items WHERE id = ? AND is_deleted = 0",
            args: [Number(itemId)]
          });
          const dbItem = itemRows[0];
          if (dbItem) {
            const currentChatId = String(cb.message.chat.id);
            const currentMsgId = String(cb.message.message_id);
            if (dbItem.tg_chat_id !== currentChatId || dbItem.tg_msg_id !== currentMsgId) {
              console.log(`[SELF-HEALING] Updating TG references for item ${dbItem.id}: chat_id ${dbItem.tg_chat_id} -> ${currentChatId}, msg_id ${dbItem.tg_msg_id} -> ${currentMsgId}`);
              await db.execute({
                sql: "UPDATE items SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
                args: [currentChatId, currentMsgId, dbItem.id]
              });
            }
          }
        } catch (err) {
          console.error("[SELF-HEALING] Error healing TG references:", err);
        }
      }

      if (action === "copy_item") {
        const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [itemId] });
        const item = rows[0];
        if (item) {
          const textToCopy =
            `Name: ${item.name || "-"}\n` +
            `Serial: ${item.serial_clean || "-"}\n` +
            `Coverage: ${item.coverage || "-"}\n` +
            `Battery: ${item.battery || "-"}\n` +
            `Condition: ${item.condition || "-"}\n` +
            `Note: ${item.note || "-"}`;

          await sendTelegramMessage(`📋 <b>Thông tin sản phẩm (Chạm để copy):</b>\n\n<code>${escTg(textToCopy)}</code>`, cb.message.chat.id);

          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "✅ Đã gửi thông tin copy!" })
          });
        }
        return res.sendStatus(200);
      }

      if (action === "meru") {
        const { rows } = await db.execute({ sql: "SELECT id, is_meru_logged FROM items WHERE id = ?", args: [itemId] });
        const item = rows[0];
        if (item) {
          const updated_at = nowISO();
          const next_val = item.is_meru_logged ? 0 : 1;
          const actor = getTgActorName(cb.from);
          await db.execute({ sql: "UPDATE items SET is_meru_logged = ?, updated_at = ? WHERE id = ?", args: [next_val, updated_at, itemId] });
          await db.execute({ sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)", args: [itemId, actor, JSON.stringify({ is_meru_logged: next_val }), updated_at] });

          await syncTelegramButtons(itemId).catch(e => console.error("Sync TG Meru failed:", e));

          const answerUrl = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
          await fetch(answerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: cb.id,
              text: next_val ? "✅ Đã Log Meru!" : "🔄 Đã Hủy Log Meru",
              show_alert: false
            })
          });
        }
      }

      if (action === "posted") {
        const { rows } = await db.execute({ sql: "SELECT id, package_id, is_posted FROM items WHERE id = ?", args: [itemId] });
        const item = rows[0];
        if (item) {
          const updated_at = nowISO();
          if (!item.is_posted) {
            const actor = getTgActorName(cb.from);
            await db.execute({ sql: "UPDATE items SET is_posted = 1, updated_at = ? WHERE id = ?", args: [updated_at, itemId] });
            await db.execute({ sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)", args: [itemId, actor, JSON.stringify({ is_posted: 1 }), updated_at] });

            // Xóa tin nhắn nhắc nhở unposted (nếu có)
            if (item.post_task_msg_id && item.post_task_chat_id) {
              const token = process.env.TELEGRAM_BOT_TOKEN;
              await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: item.post_task_chat_id, message_id: item.post_task_msg_id })
              }).catch(e => console.error("Delete unposted reminder failed:", e));

              await db.execute({
                sql: "UPDATE items SET post_task_msg_id = NULL, post_task_chat_id = NULL WHERE id = ?",
                args: [itemId]
              });
            }

            await syncTelegramButtons(itemId).catch(e => console.error("Sync TG Posted failed:", e));

            // Trả lời Telegram kèm thông báo
            const answerUrl = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
            await fetch(answerUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                callback_query_id: cb.id,
                text: "✅ Đã đăng bán thành công!",
                show_alert: false
              })
            });
          } else {
            const answerUrl = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
            await fetch(answerUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                callback_query_id: cb.id,
                text: "ℹ️ Sản phẩm này đã được đăng bán rồi.",
                show_alert: false
              })
            });
          }
        }
      }
      if (action === "edit_json_tg") {
        const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [itemId] });
        const item = rows[0];
        if (item) {
          const captionData = {
            mvd: item.mvd || "",
            name: item.name || "",
            serial: item.serial_clean || "",
            condition: item.condition || "",
            battery: item.battery || "",
            coverage: item.coverage || "",
            note: item.note || ""
          };

          const textMsg =
            `✏️ <b>Sửa JSON sản phẩm (ID: ${item.id})</b>\n` +
            `Hãy copy đoạn JSON bên dưới, chỉnh sửa các giá trị và thực hiện <b>Reply (Phản hồi)</b> trực tiếp lại tin nhắn này:\n\n` +
            `<code>${escTg(JSON.stringify(captionData))}</code>`;

          await sendTelegramMessage(textMsg, cb.message.chat.id);

          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "✅ Đã gửi mẫu JSON. Hãy reply để sửa!" })
          });
        }
        return res.sendStatus(200);
      }
      if (action === "request_return_tg") {
        const userId = String(cb.from.id);
        const adminId = process.env.TELEGRAM_ADMIN_ID
          ? String(process.env.TELEGRAM_ADMIN_ID).trim()
          : String(process.env.AUTHORIZED_TELEGRAM_USER_IDS || "").split(',')[0].trim();

        if (userId !== adminId) {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "❌ Chỉ admin mới có quyền yêu cầu Return!", show_alert: true })
          });
          return res.sendStatus(200);
        }

        const itemId2 = itemId;
        const { rows: iRows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0", args: [itemId2] });
        const itemData = iRows[0];

        if (!itemData) {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "❌ Không tìm thấy sản phẩm.", show_alert: true })
          });
          return res.sendStatus(200);
        }

        const { rows: pendingRows } = await db.execute({
          sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING'",
          args: [itemId2]
        });
        if (pendingRows[0]) {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "⚠️ Đã có yêu cầu đang chờ duyệt!", show_alert: true })
          });
          return res.sendStatus(200);
        }

        const t = nowISO();
        const requester = getTgActorName(cb.from);

        await db.execute({
          sql: "UPDATE items SET status = 'REQUEST_RETURN', updated_at = ? WHERE id = ?",
          args: [t, itemId2]
        });

        await db.execute({
          sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
          args: [itemId2, itemData.status, 'REQUEST_RETURN', requester, t]
        });

        await db.execute({
          sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)",
          args: [itemId2, requester, t]
        });

        const { rows: newReqRows } = await db.execute({
          sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
          args: [itemId2]
        });
        const newReqId = newReqRows[0].id;

        const returnGroupId = process.env.RETURN_GROUP_CHAT_ID;
        const taskGroupId = process.env.TASK_GROUP_CHAT_ID || returnGroupId;
        const tagAaron = process.env.TELEGRAM_AARON ? `\n🔔 Tag: <a href="tg://user?id=${process.env.TELEGRAM_AARON}">@AARON</a>` : "";
        const retMsg = `📦 <b>YÊU CẦU RETURN & XÓA</b>\n\n` +
          `📦 ID: <code>${itemData.package_id}</code>\n` +
          `🏷️ Tên: <b>${escTg(itemData.name)}</b>\n` +
          `🔢 Serial: <code>${itemData.serial_clean || "-"}</code>\n` +
          `📍 Trạng thái: ${itemData.status} ➔ <b>REQUEST_RETURN</b>\n` +
          `👤 Yêu cầu bởi: <b>${escTg(requester)}</b>${tagAaron}\n` +
          `⏰ Thời gian: ${fmtTimeLocal(t)}`;

        const buttons = [
          { text: "✅ Done", callback_data: `return_done:${newReqId}` },
          { text: `📍 REQUEST_RETURN`, callback_data: "none" }
        ];

        if (itemData.tg_chat_id && itemData.tg_msg_id) {
          const cleanChatId = String(itemData.tg_chat_id).replace("-100", "");
          buttons.push({ text: "🔗 Xem tin gốc", url: `https://t.me/c/${cleanChatId}/${itemData.tg_msg_id}` });
        }

        try {
          // 1. Gửi tin nhắn tới nhóm Admin/Return
          const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: returnGroupId, text: retMsg, parse_mode: "HTML", reply_markup: { inline_keyboard: [buttons] } })
          });
          const tgData = await tgRes.json();
          let adminMsgId = null;
          if (tgData.ok && tgData.result) {
            adminMsgId = String(tgData.result.message_id);
          }

          // 2. Gửi tin nhắn tới nhóm Task
          const taskMsg = `📝 <b>TASK: KIỂM TRA HÀNG RETURN</b>\n\n` +
            `📦 ID: <code>${itemData.package_id}</code>\n` +
            `🏷 Tên: <b>${escTg(itemData.name)}</b>\n` +
            `🔢 Serial: <code>${itemData.serial_clean || "-"}</code>\n` +
            `👤 Người yêu cầu: ${escTg(requester)}` +
            (process.env.TELEGRAM_AARON ? `\n🔔 Tag: <a href="tg://user?id=${process.env.TELEGRAM_AARON}">@AARON</a>` : "");

          const taskRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: taskGroupId, text: taskMsg, parse_mode: "HTML" })
          });
          const taskData = await taskRes.json();
          let taskMsgId = null;
          if (taskData.ok && taskData.result) {
            taskMsgId = String(taskData.result.message_id);
          }

          // 3. Cập nhật database với ID của cả 2 tin nhắn
          await db.execute({
            sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ?, task_chat_id = ?, task_msg_id = ? WHERE id = ?",
            args: [returnGroupId, adminMsgId, taskGroupId, taskMsgId, newReqId]
          });

        } catch (e) {
          console.error("Telegram request return failed:", e);
        }

        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cb.id, text: "✅ Đã gửi yêu cầu Return tới admin!", show_alert: true })
        });
        return res.sendStatus(200);
      }

      if (action === "request_delete_tg") {
        const itemId2 = itemId;
        const { rows: iRows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0", args: [itemId2] });
        const itemData = iRows[0];

        if (!itemData) {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "❌ Không tìm thấy sản phẩm.", show_alert: true })
          });
          return res.sendStatus(200);
        }

        // Kiểm tra pending request
        const { rows: pendingRows } = await db.execute({
          sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING'",
          args: [itemId2]
        });
        if (pendingRows[0]) {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "⚠️ Đã có yêu cầu xóa đang chờ duyệt!", show_alert: true })
          });
          return res.sendStatus(200);
        }

        const t = nowISO();
        const requester = getTgActorName(cb.from);

        // Cập nhật trạng thái item (nếu cần - hiện tại delete_requests không đổi status item ngay lập tức nhưng nên ghi log)
        await db.execute({
          sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
          args: [itemId2, itemData.status, 'REQUEST_DELETE', requester, t]
        });

        await db.execute({
          sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)",
          args: [itemId2, requester, t]
        });

        const { rows: newReqRows } = await db.execute({
          sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
          args: [itemId2]
        });
        const newReqId = newReqRows[0].id;

        const delMsg = `🗑️ <b>YÊU CẦU XÓA SẢN PHẨM</b>\n\n` +
          `📦 ID: <code>${itemData.package_id}</code>\n` +
          `🏷️ Tên: <b>${escTg(itemData.name)}</b>\n` +
          `🔢 Serial: <code>${itemData.serial_clean || "-"}</code>\n` +
          `📍 Trạng thái: ${itemData.status}\n` +
          `👤 Yêu cầu bởi: <b>${escTg(requester)}</b>\n` +
          `⏰ Thời gian: ${fmtTimeLocal(t)}`;

        const buttons = [
          { text: "✅ Duyệt xóa", callback_data: `approve_delete:${newReqId}` },
          { text: "❌ Từ chối", callback_data: `reject_delete:${newReqId}` }
        ];



        const delMarkup = {
          inline_keyboard: [buttons]
        };

        try {
          console.log(`[DELETE REQUEST] Sending to chat_id: ${DELETE_GROUP_CHAT_ID}`);
          const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: DELETE_GROUP_CHAT_ID, text: delMsg, parse_mode: "HTML", reply_markup: delMarkup })
          });
          const tgData = await tgRes.json();
          console.log(`[DELETE REQUEST] Telegram response:`, tgData);
          if (tgData.ok && tgData.result) {
            await db.execute({
              sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
              args: [String(tgData.result.chat.id), String(tgData.result.message_id), newReqId]
            });
          } else if (!tgData.ok) {
            console.error(`[DELETE REQUEST] Telegram error: ${tgData.description}`);
          }
        } catch (e) { console.error("Telegram delete request from TG button failed:", e); }

        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cb.id, text: "✅ Đã gửi yêu cầu xóa tới admin!", show_alert: true })
        });
        return res.sendStatus(200);
      }

      if (action === "return_done") {
        // userId va allowed da co san tu check o tren
        // khong can check userId === "7818712996" nua vi allowed da bao gom AUTHORIZED_TELEGRAM_USER_IDS

        const reqId = itemId; // Doi voi return_done, itemId thuc chat la reqId
        const { rows: reqRows } = await db.execute({ sql: "SELECT * FROM delete_requests WHERE id = ?", args: [reqId] });
        const request = reqRows[0];
        if (!request) return res.sendStatus(200);

        const { rows: itemRows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [request.item_id] });
        const item = itemRows[0];
        if (!item) return res.sendStatus(200);

        const t = nowISO();
        const actor = getTgActorName(cb.from);

        // 1. Cập nhật trạng thái sản phẩm
        await db.execute({
          sql: "UPDATE items SET status = 'RETURN', updated_at = ? WHERE id = ?",
          args: [t, item.id]
        });

        // Thêm log vào timeline
        await db.execute({
          sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
          args: [item.id, item.status, 'RETURN', actor, t]
        });

        // 2. Cập nhật trạng thái yêu cầu
        await db.execute({
          sql: "UPDATE delete_requests SET status = 'DONE', resolved_at = ? WHERE id = ?",
          args: [t, reqId]
        });

        // 3. Xóa tin nhắn bên nhóm Task (nếu có)
        if (request.task_chat_id && request.task_msg_id) {
          await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: request.task_chat_id, message_id: request.task_msg_id })
          }).catch(e => console.error("Xóa task message thất bại:", e));
        }

        // 4. Cập nhật lại tin nhắn hiện tại
        const newText = cb.message.text.replace("YÊU CẦU RETURN & XÓA", "✅ ĐÃ HOÀN TẤT RETURN") + `\n\n✅ Đã xử lý bởi: <b>${escTg(cb.from.first_name)}</b>`;
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: newText,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: "📍 RETURN", callback_data: "none" }]]
            }
          })
        });

        // 5. Đồng bộ nút bấm tin nhắn gốc
        await syncTelegramButtons(item.id);

        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cb.id, text: "✅ Đã xác nhận hoàn tất Return!" })
        });
        return res.sendStatus(200);
      }


      if (action === "approve_delete") {
        const reqId = itemId;
        const { rows: reqRows } = await db.execute({
          sql: `SELECT dr.*, i.package_id, i.name, i.tg_chat_id as item_tg_chat, i.tg_msg_id as item_tg_msg
                FROM delete_requests dr JOIN items i ON dr.item_id = i.id WHERE dr.id = ?`,
          args: [reqId]
        });
        const reqData = reqRows[0];

        if (!reqData || reqData.status !== 'PENDING') {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "⚠️ Yêu cầu này đã được xử lý rồi.", show_alert: true })
          });
          return res.sendStatus(200);
        }

        const t = nowISO();
        const actor = getTgActorName(cb.from);

        // Soft-delete item
        await db.execute({
          sql: `UPDATE items SET is_deleted=1, status='DELETED', deleted_at=?, deleted_by=?, updated_at=? WHERE id=?`,
          args: [t, actor, t, reqData.item_id]
        });

        // Log timeline
        await db.execute({
          sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
          args: [reqData.item_id, 'PENDING_DELETE', 'DELETED', actor, t]
        });

        // Update request status
        await db.execute({
          sql: `UPDATE delete_requests SET status='APPROVED', resolved_at=? WHERE id=?`,
          args: [t, reqId]
        });

        // Thông báo hệ thống
        const notifyMsg = `🔔 <b>HỆ THỐNG: ĐÃ XÓA SẢN PHẨM</b>\n\n` +
          `📦 ID: <code>${reqData.package_id}</code>\n` +
          `🏷 Tên: <b>${escTg(reqData.name)}</b>\n` +
          `👤 Duyệt bởi: <b>${escTg(actor)}</b>\n` +
          `⏰ Thời gian: ${fmtTimeLocal(t)}`;
        await sendTelegramMessage(notifyMsg, NOTIFICATION_GROUP_CHAT_ID);

        // Xóa tin nhắn gốc của item trên Telegram (nếu có)
        if (reqData.item_tg_chat && reqData.item_tg_msg) {
          try {
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: reqData.item_tg_chat, message_id: Number(reqData.item_tg_msg) })
            });
          } catch (e) { console.error("Delete item TG msg failed:", e); }
        }

        // Xóa tin nhắn yêu cầu trong group
        if (reqData.tg_chat_id && reqData.tg_msg_id) {
          try {
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: reqData.tg_chat_id, message_id: Number(reqData.tg_msg_id) })
            });
          } catch (e) { console.error("Delete request TG msg failed:", e); }
        }

        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cb.id, text: `✅ Đã duyệt xóa: ${reqData.package_id}`, show_alert: true })
        });
        return res.sendStatus(200);
      }

      if (action === "reject_delete") {
        const reqId = itemId;
        const { rows: reqRows } = await db.execute({
          sql: `SELECT * FROM delete_requests WHERE id = ?`,
          args: [reqId]
        });
        const reqData = reqRows[0];

        if (!reqData || reqData.status !== 'PENDING') {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "⚠️ Yêu cầu này đã được xử lý rồi.", show_alert: true })
          });
          return res.sendStatus(200);
        }

        const t = nowISO();
        const actor = getTgActorName(cb.from);

        // Log timeline
        await db.execute({
          sql: "INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at) VALUES(?,?,?,?,?)",
          args: [reqData.item_id, 'REQUEST_DELETE', 'CREATED', actor, t]
        });

        await db.execute({
          sql: `UPDATE delete_requests SET status='REJECTED', resolved_at=? WHERE id=?`,
          args: [t, reqId]
        });

        // Xóa tin nhắn yêu cầu trong group
        if (reqData.tg_chat_id && reqData.tg_msg_id) {
          try {
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: reqData.tg_chat_id, message_id: Number(reqData.tg_msg_id) })
            });
          } catch (e) { console.error("Delete reject TG msg failed:", e); }
        }

        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cb.id, text: "❌ Đã từ chối yêu cầu xóa.", show_alert: false })
        });
        return res.sendStatus(200);
      }

      // Luôn trả lời Telegram nếu chưa trả lời ở trên (để tắt spinner)
      const answerUrl = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
      await fetch(answerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cb.id })
      });

    } catch (e) {
      console.error("Telegram callback error:", e);
    }
    return res.sendStatus(200);
  }

  const msg = req.body.message;
  if (!msg || !msg.chat) return res.sendStatus(200);
  const chatId = String(msg.chat.id);
  const isFromAuthorizedChat =
    chatId === String(authorizedChatId) ||
    chatId === String(DELETE_GROUP_CHAT_ID) ||
    chatId === String(RETURN_GROUP_CHAT_ID) ||
    chatId === String(TASK_GROUP_CHAT_ID);
  if (!isFromAuthorizedChat) return res.sendStatus(200);

  // Handle Serial as Text (Mark as Posted)
  if (msg.text) {
    const text = msg.text.trim();

    // 0. Handle text reply edits (both helper template JSON and direct card JSON edits)
    if (msg.reply_to_message) {
      let item = null;
      let helperMsgId = null;

      const editMatch = msg.reply_to_message.text ? msg.reply_to_message.text.match(/Sửa JSON sản phẩm \(ID:\s*(\d+)\)/i) : null;
      if (editMatch) {
        const itemId = parseInt(editMatch[1]);
        const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0", args: [itemId] });
        item = rows[0];
        helperMsgId = msg.reply_to_message.message_id;
      } else {
        const replyMsgId = String(msg.reply_to_message.message_id);
        const { rows } = await db.execute({
          sql: "SELECT * FROM items WHERE tg_msg_id = ? AND tg_chat_id = ? AND is_deleted = 0 LIMIT 1",
          args: [replyMsgId, chatId]
        });
        item = rows[0];

        // Self-healing fallback: If tg_msg_id isn't linked, parse serial from target message's caption
        if (!item && msg.reply_to_message.caption) {
          const caption = msg.reply_to_message.caption;
          const jsonMatch = caption.match(/\{.*\}/s);
          if (jsonMatch) {
            try {
              const capObj = JSON.parse(jsonMatch[0].trim());
              const serial = capObj.serial || capObj.serial_clean;
              if (serial) {
                const clean = (serial.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim();
                if (clean) {
                  const { rows: fallbackRows } = await db.execute({
                    sql: "SELECT * FROM items WHERE LOWER(serial_clean) = LOWER(?) AND is_deleted = 0 LIMIT 1",
                    args: [clean]
                  });
                  item = fallbackRows[0];
                  if (item) {
                    await db.execute({
                      sql: "UPDATE items SET tg_msg_id = ?, tg_chat_id = ? WHERE id = ?",
                      args: [replyMsgId, chatId, item.id]
                    });
                    console.log(`[SELF-HEAL] Linked item ID ${item.id} with tg_msg_id: ${replyMsgId}`);
                  }
                }
              }
            } catch (err) {
              console.error("Caption JSON parse fallback failed:", err);
            }
          }
        }
      }

      if (item) {
        let isProcessed = false;
        try {
          let obj = null;
          try {
            obj = JSON.parse(text);
          } catch (e) {
            // Not valid JSON - let it fall through as normal chat reply
          }

          const updates = {};
          if (obj) {
            // Role restriction check: admin vs TELEGRAM_AARON only
            const aaronId = String(process.env.TELEGRAM_AARON || "").trim();
            const adminId = process.env.TELEGRAM_ADMIN_ID
              ? String(process.env.TELEGRAM_ADMIN_ID).trim()
              : String(process.env.AUTHORIZED_TELEGRAM_USER_IDS || "").split(',')[0].trim();
            const userId = String(msg.from.id);

            const isAuthorized = (userId === adminId) || (aaronId && userId === aaronId);

            if (!isAuthorized) {
              // Delete the reply message to keep the chat clean
              try {
                await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: chatId, message_id: msg.message_id })
                });
              } catch (e) { }

              // Send warning and delete it after 5 seconds
              try {
                const warnRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: chatId, text: "❌ Bạn không có quyền sửa sản phẩm!" })
                });
                const warnData = await warnRes.json();
                if (warnData.ok && warnData.result) {
                  const tempMsgId = warnData.result.message_id;
                  setTimeout(async () => {
                    try {
                      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ chat_id: chatId, message_id: tempMsgId })
                      });
                    } catch (e) { }
                  }, 5000);
                }
              } catch (e) { }

              return res.sendStatus(200);
            }

            isProcessed = true;
            const rawSerial = obj.serial !== undefined ? obj.serial : (obj.serial_raw !== undefined ? obj.serial_raw : item.serial_raw);
            updates.name = (obj.name !== undefined ? obj.name : item.name) || "";
            updates.serial_raw = (rawSerial !== undefined ? rawSerial : item.serial_raw) || "";
            updates.condition = (obj.condition !== undefined ? obj.condition : item.condition) || "";
            updates.mvd = (obj.mvd !== undefined ? obj.mvd : item.mvd) || "";
            updates.note = (obj.note !== undefined ? obj.note : item.note) || "";
            updates.battery = (obj.battery !== undefined ? obj.battery : item.battery) || "";
            updates.coverage = (obj.coverage !== undefined ? obj.coverage : item.coverage) || "";
          }

          if (isProcessed) {
            if (updates.serial_raw !== undefined && updates.serial_clean === undefined) {
              updates.serial_clean = (updates.serial_raw.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim().toUpperCase();
            }

            const allowed = ["name", "serial_raw", "serial_clean", "condition", "mvd", "note", "battery", "coverage"];
            const changes = {};
            for (const k of allowed) {
              if (updates[k] === undefined) {
                updates[k] = item[k] ?? "";
              }
              const oldValue = item[k] ?? "";
              const newValue = String(updates[k]).trim();
              if (oldValue !== newValue) {
                changes[k] = { from: oldValue, to: newValue };
              }
            }

            if (Object.keys(changes).length > 0) {
              const updated_at = nowISO();
              const actor = getTgActorName(msg.from);

              await db.execute({
                sql: `
                  UPDATE items SET
                    name = ?,
                    serial_raw = ?,
                    serial_clean = ?,
                    condition = ?,
                    mvd = ?,
                    note = ?,
                    battery = ?,
                    coverage = ?,
                    updated_at = ?
                  WHERE id = ?
                `,
                args: [
                  updates.name,
                  updates.serial_raw,
                  updates.serial_clean,
                  updates.condition,
                  updates.mvd,
                  updates.note,
                  updates.battery,
                  updates.coverage,
                  updated_at,
                  item.id
                ]
              });

              await db.execute({
                sql: `INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)`,
                args: [item.id, actor, JSON.stringify(changes), updated_at]
              });

              await syncTelegramButtons(item.id);
            }

            // Clean up: delete user's reply message
            try {
              await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, message_id: msg.message_id })
              });
            } catch (e) {
              console.error("Failed to delete user reply message:", e);
            }

            // Clean up: delete helper template message if it exists
            if (helperMsgId) {
              try {
                await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: chatId, message_id: helperMsgId })
                });
              } catch (e) {
                console.error("Failed to delete helper message:", e);
              }
            }

            // Send temporary success message and delete after 3s
            try {
              const successText = `✅ Đã cập nhật sản phẩm <code>${item.package_id}</code>!`;
              const successRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: successText, parse_mode: "HTML" })
              });
              const successData = await successRes.json();
              if (successData.ok && successData.result) {
                const tempMsgId = successData.result.message_id;
                setTimeout(async () => {
                  try {
                    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ chat_id: chatId, message_id: tempMsgId })
                    });
                  } catch (e) { }
                }, 3000);
              }
            } catch (e) { }

            return res.sendStatus(200);
          }

        } catch (err) {
          console.error("Edit reply processing failed:", err);
          // Send temporary error message and delete after 5s
          try {
            const errRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: `❌ Lỗi: ${err.message}` })
            });
            const errData = await errRes.json();
            if (errData.ok && errData.result) {
              const tempMsgId = errData.result.message_id;
              setTimeout(async () => {
                try {
                  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chat_id: chatId, message_id: tempMsgId })
                  });
                } catch (e) { }
              }, 5000);
            }
          } catch (e) { }

          return res.sendStatus(200);
        }
      }
    }

    // ── Task / Reminder ──────────────────────────────────────────
    if (msg.text && /^(nhắc|remind|task)\s*:/i.test(msg.text.trim())) {
      try {
        const raw = msg.text.replace(/^(nhắc|remind|task)\s*:/i, "").trim();

        // Parse time: 30p | 1h | 2h30p | 14:30 | 9h30
        let dueMs = null;
        let title = raw;
        const VN_OFFSET = 7 * 3600000;
        const nowVN = () => Date.now() + VN_OFFSET;

        // Pattern 1: ends with NhMp or Nh or Mp
        const relMatch = raw.match(/(\d+h)?(\d+p)?\s*$/i);
        const clockMatch = raw.match(/(?:lúc\s*)?(\d{1,2})[h:](\d{2})/i);
        const hOnly = raw.match(/(\d+)h\s*$/i);
        const mOnly = raw.match(/(\d+)p\s*$/i);

        if (clockMatch) {
          const hh = parseInt(clockMatch[1]), mm = parseInt(clockMatch[2]);
          const todayVN = new Date(nowVN());
          let due = new Date(Date.UTC(todayVN.getUTCFullYear(), todayVN.getUTCMonth(), todayVN.getUTCDate(), hh - 7, mm));
          if (due.getTime() <= Date.now()) due = new Date(due.getTime() + 86400000); // tomorrow
          dueMs = due.getTime();
          title = raw.replace(clockMatch[0], "").replace(/\s*(lúc)?\s*$/, "").trim();
        } else if (hOnly && mOnly && relMatch[1] && relMatch[2]) {
          const h = parseInt(relMatch[1]), m = parseInt(relMatch[2]);
          dueMs = Date.now() + (h * 3600 + m * 60) * 1000;
          title = raw.replace(relMatch[0].trim(), "").trim();
        } else if (hOnly) {
          const h = parseInt(hOnly[1]);
          dueMs = Date.now() + h * 3600000;
          title = raw.replace(hOnly[0].trim(), "").trim();
        } else if (mOnly) {
          const m = parseInt(mOnly[1]);
          dueMs = Date.now() + m * 60000;
          title = raw.replace(mOnly[0].trim(), "").trim();
        }

        if (!dueMs || !title) {
          await sendTelegramMessage(`⚠️ Không hiểu thời gian. Ví dụ:\n<code>nhắc: Kiểm hàng 30p</code>\n<code>nhắc: Gọi khách 1h30p</code>\n<code>nhắc: Meeting 14:30</code>`);
        } else {
          const due_at = new Date(dueMs).toISOString();
          const created_at = nowISO();
          const from = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || "TG");
          const chatId = String(msg.chat.id);

          const result = await db.execute({
            sql: "INSERT INTO tasks (title, due_at, chat_id, created_by, status, created_at) VALUES (?,?,?,?,?,?)",
            args: [title, due_at, chatId, from, "PENDING", created_at]
          });
          const taskId = Number(result.lastInsertRowid);

          // Format due time in Vietnam TZ
          const dueVN = new Date(dueMs + VN_OFFSET);
          const dueStr = `${String(dueVN.getUTCHours()).padStart(2, "0")}:${String(dueVN.getUTCMinutes()).padStart(2, "0")}`;

          await sendTelegramMessage(
            `⏰ <b>Đã đặt nhắc:</b> ${escTg(title)}\n🕐 Nhắc lúc: <b>${dueStr}</b>`,
            { inline_keyboard: [[{ text: "❌ Huỷ nhắc", callback_data: `task_cancel:${taskId}` }]] }
          );
        }
      } catch (e) { console.error("Task creation failed:", e); }
    }
  }

  res.sendStatus(200);
});

// ── Task callbacks: done / snooze / cancel ────────────────────────────
// (handled inside existing callback_query block above via action routing)

// ── Background scheduler: fire due reminders every 30s ───────────────
let lastUnpostedCheck = "";
setInterval(async () => {
  try {
    const now = nowISO();
    const { rows } = await db.execute({
      sql: "SELECT * FROM tasks WHERE status = 'PENDING' AND due_at <= ? ORDER BY due_at ASC LIMIT 20",
      args: [now]
    });

    for (const task of rows) {
      const markup = {
        inline_keyboard: [[
          { text: "✅ Xong", callback_data: `task_done:${task.id}` },
          { text: "⏰ +15p", callback_data: `task_snooze15:${task.id}` },
          { text: "⏰ +1h", callback_data: `task_snooze60:${task.id}` }
        ]]
      };

      const token = process.env.TELEGRAM_BOT_TOKEN;
      const count = (task.remind_count || 0) + 1;
      const prefix = count > 1 ? `🔔×${count} ` : "🔔 ";

      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: task.chat_id,
            text: `${prefix}<b>Nhắc nhở:</b> ${escTg(task.title)}`,
            parse_mode: "HTML",
            reply_markup: markup
          })
        });
        const tgData = await tgRes.json();
        const newMsgId = tgData.ok ? String(tgData.result.message_id) : null;

        // Snooze 5p nếu chưa có phản hồi (tránh spam)
        const nextDue = new Date(Date.now() + 5 * 60000).toISOString();
        await db.execute({
          sql: "UPDATE tasks SET status='PENDING', due_at=?, remind_count=?, tg_msg_id=? WHERE id=?",
          args: [nextDue, count, newMsgId, task.id]
        });
      } catch (e) { console.error("Reminder send failed:", e); }
    }

    // 2. Kiểm tra hàng chưa đăng bán quá 2 ngày (Chỉ chạy 1 lần mỗi ngày)
    const today = yyyymmddLocal();
    if (lastUnpostedCheck !== today) {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const { rows: staleItems } = await db.execute({
        sql: `SELECT * FROM items 
              WHERE is_posted = 0 AND is_deleted = 0 
              AND status = 'CREATED'
              AND post_task_msg_id IS NULL 
              AND created_at <= ?`,
        args: [twoDaysAgo]
      });

      for (const item of staleItems) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const taskChatId = process.env.TASK_GROUP_CHAT_ID || process.env.RETURN_GROUP_CHAT_ID;
        if (!token || !taskChatId) continue;

        const msg = `⚠️ <b>NHẮC NHỞ: CHƯA ĐĂNG BÁN (QUÁ 2 NGÀY)</b>\n\n` +
          `🔔 Tag: <a href="tg://user?id=${process.env.TELEGRAM_BONG || ''}">@BONG</a>\n\n` +
          `📦 ID: <code>${item.package_id}</code>\n` +
          `🏷 Tên: <b>${escTg(item.name)}</b>\n` +
          `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
          `📅 Ngày nhập: ${fmtTimeLocal(item.created_at)}\n\n` +
          `👉 <i>Vui lòng kiểm tra và đăng bán sản phẩm này!</i>`;

        const markup = {
          inline_keyboard: [[
            { text: "🔴 Post Ngay", callback_data: `posted:${item.id}` }
          ]]
        };

        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: taskChatId, text: msg, parse_mode: "HTML", reply_markup: markup })
          });
          const data = await res.json();
          if (data.ok) {
            await db.execute({
              sql: "UPDATE items SET post_task_msg_id = ?, post_task_chat_id = ? WHERE id = ?",
              args: [String(data.result.message_id), String(taskChatId), item.id]
            });
          }
        } catch (e) { console.error("Unposted reminder send failed:", e); }
      }
      lastUnpostedCheck = today;
    }
  } catch (e) { console.error("Scheduler error:", e); }
}, 30000);


function buildItemQuery(req) {
  const q = req.query.q;
  const status = req.query.status;
  const inventory = req.query.inventory;
  const tab = req.query.tab;
  const posted = req.query.posted;

  const where = ["is_deleted = 0", "NOT (is_order = 1 AND status = 'ORDERED')"];
  const params = [];
  const like = `%${q}%`;

  if (q) {
    where.push(
      `(package_id LIKE ? OR name LIKE ? OR serial_clean LIKE ? OR tracking_code LIKE ?)`
    );
    params.push(like, like, like, like);
  }

  if (tab === 'stock') {
    where.push(`status IN ('CREATED', 'SOLD')`);
  } else if (tab === 'shipped') {
    where.push(`status = 'SHIPPED'`);
  } else if (tab === 'return') {
    where.push(`status IN ('HENBIN', 'RETURNED', 'RETURN', 'REQUEST_RETURN')`);
  } else if (tab === 'not_logged') {
    where.push(`is_meru_logged = 0 AND status NOT IN ('SHIPPED', 'RETURNED', 'HENBIN', 'RETURN', 'REQUEST_RETURN')`);
  } else if (tab === 'not_posted') {
    where.push(`is_posted = 0 AND status NOT IN ('SHIPPED', 'RETURNED', 'HENBIN', 'RETURN', 'REQUEST_RETURN')`);
  } else if (status) {
    where.push(`status = ?`);
    params.push(status);
  }

  if (inventory) {
    where.push(`inventory_status = ?`);
    params.push(inventory);
  }

  if (posted === '1') {
    where.push(`is_posted = 1`);
  } else if (posted === '0') {
    where.push(`is_posted = 0`);
  }

  return { where, params };
}

// ====== List/search ======
app.get("/api/items", requireAuth, async (req, res) => {
  const { where, params } = buildItemQuery(req);

  const sql = `
    SELECT id, package_id, name, serial_clean, mvd, status, inventory_status, is_posted, last_inventory_at, created_at, updated_at, category, buy_price, sold_price, ship_fee, profit, link
    FROM items
    WHERE ${where.join(" AND ")}
    ORDER BY datetime(updated_at) DESC
    LIMIT 1000
  `;

  const { rows } = await db.execute({ sql, args: params });

  // Lấy thống kê số lượng theo loại dựa trên bộ lọc hiện tại
  const summarySql = `
    SELECT coalesce(category, 'else') as category, COUNT(*) as count 
    FROM items 
    WHERE ${where.join(" AND ")}
    GROUP BY category
  `;
  const { rows: summaryRows } = await db.execute({ sql: summarySql, args: params });

  res.json({ rows, summary: summaryRows });
});

app.post("/api/items/export", requireAuth, requireStaff, async (req, res) => {
  const { where, params } = buildItemQuery(req);
  const date_key = yyyymmddLocal();

  try {
    const { rows } = await db.execute({
      sql: `
        SELECT category, name, serial_clean, tracking_code, package_id, mvd, status, inventory_status, created_at, updated_at
        FROM items
        WHERE ${where.join(" AND ")}
        ORDER BY category ASC, name ASC
      `,
      args: params
    });

    if (rows.length === 0) {
      return res.json({ ok: true, url: null, count: 0, message: "No data" });
    }

    const header = ["Category", "Name", "Serial", "Tracking", "PackageID", "MVD", "Status", "InventoryStatus", "Created", "Updated"];
    const csv = [header.join(",")]
      .concat(
        rows.map((r) =>
          [
            csvCell(r.category),
            csvCell(r.name),
            csvCell(r.serial_clean),
            csvCell(r.tracking_code),
            csvCell(r.package_id),
            csvCell(r.mvd),
            csvCell(r.status),
            csvCell(r.inventory_status),
            csvCell(r.created_at),
            csvCell(r.updated_at),
          ].join(",")
        )
      )
      .join("\n");

    const filename = `list_export_${date_key}_${Date.now()}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);
    fs.writeFileSync(filePath, csv, "utf8");
    const url = `/exports/${filename}`;

    await db.execute({
      sql: `
        INSERT INTO inventory_exports(date_key, actor, filename, url, row_count, created_at)
        VALUES(?,?,?,?,?,?)
      `,
      args: [date_key, req.user, filename, url, rows.length, nowISO()]
    });

    res.json({ ok: true, url, count: rows.length, filename });

    // Gửi Telegram (Plain Text)
    sendTelegramDocument(filePath, `Báo cáo Danh sách (Filter)\nNgày: ${date_key}\nSố lượng: ${rows.length} món\nNgười xuất: ${req.user}`)
      .catch(e => console.error("Telegram export notify failed:", e));

  } catch (e) {
    res.status(500).json({ error: "Export failed: " + e.message });
  }
});

// ====== Scan: fetch by token ======
app.get("/api/scan/:token", requireAuth, async (req, res) => {
  const { token } = req.params;
  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE token = ?", args: [token] });
  const item = rows[0];
  if (!item) {
    console.warn(`[SCAN-REJECT] user=${req.user} token="${token}" không tồn tại (QR cũ hoặc sai mã)`);
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ item });
});

// ====== Inventory work ======
app.post("/api/inventory/add", requireAuth, requireStaff, async (req, res) => {
  const { token, serial } = req.body || {};
  if (!token && !serial) {
    console.warn(`[SCAN-REJECT] user=${req.user} thiếu token/serial`);
    return res.status(400).json({ error: "Thiếu token hoặc serial" });
  }

  let item;
  if (token) {
    const { rows: itemRows } = await db.execute({ sql: "SELECT * FROM items WHERE token = ?", args: [token] });
    item = itemRows[0];
  } else {
    const cleanSerial = serial.trim();
    // Tìm kiếm theo serial_clean, serial_raw hoặc package_id
    const { rows: itemRows } = await db.execute({
      sql: "SELECT * FROM items WHERE (LOWER(serial_clean) = LOWER(?) OR serial_raw = ? OR package_id = ?) AND is_deleted = 0",
      args: [cleanSerial, cleanSerial, cleanSerial]
    });
    if (itemRows.length === 0) {
      console.warn(`[SCAN-REJECT] user=${req.user} serial="${serial}" không tìm thấy sản phẩm`);
      return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
    }
    
    // Ưu tiên sản phẩm chưa được xuất (status !== 'SHIPPED')
    const activeItems = itemRows.filter(x => x.status !== 'SHIPPED');
    if (activeItems.length > 0) {
      item = activeItems[0];
    } else {
      item = itemRows[0];
    }
  }

  if (!item) {
    console.warn(`[SCAN-REJECT] user=${req.user} token="${token}" không tìm thấy sản phẩm`);
    return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
  }
  if (item.is_deleted === 1 || item.status === "DELETED") {
    console.warn(`[SCAN-REJECT] user=${req.user} ${item.package_id} đã bị xóa`);
    return res.status(400).json({ error: "Sản phẩm đã bị xóa" });
  }
  if (item.status === "SHIPPED") {
    console.warn(`[SCAN-REJECT] user=${req.user} ${item.package_id} đã giao, không thể kiểm kho lại`);
    return res.status(400).json({ error: `Hàng đã giao (${item.package_id}), không thể kiểm kho lại.` });
  }

  const date_key = yyyymmddLocal();
  const scanned_at = nowISO();

  // Lưu ý: nếu lỗi giữa chừng (vd UNIQUE khi scan trùng) mà không rollback thì
  // transaction ghi bị treo giữ lock SQLite -> mọi ghi sau đó dính SQLITE_BUSY
  // "database is locked" cho tới khi restart server. Bắt buộc rollback trong catch.
  let tx;
  try {
    tx = await db.transaction("write");

    // 1. Thêm vào bảng công việc kiểm kê ngày hôm nay
    await tx.execute({
      sql: `
      INSERT INTO inventory_work(date_key, token, item_id, package_id, name, mvd, serial, actor, scanned_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `,
      args: [
        date_key,
        item.token,
        item.id,
        item.package_id || "",
        item.name || "",
        item.mvd || "",
        item.serial_clean || item.serial_raw || "",
        req.user,
        scanned_at
      ]
    });

    // 2. Cập nhật trạng thái trong bảng items chính
    await tx.execute({
      sql: `UPDATE items SET inventory_status = 'IN_STOCK', last_inventory_at = ?, updated_at = ? WHERE id = ?`,
      args: [scanned_at, scanned_at, item.id]
    });

    // 3. Ghi nhật ký kiểm kê (Inventory Logs)
    await tx.execute({
      sql: `INSERT INTO inventory_logs(item_id, action, actor, created_at) VALUES(?,?,?,?)`,
      args: [item.id, 'IN_STOCK', req.user, scanned_at]
    });

    await tx.commit();
    res.json({ ok: true, item });
  } catch (e) {
    if (tx) { try { await tx.rollback(); } catch { /* tx đã đóng */ } }
    if (e.message && e.message.includes("UNIQUE constraint failed")) {
      console.warn(`[SCAN-REJECT] user=${req.user} ${item.package_id} đã được kiểm kê hôm nay (scan trùng)`);
      return res.status(400).json({ error: `Sản phẩm "${item.name}" đã được kiểm kê hôm nay rồi.`, item });
    }
    console.error(`[SCAN-ERROR] user=${req.user} ${item.package_id}:`, e.message);
    res.status(500).json({ error: e.message || "DB error" });
  }
});

app.get("/api/inventory/today", requireAuth, async (req, res) => {
  const date_key = yyyymmddLocal();
  const { rows } = await db.execute({
    sql: `
    SELECT w.package_id, w.name, w.serial, w.mvd, w.scanned_at, w.actor, w.token, i.category
    FROM inventory_work w
    LEFT JOIN items i ON w.item_id = i.id
    WHERE w.date_key = ?
    ORDER BY datetime(w.scanned_at) DESC
  `,
    args: [date_key]
  });

  res.json({ date_key, rows });
});

app.delete("/api/inventory/exports/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  const { rows } = await db.execute({
    sql: `SELECT id, filename FROM inventory_exports WHERE id = ?`,
    args: [id]
  });
  const row = rows[0];

  if (!row) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(EXPORT_DIR, row.filename);

  // xoá file csv (nếu file đã bị xoá trước đó vẫn cho xoá DB)
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    return res.status(500).json({ error: "Delete file failed" });
  }

  await db.execute({ sql: `DELETE FROM inventory_exports WHERE id = ?`, args: [id] });
  res.json({ ok: true });
});

app.post("/api/inventory/reset", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: `UPDATE items SET inventory_status = 'UNKNOWN', last_inventory_at = NULL WHERE is_deleted = 0`,
      args: []
    });
    res.json({ ok: true, message: "Đã reset toàn bộ trạng thái kiểm kho về UNKNOWN." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/inventory/export", requireAuth, requireStaff, async (req, res) => {
  const date_key = yyyymmddLocal();

  let tx;
  try {
    tx = await db.transaction("write");

    // 1. Lấy hàng đã quét hôm nay (kèm category)
    const { rows: scanned } = await tx.execute({
      sql: `
        SELECT w.package_id, w.name, w.serial, w.mvd, w.scanned_at, w.actor, 'OK' as audit_status, i.category
        FROM inventory_work w
        LEFT JOIN items i ON w.item_id = i.id
        WHERE w.date_key = ?
        ORDER BY datetime(w.scanned_at) DESC
      `,
      args: [date_key]
    });

    // 2. Lấy hàng còn đang UNKNOWN (chưa quét - kèm category)
    const { rows: missing } = await tx.execute({
      sql: `
        SELECT package_id, name, serial_clean as serial, mvd, '-' as scanned_at, '-' as actor, 'MISSING' as audit_status, category
        FROM items
        WHERE inventory_status = 'UNKNOWN' 
          AND is_deleted = 0 
          AND status NOT IN ('SHIPPED', 'RETURN', 'RETURNED', 'HENBIN', 'REQUEST_RETURN')
        ORDER BY category ASC, name ASC
      `,
      args: []
    });

    const allRows = [...scanned, ...missing];

    if (allRows.length === 0) {
      await tx.rollback();
      return res.json({ ok: true, url: null, count: 0, message: "No data" });
    }

    const header = ["status", "category", "time", "package_id", "mvd", "serial", "name", "actor"];
    const csv = [header.join(",")]
      .concat(
        allRows.map((r) =>
          [
            csvCell(r.audit_status),
            csvCell(r.category || "unknown"),
            csvCell(r.scanned_at),
            csvCell(r.package_id),
            csvCell(r.mvd),
            csvCell(r.serial),
            csvCell(r.name),
            csvCell(r.actor),
          ].join(",")
        )
      )
      .join("\n");

    const filename = `inventory_audit_${date_key}_${Date.now()}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);

    fs.writeFileSync(filePath, csv, "utf8");

    const url = `/exports/${filename}`;

    await tx.execute({
      sql: `
      INSERT INTO inventory_exports(date_key, actor, filename, url, row_count, created_at)
      VALUES(?,?,?,?,?,?)
    `,
      args: [date_key, req.user, filename, url, allRows.length, nowISO()]
    });

    await tx.execute({
      sql: `DELETE FROM inventory_work WHERE date_key = ?`,
      args: [date_key]
    });

    await tx.commit();
    res.json({ ok: true, url, count: allRows.length, filename });

    // Gửi Telegram (Plain Text)
    sendTelegramDocument(filePath, `Báo cáo Kiểm kê Kho (Audit)\nNgày: ${date_key}\nSố lượng: ${allRows.length} món\nNgười xuất: ${req.user}`)
      .catch(e => console.error("Telegram inventory export notify failed:", e));

  } catch (e) {
    if (tx) { try { await tx.rollback(); } catch { /* tx đã đóng */ } }
    console.error("[EXPORT-ERROR]", e.message);
    res.status(500).json({ error: "Export failed" });
  }
});

app.get("/api/inventory/exports", requireAuth, async (req, res) => {
  const { rows } = await db.execute({
    sql: `
    SELECT id, date_key, actor, filename, url, row_count, created_at
    FROM inventory_exports
    ORDER BY datetime(created_at) DESC
    LIMIT 200
  `
  });
  res.json({ rows });
});

// ====== Update status (ship/henbin) ======
app.post("/api/items/:id/status", requireAuth, requireStaff, async (req, res) => {
  const { id } = req.params;
  const { to_status } = req.body;

  const allowed = new Set(["SHIPPED", "RETURN", "RETURNED", "HENBIN", "CREATED", "REQUEST_RETURN"]);
  if (!allowed.has(to_status)) return res.status(400).json({ error: "Invalid status" });

  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] });
  const item = rows[0];

  if (!item) {
    console.warn(`[STATUS-REJECT] user=${req.user} item=${id} không tồn tại`);
    return res.status(404).json({ error: "Not found" });
  }
  if (item.is_deleted === 1 || item.status === "DELETED") {
    console.warn(`[STATUS-REJECT] user=${req.user} ${item.package_id} đã bị xóa, không đổi được trạng thái`);
    return res.status(400).json({ error: "Item is deleted" });
  }

  const from_status = item.status;
  const updated_at = nowISO();

  let inventory_status = item.inventory_status;
  let shipped_at = item.shipped_at;

  const returnStatuses = new Set(["RETURN", "RETURNED", "HENBIN", "REQUEST_RETURN"]);
  let created_at = item.created_at;

  if (to_status === "SHIPPED") {
    inventory_status = "NOT_IN_STOCK";
    shipped_at = updated_at;
  } else if (returnStatuses.has(to_status)) {
    inventory_status = "NOT_IN_STOCK";
    // Reset created_at to current time so stock days starts from 0
    created_at = updated_at;
  }

  await db.execute({
    sql: "UPDATE items SET status = ?, inventory_status = ?, shipped_at = ?, created_at = ?, updated_at = ? WHERE id = ?",
    args: [to_status, inventory_status, shipped_at, created_at, updated_at, id]
  });

  // CHỈ ghi log nếu trạng thái thay đổi
  if (from_status !== to_status) {
    await db.execute({
      sql: `
      INSERT INTO status_logs(item_id, from_status, to_status, actor, created_at)
      VALUES(?, ?, ?, ?, ?)
    `,
      args: [id, from_status, to_status, req.user, updated_at]
    });

    // Dong bo Telegram
    syncTelegramButtons(id).catch(e => console.error("Sync TG status failed:", e));
  }

  res.json({ ok: true });
});

// ====== Inventory: In stock ======
app.post("/api/items/:id/inventory", requireAuth, requireStaff, async (req, res) => {
  const { id } = req.params;
  const { inventory_status } = req.body;

  const allowed = new Set(["IN_STOCK", "NOT_IN_STOCK", "UNKNOWN"]);
  if (!allowed.has(inventory_status)) return res.status(400).json({ error: "Invalid inventory_status" });

  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] });
  const item = rows[0];
  if (!item) return res.status(404).json({ error: "Not found" });
  if (item.is_deleted === 1 || item.status === "DELETED") {
    return res.status(400).json({ error: "Item is deleted" });
  }

  const from_inv = item.inventory_status;
  const t = nowISO();

  await db.execute({
    sql: "UPDATE items SET inventory_status = ?, last_inventory_at = ?, last_inventory_by = ?, updated_at = ? WHERE id = ?",
    args: [inventory_status, t, req.user, t, id]
  });

  // CHỈ ghi log nếu trạng thái kho thay đổi
  if (from_inv !== inventory_status) {
    await db.execute({
      sql: `
      INSERT INTO inventory_logs(item_id, action, actor, created_at)
      VALUES(?, ?, ?, ?)
    `,
      args: [id, inventory_status, req.user, t]
    });
  }

  res.json({ ok: true });
});

app.post("/api/items/:id/posted", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { is_posted } = req.body;

  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] });
  const item = rows[0];
  if (!item) return res.status(404).json({ error: "Not found" });

  const updated_at = nowISO();
  const next_val = is_posted ? 1 : 0;

  await db.execute({
    sql: "UPDATE items SET is_posted = ?, updated_at = ? WHERE id = ?",
    args: [next_val, updated_at, id]
  });

  // Chỉ ghi log nếu giá trị thực sự thay đổi
  if (item.is_posted !== next_val) {
    await db.execute({
      sql: `INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)`,
      args: [id, req.user, JSON.stringify({ is_posted: next_val }), updated_at]
    });

    // Dong bo nut bam Telegram neu co
    syncTelegramButtons(id).catch(e => console.error("Sync TG Posted failed:", e));
  }

  res.json({ ok: true });
});

// ====== Toggle Meru Logged Status ======
app.post("/api/items/:id/meru-logged", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { is_meru_logged } = req.body;

  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] });
  const item = rows[0];
  if (!item) return res.status(404).json({ error: "Not found" });

  const updated_at = nowISO();
  const next_val = is_meru_logged ? 1 : 0;

  await db.execute({
    sql: "UPDATE items SET is_meru_logged = ?, updated_at = ? WHERE id = ?",
    args: [next_val, updated_at, id]
  });

  if (item.is_meru_logged !== next_val) {
    await db.execute({
      sql: `INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)`,
      args: [id, req.user, JSON.stringify({ is_meru_logged: next_val }), updated_at]
    });

    // Dong bo nut bam Telegram neu co
    syncTelegramButtons(id).catch(e => console.error("Sync TG Meru failed:", e));
  }

  res.json({ ok: true });
});

// ====== Public Secure API for Telegram Web App ======
app.get("/api/public/item", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE token = ? AND is_deleted = 0", args: [token] });
    const item = rows[0];
    if (!item) return res.status(404).json({ error: "Item not found" });

    res.json({
      mvd: item.mvd || "",
      name: item.name || "",
      serial: item.serial_clean || "",
      condition: item.condition || "",
      battery: item.battery || "",
      coverage: item.coverage || "",
      note: item.note || ""
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/public/item", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE token = ? AND is_deleted = 0", args: [token] });
    const item = rows[0];
    if (!item) return res.status(404).json({ error: "Item not found" });

    const fields = req.body;
    const allowed = ["name", "serial_raw", "serial_clean", "condition", "mvd", "note", "battery", "coverage"];
    const updates = {};

    const rawSerial = fields.serial !== undefined ? fields.serial : (fields.serial_raw !== undefined ? fields.serial_raw : item.serial_raw);

    updates.name = (fields.name !== undefined ? fields.name : item.name) || "";
    updates.serial_raw = (rawSerial !== undefined ? rawSerial : item.serial_raw) || "";
    updates.condition = (fields.condition !== undefined ? fields.condition : item.condition) || "";
    updates.mvd = (fields.mvd !== undefined ? fields.mvd : item.mvd) || "";
    updates.note = (fields.note !== undefined ? fields.note : item.note) || "";
    updates.battery = (fields.battery !== undefined ? fields.battery : item.battery) || "";
    updates.coverage = (fields.coverage !== undefined ? fields.coverage : item.coverage) || "";

    updates.serial_clean = (updates.serial_raw.match(/[A-Z0-9]{4,}/i)?.[0] ?? "").trim();

    const changes = {};
    for (const k of allowed) {
      const oldValue = item[k] ?? "";
      const newValue = String(updates[k] ?? "").trim();
      if (oldValue !== newValue) {
        changes[k] = { from: oldValue, to: newValue };
      }
    }

    if (Object.keys(changes).length > 0) {
      const updated_at = nowISO();
      const actor = "TelegramWebApp";

      await db.execute({
        sql: `
          UPDATE items SET
            name = ?,
            serial_raw = ?,
            serial_clean = ?,
            condition = ?,
            mvd = ?,
            note = ?,
            battery = ?,
            coverage = ?,
            updated_at = ?
          WHERE id = ?
        `,
        args: [
          updates.name,
          updates.serial_raw,
          updates.serial_clean,
          updates.condition,
          updates.mvd,
          updates.note,
          updates.battery,
          updates.coverage,
          updated_at,
          item.id
        ]
      });

      await db.execute({
        sql: `INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)`,
        args: [item.id, actor, JSON.stringify(changes), updated_at]
      });

      // Synchronize back to Telegram
      await syncTelegramButtons(item.id);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Shortcut API: Mark as Posted by Serial ======
app.post("/api/external/mark-posted", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.SHORTCUT_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const serial = (req.body.serial ?? "").trim();
  if (!serial || serial.length < 4) {
    return res.status(400).json({ error: "Missing or too short serial" });
  }

  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM items WHERE (LOWER(serial_clean) = LOWER(?) OR serial_raw = ?) AND is_deleted = 0 LIMIT 1",
      args: [serial, serial]
    });
    const item = rows[0];

    if (!item) {
      return res.json({ ok: false, error: `Serial not found: ${serial}` });
    }

    if (item.is_posted) {
      return res.json({ ok: true, already: true, message: `Already posted: ${item.package_id} (${item.serial_clean})` });
    }

    const updated_at = nowISO();
    await db.execute({ sql: "UPDATE items SET is_posted = 1, updated_at = ? WHERE id = ?", args: [updated_at, item.id] });
    await db.execute({
      sql: "INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)",
      args: [item.id, "Shortcut", JSON.stringify({ is_posted: 1, method: "shortcut" }), updated_at]
    });

    // Sync Telegram buttons
    syncTelegramButtons(item.id).catch(e => console.error("Sync TG mark-posted failed:", e));

    // Send TG notification to group
    try {
      const msg = `✅ <b>Đã đăng (Shortcut)</b>\n📦 ID: <code>${item.package_id}</code>\n🏷️ ${escTg(item.name)}\n🔢 Serial: <code>${item.serial_clean || "-"}</code>`;
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: DELETE_GROUP_CHAT_ID, text: msg, parse_mode: "HTML" })
      });
    } catch (e) { console.error("TG notify mark-posted failed:", e); }

    res.json({ ok: true, message: `Marked as posted: ${item.package_id} — ${item.name} (${item.serial_clean})` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Batch Update Posted Status by Serials ======
app.post("/api/items/batch-posted", requireAuth, async (req, res) => {
  const { serials_text } = req.body;
  if (!serials_text) return res.status(400).json({ error: "Missing serials_text" });

  const serials = serials_text.split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);

  if (serials.length === 0) return res.status(400).json({ error: "No valid serials found" });

  try {
    const updated_at = nowISO();
    let totalUpdated = 0;
    const notFound = [];
    const alreadyPosted = [];

    for (const sn of serials) {
      // Tìm máy theo serial_clean hoặc serial_raw
      const { rows } = await db.execute({
        sql: "SELECT id, is_posted FROM items WHERE (LOWER(serial_clean) = LOWER(?) OR serial_raw = ?) AND is_deleted = 0",
        args: [sn, sn]
      });

      if (rows.length === 0) {
        notFound.push(sn);
        continue;
      }

      for (const item of rows) {
        if (!item.is_posted) {
          await db.execute({
            sql: "UPDATE items SET is_posted = 1, updated_at = ? WHERE id = ?",
            args: [updated_at, item.id]
          });

          await db.execute({
            sql: `INSERT INTO edit_logs(item_id, actor, changes_json, created_at) VALUES(?,?,?,?)`,
            args: [item.id, req.user, JSON.stringify({ is_posted: 1, method: "batch" }), updated_at]
          });
          totalUpdated++;
        } else {
          // Nếu đã đăng rồi, thêm vào danh sách bỏ qua để báo cáo
          if (!alreadyPosted.includes(sn)) alreadyPosted.push(sn);
        }
      }
    }

    res.json({ ok: true, count: totalUpdated, notFound, alreadyPosted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/items/:id", requireAuth, async (req, res) => {
  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id=?", args: [req.params.id] });
  const it = rows[0];
  if (!it) return res.status(404).json({ error: "Not found" });

  const allowed = ["name", "serial_raw", "serial_clean", "condition", "mvd", "note", "battery", "coverage"];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = String(req.body[k] ?? "").trim();

  const changes = {};
  for (const k of Object.keys(updates)) {
    if ((it[k] ?? "") !== updates[k]) changes[k] = { from: it[k] ?? "", to: updates[k] };
  }

  const updated_at = nowISO();
  await db.execute({
    sql: `
    UPDATE items SET
      name=?,
      serial_raw=?,
      serial_clean=?,
      condition=?,
      mvd=?,
      note=?,
      battery=?,
      coverage=?,
      updated_at=?
    WHERE id=?
  `,
    args: [
      updates.name ?? it.name,
      updates.serial_raw ?? it.serial_raw,
      updates.serial_clean ?? it.serial_clean,
      updates.condition ?? it.condition,
      updates.mvd ?? it.mvd,
      updates.note ?? it.note,
      updates.battery ?? it.battery,
      updates.coverage ?? it.coverage,
      updated_at,
      req.params.id
    ]
  });

  if (Object.keys(changes).length) {
    await db.execute({
      sql: `
      INSERT INTO edit_logs(item_id, actor, changes_json, created_at)
      VALUES(?,?,?,?)
    `,
      args: [req.params.id, req.user, JSON.stringify(changes), updated_at]
    });
  }

  res.json({ ok: true });
});

app.get("/api/items/:id", requireAuth, async (req, res) => {
  const id = req.params.id;
  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] });
  const item = rows[0];
  if (!item) return res.status(404).json({ error: "Not found" });

  const scanUrl = `${req.protocol}://${req.get("host")}/scan.html?token=${encodeURIComponent(item.token)}`;
  const qrDataUrl = await QRCode.toDataURL(item.token, { margin: 1, width: 400, errorCorrectionLevel: 'L' });

  res.json({ item, scanUrl, qrDataUrl });
});

app.get("/api/items/:id/history", requireAuth, async (req, res) => {
  const id = req.params.id;

  const { rows: itemRows } = await db.execute({ sql: "SELECT created_at, created_by FROM items WHERE id = ?", args: [id] });
  const item = itemRows[0];
  if (!item) return res.status(404).json({ error: "Not found" });

  const [statusLogs, invLogs, editLogs] = await Promise.all([
    db.execute({ sql: "SELECT 'status' as type, from_status, to_status, actor, created_at FROM status_logs WHERE item_id = ? ORDER BY created_at ASC", args: [id] }),
    db.execute({ sql: "SELECT 'inventory' as type, action, actor, created_at FROM inventory_logs WHERE item_id = ? ORDER BY created_at ASC", args: [id] }),
    db.execute({ sql: "SELECT 'edit' as type, changes_json, actor, created_at FROM edit_logs WHERE item_id = ? ORDER BY created_at ASC", args: [id] })
  ]);

  const history = [
    { type: 'created', actor: item.created_by || 'System', created_at: item.created_at },
    ...statusLogs.rows,
    ...invLogs.rows,
    ...editLogs.rows
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  res.json({ history });
});

// ====== Telegram Bot Diagnostics ======
app.post("/api/telegram/test", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    // 1. Thử gửi tin nhắn
    await sendTelegramMessage("🔔 <b>Hệ thống WMS:</b> Đang kiểm tra kết nối Bot...");

    // 2. Thử tạo và gửi file mẫu
    const testFile = path.join(EXPORT_DIR, "test_connection.csv");
    fs.writeFileSync(testFile, "ID,Name,Status\n1,Test Item,Success", "utf8");

    await sendTelegramDocument(testFile, "📄 Đây là tệp tin kiểm tra từ hệ thống WMS.");

    res.json({ ok: true, message: "Đã gửi tin nhắn và file mẫu tới Telegram. Hãy kiểm tra điện thoại của bạn!" });
  } catch (e) {
    // Trả về nội dung lỗi chi tiết từ Telegram nếu có
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/telegram/test", requireAuth, requireAdmin, async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(400).json({ error: "Thiếu cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trên Render." });
  }

  try {
    const text = `🚀 <b>KẾT NỐI THÀNH CÔNG!</b>\n\nHệ thống WMS đã kết nối được với Telegram của bạn.\nThời gian: ${nowISO()}`;
    await sendTelegramMessage(text);
    res.json({ ok: true, message: "Đã gửi tin nhắn test thành công!" });
  } catch (e) {
    res.status(500).json({ error: "Gửi thất bại: " + e.message });
  }
});

// ====== Request Delete (any authenticated user) ======
app.post("/api/items/:id/request-delete", requireAuth, async (req, res) => {
  const id = req.params.id;

  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0", args: [id] });
  const item = rows[0];
  if (!item) return res.status(404).json({ error: "Không tìm thấy sản phẩm" });

  // Kiểm tra nếu đã có yêu cầu đang pending cho item này
  const { rows: pendingRows } = await db.execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING'",
    args: [id]
  });
  if (pendingRows[0]) {
    return res.status(409).json({ error: "Đã có yêu cầu xóa đang chờ duyệt cho sản phẩm này" });
  }

  const t = nowISO();

  // 1. Lưu yêu cầu xóa vào database
  await db.execute({
    sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)",
    args: [id, req.user, t]
  });

  const { rows: reqRows } = await db.execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
    args: [id]
  });
  const reqId = reqRows[0].id;

  // 2. Gửi thông báo Telegram (Yêu cầu xóa)
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken) {
    try {
      const targetChatId = DELETE_GROUP_CHAT_ID;
      const title = "🗑️ <b>YÊU CẦU XÓA SẢN PHẨM</b>";

      const msg = `${title}\n\n` +
        `📦 ID: <code>${item.package_id}</code>\n` +
        `🏷️ Tên: <b>${escTg(item.name)}</b>\n` +
        `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
        `📍 Trạng thái: ${item.status}\n` +
        `👤 Yêu cầu bởi: <b>${escTg(req.user)}</b>\n` +
        `⏰ Thời gian: ${fmtTimeLocal(t)}`;

      const buttons = [
        { text: "✅ Duyệt xóa", callback_data: `approve_delete:${reqId}` },
        { text: "❌ Từ chối", callback_data: `reject_delete:${reqId}` }
      ];



      const tgRes = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: targetChatId,
          text: msg,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [buttons] }
        })
      });
      const tgData = await tgRes.json();

      if (tgData.ok && tgData.result) {
        await db.execute({
          sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
          args: [String(tgData.result.chat.id), String(tgData.result.message_id), reqId]
        });
      }
    } catch (e) {
      console.error("Request-delete notify error:", e);
    }
  }

  res.json({ ok: true });
});

// ====== Request Return (Admin only) ======
app.post("/api/items/:id/request-return", requireAuth, requireAdmin, async (req, res) => {
  const id = req.params.id;

  const { rows } = await db.execute({ sql: "SELECT * FROM items WHERE id = ? AND is_deleted = 0", args: [id] });
  const item = rows[0];
  if (!item) return res.status(404).json({ error: "Không tìm thấy sản phẩm" });

  // Kiểm tra pending
  const { rows: pendingRows } = await db.execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING'",
    args: [id]
  });
  if (pendingRows[0]) return res.status(409).json({ error: "Đã có yêu cầu đang chờ duyệt cho sản phẩm này" });

  const t = nowISO();

  // 1. Đổi trạng thái thành REQUEST_RETURN
  await db.execute({
    sql: "UPDATE items SET status = 'REQUEST_RETURN', updated_at = ? WHERE id = ?",
    args: [t, id]
  });

  // 2. Lưu yêu cầu vào DB
  await db.execute({
    sql: "INSERT INTO delete_requests (item_id, requested_by, status, created_at) VALUES (?, ?, 'PENDING', ?)",
    args: [id, req.user, t]
  });

  const { rows: reqRows } = await db.execute({
    sql: "SELECT id FROM delete_requests WHERE item_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
    args: [id]
  });
  const reqId = reqRows[0].id;

  // 3. Thông báo Telegram tới Group Return & Delete
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken) {
    try {
      const returnGroupId = process.env.RETURN_GROUP_CHAT_ID;
      const taskGroupId = process.env.TASK_GROUP_CHAT_ID || returnGroupId;
      const title = "📦 <b>YÊU CẦU RETURN & XÓA</b>";

      const msg = `${title}\n\n` +
        `📦 ID: <code>${item.package_id}</code>\n` +
        `🏷️ Tên: <b>${escTg(item.name)}</b>\n` +
        `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
        `📍 Trạng thái: ${item.status} ➔ <b>REQUEST_RETURN</b>\n` +
        `👤 Yêu cầu bởi: <b>${escTg(req.user)}</b>` + (process.env.TELEGRAM_AARON ? `\n🔔 Tag: <a href="tg://user?id=${process.env.TELEGRAM_AARON}">@AARON</a>` : "") + `\n` +
        `⏰ Thời gian: ${fmtTimeLocal(t)}`;

      const buttons = [
        { text: "✅ Duyệt xóa", callback_data: `approve_delete:${reqId}` },
        { text: "❌ Từ chối", callback_data: `reject_delete:${reqId}` }
      ];

      if (item.tg_chat_id && item.tg_msg_id) {
        const cleanChatId = String(item.tg_chat_id).replace("-100", "");
        buttons.push({ text: "🔗 Xem tin gốc", url: `https://t.me/c/${cleanChatId}/${item.tg_msg_id}` });
      }



      const tgRes = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: returnGroupId,
          text: msg,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [buttons] }
        })
      });
      const tgData = await tgRes.json();

      if (tgData.ok && tgData.result) {
        await db.execute({
          sql: "UPDATE delete_requests SET tg_chat_id = ?, tg_msg_id = ? WHERE id = ?",
          args: [String(tgData.result.chat.id), String(tgData.result.message_id), reqId]
        });
      }

      // Gửi task message
      const taskMsg = `📝 <b>TASK: KIỂM TRA HÀNG RETURN</b>\n\n` +
        `📦 ID: <code>${item.package_id}</code>\n` +
        `🏷️ Tên: <b>${escTg(item.name)}</b>\n` +
        `🔢 Serial: <code>${item.serial_clean || "-"}</code>\n` +
        `👤 Người yêu cầu: ${escTg(req.user)}`;

      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: taskGroupId, text: taskMsg, parse_mode: "HTML" })
      });

    } catch (e) {
      console.error("Request-return notify error:", e);
    }
  }

  res.json({ ok: true });
});

app.post("/api/items/:id/delete", requireAuth, requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { rows } = await db.execute({
    sql: "SELECT id, package_id, name, tg_chat_id, tg_msg_id, post_task_msg_id FROM items WHERE id=?",
    args: [id]
  });
  const item = rows[0];
  if (!item) return res.status(404).json({ error: "Not found" });

  const t = nowISO();
  await db.execute({
    sql: `
    UPDATE items
    SET is_deleted=1,
        status='DELETED',
        deleted_at=?,
        deleted_by=?,
        updated_at=?
    WHERE id=?
  `,
    args: [t, req.user, t, id]
  });

  // Gửi thông báo Telegram về việc đã xóa
  const msg = `🔔 <b>HỆ THỐNG: ĐÃ XÓA SẢN PHẨM (TỪ WEB)</b>\n\n` +
    `📦 ID: <code>${item.package_id}</code>\n` +
    `🏷️ Tên: <b>${escTg(item.name)}</b>\n` +
    `👤 Người xóa: <b>${escTg(req.user)}</b>\n` +
    `⏰ Thời gian: ${fmtTimeLocal(t)}`;
  await sendTelegramMessage(msg, NOTIFICATION_GROUP_CHAT_ID);

  // Xóa tin nhắn gốc trên Telegram (nếu có)
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    // 1. Xóa tin nhắn tạo hàng ban đầu
    if (item.tg_chat_id && item.tg_msg_id) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: item.tg_chat_id, message_id: Number(item.tg_msg_id) })
        });
      } catch (e) { console.error("Xóa tin nhắn gốc TG lỗi:", e.message); }
    }
    // 2. Xóa tin nhắn nhắc nhở/task (nếu có)
    if (item.post_task_msg_id) {
      const taskChatId = process.env.TASK_GROUP_CHAT_ID || process.env.RETURN_GROUP_CHAT_ID;
      if (taskChatId) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: taskChatId, message_id: Number(item.post_task_msg_id) })
          });
        } catch (e) { console.error("Xóa tin nhắn task TG lỗi:", e.message); }
      }
    }
  }

  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user, role: req.role });
});


// ====== Category Management ======
app.get("/api/categories", requireAuth, requireSuperAdmin, async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM category_rules ORDER BY id ASC");
  res.json({ rows });
});

app.post("/api/categories", requireAuth, requireSuperAdmin, async (req, res) => {
  const { id, name, keywords, priority } = req.body;
  if (!name || !keywords) return res.status(400).json({ error: "Missing name or keywords" });

  try {
    if (id) {
      await db.execute({
        sql: "UPDATE category_rules SET name = ?, keywords = ?, priority = ? WHERE id = ?",
        args: [name, keywords, priority || 0, id]
      });
    } else {
      await db.execute({
        sql: "INSERT INTO category_rules (name, keywords, priority) VALUES (?, ?, ?)",
        args: [name, keywords, priority || 0]
      });
    }
    await loadCategories(); // Reload cache
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/categories/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM category_rules WHERE id = ?", args: [req.params.id] });
    await loadCategories(); // Reload cache
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/categories/reclassify", requireAuth, requireAdmin, async (req, res) => {
  let tx;
  try {
    const { rows: items } = await db.execute("SELECT id, name FROM items WHERE is_deleted = 0");
    tx = await db.transaction("write");

    for (const item of items) {
      const cat = detectCategory(item.name);
      await tx.execute({
        sql: "UPDATE items SET category = ? WHERE id = ?",
        args: [cat, item.id]
      });
    }

    await tx.commit();
    res.json({ ok: true, count: items.length });
  } catch (e) {
    if (tx) { try { await tx.rollback(); } catch { /* tx đã đóng */ } }
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/bong-stats", requireAuth, requireAdmin, async (req, res) => {
  try {
    const bongUser = process.env.BONG_USER || 'bong';
    const { rows } = await db.execute({
      sql: `
        SELECT 
          substr(created_at, 1, 7) as month,
          count(distinct item_id) as count
        FROM edit_logs
        WHERE (
            actor = ? 
            OR lower(actor) = 'bong' 
            OR lower(actor) LIKE '%dang%' 
            OR lower(actor) LIKE '%bong%'
          )
          AND (
            changes_json LIKE '%"is_posted":1%'
            OR changes_json LIKE '%"is_posted":true%'
          )
        GROUP BY month
        ORDER BY month DESC
      `,
      args: [bongUser]
    });
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/debug-edit-logs", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: actors } = await db.execute("SELECT DISTINCT actor, count(*) as count FROM edit_logs GROUP BY actor");
    const { rows: sampleLogs } = await db.execute(`
      SELECT id, item_id, actor, changes_json, created_at 
      FROM edit_logs 
      WHERE changes_json LIKE '%is_posted%'
      ORDER BY datetime(created_at) DESC
      LIMIT 50
    `);
    res.json({ actors, sampleLogs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Start server ======
// Dong bo tat ca cac nut bam tren Telegram (Status, Posted, MeruLogged)
async function syncTelegramButtons(itemId) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, package_id, token, name, serial_clean, condition, status, is_posted, is_meru_logged, tg_chat_id, tg_msg_id, created_at, mvd, battery, coverage, note FROM items WHERE id = ?",
      args: [itemId]
    });
    const item = rows[0];
    if (!item || !item.tg_chat_id || !item.tg_msg_id) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;

    // 1. Quay lai Caption don gian
    const captionData = {
      mvd: item.mvd || "",
      name: item.name || "",
      serial: item.serial_clean || "",
      condition: item.condition || "",
      battery: item.battery || "",
      coverage: item.coverage || "",
      note: item.note || ""
    };
    let caption = `<code>${escTg(JSON.stringify(captionData))}</code>`;

    if (process.env.APP_URL) {
      caption += `\n\n🔗 <a href="${process.env.APP_URL}/item.html?id=${item.id}">Xem chi tiết trên Web</a>`;
    }

    const firstRow = [
      { text: `${{ SHIPPED: '🟢', RETURN: '⚫', RETURNED: '⚫', CREATED: '🟡', REQUEST_RETURN: '🟠' }[item.status] || '⬜'} ${item.status}`, callback_data: "none" },
      { text: "↩️", callback_data: `request_return_tg:${item.id}` }
    ];

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
    await fetch(url, {
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

  } catch (e) {
    console.error("syncTelegramButtons error:", e);
  }
}

app.listen(3000, "0.0.0.0", () => {
  console.log("WMS running:");
  console.log(" - http://localhost:3000/login.html");
  console.log("\n📋 Telegram Groups:");
  console.log(` - DELETE_GROUP_CHAT_ID: ${DELETE_GROUP_CHAT_ID || "❌ NOT SET"}`);
  console.log(` - RETURN_GROUP_CHAT_ID: ${RETURN_GROUP_CHAT_ID || "❌ NOT SET"}`);
  console.log(` - TASK_GROUP_CHAT_ID: ${TASK_GROUP_CHAT_ID || "❌ NOT SET"}`);
  console.log(` - NOTIFICATION_GROUP_CHAT_ID: ${NOTIFICATION_GROUP_CHAT_ID || "❌ NOT SET"}\n`);
});