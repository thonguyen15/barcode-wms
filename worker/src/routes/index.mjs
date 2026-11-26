import { Hono } from "hono";
import { authRoutes } from "./auth.mjs";

export const routes = new Hono().route("/", authRoutes);
