/**
 * Telegram — the wire. One bot token, one HTTP entry point, and no URL that
 * is ever written down.
 *
 * THE TOKEN IS IN THE PATH, WHICH IS THE WHOLE PROBLEM WITH THIS API.
 * `https://api.telegram.org/bot<token>/sendMessage` puts the credential in the
 * request line, so every ordinary habit of a provider in this codebase — log
 * the endpoint that failed, put the URL in the error, echo the request on a
 * timeout — would print a live bot token into a `runs` row the interface
 * displays. So: nothing here logs a URL, nothing returns one, and every
 * message that leaves this file goes through `scrub()` on the way out. That is
 * the same rule Pixabay's key-in-the-query-string gets in providers/stock.ts,
 * for a stronger reason: a bot token is a bearer credential for a chat.
 *
 * WHAT A BOT TOKEN IS. BotFather issues `<bot id>:<35 or so characters>`, it
 * is not scoped, and REGENERATING ONE INVALIDATES THE PREVIOUS ONE — which is
 * the single most likely reason a token that used to work is suddenly refused,
 * and worth saying in as many words rather than reporting "401".
 *
 * A PLUGIN HOLDS ACCOUNTS, so this file takes a token per call and knows
 * nothing about which account it belongs to. Two bots is the ordinary shape
 * once a person has a personal bot and a project one; each gets its own token,
 * its own poller and its own locked chat.
 *
 * THIS FILE DOES NO POLLING AND HOLDS NO STATE. `getUpdates` is here because it
 * is an HTTP call; the loop that drives it, the offset it keeps and the backoff
 * it applies live in ../telegram/poller.ts.
 */

const API = "https://api.telegram.org";

/** Long-poll seconds asked of Telegram. 50 is what the notifier on the Pi has
 *  used for a year: long enough that an idle bot costs about one request a
 *  minute, short enough to sit inside every proxy's idle timeout. */
export const POLL_SECONDS = 50;

/** Our own ceiling on one request, a comfortable margin over the long poll.
 *  Without it a socket that dies silently wedges the loop forever, which looks
 *  exactly like a bot that has stopped caring. */
const TIMEOUT_MS = (POLL_SECONDS + 15) * 1000;

/** Telegram's hard cap on one message. Not a guideline: a longer message is
 *  refused whole, so a reply that runs over must be split rather than sent and
 *  lost. */
export const MAX_MESSAGE = 4096;

/** What we actually split at. The margin is for the "(1/3)" a split adds and
 *  for the fact that Telegram counts UTF-16 code units rather than characters. */
const CHUNK = 3800;

export class TelegramError extends Error {
  /** Telegram's own `error_code`, or the HTTP status when the body was not
   *  the JSON envelope this API always sends. */
  status: number;
  /** Seconds Telegram asked us to wait, from `parameters.retry_after`. Null is
   *  "it did not say", never zero — the difference decides the backoff. */
  retryAfter: number | null;
  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Take the token back out of anything before it is stored or printed.
 *
 * Telegram does not echo the token in its error bodies today. This is not
 * defensive programming for its own sake: the token is in the request line, so
 * any future error that quotes the request — a proxy's 502 page, a DNS
 * failure that includes the URL, an `undici` message that names the origin —
 * arrives here as a string that may carry it, and this is the last place with
 * both the string and the token in hand.
 */
export function scrub(text: string, token: string): string {
  let out = token.length >= 8 ? text.split(token).join("[redacted]") : text;
  // The bot id half is enough to be recognisable and not enough to use, but a
  // reader who sees `bot123456:` in an error will reasonably assume the rest
  // leaked too. Both halves go.
  const id = token.split(":")[0];
  if (id && id.length >= 5) out = out.split(id).join("[bot]");
  return out.slice(0, 240);
}

/**
 * One call. POST with a JSON body, always.
 *
 * GET with a query string would be the same request and a worse one: the
 * parameters of a `sendMessage` are the message, and a chat's text has no
 * business in a request line even when the request line is never logged.
 */
async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // The URL is deliberately absent from this sentence. `err.message` from
    // undici names the origin but never the path, and it goes through scrub
    // anyway before anybody stores it.
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
      throw new TelegramError(0, `Telegram did not answer ${method} in time.`);
    throw new TelegramError(
      0,
      scrub(`Could not reach Telegram: ${err instanceof Error ? err.message : "network error"}`, token),
    );
  }

  /** Telegram's envelope, which is the same shape for every method and for
   *  every failure — the `description` on a bad one is the sentence worth
   *  showing, and `parameters.retry_after` is the only backoff advice this API
   *  ever gives. */
  type Envelope = {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  };

  let envelope: Envelope | null = null;
  try {
    envelope = (await res.json()) as Envelope;
  } catch {
    /* Telegram answers JSON for every outcome it has an opinion about. A body
       that is not JSON is something in front of it — a proxy, a captive
       network — and the status is all there is to report. */
    throw new TelegramError(res.status, `Telegram answered HTTP ${res.status} with no JSON.`);
  }

  if (!envelope?.ok) {
    const code = envelope?.error_code ?? res.status;
    const retry = envelope?.parameters?.retry_after ?? null;
    throw new TelegramError(
      code,
      scrub(envelope?.description ?? `Telegram answered ${code}.`, token),
      typeof retry === "number" ? retry : null,
    );
  }
  return envelope.result as T;
}

/* --------------------------------------------------------------- identity */

export type BotIdentity = { id: number; username: string | null; name: string };

/** Who this token is. The one call that proves a token without touching a
 *  chat, and the one that gives the account its name. */
export async function getMe(token: string, signal?: AbortSignal): Promise<BotIdentity> {
  const me = await call<{ id: number; username?: string; first_name?: string }>(
    token,
    "getMe",
    {},
    signal,
  );
  return {
    id: me.id,
    username: me.username ?? null,
    name: me.first_name ?? me.username ?? String(me.id),
  };
}

/**
 * Is this token real, and whose is it?
 *
 * There is nothing else to check. A bot token is not scoped, there are no
 * permissions to probe, and the chat it will serve does not exist yet — it is
 * discovered on the first message, which is a thing a human does after this
 * returns. So unlike Cloudflare's two calls or Meta's three, one is genuinely
 * the whole verification available here, and the second half of "does this
 * work" is a state the plugin page reports rather than a check this can make.
 */
export async function verify(
  token: string,
): Promise<{ ok: true; bot: BotIdentity } | { ok: false; error: string }> {
  try {
    return { ok: true, bot: await getMe(token) };
  } catch (err) {
    if (err instanceof TelegramError) {
      if (err.status === 401)
        return {
          ok: false,
          error:
            "Telegram refused that token. Regenerating a token in BotFather invalidates the previous one, so a token that used to work is usually a token that was replaced — /mybots → the bot → API Token.",
        };
      if (err.status === 404)
        return {
          ok: false,
          error:
            "Telegram does not know that token. Paste the whole line BotFather sent, including the digits before the colon.",
        };
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Could not reach Telegram." };
  }
}

/* --------------------------------------------------------------- escaping */

/**
 * The five characters that break Telegram's HTML parser.
 *
 * `parse_mode` IS ALL-OR-NOTHING, and that is why this matters more than it
 * looks. A message whose markup does not parse is not delivered plainly — it is
 * REFUSED, 400 "can't parse entities", and the whole reply is lost. So every
 * value this app interpolates into an HTML message goes through here, and
 * anything whose markup we did not write is sent with no `parse_mode` at all
 * (see `send`).
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * MarkdownV2's escape, for completeness and for callers that would rather
 * write markdown than tags.
 *
 * Telegram's MarkdownV2 reserves eighteen characters and refuses the message
 * for an unescaped one ANYWHERE in it — including inside a URL and inside a
 * word, which is why an ordinary sentence containing "3.5" or "a-b" is
 * rejected by it. Nothing in this app sends MarkdownV2 for exactly that
 * reason; the function exists so that a caller who reaches for markdown finds
 * the correct escape rather than inventing a partial one.
 */
export function escapeMarkdownV2(value: unknown): string {
  return String(value ?? "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

/**
 * One reply, cut into things Telegram will accept.
 *
 * Cut on a blank line, then on a line, then on a space, and only then in the
 * middle of a word — a paragraph split mid-sentence reads as a bug in the bot
 * rather than as a long answer.
 *
 * THE ENTITY RULE. When the text carries HTML we escaped, a hard split could
 * land inside `&amp;` or inside a tag, and the fragment that follows would be
 * refused whole by the parser. So a break is never taken inside an unclosed
 * `&…;` or `<…>`; the search walks back to before it started.
 */
export function chunk(text: string, limit = CHUNK): string[] {
  const out: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      cut = rest.lastIndexOf(sep, limit);
      if (cut > limit * 0.5) {
        cut += sep === " " ? 1 : sep.length;
        break;
      }
      cut = -1;
    }
    if (cut < 0) cut = limit;
    cut = backOffMarkup(rest, cut);
    out.push(rest.slice(0, cut).replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) out.push(rest);
  return out.length ? out : [""];
}

/** Walk a cut point back out of a half-written entity or tag. Bounded, so a
 *  stray `<` in prose cannot drag the split to the start of the message. */
function backOffMarkup(text: string, cut: number): number {
  const window = text.slice(Math.max(0, cut - 80), cut);
  for (const [open, close] of [
    ["&", ";"],
    ["<", ">"],
  ] as const) {
    const at = window.lastIndexOf(open);
    if (at >= 0 && !window.slice(at).includes(close)) return cut - (window.length - at);
  }
  return cut;
}

/* ---------------------------------------------------------------- sending */

export type SendOptions = {
  /** Send as HTML. Only for text this app WROTE — see below. */
  html?: boolean;
  signal?: AbortSignal;
};

/**
 * Send a message to one chat, in as many parts as it takes.
 *
 * PLAIN TEXT IS THE DEFAULT, AND THAT IS A DECISION ABOUT THE AGENT'S REPLIES.
 * An agent answers in markdown — asterisks, backticks, the occasional stray
 * underscore — and Telegram's parsers refuse a message whose markup does not
 * balance rather than degrading it. Sent as Markdown, an agent's reply
 * containing one unmatched `*` is not delivered at all; sent plainly, it
 * arrives with its asterisks visible. A visible asterisk is a blemish. A
 * missing reply is a broken bot, and the second failure is invisible from the
 * phone. So the agent's words go out unparsed, and only the messages this app
 * composes itself — /start, /status, notifications — ask for HTML, with every
 * interpolated value escaped by `escapeHtml` at the point it is interpolated.
 *
 * The fallback beneath that: a 400 mentioning entities is retried once as
 * plain text. If our own escaping is ever wrong, the owner gets the message
 * with tags in it instead of silence.
 */
export async function send(
  token: string,
  chatId: number | string,
  text: string,
  opts: SendOptions = {},
): Promise<{ parts: number }> {
  const parts = chunk(text);
  for (const part of parts) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: part,
      link_preview_options: { is_disabled: true },
    };
    if (opts.html) body.parse_mode = "HTML";
    try {
      await call(token, "sendMessage", body, opts.signal);
    } catch (err) {
      if (
        opts.html &&
        err instanceof TelegramError &&
        err.status === 400 &&
        /entit|parse/i.test(err.message)
      ) {
        delete body.parse_mode;
        await call(token, "sendMessage", body, opts.signal);
        continue;
      }
      throw err;
    }
  }
  return { parts: parts.length };
}

/**
 * The three dots, while the agent thinks.
 *
 * Telegram clears it after five seconds or when a message arrives, so it is a
 * hint rather than a state to manage. A failure here is swallowed: the reply
 * is the point, and nothing about the answer changes because a typing
 * indicator did not show.
 */
export async function typing(token: string, chatId: number | string): Promise<void> {
  try {
    await call(token, "sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {
    /* deliberately ignored */
  }
}

/** The command list a Telegram client shows in its menu. One call per poller
 *  start; Telegram stores it against the bot, so it is idempotent. */
export async function setCommands(
  token: string,
  commands: { command: string; description: string }[],
): Promise<void> {
  await call(token, "setMyCommands", { commands });
}

/* --------------------------------------------------------------- updates */

/** The subset of an update this bridge reads. Everything else Telegram sends —
 *  edits, channel posts, reactions, join events — is not requested and not
 *  handled, so it cannot arrive as an unread field. */
export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    /** Present on every message. `chat.id` is the only identifier this app
     *  keeps: `from` carries a person's name and is never stored or logged. */
    chat: { id: number; type?: string };
    from?: { id: number; is_bot?: boolean };
    text?: string;
  };
};

/**
 * One long poll.
 *
 * `allowed_updates` is narrowed to messages, which is not a nicety: it is how
 * an update this bridge cannot handle is prevented from consuming an offset
 * and how a bot added to a busy group does not spend its poll on reactions.
 *
 * The offset is Telegram's acknowledgement mechanism — asking with
 * `offset = last + 1` is what makes the server forget the ones before it, so
 * an update is redelivered until this app has actually got past it.
 */
export async function getUpdates(
  token: string,
  offset: number,
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>(
    token,
    "getUpdates",
    {
      offset,
      timeout: POLL_SECONDS,
      allowed_updates: ["message"],
    },
    signal,
  );
}
