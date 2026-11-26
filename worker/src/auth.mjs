import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verifyPassword } from "./password.mjs";

export const SESSION_COOKIE = "wms_auth";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const USER_SOURCES = [
  ["ADMIN_USER", "ADMIN_PASS_HASH", "admin"],
  ["STAFF_USER", "STAFF_PASS_HASH", "staff"],
  ["BONG_USER", "BONG_PASS_HASH", "entry"],
];

/** List the accounts the environment defines, by username. */
export function loadUsers(env) {
  const users = new Map();
  for (const [userVar, hashVar, role] of USER_SOURCES) {
    if (env[userVar] && env[hashVar]) {
      users.set(env[userVar], { passwordHash: env[hashVar], role });
    }
  }
  return users;
}

/** Check a username and password and return the account, or null. */
export async function authenticateUser(env, username, password) {
  const user = typeof username === "string" ? loadUsers(env).get(username) : undefined;
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  return { username, role: user.role };
}

/** Build the signed session cookie value for a username. */
export async function createSession(username, secret, now = Date.now()) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ u: username, iat: now })));
  return `${payload}.${await sign(payload, secret)}`;
}

/** Parse a session cookie value, or null when forged, malformed or expired. */
export async function readSession(cookieValue, secret, now = Date.now()) {
  if (typeof cookieValue !== "string") return null;
  const dot = cookieValue.indexOf(".");
  if (dot < 1) return null;
  const payload = cookieValue.slice(0, dot);
  if (!hexEqual(await sign(payload, secret), cookieValue.slice(dot + 1))) return null;
  let session;
  try {
    session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (typeof session?.u !== "string" || typeof session?.iat !== "number") return null;
  if (session.iat > now + CLOCK_SKEW_MS || now - session.iat > SESSION_MAX_AGE_MS) return null;
  return session;
}

/** Resolve the signed-in account from a cookie value, or null. */
export async function resolveUser(env, cookieValue) {
  if (env.BYPASS_AUTH === "true") return { username: env.ADMIN_USER || "tho", role: "admin" };
  const session = await readSession(cookieValue, env.SESSION_SECRET);
  const user = session && loadUsers(env).get(session.u);
  return user ? { username: session.u, role: user.role } : null;
}

/** Reject the request with 401 unless a valid session is signed in. */
export const requireAuth = createMiddleware(async (c, next) => {
  const user = await resolveUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "Not logged in" }, 401);
  c.set("user", user.username);
  c.set("role", user.role);
  await next();
});

async function sign(payload, secret) {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
