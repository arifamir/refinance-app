/**
 * The Hono application — routes and error handling only.
 *
 * Deliberately separate from server.ts (which binds a port and wires signal
 * handlers) so tests can exercise the real router in-process via
 * `app.request(...)` without opening a socket.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { IllegalTransitionError } from "@refi/domain";
import { prisma } from "@refi/db";
import { authRoutes } from "./routes/auth.js";
import { appRoutes, quizRoutes } from "./routes/applications.js";
import { offerRoutes } from "./routes/offers.js";
import { loanRoutes } from "./routes/loans.js";
import { ucScoreRoutes } from "./routes/ucScore.js";
import { opsRoutes } from "./routes/ops.js";
import type { AuthEnv } from "./auth.js";

export const app = new Hono<AuthEnv>();

// The request logger is noise in tests; keep it out of NODE_ENV=test.
if (process.env.NODE_ENV !== "test") app.use("*", logger());

app.use(
  "*",
  cors({
    origin: process.env.WEB_ORIGIN?.split(",") ?? ["http://localhost:5173"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.get("/health", async (c) => {
  await prisma.$queryRaw`SELECT 1`;
  return c.json({ ok: true, service: "refinance-api" });
});

app.route("/auth/bankid", authRoutes);
// Two routers on the same base path: the anonymous quiz and the authenticated
// app. appRoutes is mounted first so its static "/claim" wins over the quiz's
// "/:id/..." param routes.
app.route("/applications", appRoutes);
app.route("/applications", quizRoutes);
app.route("/offers", offerRoutes);
app.route("/loans", loanRoutes);
app.route("/uc-score", ucScoreRoutes);
app.route("/ops", opsRoutes);

/**
 * One error boundary. An illegal state transition is a 409, not a 500 — the
 * request was well-formed, the system just refused to make an unsafe move.
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();

  if (err instanceof IllegalTransitionError) {
    return c.json({ error: err.message, code: "ILLEGAL_TRANSITION" }, 409);
  }

  if (err instanceof ZodError) {
    return c.json({ error: "Validation failed", issues: err.issues }, 400);
  }

  console.error("[api] unhandled", err);
  return c.json({ error: "Internal error" }, 500);
});
