# Route contract

One domain, one file: `worker/src/routes/<domain>.mjs` exports a Hono subapp named
`<domain>Routes`, and `worker/src/routes/index.mjs` mounts it. `worker/src/index.mjs` mounts the
combined subapp under `/api`, so a route declared as `/items` is served at `/api/items`.

```js
import { Hono } from "hono";
import { requireAuth } from "../auth.mjs";
import { getDb } from "../db.mjs";

export const itemRoutes = new Hono();

itemRoutes.get("/items", requireAuth, async (c) => {
  const user = c.get("user");
  const role = c.get("role");
  const { rows } = await getDb(c.env).execute("SELECT * FROM items");
  return c.json({ rows });
});
```

```js
import { itemRoutes } from "./item.mjs";

export const routes = new Hono().route("/", authRoutes).route("/", itemRoutes);
```

`worker/src/routes/auth.mjs` is the worked example.

## Rules for every route file

- `requireAuth` sets `c.get("user")` and `c.get("role")` (`admin`, `staff`, `entry`); check the role
  in the handler, as `page_guard.mjs` does for `/reconcile.html`.
- `getDb(c.env)` and `batch(c.env, statements)` from `worker/src/db.mjs` are the only database
  access. Prefer `batch`: each `execute` is one subrequest and a request has 50.
- No I/O and no reading of `env` at module scope; `env` exists only inside a handler.
- Telegram goes through `tgFetch(env, url, options)` and `sendTelegramMessage` in
  `worker/src/telegram.mjs`. Set `TG_DRY_RUN=1` to log calls instead of sending them.
- Background work goes through `c.executionCtx.waitUntil(promise)`.
- Plain JavaScript, named exports, `===`, no `#` or `//` comment lines, one-line JSDoc on
  exports, under 500 lines per file.
