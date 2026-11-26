import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../auth.mjs";
import { renderLabel } from "../label/index.mjs";
import { SAMPLE_ITEMS } from "../label/samples.mjs";

const MAX_REPEAT = 500;

export const labelRoutes = new Hono().get("/debug/label/:test", requireAuth, requireAdmin, async (c) => {
  const item = SAMPLE_ITEMS[c.req.param("test")];
  if (!item) return c.json({ error: "Unknown label sample" }, 404);
  const repeat = Math.min(MAX_REPEAT, Math.max(1, Number(c.req.query("repeat")) || 1));
  const started = performance.now();
  let png;
  for (let i = 0; i < repeat; i += 1) png = await renderLabel(item, item.qrText);
  const duration = (performance.now() - started) / repeat;
  return c.body(png, 200, {
    "Content-Type": "image/png",
    "Cache-Control": "no-store",
    "Server-Timing": `label;dur=${duration.toFixed(3)}`,
  });
});
