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
 * STREAMING IS EXPLICITLY OFF. Both servers support SSE and the page could
 * render it, but a streamed answer has to be persisted at the end anyway and
 * the failure modes are worse: a stream that dies half way has already put
 * half an answer on screen, and there is no honest way to store that as a
 * message. This asks for the whole turn, waits for it, writes it down, and
 * returns it. See the note in routes/chat.ts about what streaming would cost.
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
