/**
 * THE CHAT BACKEND — one contract, several agents behind it, exactly one live.
 *
 * Hermes (Nous Research's agent, reached over an OpenAI-compatible endpoint)
 * and OpenClaw (the open-source gateway, reached over its tools-invoke API) do
 * the same job for this app: take a conversation, think, answer. They differ
 * in wire shape and nothing that matters to a caller, so a caller never learns
 * which one it is talking to. The Chat page, the Telegram bridge, and anything
 * that arrives later all go through `ask()` below and nowhere else.
 *
 * ONLY ONE IS ACTIVE. Both may be connected — a key for each stored in the
 * vault — but a single `chat.backend` config value names the one that answers.
 * Two live agents answering the same question from two places is not a
 * feature; it is the same message arriving twice on a phone. The setting is
 * read on every call rather than cached, so switching takes effect on the next
 * message and never needs a restart.
 *
 * WHAT THIS FILE IS AND IS NOT. It is the seam: the type every adapter
 * implements and the one function every caller uses. It is not where the
 * adapters live — those are `providers/hermes.ts` and `providers/openclaw.ts`,
 * registered here — and it holds no HTTP itself.
 *
 * NULL MEANS "NO AGENT". `activeBackend()` returns null when nothing is
 * connected, or the configured backend is not connected, or nothing has been
 * chosen. A caller that gets null should say "no agent is connected" in its
 * own words (the Chat page's, Telegram's) rather than reply with an empty
 * string — silence from a bot is indistinguishable from a broken bot.
 */

export type ChatBackendId = "hermes" | "openclaw";

export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ChatReply = {
  text: string;
  /** Which agent answered. Surfaced, never hidden, because the two may not
   *  answer identically and the owner is entitled to know which one did. */
  backend: ChatBackendId;
  /** The model the agent reports having used, when it reports one. */
  model: string | null;
  /** Tokens, when the backend counts them. Absent is "not reported", not 0. */
  usage: { prompt: number; completion: number } | null;
  /** How long the round trip took, measured here. */
  ms: number;
};

export type AskOptions = {
  /** A stable id for a conversation, so a backend that keeps its own session
   *  state (OpenClaw can) continues the right one. Optional: a one-off ask
   *  has no session. */
  sessionId?: string;
  /** Where the message came from — the page, or a Telegram chat. Passed to
   *  the backend as context, and used in logs. */
  channel?: "web" | "telegram";
  signal?: AbortSignal;
};

export interface ChatBackend {
  id: ChatBackendId;
  /** The account label this backend is using, for display ("Hermes · Nous
   *  Portal"). */
  label: string;
  ask(turns: ChatTurn[], opts?: AskOptions): Promise<ChatReply>;
}

/* ------------------------------------------------------------------ registry */

/**
 * Adapters register themselves at import time. The order of `import` lines in
 * index.ts is therefore load-bearing and is commented there.
 */
const adapters = new Map<ChatBackendId, () => ChatBackend | null>();

/**
 * An adapter registers a FACTORY, not an instance: it is called on every
 * `activeBackend()` so a rotated key or a changed URL is picked up without a
 * restart. The factory returns null when its plugin is not connected.
 */
export function registerBackend(id: ChatBackendId, make: () => ChatBackend | null) {
  adapters.set(id, make);
}

/** Which backend is configured to answer. Read from plugin config on every
 *  call — see the header for why it is not cached. Implemented by the chat
 *  routes module, which owns the config key; set here so this file has no
 *  import of the config store and stays a pure seam. */
let readChoice: () => ChatBackendId | null = () => null;

export function setChoiceReader(fn: () => ChatBackendId | null) {
  readChoice = fn;
}

export function activeBackend(): ChatBackend | null {
  const id = readChoice();
  if (!id) return null;
  const make = adapters.get(id);
  return make ? make() : null;
}

/** Every backend that could be chosen, and whether each is connected — for the
 *  selector on the Chat page and the plugin pages. */
export function backends(): { id: ChatBackendId; connected: boolean; label: string | null }[] {
  const ids: ChatBackendId[] = ["hermes", "openclaw"];
  return ids.map((id) => {
    const b = adapters.get(id)?.() ?? null;
    return { id, connected: b !== null, label: b?.label ?? null };
  });
}

/**
 * The one call every caller makes.
 *
 * Throws `NoBackendError` rather than returning null so a caller cannot forget
 * to handle the case: the Chat page turns it into a sentence, the Telegram
 * bridge into a reply, and neither can accidentally send nothing.
 */
export async function ask(turns: ChatTurn[], opts?: AskOptions): Promise<ChatReply> {
  const backend = activeBackend();
  if (!backend) throw new NoBackendError();
  return backend.ask(turns, opts);
}

export class NoBackendError extends Error {
  constructor() {
    super(
      "No agent is connected. Connect Hermes or OpenClaw under Integrations and choose one as the chat backend.",
    );
    this.name = "NoBackendError";
  }
}
