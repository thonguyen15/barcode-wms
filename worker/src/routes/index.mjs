import { Hono } from "hono";
import { authRoutes } from "./auth.mjs";
import { externalRoutes } from "./external.mjs";
import { telegramRoutes } from "./telegram.mjs";

export const routes = new Hono().route("/", authRoutes).route("/", externalRoutes).route("/", telegramRoutes);
