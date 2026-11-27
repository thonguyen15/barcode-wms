import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../auth.mjs";
import { getDb } from "../db.mjs";
import { detectCategory, genToken, nextPackageId, nowISO } from "../items_common.mjs";
import { detectShipFee, parseAndNormalizeDate } from "../order_utils.mjs";

function orderProfit(order) {
  return (order.sold_price || 0) * 0.9 - (order.buy_price || 0) - (order.ship_fee || 0);
}

export const orderRoutes = new Hono()
  .get("/orders", requireAuth, requireAdmin, async (c) => {
    try {
      const month = c.req.query("month");
      let sql = "SELECT * FROM items WHERE is_order = 1 AND is_deleted = 0";
      const args = [];
      if (month) {
        sql += " AND order_date LIKE ?";
        args.push(`${month}%`);
      }
      sql += " ORDER BY order_date ASC, id ASC";
      const db = getDb(c.env);
      const { rows } = await db.execute({ sql, args });
      return c.json({ rows });
    } catch (e) {
      console.error("Get orders failed:", e);
      return c.json({ error: e.message || "Failed to get orders" }, 500);
    }
  })
  .post("/orders", requireAuth, requireAdmin, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const name = (body.name ?? "").trim();
      const buy_price = parseFloat(body.buy_price ?? 0);
      const sold_price = parseFloat(body.sold_price ?? 0);
      const ship_fee = body.ship_fee !== undefined && parseFloat(body.ship_fee) !== 0 ? parseFloat(body.ship_fee) : detectShipFee(name);
      const link = (body.link ?? "").trim();
      const note = (body.note ?? "no").trim();
      const mvd = (body.mvd ?? "").trim();

      if (!name) return c.json({ error: "Product name is required" }, 400);

      const order_date = parseAndNormalizeDate(body.order_date);
      const env = c.env;
      const db = getDb(env);
      const package_id = await nextPackageId(env);
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
          t, t, c.get("user"), await detectCategory(env, name), mvd,
        ],
      });

      return c.json({ ok: true, package_id, token, profit, ship_fee, mvd });
    } catch (e) {
      console.error("Create order failed:", e);
      return c.json({ error: e.message || "Failed to create order" }, 500);
    }
  })
  .get("/orders/unmerged-arrived", requireAuth, requireAdmin, async (c) => {
    try {
      const db = getDb(c.env);
      const { rows } = await db.execute(
        "SELECT * FROM items WHERE is_order = 0 AND is_deleted = 0 AND status = 'CREATED' ORDER BY datetime(updated_at) DESC",
      );
      return c.json({ rows });
    } catch (e) {
      console.error("Get unmerged items failed:", e);
      return c.json({ error: e.message || "Failed to get unmerged items" }, 500);
    }
  })
  .post("/orders/merge", requireAuth, requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { order_id, arrived_item_id } = body;
    if (!order_id || !arrived_item_id) return c.json({ error: "Missing order_id or arrived_item_id" }, 400);

    try {
      const db = getDb(c.env);
      const { rows: orderRows } = await db.execute({
        sql: "SELECT * FROM items WHERE id = ? AND is_order = 1 AND is_deleted = 0",
        args: [order_id],
      });
      const { rows: arrivedRows } = await db.execute({
        sql: "SELECT * FROM items WHERE id = ? AND is_order = 0 AND is_deleted = 0",
        args: [arrived_item_id],
      });
      const order = orderRows[0];
      const arrived = arrivedRows[0];

      if (!order) return c.json({ error: "Calendar order not found" }, 404);
      if (order.status !== "ORDERED") return c.json({ error: "Calendar order is already merged" }, 400);
      if (!arrived) return c.json({ error: "Arrived physical item not found" }, 404);
      if (arrived.merged_from_id) return c.json({ error: "Arrived physical item is already merged" }, 400);

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
            is_order = 0,
            updated_at = ?
          WHERE id = ?
        `,
        args: [
          order.name, arrived.mvd, arrived.serial_raw, arrived.serial_clean,
          arrived.condition, arrived.battery, arrived.coverage, arrived.note,
          arrived.inventory_status, arrived.category, profit, order.id, t, arrived.id,
        ],
      });

      return c.json({ ok: true, merged_order_id: order.id });
    } catch (e) {
      console.error("Merge failed:", e);
      return c.json({ error: e.message || "Merge failed" }, 500);
    }
  })
  .post("/orders/unmerge", requireAuth, requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { order_id } = body;
    if (!order_id) return c.json({ error: "Missing order_id" }, 400);

    try {
      const db = getDb(c.env);
      const { rows } = await db.execute({
        sql: "SELECT * FROM items WHERE id = ? AND is_order = 1 AND is_deleted = 0",
        args: [order_id],
      });
      const order = rows[0];
      if (!order) return c.json({ error: "Order not found" }, 404);
      if (order.status !== "CREATED" || !order.merged_from_id) {
        return c.json({ error: "Order is not currently merged with a package" }, 400);
      }

      const t = nowISO();
      const { rows: physicalRows } = await db.execute({
        sql: "SELECT * FROM items WHERE id = ? AND is_order = 0 AND is_deleted = 1",
        args: [order.merged_from_id],
      });
      const physicalItem = physicalRows[0];

      if (physicalItem) {
        await db.execute({
          sql: "UPDATE items SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, status = 'CREATED' WHERE id = ?",
          args: [physicalItem.id],
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
        args: [profit, t, order.id],
      });

      return c.json({ ok: true, unmerged_order_id: order.id });
    } catch (e) {
      console.error("Unmerge failed:", e);
      return c.json({ error: e.message || "Unmerge failed" }, 500);
    }
  })
  .delete("/orders/:id", requireAuth, requireAdmin, async (c) => {
    const id = c.req.param("id");
    try {
      const db = getDb(c.env);
      await db.execute({
        sql: "UPDATE items SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?",
        args: [nowISO(), c.get("user"), id],
      });
      return c.json({ ok: true });
    } catch (e) {
      console.error("Delete order failed:", e);
      return c.json({ error: e.message || "Failed to delete order" }, 500);
    }
  });

