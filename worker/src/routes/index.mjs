import { Hono } from "hono";
import { authRoutes } from "./auth.mjs";
import { inventoryRoutes } from "./inventory.mjs";

export const routes = new Hono().route("/", authRoutes).route("/", inventoryRoutes);
