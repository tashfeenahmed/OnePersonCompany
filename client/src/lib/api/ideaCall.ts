import { BASE, ApiError, call } from "@/lib/api";

/**
 * THE IDEA CALL — one continuing conversation per venture, in which the
 * assistant refines the idea with the owner, looks things up while it talks,
 * and writes what is settled into the idea page. Shapes are the server's:
 * server/src/integrations/ideacall/routes.ts.
 */
export type IdeaCallTool = { id: string; tool: string; label: string; status: "running" | "completed" };
export type IdeaCallTurn = { id: number; role: "user" | "assistant"; text: string; at: string };
/** What a turn wrote into the idea page, in the page's own words. */
export type IdeaCallUpdate = { fields: string[]; competitors: string[]; names: string[] };
export type IdeaCallDoc = {
  ventureId: string;
  turns: IdeaCallTurn[];
  /** Whether the box can speak a clip itself; otherwise the page uses the browser's voice. */
  voice: { tts: boolean; stt: boolean };
  /** The port this same app answers on over HTTPS, when the box offers one —
   *  where a page on a plain LAN address sends the owner for the microphone. */
  secure: { httpsPort: number | null };
  /** Which model is on the line. `reason` is set when it is not the
   *  workspace's own — see `callProvider` on the server. */
  answering: { id: string; label: string; reason: string | null; model: string | null; choices: { id: string; label: string }[] } | null;
  /** False when no model is connected: the call cannot be answered. */
  ready: boolean;
  note: string | null;
};

/** The three models of a call — who thinks, who hears, who speaks — and what
 *  there is to choose from. `chosen*` is this call's own override; `model` is
 *  what will actually be used. */
export type IdeaCallSettings = {
  text: { provider: string | null; model: string | null; answering: { id: string; label: string; reason: string | null; model: string | null } | null; providers: { id: string; label: string; models: string[] }[] };
  listen: { configured: boolean; model: string | null; chosen: string | null; models: string[] };
  speak: { ready: boolean; mode: string; model: string | null; voice: string | null; chosenModel: string | null; chosenVoice: string | null; models: string[] };
  secure: { httpsPort: number | null };
};
export type IdeaCallSettingsPatch = Partial<Record<"provider" | "model" | "sttModel" | "ttsModel" | "ttsVoice", string | null>>;

export type IdeaCallHandlers = {
  onTool?(tool: IdeaCallTool): void;
  onUpdated?(update: IdeaCallUpdate): void;
  /** The assistant's whole reply for this turn. Arrives once. */
  onSay?(turn: IdeaCallTurn): void;
  onError?(message: string): void;
};

const root = (venture: string) => `/idea-call/${encodeURIComponent(venture)}`;

export const ideaCallApi = {
  read: (venture: string) => call<IdeaCallDoc>(root(venture)),
  settings: () => call<IdeaCallSettings>("/idea-call/settings"),
  saveSettings: (patch: IdeaCallSettingsPatch) => call<IdeaCallSettings>("/idea-call/settings", { method: "PUT", body: JSON.stringify(patch) }),
  /** A recorded turn, as words — the box's transcription model. Not `call`:
   *  that sets a JSON content type and this is a multipart body. */
  listen: async (blob: Blob, filename: string): Promise<{ text: string }> => {
    const form = new FormData();
    form.append("file", blob, filename);
    const res = await fetch(`${BASE}/idea-call/listen`, { method: "POST", body: form });
    const body = await res.json().catch(() => null) as { text?: string; error?: string } | null;
    if (!res.ok) throw new ApiError(res.status, body?.error ?? `Could not transcribe that (${res.status}).`);
    return { text: body?.text ?? "" };
  },
  /** One paragraph as a clip, in this call's voice. */
  say: (text: string) => call<{ url: string }>("/idea-call/say", { method: "POST", body: JSON.stringify({ text }) }),
  /** Forget the conversation. What it wrote into the idea page stays. */
  reset: (venture: string) => call<{ deleted: number }>(root(venture), { method: "DELETE" }),
  /** Hanging up: one last pass that files anything said and not yet written down. */
  finish: (venture: string) => call<IdeaCallUpdate>(`${root(venture)}/finish`, { method: "POST" }),

  /**
   * One turn. `message: null` opens the line — the assistant greets, or picks
   * up where the last call stopped. Resolves when the stream ends; an answer
   * that fails mid-way arrives as `onError`, a request refused outright throws.
   */
  turn: async (venture: string, message: string | null, handlers: IdeaCallHandlers, signal?: AbortSignal): Promise<void> => {
    const res = await fetch(`${BASE}${root(venture)}/turn`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      throw new ApiError(res.status, body?.error ?? `The call could not be answered (${res.status}).`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        let event = "message", data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: unknown; try { parsed = JSON.parse(data); } catch { continue; }
        if (event === "tool") handlers.onTool?.(parsed as IdeaCallTool);
        else if (event === "updated") handlers.onUpdated?.(parsed as IdeaCallUpdate);
        else if (event === "say") handlers.onSay?.(parsed as IdeaCallTurn);
        else if (event === "error") handlers.onError?.((parsed as { message: string }).message);
      }
    }
  },
};
