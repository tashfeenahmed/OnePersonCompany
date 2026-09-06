/**
 * THE OPENAI CHAT-COMPLETIONS WIRE, WRITTEN ONCE FOR BOTH AGENTS.
 *
 * Hermes and OpenClaw are different programs by different people, and both of
 * them answer a chat turn on `POST <base>/v1/chat/completions` with an
 * OpenAI-shaped body. That is not a coincidence worth abstracting away — it is
 * the actual reason one `ChatBackend` contract can cover both — but it does
 * mean the fiddly half of each adapter would otherwise be the same two hundred
 * lines twice, and a response parser copied twice is a response parser that
 * gets fixed once.
 *
 * SO WHAT LIVES HERE IS THE WIRE, AND ONLY THE WIRE: how to say a request, how
 * to read an answer, and how to turn a refusal into a sentence. What does NOT
 * live here is anything either agent does differently — Hermes takes a model
 * id and a plain bearer, OpenClaw takes an AGENT target and keeps its own
 * sessions and has a health probe that needs no token at all. Those belong in
 * `providers/hermes.ts` and `providers/openclaw.ts` beside the reasons for
 * them, and pulling them up here would produce a "generic" module with two
 * flags in it that is really just both adapters in a trench coat.
 *
 * THE READER IS DELIBERATELY GENEROUS AND THE WRITER IS DELIBERATELY PLAIN.
 * Every OpenAI-compatible server agrees about the request and disagrees about
 * the response: `content` is a string on most and an array of typed parts on
 * some, reasoning models put their working in `reasoning` or
 * `reasoning_content` beside it, and one of the two endpoints this was built
 * against (the Pi's router, probed 2026-09-04) returns BOTH with the same text
 * in each when it is cut off at max_tokens. So the request sends the four
 * fields everybody implements and nothing clever, and the reader tries the
 * shapes in the order of how likely they are to be the real answer.
 */
/* The frame reader, in its own file because it is the one piece of this that
   is also needed on the OTHER side of the wire — the browser reads this
   server's SSE with a copy of the same parser. */
import { readSse, type SseFrame } from "./sse.ts";

/** Every outbound call in this file carries one. An agent is allowed to think
 *  for a while; it is not allowed to think for as long as it likes while a
 *  page spins. Sixty seconds is long by HTTP standards and short by agent
 *  standards, which is the honest place to sit: it is enough for a tool-using
 *  turn and short enough that a hung gateway is a sentence rather than a
 *  stall. `verify` uses its own, much shorter, budget — see below. */
export const ASK_TIMEOUT_MS = 60_000;

/** What a connect-time probe gets. A round trip that cannot answer "are you
 *  there and is this token real" in fifteen seconds is not going to answer a
 *  chat turn, and the owner is sitting in front of the form waiting. */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * A STREAM GETS TWO DEADLINES, AND NEITHER OF THEM IS `ASK_TIMEOUT_MS`.
 *
 * The sixty-second budget above exists because a page is spinning on nothing:
 * the whole cost of a slow agent is paid before a single word appears. A
 * stream inverts that. Words are appearing the entire time, the owner can read
 * them, and cutting a working answer off at sixty seconds because the agent is
 * still writing would be the timeout doing harm.
 *
 * What is actually wrong with a stream is SILENCE. So the budget that matters
 * is idle time — no bytes for this long means the far end has died in a way
 * that did not close the socket, which is the failure a TCP connection cannot
 * tell you about on its own. It resets on every chunk.
 *
 * The hard cap is the backstop for the pathological case the idle timer cannot
 * see: an agent looping, emitting a token a second, forever. Ten minutes is
 * long enough that no honest answer hits it and short enough that a runaway is
 * a sentence rather than a socket held until the process restarts.
 */
export const STREAM_IDLE_MS = 90_000;
export const STREAM_MAX_MS = 600_000;

/**
 * A failure with the status that caused it, so the adapters can map 401 to
 * "that token was refused" without re-parsing a string.
 */
export class WireError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WireError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------- urls */

/**
 * The address half of the credential, checked before anything is sent to it.
 *
 * REFUSING A NON-http(s) URL IS NOT PEDANTRY. `fetch` will happily accept
 * `file:` and `data:` and fail somewhere deep, and a pasted `127.0.0.1:18789`
 * with no scheme is parsed by `new URL` as the protocol `127.0.0.1:` with the
 * path `18789` — which is not an error, and is not a server either. Both would
 * surface an hour later as "the agent never answers", so both are refused at
 * the point they were typed.
 *
 * The trailing tidy-up is for what people actually paste. A person copying an
 * endpoint out of a README copies the endpoint, so `…/v1/chat/completions` and
 * `…/v1/models` arrive here regularly; keeping them would build
 * `…/v1/chat/completions/v1/chat/completions`, which 404s with no clue as to
 * why.
 */
export function parseEndpoint(
  raw: string,
  service: string,
): { ok: true; base: string; url: URL } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: `Paste the ${service} URL.` };
  if (text.includes("\n"))
    return { ok: false, error: "That is more than one line. One URL per account here." };

  if (!/^https?:\/\//i.test(text))
    return {
      ok: false,
      error:
        `That is not a URL this can call — it needs a scheme, like ` +
        `http://127.0.0.1:18789 or https://agent.example.com. ` +
        `"${text.slice(0, 40)}" has none.`,
    };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `“${text.slice(0, 60)}” is not a URL.` };
  }
  if (!url.hostname) return { ok: false, error: "That URL has no host." };

  let base = url.origin + url.pathname.replace(/\/+$/, "");
  base = base.replace(/\/(chat\/completions|completions|models)$/, "");
  return { ok: true, base, url: new URL(base) };
}

/**
 * Is this host somewhere a credential may travel in the clear?
 *
 * Loopback and the RFC1918 ranges plus the CGNAT block Tailscale hands out.
 * Used by the OpenClaw adapter and not by the Hermes one, and the asymmetry is
 * on purpose — see the comment at that call site. Anything unrecognised is
 * treated as public, which is the safe direction to be wrong in.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  /* Tailscale's 100.64.0.0/10, and the rest of the CGNAT block with it. */
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

/* ------------------------------------------------------------------ types */

export type WireTurn = { role: "user" | "assistant" | "system"; content: string };

/** The parts of an OpenAI response this reads. Everything is optional because
 *  everything genuinely is: two servers, two subsets. */
type Part = { type?: string; text?: string };
type Message = {
  content?: string | Part[] | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
};
export type Completion = {
  model?: string | null;
  choices?: { message?: Message | null; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
  } | null;
  error?: { message?: string; type?: string } | string | null;
};

/* ----------------------------------------------------------------- reading */

/**
 * The answer, out of whichever field this particular server put it in.
 *
 * ORDER MATTERS AND IS AN OPINION. `content` first, because that is where the
 * answer belongs and where every server that only implements one field puts
 * it. The reasoning fields are a FALLBACK and never a supplement: a model that
 * was cut off mid-thought has its working in `reasoning` and an empty
 * `content`, and showing the owner the working is better than showing them
 * nothing — but concatenating the two when both are present would put the
 * model's scratchpad in front of its answer on every turn.
 *
 * Returns null rather than "" when there is no text anywhere. Null is "the
 * server answered and said nothing", which the caller turns into a sentence;
 * an empty string rendered in a bubble is indistinguishable from a bug.
 */
export function readText(doc: Completion): string | null {
  const message = doc.choices?.[0]?.message;
  if (!message) return null;

  const content = message.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content
      .filter((p) => p && (p.type === undefined || p.type === "text"))
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (joined) return joined;
  }

  const thinking = message.reasoning ?? message.reasoning_content;
  if (typeof thinking === "string" && thinking.trim()) return thinking;
  return null;
}

/** Tokens, when they were counted. `null` throughout rather than 0, because a
 *  server that reports no usage has told us nothing about how many tokens the
 *  turn cost, and a confident 0 on a cost page would be a lie. */
export function readUsage(
  doc: Completion,
): { prompt: number; completion: number } | null {
  const u = doc.usage;
  if (!u) return null;
  const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : null;
  const completion =
    typeof u.completion_tokens === "number" ? u.completion_tokens : null;
  if (prompt === null && completion === null) return null;
  return { prompt: prompt ?? 0, completion: completion ?? 0 };
}

/** The model the server says it used — which is frequently NOT the model that
 *  was asked for. The Pi's router answers `-m auto` with the id of whatever it
 *  routed to, and the owner is entitled to know which one wrote the words. */
export function readModel(doc: Completion): string | null {
  return typeof doc.model === "string" && doc.model.trim() ? doc.model : null;
}

/* ---------------------------------------------------------------- requests */

/**
 * One request, with a deadline that is not negotiable.
 *
 * TWO SIGNALS, COMBINED. The caller's — a browser tab that closed, a Telegram
 * poll that gave up — and this file's own timeout. `AbortSignal.any` means
 * either one ends the call, which is the only correct answer: without the
 * timeout a hung agent pins a socket forever, and without the caller's signal
 * a cancelled page keeps paying for a turn nobody will read.
 */
async function send(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  service: string,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    if (name === "TimeoutError" || deadline.aborted)
      throw new WireError(
        504,
        `${service} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      );
    if (name === "AbortError") throw new WireError(499, `The ${service} call was cancelled.`);
    /*
      A connection refused here is the ordinary case rather than an exception:
      these are addresses on the owner's own machine or LAN, and the thing at
      the other end is a container that may simply not be running. The URL is
      in the message because "could not reach it" without saying WHAT it tried
      to reach is the least useful error a local integration can produce — and
      it is not a secret, it is the address the owner typed.
    */
    throw new WireError(502, `Could not reach ${service} at ${url} (${name}).`);
  }
}

/** Whatever the server said about why it refused, or the bare status when it
 *  said nothing. Capped, because an HTML error page is not a sentence and the
 *  first line of one is all anybody needs. */
async function refusal(res: Response, service: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as Completion;
    const e = body?.error;
    const text = typeof e === "string" ? e : e?.message;
    if (text) detail = ` — ${text}`;
  } catch {
    /* not JSON. The status is all there is, and that is fine. */
  }
  return `${service} answered HTTP ${res.status}${detail}`.slice(0, 400);
}

/** A GET that expects JSON — the model list, a health probe. */
export async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  service: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  const res = await send(
    url,
    { method: "GET", headers: { Accept: "application/json", ...headers } },
    timeoutMs,
    signal,
    service,
  );
  if (!res.ok) throw new WireError(res.status, await refusal(res, service));
  /*
    A 200 carrying HTML is the single most confusing failure on this wire and
    it is not hypothetical: the address the Hermes catalog entry shipped with
    (127.0.0.1:3011) turned out to be a single-page app that serves its own
    index.html for every unmatched path, so `GET /v1/models` came back 200 with
    a doctype. Read as JSON that is a parse error three frames from the cause;
    named here it is one sentence that tells the owner they have the wrong port.
  */
  if (!(res.headers.get("content-type") ?? "").includes("json"))
    throw new WireError(
      res.status,
      `${service} answered with a page rather than JSON at ${url} — that is ` +
        `usually a web UI on the port rather than the API.`,
    );
  return (await res.json()) as T;
}

/**
 * One chat turn.
 *
 * `extra` is where the two adapters put what is theirs: OpenClaw's session
 * headers, and anything Hermes needs later. The body is deliberately the
 * minimum every implementation agrees on — `model`, `messages`, `stream:
 * false` — because each optional field is one more thing a gateway can refuse
 * a whole turn over.
 *
 * STREAMING IS OFF ON THIS FUNCTION, AND IT IS A SEPARATE FUNCTION NOW.
 *
 * This one asks for the whole turn, waits for it, and hands back a document —
 * which is what a caller with nowhere to put a half-answer wants, and there is
 * one: the Telegram bridge, which has no growing bubble to render into and
 * sends a message once. `chatCompletionStream` below is the other shape, and
 * the objection that kept it out for so long ("no honest way to store half an
 * answer") is answered in the schema rather than avoided — see the `partial`
 * column in 019_chat_tools.
 *
 * Two functions rather than one with a flag, because the return types are
 * genuinely different — a document versus a sequence of frames — and a
 * `stream?: boolean` parameter that changes what comes back is a function that
 * every caller has to narrow before it can use.
 */
export async function chatCompletion(opts: {
  base: string;
  path?: string;
  key: string | null;
  model: string;
  turns: WireTurn[];
  service: string;
  extra?: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Completion> {
  const url = `${opts.base}${opts.path ?? "/chat/completions"}`;
  const res = await send(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
        ...opts.extra,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.turns,
        stream: false,
        ...opts.body,
      }),
    },
    opts.timeoutMs ?? ASK_TIMEOUT_MS,
    opts.signal,
    opts.service,
  );
  if (!res.ok) throw new WireError(res.status, await refusal(res, opts.service));
  if (!(res.headers.get("content-type") ?? "").includes("json"))
    throw new WireError(
      res.status,
      `${opts.service} answered with a page rather than JSON at ${url} — that ` +
        `is usually a web UI on the port rather than the API.`,
    );
  return (await res.json()) as Completion;
}

/**
 * One OpenAI streaming chunk. Every field is optional for the same reason the
 * non-streaming `Completion`'s are: two servers, two subsets. The reasoning
 * fields sit on the DELTA here rather than on a message, which is the shape
 * Hermes' router emits them in.
 */
export type StreamChunk = {
  model?: string | null;
  choices?: {
    delta?: {
      content?: string | Part[] | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
  } | null;
  error?: { message?: string; type?: string } | string | null;
};

/** The text out of one delta, in the same order of preference `readText` uses
 *  on a whole message: `content` is the answer, and a string or an array of
 *  parts are both legal spellings of it. Empty string rather than null,
 *  because a chunk with no content is the normal case (the opening
 *  `{"role":"assistant"}` frame) and not a fault worth reporting. */
export function deltaText(
  delta: { content?: string | Part[] | null } | null | undefined,
): string {
  const content = delta?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p) => p && (p.type === undefined || p.type === "text"))
      .map((p) => p.text ?? "")
      .join("");
  return "";
}

/**
 * The same turn, as it is written.
 *
 * WHAT COMES BACK IS FRAMES, NOT TEXT, and that is the point. Hermes'
 * router interleaves named events with the ordinary chunks — a tool starting,
 * a tool finishing — and a function that yielded strings would have thrown
 * away the half of the stream that says what the agent DID. The adapters
 * decide what each frame means, because that is the part the two of them
 * genuinely differ on; the fetch, the deadlines and the refusal are the same
 * on both wires and live here.
 *
 * THE DEADLINES ARE A CONTROLLER RATHER THAN `AbortSignal.timeout`, which is
 * the one real difference from `send()` above. A single timeout on a stream is
 * wrong in both directions at once: short enough to catch a dead gateway is
 * short enough to cut off a long answer, and long enough for a long answer
 * leaves a dead gateway holding a socket for ten minutes. So there are two —
 * an idle timer that resets on every frame, and a hard cap — and both abort
 * the same controller, with a flag saying which fired so the error can say so.
 *
 * The idle timer resets per FRAME rather than per chunk, which is a small
 * inaccuracy in the honest direction: a server dribbling out half a frame
 * every eighty seconds is not a server anybody is being asked to tolerate.
 */
export async function* chatCompletionStream(opts: {
  base: string;
  path?: string;
  key: string | null;
  model: string;
  turns: WireTurn[];
  service: string;
  extra?: Record<string, string>;
  body?: Record<string, unknown>;
  idleMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
}): AsyncGenerator<SseFrame> {
  const url = `${opts.base}${opts.path ?? "/chat/completions"}`;
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  const maxMs = opts.maxMs ?? STREAM_MAX_MS;

  const controller = new AbortController();
  /* Which of the two fired, so the failure names itself. Without this both
     look like a bare AbortError and the owner is told "cancelled" about a
     gateway that stopped talking. */
  let expired: "idle" | "max" | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const hard = setTimeout(() => {
    expired = "max";
    controller.abort();
  }, maxMs);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      expired = "idle";
      controller.abort();
    }, idleMs);
  };
  touch();

  const signal = opts.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          /* Asked for explicitly. A gateway that can answer either way needs
             to be told which, and one that cannot will ignore it. */
          Accept: "text/event-stream",
          ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
          ...opts.extra,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.turns,
          stream: true,
          ...opts.body,
        }),
        signal,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      if (expired) throw expiredError(opts.service, expired, idleMs, maxMs);
      if (name === "AbortError")
        throw new WireError(499, `The ${opts.service} call was cancelled.`);
      throw new WireError(502, `Could not reach ${opts.service} at ${url} (${name}).`);
    }

    if (!res.ok) throw new WireError(res.status, await refusal(res, opts.service));
    /*
      A 200 that is not an event stream is a server that quietly ignored
      `stream: true` and answered with the whole document — which is a
      perfectly reasonable thing for an OpenAI-compatible server to do and is
      NOT an error the caller should die on. It is named as its own status so
      the adapter can fall back to `ask()` rather than showing the owner a
      failure for a turn that actually succeeded somewhere.
    */
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream"))
      throw new WireError(
        406,
        `${opts.service} was asked to stream and answered with ` +
          `${type || "no content type"} instead. That endpoint does not stream.`,
      );
    if (!res.body) throw new WireError(502, `${opts.service} sent an empty stream.`);

    try {
      /* `onActivity` is what makes a keepalive comment count: Hermes sends one
         every thirty seconds while its model thinks, and a first token that
         takes two minutes on a long context is an answer, not a hang. */
      for await (const frame of readSse(res.body, { onActivity: touch })) {
        touch();
        yield frame;
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      if (expired) throw expiredError(opts.service, expired, idleMs, maxMs);
      /*
        THE CALLER'S SIGNAL IS CHECKED BEFORE THE ERROR'S NAME, because a body
        read that is aborted mid-stream does NOT reliably surface as an
        AbortError — undici raises a plain TypeError from the reader when the
        request underneath it goes away, and reporting that as "the stream
        broke" would blame the agent for a tab the owner closed.
      */
      if (opts.signal?.aborted)
        throw new WireError(
          499,
          `The ${opts.service} stream was cancelled — whatever it had already ` +
            `said is kept.`,
        );
      if (name === "AbortError")
        throw new WireError(499, `The ${opts.service} stream was cancelled.`);
      throw new WireError(
        502,
        `${opts.service}'s stream broke half way (${name}).`,
      );
    }
  } finally {
    clearTimeout(hard);
    clearTimeout(idle);
  }
}

function expiredError(
  service: string,
  which: "idle" | "max",
  idleMs: number,
  maxMs: number,
): WireError {
  return which === "idle"
    ? new WireError(
        504,
        `${service} stopped sending anything for ${Math.round(idleMs / 1000)} ` +
          `seconds mid-answer. Whatever it had already said is kept.`,
      )
    : new WireError(
        504,
        `${service} was still writing after ${Math.round(maxMs / 60_000)} ` +
          `minutes. The answer so far is kept.`,
      );
}

/** The `{ data: [{ id }] }` every OpenAI-compatible server returns from
 *  `/models`, reduced to the ids. An entry without an id is dropped rather
 *  than named "undefined" in a picker. */
export function readModelIds(doc: unknown): string[] {
  const data = (doc as { data?: { id?: unknown }[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (typeof m?.id === "string" ? m.id.trim() : ""))
    .filter((id) => id.length > 0);
}
