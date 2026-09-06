/**
 * ONE REPLICATE PREDICTION, END TO END — the one implementation.
 *
 * Two areas ran a prediction: the Studio makes an image, the social feed
 * animates it. Same endpoint, same `Prefer: wait` header, same `owner/name`
 * validation regex, same recursive walk over the output looking for a URL —
 * `firstUrl` was written twice — and a single UGC job calls both.
 *
 * AND THE TWO HALVES OF THAT ONE JOB BEHAVED DIFFERENTLY, for no stated
 * reason. The image call gave up the moment Replicate handed back a prediction
 * that was still queued, telling the owner to press the button again; the
 * animation call polled the prediction's own `urls.get` with a retry budget.
 * The polling one is right and it is what this file does, because of what the
 * other one costs: BY THE TIME A PREDICTION EXISTS IT HAS BEEN PAID FOR.
 * Abandoning it because Replicate would not hold the connection open for the
 * full sixty seconds is the worst of both — the money is spent and the file is
 * thrown away. So `poll` is an OPTION rather than a difference between two
 * files, it defaults to on, and the caller that genuinely wants the
 * synchronous-only behaviour has to ask for it.
 *
 * A FAILED POLL IS COUNTED, NOT FATAL, for the same reason. Only
 * `failuresAllowed` consecutive failures end it, and the sentence then says
 * the prediction may still have finished at Replicate — because it may have,
 * and the owner's own dashboard is where they would find it.
 *
 * EVERY POLL HAS ITS OWN TIMEOUT. Without one a hung connection hangs the run:
 * the deadline is only checked BETWEEN iterations, and a fetch that never
 * settles never reaches the next one.
 *
 * WHAT THIS DOES NOT DO: it does not pick a model, does not know what an
 * aspect ratio is, and does not choose a token. Those are the caller's, and
 * they are genuinely different per area — the Studio has a default model and
 * the animation deliberately has none, because image-to-video costs dollars a
 * clip and the price differs a hundredfold between models.
 */
import { REPLICATE_API } from "../providers/replicate.ts";

/** A model reference Replicate will accept on the model-scoped endpoint. The
 *  model-scoped door (`/v1/models/<owner>/<name>/predictions`) rather than the
 *  generic one, because it takes no version hash: a version pinned in code is
 *  code that stops working the day the model publishes a new one, for a
 *  feature whose whole point is that the model is a setting. */
const MODEL_RE = /^[\w.-]+\/[\w.-]+$/;

/** How long the synchronous door is held open. Replicate's own `Prefer: wait`
 *  caps out around a minute; this is that plus room for the round trip. */
const WAIT_MS = 90_000;
/** How long the whole poll may run, how long between polls, how long any one
 *  poll may take, and how many consecutive failures end it. */
const POLL_FOR_MS = 12 * 60_000;
const POLL_EVERY_MS = 3_000;
const POLL_TIMEOUT_MS = 20_000;
const POLL_FAILURES_ALLOWED = 3;

/** How long a finished artefact has to download. */
const DOWNLOAD_MS = 120_000;

/** The states Replicate stops in. Anything else is still going. */
const TERMINAL = ["succeeded", "failed", "canceled"];

export type PollOptions = {
  forMs?: number;
  everyMs?: number;
  timeoutMs?: number;
  failuresAllowed?: number;
};

export type PredictOptions = {
  /** An `r8_…` API token. Which account it came from is the caller's
   *  business — see `tokenAccounts` in providers/replicate.ts. */
  token: string;
  /** `owner/name`. Validated before anything is spent. */
  model: string;
  /** The model's own input object, passed through untouched. */
  input: Record<string, unknown>;
  /** `false` gives up on a prediction Replicate did not finish while the
   *  connection was held open. Default is to poll — see the header. */
  poll?: boolean | PollOptions;
  /** How long the synchronous door is held open. */
  waitMs?: number;
  /** Cancellation from the run that asked for this. */
  signal?: AbortSignal;
};

export type PredictionDoc = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  detail?: string;
  urls?: { get?: string };
};

export type PredictResult =
  | { ok: true; output: unknown; status: string; doc: PredictionDoc; ms: number; spent: true }
  | {
      ok: false;
      error: string;
      status: string | null;
      /**
       * Whether a prediction was created, i.e. whether this cost money.
       *
       * The distinction matters enough to be a field rather than a wording:
       * "no model is configured, so nothing was spent" and "the prediction ran
       * and failed" send an owner to two different places, and a run's report
       * should be able to say which without parsing a sentence.
       */
      spent: boolean;
      ms: number;
    };

/** Both the caller's cancellation and a timeout, never one or the other.
 *  `signal ?? timeout` meant a run that HAD a cancellation signal made a
 *  request with no timeout at all, so a Replicate that stopped answering hung
 *  the run until somebody cancelled it by hand. */
function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/**
 * Start one prediction and see it through to a terminal state.
 *
 * Returns the raw `output` rather than a file: what an output IS differs by
 * model — a URL, a list of URLs, an object with a `video` key, a string of
 * text — and `firstUrl` beside this is the walker for the common case.
 */
export async function predict(opts: PredictOptions): Promise<PredictResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const fail = (error: string, spent: boolean, status: string | null = null): PredictResult => ({
    ok: false,
    error,
    status,
    spent,
    ms: ms(),
  });

  if (!MODEL_RE.test(opts.model))
    return fail(`“${opts.model}” is not a Replicate model. It wants owner/name. Nothing was spent.`, false);
  if (!opts.token.trim())
    return fail("Replicate is not connected, so nothing ran. Paste an `r8_…` API token under Integrations → Replicate.", false);

  const waitMs = opts.waitMs ?? WAIT_MS;
  let doc: PredictionDoc;
  try {
    const res = await fetch(`${REPLICATE_API}/models/${opts.model}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
        /* The synchronous door. Without it this answers immediately with a
           queued prediction and somebody has to poll for all of it. */
        Prefer: "wait",
      },
      body: JSON.stringify({ input: opts.input }),
      signal: deadline(waitMs, opts.signal),
    });
    doc = (await res.json().catch(() => ({}))) as PredictionDoc;
    if (!res.ok)
      /* A rejected POST created nothing, so nothing was spent — a 402 for a
         card that expired and a 422 for a bad input field are both free. */
      return fail(
        `Replicate answered HTTP ${res.status}${doc?.detail ? ` — ${doc.detail}` : ""}.`,
        false,
      );
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    /* A request that never got an answer MAY have created a prediction, and
       saying "nothing was spent" would be a claim this cannot make. */
    return fail(
      name === "TimeoutError"
        ? `Replicate did not answer within ${Math.round(waitMs / 1000)} seconds.`
        : `Could not reach Replicate (${name}).`,
      true,
    );
  }

  if (opts.poll === false && doc.status && !TERMINAL.includes(doc.status))
    return fail(
      `The prediction is “${doc.status}” — Replicate did not finish it while the connection was ` +
        "held open, and this caller asked not to poll. The prediction was paid for and may still " +
        "have finished; look for it in Replicate's own dashboard.",
      true,
      doc.status,
    );

  if (opts.poll !== false) {
    const p = typeof opts.poll === "object" ? opts.poll : {};
    const until = Date.now() + (p.forMs ?? POLL_FOR_MS);
    const every = p.everyMs ?? POLL_EVERY_MS;
    const timeout = p.timeoutMs ?? POLL_TIMEOUT_MS;
    const allowed = p.failuresAllowed ?? POLL_FAILURES_ALLOWED;
    let failures = 0;

    while (doc.status && !TERMINAL.includes(doc.status) && Date.now() < until) {
      if (opts.signal?.aborted)
        return fail("The run was cancelled while the prediction was still going.", true, doc.status);
      await new Promise((r) => setTimeout(r, every));
      const get = doc.urls?.get;
      /* No `urls.get` is not a retryable failure — there is nowhere to ask. */
      if (!get) break;
      const res = await fetch(get, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
        signal: deadline(timeout, opts.signal),
      }).catch(() => null);
      if (!res?.ok) {
        failures += 1;
        if (failures >= allowed)
          return fail(
            `Replicate stopped answering when asked how the prediction was going (${failures} tries in a row). ` +
              "The prediction was paid for and may still have finished — look for it in Replicate's own dashboard.",
            true,
            doc.status ?? null,
          );
        continue;
      }
      failures = 0;
      doc = (await res.json().catch(() => doc)) as PredictionDoc;
    }
  }

  if (doc.status !== "succeeded")
    return fail(
      `The prediction is “${doc.status ?? "unknown"}”${doc.error ? ` — ${String(doc.error).slice(0, 300)}` : ""}.`,
      true,
      doc.status ?? null,
    );
  /* A succeeded prediction with an error beside it is Replicate telling you
     the model ran and complained. It is a failure here: handing the caller an
     output it has already been told is wrong is how a broken image gets
     published. */
  if (doc.error)
    return fail(`The prediction failed — ${String(doc.error).slice(0, 300)}`, true, doc.status);

  return { ok: true, output: doc.output, status: doc.status, doc, ms: ms(), spent: true };
}

/**
 * The first HTTP URL anywhere in a prediction's output.
 *
 * A STRING, A LIST, OR AN OBJECT WITH ONE INSIDE. Replicate's output shape is
 * the model's, not the API's: an image model returns a list of URLs, a video
 * model an object with a `video` key, some return a bare string. Rather than a
 * per-model map that would need editing every time a setting changed, this
 * walks. The two copies this replaces differed on exactly that last case —
 * one did not look inside objects at all, so a model that returned
 * `{video: "https://…"}` read as "produced no URL".
 *
 * The `http` prefix check is what keeps a base64 data string or a caption out
 * of the result.
 */
export function firstUrl(output: unknown): string | null {
  if (typeof output === "string") return output.startsWith("http") ? output : null;
  if (Array.isArray(output)) {
    for (const o of output) {
      const u = firstUrl(o);
      if (u) return u;
    }
    return null;
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    /* The keys the models on this box actually use, in order, before falling
       back to every other value. Named first so `{url, thumbnail}` gives the
       artefact rather than whichever key the object happened to list first. */
    for (const key of ["video", "url", "image", "output"]) {
      const u = firstUrl(o[key]);
      if (u) return u;
    }
    for (const v of Object.values(o)) {
      const u = firstUrl(v);
      if (u) return u;
    }
  }
  return null;
}

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; error: null }
  | { ok: false; bytes: null; error: string };

/**
 * The finished artefact, fetched and capped.
 *
 * Both callers wrote this block with different caps and different sentences.
 * The cap is a real limit and not paranoia: these files are held whole in
 * memory before they are written, because they are one file that is already
 * entirely in a response body, and a model that returned a gigabyte would
 * otherwise take the process with it.
 */
export async function download(opts: {
  url: string;
  /** Bytes. Above this the download is refused with what it actually was. */
  cap: number;
  /** What the thing is, for the sentence: "image", "clip". */
  what: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_MS;
  const no = (error: string): DownloadResult => ({ ok: false, bytes: null, error });
  try {
    const res = await fetch(opts.url, { signal: deadline(timeoutMs, opts.signal) });
    if (!res.ok) return no(`The ${opts.what} URL answered HTTP ${res.status}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return no(`The ${opts.what} URL answered with nothing.`);
    if (bytes.length > opts.cap)
      return no(
        `The ${opts.what} is ${Math.round(bytes.length / 1024)} KB, which is larger than the ` +
          `${Math.round(opts.cap / 1024)} KB this stores.`,
      );
    return { ok: true, bytes, error: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return no(
      name === "TimeoutError"
        ? `The finished ${opts.what} took longer than ${Math.round(timeoutMs / 1000)} seconds to download.`
        : `The finished ${opts.what} could not be downloaded (${name}).`,
    );
  }
}
