import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { setConfig, upsertPlugin, ventureRow } from "../../db.ts";
import { providers, type ProviderId } from "../../models/provider.ts";
import { state as voiceState } from "../signals/voice/provider.ts";
import { IDEACALL_PLUGIN, callProvider, callTurn, callTurns, finishCall, resetCall } from "./call.ts";

const MAX_MESSAGE = 4000;

/** One answer at a time per venture: two tabs on one call would interleave
 *  two turns into one transcript. */
const answering = new Set<string>();

export const ideaCallRoutes = new Hono();

/** Pin which connected provider takes the call, or `null` to let it choose —
 *  see `callProvider`. Declared before `/:key` so "settings" is not a venture. */
ideaCallRoutes.put("/settings", async (c) => {
  const body = await c.req.json().catch(() => null) as { provider?: unknown } | null;
  const id = body?.provider;
  if (id !== null && !providers().some(p => p.connected && p.id === id)) return c.json({ error: "Choose a connected provider, or null." }, 400);
  upsertPlugin(IDEACALL_PLUGIN, true, null);
  setConfig(IDEACALL_PLUGIN, "provider", (id as ProviderId | null) ?? "");
  return c.json({ answering: callProvider() });
});

ideaCallRoutes.get("/:key", (c) => {
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  const answering = callProvider(), ready = !!answering;
  let tts = false;
  try { tts = voiceState().tts.ready; } catch { /* no voice plugin is not a reason to refuse the call */ }
  return c.json({
    ventureId: venture.id, turns: callTurns(venture.id), voice: { tts }, ready,
    /* Which model is on the line, and why if it is not the workspace's. */
    answering: answering && { ...answering, choices: providers().filter(p => p.connected).map(p => ({ id: p.id, label: p.label ?? p.id })) },
    note: ready ? null : "No model is connected, so there is nobody to take the call. Connect one under Settings, then call again.",
  });
});

ideaCallRoutes.post("/:key/turn", async (c) => {
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  const body = await c.req.json().catch(() => null) as { message?: unknown } | null;
  if (!body || (body.message !== null && typeof body.message !== "string")) return c.json({ error: "Send { message } — text, or null to open the call." }, 400);
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : null;
  if (message === "") return c.json({ error: "Nothing was said." }, 400);
  if (!callProvider()) return c.json({ error: "No model is connected." }, 503);
  if (answering.has(venture.id)) return c.json({ error: "This call is already being answered in another window." }, 409);

  answering.add(venture.id);
  const signal = c.req.raw.signal;
  return streamSSE(c, async (sse) => {
    /* A search can be quiet for twenty seconds; a proxy that sees nothing for
       that long hangs up. A comment, not a frame. */
    const beat = setInterval(() => { void sse.write(": keepalive\n\n").catch(() => {}); }, 15_000);
    try {
      for await (const event of callTurn(venture, message, signal)) {
        if (event.type === "tool") await sse.writeSSE({ event: "tool", data: JSON.stringify({ id: event.id, tool: event.tool, label: event.label, status: event.status }) });
        else if (event.type === "updated") await sse.writeSSE({ event: "updated", data: JSON.stringify(event.update) });
        else await sse.writeSSE({ event: "say", data: JSON.stringify(event.turn) });
      }
    } catch (err) {
      if (!signal.aborted) {
        console.warn(`[idea-call] ${venture.slug}: ${err instanceof Error ? err.message : String(err)}`);
        await sse.writeSSE({ event: "error", data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }) }).catch(() => {});
      }
    } finally {
      clearInterval(beat);
      answering.delete(venture.id);
    }
  });
});

ideaCallRoutes.post("/:key/finish", async (c) => {
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  if (!callProvider()) return c.json({ fields: [], competitors: [], names: [] });
  try { return c.json(await finishCall(venture, c.req.raw.signal)); }
  catch (err) {
    console.warn(`[idea-call] finish ${venture.slug}: ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

ideaCallRoutes.delete("/:key", (c) => {
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  return c.json({ deleted: resetCall(venture.id) });
});
