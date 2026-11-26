import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { authenticateUser, createSession, requireAuth, SESSION_COOKIE } from "../auth.mjs";
import { notifyLogin } from "../login_notify.mjs";

const LOGIN_RATE_LIMIT_PERIOD_S = 60;
const COOKIE_OPTIONS = { path: "/", httpOnly: true, sameSite: "Strict", secure: true };

export const authRoutes = new Hono()
  .get("/ping", (c) => c.text("pong"))
  .post("/login", async (c) => {
    const outcome = await c.env.RATE_LIMITER.limit({ key: c.req.header("CF-Connecting-IP") ?? "unknown" });
    if (!outcome.success) {
      return c.json({ error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, {
        "Retry-After": String(LOGIN_RATE_LIMIT_PERIOD_S),
      });
    }
    const body = await c.req.json().catch(() => undefined);
    if (!isRecord(body)) return c.json({ error: "Invalid JSON body" }, 400);
    const user = await authenticateUser(c.env, body.username, body.password);
    if (!user) return c.json({ error: "Invalid credentials" }, 401);

    setCookie(c, SESSION_COOKIE, await createSession(user.username, c.env.SESSION_SECRET), COOKIE_OPTIONS);
    c.executionCtx.waitUntil(notifyLogin(c.env, c.req.raw, user.username, user.role));
    return c.json({ ok: true });
  })
  .post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
    return c.json({ ok: true });
  })
  .get("/me", requireAuth, (c) => c.json({ user: c.get("user"), role: c.get("role") }));

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
