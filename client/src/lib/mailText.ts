/**
 * THE EMAIL AREA'S PLAIN WORDS — how a time, a sender, a triage verdict and a
 * delivery event are said on every Email tab, in one place so the tabs agree.
 *
 * Pure functions only (no React), so they are unit-tested in mailText.test.ts.
 */

/**
 * A timestamp from any of the mail sources, as epoch milliseconds, or null.
 *
 * Resend stamps come back as `2026-09-29 11:47:55.208+00` — Postgres's own
 * shape, with a two-digit offset that `Date.parse` refuses. Left alone, every
 * "Sent by apps" row drew no time at all. Numbers pass through.
 */
export function parseStamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  let s = value.trim().replace(" ", "T");
  /* "+00" / "-05" → "+00:00" / "-05:00" */
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  /* Six fractional digits → three: some engines refuse microseconds. */
  s = s.replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A mail list's time column, the way people say it: "just now", "5m ago",
 * "2h ago", "Yesterday", "Mon", "3 Mar", "3 Mar 2024". `now` is injectable for
 * the tests.
 */
export function mailTime(value: string | number | null | undefined, now: number = Date.now()): string {
  const ms = parseStamp(value);
  if (ms === null) return "";
  const diff = now - ms;
  if (diff < 0) return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const d = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday || hours < 6) return `${hours}h ago`;
  if (ms >= startOfToday - 86_400_000) return "Yesterday";
  if (ms >= startOfToday - 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
  });
}

/** Gmail's snippets arrive HTML-escaped ("can&#39;t"). Decode the common
 *  entities for display; the text is still drawn as plain text, never markup. */
export function decodeEntities(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The name to show for a sender: the display name, else the part of the
 *  address before the @, else a placeholder. */
export function senderName(name: string | null | undefined, address: string | null | undefined): string {
  const n = (name ?? "").replace(/^["']|["']$/g, "").trim();
  if (n) return n;
  const a = bareAddress(address);
  if (a) return a;
  return "Unknown sender";
}

/** `Acme <hello@acme.example>` → `hello@acme.example`. */
export function bareAddress(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1]! : v).trim();
}

/** The domain of an address, or "". */
export function addressDomain(value: string | null | undefined): string {
  const a = bareAddress(value);
  const at = a.lastIndexOf("@");
  return at >= 0 ? a.slice(at + 1).toLowerCase() : "";
}

/** One or two letters for an avatar. */
export function initials(label: string): string {
  const clean = label.replace(/<.*?>/g, "").replace(/[^\p{L}\p{N}\s@._-]/gu, "").trim();
  if (!clean) return "?";
  const base = clean.includes("@") && !clean.includes(" ") ? clean.split("@")[0]! : clean;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? base).slice(0, 1).toUpperCase();
}

/** A stable hue (0–359) for an avatar, so a sender keeps their colour. */
export function avatarHue(seed: string): number {
  let h = 0;
  for (const ch of seed.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/* ------------------------------------------------------------ triage words */

export type TriageKey = "needs_reply" | "waiting_on_them" | "fyi" | "noise" | "unscored";

export type Tone = "bad" | "warn" | "ok" | "muted";

/** What each triage verdict is called on screen, and what it means in a line. */
export const TRIAGE_LABELS: Record<TriageKey, { label: string; short: string; hint: string; tone: Tone }> = {
  needs_reply: { label: "Needs reply", short: "Needs reply", hint: "Someone is waiting for your answer.", tone: "bad" },
  waiting_on_them: { label: "Waiting on them", short: "Waiting", hint: "You replied — the ball is in their court.", tone: "warn" },
  fyi: { label: "FYI", short: "FYI", hint: "Worth knowing, nothing to answer.", tone: "ok" },
  noise: { label: "Newsletter", short: "Newsletter", hint: "Newsletters, alerts and receipts — nothing to answer.", tone: "muted" },
  unscored: { label: "Not sorted yet", short: "Not sorted", hint: "Not sorted yet — read it yourself.", tone: "muted" },
};

export function triageKey(score: string | null | undefined): TriageKey {
  return score && score in TRIAGE_LABELS ? (score as TriageKey) : "unscored";
}

/* ----------------------------------------------------- delivery (Resend) */

/** Resend's last event, said plainly, with a tone. Null means nothing was
 *  reported yet — which is not the same as "not delivered". */
export function deliveryLabel(event: string | null | undefined): { label: string; tone: Tone } {
  switch ((event ?? "").toLowerCase()) {
    case "delivered":
      return { label: "Delivered", tone: "ok" };
    case "opened":
      return { label: "Opened", tone: "ok" };
    case "clicked":
      return { label: "Clicked", tone: "ok" };
    case "bounced":
      return { label: "Bounced", tone: "bad" };
    case "complained":
      return { label: "Marked as spam", tone: "bad" };
    case "delivery_delayed":
      return { label: "Delayed", tone: "warn" };
    case "failed":
      return { label: "Failed", tone: "bad" };
    case "sent":
      return { label: "Sent", tone: "muted" };
    case "queued":
    case "scheduled":
      return { label: "Queued", tone: "muted" };
    case "":
      return { label: "No update yet", tone: "muted" };
    default:
      return { label: event![0]!.toUpperCase() + event!.slice(1).replace(/_/g, " "), tone: "muted" };
  }
}

/* ----------------------------------------------------------- people words */

/** A contact's temperature, said as a relationship state. */
export function temperatureLabel(t: string | null | undefined): { label: string; tone: Tone } {
  if (t === "warm") return { label: "In touch", tone: "ok" };
  if (t === "cooling") return { label: "Cooling off", tone: "warn" };
  if (t === "cold") return { label: "Gone cold", tone: "bad" };
  return { label: "Too new to tell", tone: "muted" };
}

/** "2026-W39" → "Week 39, 2026" (current year drops the year). */
export function weekLabel(week: string, now: Date = new Date()): string {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(week);
  if (!m) return week;
  const n = Number(m[2]);
  return Number(m[1]) === now.getFullYear() ? `Week ${n}` : `Week ${n}, ${m[1]}`;
}

/**
 * When a promise is due, in words. `due` is a bare YYYY-MM-DD or null.
 * Overdue only when a real date has passed — an undated promise is never late.
 */
export function dueLabel(
  due: string | null,
  dueText: string | null,
  open: boolean,
  now: Date = new Date(),
): { label: string; overdue: boolean } {
  if (!due) return { label: dueText ? `“${dueText}”` : "No date given", overdue: false };
  const today = now.toISOString().slice(0, 10);
  const pretty = new Date(`${due}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  if (open && due < today) return { label: `Overdue · was due ${pretty}`, overdue: true };
  if (due === today) return { label: "Due today", overdue: false };
  return { label: `Due ${pretty}`, overdue: false };
}

/**
 * Server sentences sometimes carry raw stamps ("reached back only to
 * 2025-10-01T09:40:18.000Z", "Relations — 2026-W39"). Say them as dates.
 */
export function humanizeStamps(text: string | null | undefined, now: Date = new Date()): string {
  return (text ?? "")
    .replace(/\b(\d{4}-\d{2}-\d{2})T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, (m) => {
      const ms = parseStamp(m);
      if (ms === null) return m;
      const d = new Date(ms);
      return d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
      });
    })
    .replace(/\b\d{4}-W\d{1,2}\b/g, (m) => weekLabel(m, now));
}

/** Plural helper: `plural(3, "email")` → "3 emails". */
export function plural(n: number, word: string, many?: string): string {
  return `${n} ${n === 1 ? word : (many ?? `${word}s`)}`;
}
