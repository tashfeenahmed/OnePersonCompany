/**
 * ONE ROUTE, FOR THE STUDIO'S STEWIE TAB: what the Pi and the Dell can do
 * right now, without waking anything to find out. The render itself is not
 * a route — it is a `video` run with `format: stewie`, on the shared queue,
 * so it inherits cancellation, the ledger and the run page like every other
 * video. See stewie.ts.
 */
import { Hono } from "hono";
import { agent, capabilities } from "./stewie.ts";
import { gameplayThumbnail } from "./gameplay-previews.ts";

export const stewieRoutes = new Hono();

stewieRoutes.get("/", async (c) => c.json(await capabilities()));

stewieRoutes.get("/backgrounds/:name/thumbnail", c => {
  const connected = agent().agent;
  const bytes = connected && gameplayThumbnail(connected.url, c.req.param("name"));
  if (!bytes) return c.json({ error: "Gameplay preview is unavailable." }, 404);
  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
  });
});
