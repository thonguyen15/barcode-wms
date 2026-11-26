import { Hono } from "hono";
import { authRoutes } from "./auth.mjs";
import { labelRoutes } from "./label.mjs";

export const routes = new Hono().route("/", authRoutes).route("/", labelRoutes);
