/**
 * THE SHAPE EVERY SOCIAL PUBLISHER ANSWERS IN, and the seam that lets one be
 * rehearsed without posting.
 *
 * FOUR NETWORKS, ONE ANSWER TYPE. Facebook returns `{id, post_id}`, Instagram
 * a container then a media id then a permalink lookup, LinkedIn an id in a
 * response HEADER, and TikTok a publish id with the error INSIDE a 200 body.
 * Four shapes for one question — did it go out, where is it, and if not why —
 * so they are normalised here, once, and the pipeline above never learns which
 * network it is talking to except to choose the function.
 *
 * `configured: false` IS ITS OWN STATE and it is not a failure. A network
 * nobody connected and a network that refused the post must never render
 * alike: the first is a thing to go and set up, the second is a thing to fix
 * about the post. The pipeline reports them differently and this flag is what
 * lets it.
 *
 * ------------------------------------------------------------------------
 * THE TRANSPORT IS INJECTED, AND THAT IS THE LOAD-BEARING DECISION HERE.
 *
 * Every publisher takes a `Transport` instead of calling `fetch` directly. In
 * production it IS `fetch`, wrapped so that each request is recorded — method,
 * URL, content type, a summary of the body — with every credential removed.
 * That record is what `publish_attempts.calls` holds, and it is the only way
 * an owner can afterwards answer "what did this box actually send to Meta".
 *
 * In a DRY RUN the same publishers run against a transport that records the
 * request and answers with a canned success. Nothing about the code path
 * changes: the same limits are checked, the same page token is resolved from
 * the same credential, the same body is composed. That is the difference
 * between proving a pipeline and asserting one — and on a box where no
 * destination has posting permission yet, it is the only proof available.
 *
 * A CREDENTIAL NEVER REACHES THE RECORD. `redact` runs over the URL and over
 * every body summary; the access token, the app secret proof and the bearer
 * header are replaced with a marker. A publish log that leaked the Page token
 * would be worse than no publish log.
 */

/** One request a publisher made, or would have made. */
export type RecordedCall = {
  method: string;
  /** With every credential-shaped query parameter replaced. */
  url: string;
  /** What kind of body went up, not the body: "multipart (image/png, 214 KB)",
   *  "form: caption, published", "json: author, commentary". */
  body: string | null;
  status: number | null;
  /** Milliseconds for this one call. */
  ms: number | null;
  /** True when nothing left this machine. */
  dry: boolean;
};

/**
 * A transport is a `fetch` with a memory.
 *
 * It answers a Response like fetch does, and pushes one RecordedCall per
 * request onto `calls`. A dry transport answers `canned` without opening a
 * socket.
 */
export type Transport = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  calls: RecordedCall[];
  dry: boolean;
};

/** Query parameters whose values are credentials on one of these four APIs. */
const SECRET_PARAMS = ["access_token", "appsecret_proof", "client_secret", "code"];

/** A URL with its credential-shaped parameters blanked. Not a parser: a URL
 *  this cannot parse is truncated rather than logged whole, because an
 *  unparseable URL is exactly where a token ends up by accident. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const p of SECRET_PARAMS) if (u.searchParams.has(p)) u.searchParams.set(p, "REDACTED");
    return u.toString();
  } catch {
    return url.slice(0, 120) + (url.length > 120 ? "…" : "");
  }
}

/** Describe a body without keeping it: types and field names only. */
export function describeBody(init: RequestInit | undefined): string | null {
  /* `unknown` rather than the declared body type: RequestInit's body union
     includes primitives, and `instanceof` refuses a left-hand side that might
     be one. Narrowing from unknown is the same three checks and compiles. */
  const body: unknown = init?.body;
  if (body === undefined || body === null) return null;
  if (typeof body === "string") {
    /* JSON and urlencoded both arrive as strings. Field NAMES are useful and
       field values are the caption, the token or somebody's URL — so only the
       names travel. */
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object")
        return `json: ${Object.keys(parsed as Record<string, unknown>).join(", ")}`;
    } catch {
      /* not JSON */
    }
    if (body.includes("=")) {
      const names = [...new URLSearchParams(body).keys()].filter(
        (k) => !SECRET_PARAMS.includes(k),
      );
      if (names.length) return `form: ${names.join(", ")}`;
    }
    return `text, ${body.length} chars`;
  }
  if (body instanceof FormData) {
    const parts: string[] = [];
    for (const [k, v] of body.entries()) {
      if (SECRET_PARAMS.includes(k)) continue;
      /* A form entry is a string or a file. `typeof` rather than `instanceof`,
         because the entry union includes a primitive and `instanceof` refuses
         a left-hand side that might be one. */
      if (typeof v === "string") parts.push(k);
      else parts.push(`${k}=<${v.type || "binary"}, ${Math.round(v.size / 1024)} KB>`);
    }
    return `multipart: ${parts.join(", ")}`;
  }
  if (body instanceof Uint8Array) return `bytes, ${Math.round(body.byteLength / 1024)} KB`;
  return "binary";
}

/** The real one. Every call is timed and recorded; the answer is untouched. */
export function liveTransport(): Transport {
  const calls: RecordedCall[] = [];
  return {
    calls,
    dry: false,
    async fetch(url, init) {
      const started = Date.now();
      try {
        const res = await globalThis.fetch(url, init);
        calls.push({
          method: init?.method ?? "GET",
          url: redact(url),
          body: describeBody(init),
          status: res.status,
          ms: Date.now() - started,
          dry: false,
        });
        return res;
      } catch (err) {
        calls.push({
          method: init?.method ?? "GET",
          url: redact(url),
          body: describeBody(init),
          status: null,
          ms: Date.now() - started,
          dry: false,
        });
        throw err;
      }
    },
  };
}

/**
 * The rehearsal. Records the request and answers a plausible success WITHOUT
 * opening a socket.
 *
 * The canned answers are keyed on the shape of the path rather than on a
 * network name, so a publisher that grew a new call gets a sensible default
 * (an empty 200 JSON object) rather than a crash — and the recorded call list
 * still shows that the new call was made, which is the point.
 *
 * IT NEVER PRETENDS TO BE A PUBLISH. The pipeline knows the transport is dry
 * and refuses to write an external id, a permalink or a `published` status
 * from one; what it writes is an attempt row marked `dry`.
 */
export function dryTransport(): Transport {
  const calls: RecordedCall[] = [];
  return {
    calls,
    dry: true,
    async fetch(url, init) {
      calls.push({
        method: init?.method ?? "GET",
        url: redact(url),
        body: describeBody(init),
        status: 200,
        ms: 0,
        dry: true,
      });
      return new Response(JSON.stringify(cannedFor(url)), {
        status: 200,
        headers: {
          "content-type": "application/json",
          /* LinkedIn's post id comes back in a header and nowhere else, so the
             rehearsal has to carry one or the LinkedIn publisher would report
             a success it could not name. */
          "x-restli-id": "urn:li:share:DRY-RUN",
        },
      });
    },
  };
}

function cannedFor(url: string): Record<string, unknown> {
  if (/\/me\/accounts/.test(url))
    return {
      data: [
        {
          id: "DRY-PAGE",
          name: "Dry run page",
          access_token: "DRY-PAGE-TOKEN",
          instagram_business_account: { id: "DRY-IG", username: "dryrun" },
        },
      ],
    };
  if (/\/photos|\/videos|\/feed/.test(url)) return { id: "DRY-MEDIA", post_id: "DRY-PAGE_DRY-POST" };
  if (/media_publish/.test(url)) return { id: "DRY-IG-MEDIA" };
  if (/\/media\b/.test(url)) return { id: "DRY-IG-CONTAINER" };
  if (/permalink/.test(url)) return { permalink: "https://www.instagram.com/p/DRY/" };
  if (/creator_info/.test(url))
    return {
      data: { privacy_level_options: ["SELF_ONLY"], creator_nickname: "dry run" },
      error: { code: "ok" },
    };
  if (/publish\/status\/fetch/.test(url))
    return { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } };
  if (/publish\/video\/init/.test(url))
    return { data: { publish_id: "DRY-TT-PUBLISH" }, error: { code: "ok" } };
  if (/rest\/images/.test(url))
    return { value: { uploadUrl: "https://example.invalid/dry-upload", image: "urn:li:image:DRY" }, status: "AVAILABLE" };
  return {};
}

/** What every publisher answers. Never throws — a publisher that threw would
 *  make a bug in this file indistinguishable from a network refusing a post. */
export type PublishOutcome = {
  ok: boolean;
  /** Set only on a real success. A dry run leaves it null and says so. */
  id: string | null;
  url: string | null;
  /** False means "nobody set this up", which is a different sentence from an
   *  error and gets one. */
  configured: boolean;
  error: string | null;
  /** Anything true and worth saying that is not an error — TikTok's privacy
   *  demotion is the reason this field exists. */
  note: string | null;
};

export const failed = (error: string, configured = true): PublishOutcome => ({
  ok: false,
  id: null,
  url: null,
  configured,
  error,
  note: null,
});
