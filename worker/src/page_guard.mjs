import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { resolveUser, SESSION_COOKIE } from "./auth.mjs";

const LOGIN_PAGE = "/login.html";
const LIST_PAGE = "/list.html";
const ADMIN_PAGES = new Map([
  ["/reconcile.html", LIST_PAGE],
  ["/watcher.html", LIST_PAGE],
]);

/** Send visitors without a session to the login page before an HTML page is served. */
export const pageGuard = createMiddleware(async (c, next) => {
  const pathname = c.req.path;
  if (pathname === "/") return c.redirect(LOGIN_PAGE, 302);
  if (pathname === LOGIN_PAGE) return next();
  if (!pathname.endsWith(".html")) return next();
  const user = await resolveUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) return c.redirect(LOGIN_PAGE, 302);
  const redirect = user.role !== "admin" ? ADMIN_PAGES.get(pathname) : undefined;
  if (redirect) return c.redirect(redirect, 302);
  return next();
});
