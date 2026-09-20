import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { configValue, setConfig, upsertPlugin, ventureRow } from "../../db.ts";
import { HTTPS_PORT } from "../../config.ts";
import { providerModels, providers, type ProviderId } from "../../models/provider.ts";
import { speak, state as voiceState, transcribe, voiceModels } from "../signals/voice/provider.ts";
import { IDEACALL_PLUGIN, callProvider, callTurn, callTurns, finishCall, resetCall } from "./call.ts";

const MAX_MESSAGE = 4000;

/** One answer at a time per venture: two tabs on one call would interleave
 *  two turns into one transcript. */
const answering = new Set<string>();

export const ideaCallRoutes = new Hono();

/* ------------------------------------------------------------- settings --

   WHO THINKS, WHO HEARS, WHO SPEAKS — the three models of a call, chosen from
   inside the call. All three are declared before `/:key`, so "settings",
   "listen" and "say" are not read as ventures.

   The text model is this area's own choice (see `callProvider`). Hearing and
   speaking belong to the voice integration — its endpoints, its keys — and
   what is chosen here is only WHICH MODEL on those endpoints this call uses,
   stored as an override so Telegram's voice notes and the videos keep theirs.
   Whether the BROWSER hears and speaks instead is the browser's business and
   is kept there; this side only says what the box can offer. */
const pick = (key: string) => configValue(IDEACALL_PLUGIN, key)?.trim() || null;

async function settingsDoc() {
  const connected = providers().filter(p => p.connected);
  const voice = (() => { try { return voiceState(); } catch { return null; } })();
  const [lists, models] = await Promise.all([Promise.all(connected.map(p => providerModels(p.id))), voice ? voiceModels() : { stt: [], tts: [] }]);
  return {
    text: { provider: pick("provider"), model: pick("model"), answering: callProvider(), providers: connected.map((p, i) => ({ id: p.id, label: p.label ?? p.id, models: lists[i] })) },
    listen: { configured: !!voice?.stt.configured, model: pick("sttModel") ?? voice?.stt.model ?? null, chosen: pick("sttModel"), models: models.stt },
    speak: { ready: !!voice?.tts.ready, mode: voice?.tts.mode ?? "off", model: pick("ttsModel") ?? voice?.tts.model ?? null, voice: pick("ttsVoice") ?? voice?.tts.voice ?? null, chosenModel: pick("ttsModel"), chosenVoice: pick("ttsVoice"), models: models.tts },
    /* The port the same app answers on over TLS, or null — what a page on a
       plain LAN address needs to know to send the owner somewhere the
       microphone is allowed. */
    secure: { httpsPort: HTTPS_PORT || null },
  };
}

ideaCallRoutes.get("/settings", async (c) => c.json(await settingsDoc()));

ideaCallRoutes.put("/settings", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected JSON." }, 400);
  const text = (key: string, max = 200) => body[key] === null ? "" : typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : undefined;
  if (body.provider !== undefined && body.provider !== null && !providers().some(p => p.connected && p.id === body.provider)) return c.json({ error: "Choose a connected provider, or null." }, 400);
  upsertPlugin(IDEACALL_PLUGIN, true, null);
  if (body.provider !== undefined) {
    setConfig(IDEACALL_PLUGIN, "provider", (body.provider as ProviderId | null) ?? "");
    /* A new provider, or none: the old provider's model goes with it. */
    if (body.model === undefined) setConfig(IDEACALL_PLUGIN, "model", "");
  }
  for (const key of ["model", "sttModel", "ttsModel", "ttsVoice"]) { const value = text(key); if (value !== undefined) setConfig(IDEACALL_PLUGIN, key, value); }
  return c.json(await settingsDoc());
});

/** What was said, from a recording — the mic path that does not depend on
 *  which browser it is. multipart, field `file`. */
ideaCallRoutes.post("/listen", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !file.size) return c.json({ error: "Send the recording as multipart field `file`." }, 400);
  try {
    const heard = await transcribe(new Uint8Array(await file.arrayBuffer()), file.name || "speech.webm", { reader: "idea_call", model: pick("sttModel") ?? undefined });
    return c.json({ text: heard.text.trim(), ms: heard.ms, model: heard.model });
  } catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 502); }
});

/** A spoken clip of one paragraph, with this call's model and voice. */
ideaCallRoutes.post("/say", async (c) => {
  const body = await c.req.json().catch(() => null) as { text?: unknown } | null;
  const words = typeof body?.text === "string" ? body.text.trim().slice(0, 1500) : "";
  if (!words) return c.json({ error: "Expected { text }." }, 400);
  try {
    const clip = await speak(words, { voice: pick("ttsVoice") ?? undefined, model: pick("ttsModel") ?? undefined });
    return c.json({ url: `/api/voice/clip/${clip.id}.${clip.format}`, ms: clip.ms, via: clip.via });
  } catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 502); }
});

ideaCallRoutes.get("/:key", (c) => {
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  const answering = callProvider(), ready = !!answering;
  let tts = false, stt = false;
  try { const v = voiceState(); tts = v.tts.ready; stt = v.stt.configured; } catch { /* no voice plugin is not a reason to refuse the call */ }
  return c.json({
    ventureId: venture.id, turns: callTurns(venture.id), voice: { tts, stt }, ready, secure: { httpsPort: HTTPS_PORT || null },
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
