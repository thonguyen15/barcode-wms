import { Hono } from "hono";
import { adminRoutes } from "./admin.mjs";
import { authRoutes } from "./auth.mjs";
import { deleteFlowRoutes } from "./delete_flow.mjs";
import { externalRoutes } from "./external.mjs";
import { itemRoutes } from "./items.mjs";
import { publicRoutes } from "./public_scan.mjs";
import { telegramRoutes } from "./telegram.mjs";

export const routes = new Hono()
  .route("/", authRoutes)
  .route("/", itemRoutes)
  .route("/", publicRoutes)
  .route("/", externalRoutes)
  .route("/", telegramRoutes)
  .route("/", adminRoutes)
  .route("/", deleteFlowRoutes);
