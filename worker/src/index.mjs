import { Hono } from "hono";
import { pageGuard } from "./page_guard.mjs";
import { routes } from "./routes/index.mjs";
import { watcherPageRoute } from "./routes/watcher.mjs";
import { scheduled } from "./scheduled.mjs";

const app = new Hono();

app.use("*", pageGuard);
app.route("/api", routes);
app.route("/", watcherPageRoute);
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled,
};
