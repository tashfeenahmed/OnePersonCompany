/**
 * ONE ROUTE, FOR THE STUDIO'S STEWIE TAB: what the Pi and the Dell can do
 * right now, without waking anything to find out. The render itself is not
 * a route — it is a `video` run with `format: stewie`, on the shared queue,
 * so it inherits cancellation, the ledger and the run page like every other
 * video. See stewie.ts.
 */
import { Hono } from "hono";
import { capabilities } from "./stewie.ts";

export const stewieRoutes = new Hono();

stewieRoutes.get("/", async (c) => c.json(await capabilities()));
