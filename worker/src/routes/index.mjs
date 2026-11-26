import { Hono } from "hono";
import { adminRoutes } from "./admin.mjs";
import { authRoutes } from "./auth.mjs";
import { itemRoutes } from "./items.mjs";
import { deleteFlowRoutes } from "./delete_flow.mjs";
import { publicRoutes } from "./public_scan.mjs";

export const routes = new Hono().route("/", authRoutes).route("/", itemRoutes).route("/", publicRoutes).route("/", adminRoutes).route("/", deleteFlowRoutes);
