/**
 * THE TRANSPORT THIS AREA READS GMAIL THROUGH, AND THE ONE THING IT PROMISES:
 * it can only GET.
 *
 * `method: "GET"` is written once, below, and there is no body parameter. So
 * nothing in `integrations/people/` can archive, label, trash, send or modify
 * anything in the mailbox — the same argument `providers/gmail.ts` makes about
 * its own reader, made again here rather than borrowed, because that file's
 * `get` is private to it and exporting it would widen a surface its header
 * spends four paragraphs bounding.
 *
 * WHAT IS *NOT* PROMISED HERE is the metadata discipline. This transport will
 * fetch whatever path it is handed, and one caller in this area — the
 * commitments scan — deliberately asks for message bodies. The "no bodies"
 * promise therefore belongs to the REQUEST SHAPES in gmail-meta.ts, where
 * `format=metadata` and an explicit header list make it a property of what is
 * asked for; and the "nothing is stored" promise belongs to gmail-sent.ts,
 * where the bodies are read and dropped inside one function. Two narrow claims
 * that can each be checked in one file, rather than one wide one that cannot.
 *
 * THE SECOND GATE, AND WHY IT IS MUCH SLOWER THAN THE FIRST. providers/gmail.ts
 * paces its requests at 140 quota units a second against a ceiling its header
 * says was measured at about 250. Its spacer is module-private and knows
 * nothing about this file, so on a tick where the mail collector and this area
 * overlap the account is spending both budgets at once — which is not a
 * hypothetical: the first live collection here came back 403 "Quota exceeded
 * for quota metric 'Total Query Cost'" on its very first call. So this one is
 * paced well under half the ceiling, a throttle backs the WHOLE area off rather
 * than one request, and every call retries five times. The failure being
 * guarded against is a half-scanned window, which reads exactly like a quiet
 * mailbox.
 */
import { GMAIL_API, GmailError } from "../../providers/gmail.ts";

/** Google's published prices for the calls this area makes. */
export const COST = { profile: 1, messageList: 5, messageGet: 5 } as const;
/**
 * SIXTY UNITS A SECOND, WHICH IS LESS THAN HALF THE CEILING, AND THAT IS THE
 * POINT.
 *
 * Google's limit that actually bites is 15,000 units a MINUTE per user — a
 * moving average, shared by every process holding that grant. This box now has
 * more than one reader of the same mailbox and each has its own spacer, so
 * pacing at anything near the ceiling means the first tick on which two of them
 * overlap comes back 403 "Quota exceeded" and a year of contacts arrives empty.
 * Sixty leaves room for the others and costs a slower scan, which is the right
 * way round: a slow scan is a slow scan, and a throttled one looks like a quiet
 * mailbox.
 */
const UNITS_PER_SECOND = 60;
const TIMEOUT_MS = 45_000;

/** Six at a time. The gate below is what keeps the RATE honest; the
 *  concurrency only decides how much of the wall clock is spent waiting on
 *  Google rather than on the spacer. */
export const CONCURRENCY = 6;

const RATE_LIMITED = /rate ?limit|Quota exceeded|userRateLimitExceeded/i;
/** Five tries at 5s, 20s, 45s and 80s of backoff. Generous because the limit
 *  is a MOVING average: coming back too soon re-triggers it, and the cost of
 *  giving up early is a window that reads as empty rather than as refused. */
const MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextSlot = 0;
async function gate(units: number) {
  const t = Date.now();
  const start = Math.max(t, nextSlot);
  nextSlot = start + (units * 1000) / UNITS_PER_SECOND;
  if (start > t) await sleep(start - t);
}

/**
 * THE ONLY FUNCTION IN THIS AREA THAT TALKS TO GMAIL, and the only place the
 * word "GET" appears in it.
 *
 * Retries only for the rate limit: a 401 is a dead grant and a 404 is a message
 * somebody deleted mid-scan, and asking either again spends a request to be
 * told the same thing.
 */
export async function gmailGet<T>(
  path: string,
  token: string,
  params: [string, string][],
  units: number,
): Promise<T> {
  const url = `${GMAIL_API}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    await gate(units);
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      /* A `fields` mask makes Gmail answer 200 with ZERO BYTES when nothing it
         selects is present — an empty page of results, most often. That is a
         real answer, not a broken one; see the same note in providers/gmail.ts. */
      const text = await res.text();
      return (text.trim() ? JSON.parse(text) : {}) as T;
    }
    const body = await res.text();
    let message = body.slice(0, 300);
    try {
      const doc = JSON.parse(body) as { error?: { message?: string } };
      if (doc.error?.message) message = doc.error.message.slice(0, 300);
    } catch {
      /* not the documented shape; the body stands */
    }
    const throttled =
      (res.status === 429 || res.status === 403) && RATE_LIMITED.test(message);
    if (!throttled || attempt >= MAX_ATTEMPTS - 1) throw new GmailError(res.status, message);
    /*
      A THROTTLE STOPS THE WHOLE AREA, not just this request.

      The ceiling is per USER, so being told to slow down is news about the
      account rather than about one call: five workers each backing off
      independently would send four more requests into the same refusal while
      the first one waited. Pushing the shared spacer forward makes every
      request in flight behind this one wait too, which is what actually lets
      the moving average fall.
    */
    const wait = 5000 * (attempt + 1) ** 2;
    nextSlot = Math.max(nextSlot, Date.now() + wait);
    await sleep(wait);
  }
}

/** The worker pool providers/gmail.ts uses, written out again rather than
 *  shared across areas: eight lines twice beats a util module two areas have
 *  to agree about. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/* ------------------------------------------------------------------ headers */

export type Header = { name?: string; value?: string };

/** EVERY value of a header, not the first: a wide Cc is folded across several
 *  lines and taking only the first drops most of the recipients. */
export function headerAll(headers: Header[], name: string): string[] {
  const want = name.toLowerCase();
  const out: string[] = [];
  for (const h of headers)
    if ((h.name ?? "").toLowerCase() === want && h.value) out.push(h.value);
  return out;
}

export function header(headers: Header[], name: string): string {
  return headerAll(headers, name)[0] ?? "";
}

/** Addresses by SHAPE rather than by splitting on commas — `"Ogbeide, Courage"
 *  <c@x.io>` is one recipient with a comma inside a quoted display name, and
 *  comma-splitting turns it into two. */
const ADDRESS_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g;

export function addressesOf(...values: string[]): string[] {
  const out: string[] = [];
  for (const value of values)
    for (const m of value.matchAll(ADDRESS_RE)) {
      const address = m[0].trim().toLowerCase().replace(/[.,;>]+$/, "");
      if (address.includes("@") && !address.endsWith("@")) out.push(address);
    }
  return out;
}

/** `Jane Smith <jane@x.io>` as its two halves. The display name is a label
 *  somebody typed about themselves; the address is the fact. */
export function splitFrom(value: string): { address: string; name: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (m)
    return {
      address: m[2]!.trim().toLowerCase(),
      name: m[1]!.replace(/^"(.*)"$/, "$1").trim(),
    };
  return { address: value.trim().toLowerCase(), name: "" };
}
