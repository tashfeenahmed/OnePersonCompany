import { Hono } from "hono";
import { series } from "../db.ts";

export const metrics = new Hono();

/** One metric's history, for a widget. `days` is clamped: an unbounded range
 *  against an append-only table is a way to ask for the whole database. */
metrics.get("/:metric", (c) => {
  const metric = c.req.param("metric");
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 400);
  const rows = series(metric, days);
  return c.json({
    metric,
    days,
    points: rows.map((r) => ({
      ts: r.ts,
      value: r.value,
      meta: r.meta ? (JSON.parse(r.meta) as unknown) : null,
    })),
  });
});
