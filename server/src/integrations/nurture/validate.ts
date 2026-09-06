/**
 * THE FACT PACKET AND THE GATE THE WORDING HAS TO PASS.
 *
 * This file is pure: no database, no network, no clock beyond what a caller
 * hands it. That is what makes it the file the tests are written against, and
 * the tests are the point — this is the code that decides whether an email
 * going out in the owner's name may contain a number.
 *
 * WHY THERE IS A GATE AT ALL. A model good enough to write the email is good
 * enough to write a refund amount that never happened, a price that was never
 * charged, a link to a domain nobody owns, and a date somebody will hold him
 * to. Asking it nicely not to is not a control. So the area is split in three:
 *
 *   THE PLANNER (planner.ts) is plain code over rows this box already holds.
 *   It decides WHO is written to, WHY NOW, which venture and which identity.
 *   No model runs.
 *
 *   THE FACT PACKET (facts.ts) is a list of `Fact` rows — key, value, unit,
 *   source, observed_at — gathered from the same rows. It is shown to the
 *   owner beside the draft, so "where did that figure come from" has an answer
 *   on the page rather than in a log.
 *
 *   THE WORDING (wording.ts) is the only part a model touches, and it is
 *   handed the plan and the packet and nothing else. What comes back is read
 *   by `ungrounded()` below and REFUSED — not repaired — if it carries a
 *   number, an amount of money, a date, a link or an address the packet does
 *   not have. A refused body is replaced by a deterministic template built
 *   from the same packet, and the row records that the model's wording was
 *   refused and why.
 *
 * THE ALLOWED SET IS WALKED OUT OF THE PACKET GENERICALLY rather than listed by
 * hand. A hand-listed set goes stale the first time a gatherer grows a field,
 * and the failure is silent and in the wrong direction — a true fact refused is
 * a template email, a false fact allowed is a lie in the owner's name. Anything
 * a gatherer recorded is fair game; anything else is fabrication.
 *
 * THE FIVE KINDS OF TOKEN, AND WHY EACH IS CHECKED SEPARATELY.
 *
 *   ADDRESSES   an email address is checked whole, lower-cased. The digits
 *               inside it are not read as a price, because the address itself
 *               has already been checked as an address.
 *   LINKS       checked by HOST. A path this box never saw is allowed on a host
 *               it did — `example-app-1.example.test/pricing` off a fact carrying
 *               `example-app-1.example.test` — because a wrong path is a broken link and a
 *               wrong host is a phishing complaint. An unparseable link is
 *               refused outright.
 *   MONEY       an amount WITH its currency, normalised to `eur:29`. This is
 *               stricter than the number check on purpose: 29 and €29 and $29
 *               are three different claims, and a packet that carries one of
 *               them must not license the others.
 *   DATES       a date the packet does not carry is a deadline invented in the
 *               owner's name. An ISO date must match a day the packet holds; a
 *               "12 September" must match a month-and-day it holds. The YEAR is
 *               not required to match for the spelled form, because a packet
 *               dated this year and a letter saying "on 12 September" agree.
 *   NUMBERS     everything left after the four above are stripped out. Rounded
 *               to two places, because 29.0 and 29 are the same number and a
 *               packet that says one licenses the other.
 *
 * WHAT THIS COSTS, STATED RATHER THAN HIDDEN. "I have three questions" is
 * refused for the word "three" written as a digit. That is the trade being made
 * deliberately: the alternative is a validator that decides which numbers are
 * innocent, and that judgement is exactly what this file exists not to make.
 * The wording prompt asks for counts spelled as words, and a refusal falls back
 * to a template rather than to nothing.
 */

/* ------------------------------------------------------------------- facts */

/**
 * ONE FACT, AND EVERY FIELD IS LOAD-BEARING.
 *
 * `source` is where it was read — a table, a plugin, a document — written so
 * the owner can go and look. `observed_at` is when the SOURCE observed it, not
 * when this row was built: a contact scanned last Tuesday is a fact about last
 * Tuesday, and a packet that dated everything "now" would let a stale figure
 * read as current. NULL observed_at means the source dated nothing, which is
 * said rather than filled in.
 */
export type Fact = {
  key: string;
  value: string | number;
  unit?: string | null;
  source: string;
  observed_at: string | null;
};

export type Allowed = {
  numbers: Set<number>;
  emails: Set<string>;
  hosts: Set<string>;
  /** `eur:29`, `usd:1200.5` — currency code and amount, joined. */
  money: Set<string>;
  /** `2026-09-12` — whole days the packet carries. */
  days: Set<string>;
  /** `09-12` — the month and day of those, for the spelled-out form. */
  monthDays: Set<string>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** The symbols this box has seen on a price, mapped to the ISO code the money
 *  set is keyed by. A symbol with two meanings — `$` is dollars of eleven
 *  countries — is normalised to the ambiguous key rather than guessed at, so a
 *  packet carrying US$29 licenses "$29" and nothing narrower. */
const SYMBOL: Record<string, string> = { "€": "eur", "£": "gbp", "$": "usd", "¥": "jpy" };

const CODE = /^(usd|eur|gbp|jpy|cad|aud|chf|sek|nok|dkk|pln|inr|nzd|sgd|brl|mxn|zar)$/i;

const EMAIL_RE = /[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]+/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
/** `€29`, `€ 29.50`, `29 EUR`, `EUR 29`. */
const MONEY_SYMBOL_RE = /([€£$¥])\s?(\d[\d,]*(?:\.\d+)?)/g;
const MONEY_CODE_RE = /\b(?:(\d[\d,]*(?:\.\d+)?)\s?([A-Za-z]{3})|([A-Za-z]{3})\s?(\d[\d,]*(?:\.\d+)?))\b/g;
const ISO_DAY_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

const monthNames = MONTHS.join("|");
const monthAbbr = MONTHS.map((m) => m.slice(0, 3)).join("|");
/** "12 September", "12th Sept", "September 12", "Sep 12th". */
const SPELLED_DATE_RE = new RegExp(
  `\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames}|${monthAbbr})|(${monthNames}|${monthAbbr})\\s+(\\d{1,2})(?:st|nd|rd|th)?)\\b`,
  "gi",
);

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO instant's calendar day in UTC, or null when the value is not one.
 *  UTC because every timestamp on this box is stored in it, and reading a
 *  packet in local time would slide a fact across midnight. */
export function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const at = Date.parse(value.trim());
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString().slice(0, 10);
}

function addDay(out: Allowed, day: string) {
  out.days.add(day);
  out.monthDays.add(day.slice(5));
  /* A date also spends its parts as numbers: a packet holding 2026-09-12 has
     to license a letter that says "the twelfth" as a numeral, or every date in
     prose would be refused for the digits inside it. */
  out.numbers.add(Number(day.slice(0, 4)));
  out.numbers.add(Number(day.slice(5, 7)));
  out.numbers.add(Number(day.slice(8, 10)));
}

function scanText(out: Allowed, text: string) {
  for (const m of text.match(EMAIL_RE) ?? []) out.emails.add(m.toLowerCase().replace(/[.,;]$/, ""));
  for (const m of text.match(URL_RE) ?? []) {
    try {
      out.hosts.add(new URL(m).host.toLowerCase());
    } catch {
      /* An unparseable link in the packet allows nothing. */
    }
  }
  /* A bare host — `example-app-1.example.test`, as the ventures table stores it — is a link
     the packet carries without a scheme, and a letter that writes it with one
     is quoting the same fact. */
  for (const m of text.match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi) ?? [])
    out.hosts.add(m.toLowerCase());

  for (const m of text.matchAll(MONEY_SYMBOL_RE)) {
    const code = SYMBOL[m[1]!];
    if (code) out.money.add(`${code}:${round2(Number(m[2]!.replace(/,/g, "")))}`);
  }
  for (const m of text.matchAll(MONEY_CODE_RE)) {
    const amount = m[1] ?? m[4];
    const code = (m[2] ?? m[3] ?? "").toLowerCase();
    if (amount && CODE.test(code)) out.money.add(`${code}:${round2(Number(amount.replace(/,/g, "")))}`);
  }
  for (const m of text.matchAll(ISO_DAY_RE)) addDay(out, `${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.match(NUMBER_RE) ?? []) {
    const n = Number(m.replace(/,/g, ""));
    if (Number.isFinite(n)) out.numbers.add(round2(n));
  }
}

/**
 * Everything the packet licenses.
 *
 * A fact's `unit`, when it is a currency code, turns its numeric value into an
 * ALLOWED AMOUNT as well as an allowed number — that is how `{ key: "price",
 * value: 29, unit: "EUR" }` comes to license "€29" without the gatherer having
 * to write the symbol into the value.
 */
export function allowedFrom(facts: Fact[]): Allowed {
  const out: Allowed = {
    numbers: new Set(),
    emails: new Set(),
    hosts: new Set(),
    money: new Set(),
    days: new Set(),
    monthDays: new Set(),
  };
  for (const f of facts) {
    if (typeof f.value === "number" && Number.isFinite(f.value)) {
      out.numbers.add(round2(f.value));
      const unit = (f.unit ?? "").trim().toLowerCase();
      if (CODE.test(unit)) out.money.add(`${unit}:${round2(f.value)}`);
    } else if (typeof f.value === "string") {
      const day = isoDay(f.value);
      if (day) addDay(out, day);
      scanText(out, f.value);
    }
    /* observed_at is a fact about the packet, not about the recipient, and it
       deliberately licenses nothing: a letter may not quote the day this box
       happened to run its collector as if it were news. */
  }
  return out;
}

/* --------------------------------------------------------------- the gate */

/**
 * Read a candidate body against an allowed set.
 *
 * Returns null when it is clean, or the sentence that says what it invented —
 * naming the token, so the card can print "the model's wording was refused: it
 * wrote €49" and the owner can see for himself that the guard is doing
 * something. A gate whose refusals are invisible is a gate nobody can tell is
 * broken.
 *
 * ORDER MATTERS. Each kind of token is checked and then STRIPPED, so the digits
 * inside an address, a link, an amount or a date are never read a second time
 * as a naked number.
 */
export function ungrounded(body: string, allowed: Allowed): string | null {
  let text = String(body ?? "");

  for (const raw of text.match(EMAIL_RE) ?? []) {
    const addr = raw.toLowerCase().replace(/[.,;]$/, "");
    if (!allowed.emails.has(addr))
      return `it wrote the address ${addr}, which is not in the facts`;
  }
  text = text.replace(EMAIL_RE, " ");

  for (const raw of text.match(URL_RE) ?? []) {
    let host: string;
    try {
      host = new URL(raw).host.toLowerCase();
    } catch {
      return `it wrote a link this code could not parse (${raw.slice(0, 60)})`;
    }
    if (!allowed.hosts.has(host))
      return `it wrote a link to ${host}, and no fact here carries that host`;
  }
  text = text.replace(URL_RE, " ");

  for (const m of text.matchAll(MONEY_SYMBOL_RE)) {
    const code = SYMBOL[m[1]!];
    const amount = round2(Number(m[2]!.replace(/,/g, "")));
    if (!code || !allowed.money.has(`${code}:${amount}`))
      return `it wrote the amount ${m[0]}, and no fact here carries that figure in that currency`;
  }
  for (const m of text.matchAll(MONEY_CODE_RE)) {
    const amount = m[1] ?? m[4];
    const code = (m[2] ?? m[3] ?? "").toLowerCase();
    if (!amount || !CODE.test(code)) continue;
    if (!allowed.money.has(`${code}:${round2(Number(amount.replace(/,/g, "")))}`))
      return `it wrote the amount ${m[0]}, and no fact here carries that figure in that currency`;
  }
  text = text.replace(MONEY_SYMBOL_RE, " ").replace(MONEY_CODE_RE, " ");

  for (const m of text.matchAll(ISO_DAY_RE)) {
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    if (!allowed.days.has(day)) return `it wrote the date ${day}, which is not in the facts`;
  }
  text = text.replace(ISO_DAY_RE, " ");

  for (const m of text.matchAll(SPELLED_DATE_RE)) {
    const dayNumber = Number(m[1] ?? m[4]);
    const monthWord = (m[2] ?? m[3] ?? "").toLowerCase();
    const month = MONTHS.findIndex((name) => name.startsWith(monthWord.slice(0, 3))) + 1;
    if (!month || !Number.isFinite(dayNumber)) continue;
    if (!allowed.monthDays.has(`${pad(month)}-${pad(dayNumber)}`))
      return `it wrote the date ${m[0].trim()}, which is not in the facts`;
  }
  text = text.replace(SPELLED_DATE_RE, " ");

  for (const raw of text.match(NUMBER_RE) ?? []) {
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n) || !allowed.numbers.has(round2(n)))
      return `it wrote the number ${raw}, which is not in the facts (counts belong spelled as words)`;
  }

  return null;
}

/** The whole check in one call, for a caller that has a packet rather than an
 *  allowed set. Exported because the template path validates itself with it
 *  too: a template that could not pass its own gate is a bug worth crashing
 *  into rather than shipping. */
export function checkAgainstFacts(body: string, facts: Fact[]): string | null {
  return ungrounded(body, allowedFrom(facts));
}

/* ---------------------------------------------------------- style rules */

/**
 * Is this a style rule, or is it a fact wearing one?
 *
 * Returns null for a usable rule, or the sentence explaining the refusal. The
 * refusals are stored and shown for the reason the validator names its token.
 *
 * The digit rule costs something real: "keep it under four sentences" is a good
 * rule and "keep it under 4 sentences" is refused over one character. That is
 * the same trade the validator makes, made in the same direction, and the
 * derivation prompt asks for counts spelled as words.
 *
 * A CAPITALISED WORD MID-RULE is almost always somebody's name or a product,
 * and a name learned from one customer's email would be greeting the next one
 * by it. The first word is exempt because a rule starts with a capital.
 */
export const STYLE_RULE_MAX = 120;

export function notAStyleRule(rule: string): string | null {
  const t = String(rule ?? "").trim();
  if (t.length < 8) return "it is too short to be a rule";
  if (t.length > STYLE_RULE_MAX)
    return `it runs to ${t.length} characters — that is a paragraph, not a rule`;
  if (/\d/.test(t)) return "it contains a digit, and a style rule has no business carrying a number";
  if (/@/.test(t)) return "it contains an email address";
  if (/https?:\/\//i.test(t)) return "it contains a link";
  if (/\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}(?:\/|\b)/i.test(t)) return "it contains a domain name";
  const words = t.split(/\s+/);
  for (let n = 1; n < words.length; n++) {
    const w = words[n]!.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
    if (!w || w === "I" || /^I'[a-z]+$/.test(w)) continue;
    if (/^[A-Z][a-z']+$/.test(w))
      return `it names “${w}”, and a style rule must not carry anybody's name`;
  }
  return null;
}

/* -------------------------------------------------------- sequence timing */

export type SequenceStep = { dayOffset: number; purpose: string; hint?: string | null };

/**
 * WHICH STEP, IF ANY, IS DUE — and the reason when none is.
 *
 * Pure, and separated from the engine so it can be tested without a database,
 * because getting this wrong is not a wrong figure on a page: it is a second
 * email to a customer on a day nobody intended.
 *
 * `dayOffset` IS MEASURED FROM ENROLMENT, not from the previous step. A step
 * inserted in the middle of a running sequence therefore does not shove every
 * later step forward, and a step whose offset is edited moves for people
 * already enrolled — which is what an owner editing a sequence means.
 *
 * An offset that is not a finite number is treated as "not due, ever" rather
 * than as zero: a malformed step must never fire immediately.
 */
export function dueStep(
  enrollment: { step: number; enrolledAtMs: number },
  steps: SequenceStep[],
  nowMs: number,
): { index: number; dueAtMs: number } | { skip: string; done?: true } {
  if (!steps.length) return { skip: "this sequence has no steps" };
  if (enrollment.step >= steps.length)
    return { skip: "every step has been drafted", done: true };
  const index = Math.max(0, Math.trunc(enrollment.step));
  const step = steps[index]!;
  if (!Number.isFinite(step.dayOffset))
    return { skip: `step ${index + 1} has no usable dayOffset, so nothing is due` };
  const dueAtMs = enrollment.enrolledAtMs + step.dayOffset * 86_400_000;
  if (nowMs < dueAtMs)
    return {
      skip: `step ${index + 1} is not due until ${new Date(dueAtMs).toISOString().slice(0, 10)}`,
    };
  return { index, dueAtMs };
}

/* ------------------------------------------------------- the stop conditions */

export const STOP_CONDITIONS = ["replied", "purchased", "dismissed", "unsubscribed"] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

/** What this box observed about one enrolled person on one pass. Every field
 *  is a tri-state on purpose: `null` is "could not be asked", which must not
 *  read as "no". */
export type Observed = {
  repliedAt: string | null;
  /** Null where no product user document is connected, so nothing here knows
   *  whether anybody paid. Never folded into false. */
  paying: boolean | null;
  dismissedDraft: boolean;
  optedOut: boolean;
  /** Set when a check could not be made at all — the reason, in words. */
  unreachable: string | null;
};

/**
 * The verdict for one enrolment, given what was observed and which conditions
 * this sequence subscribes to.
 *
 * `hold` IS NOT `stop` AND IT IS NOT `go`. A reply check that could not be made
 * leaves the enrolment where it is with the reason on it: writing a third note
 * to somebody who may have answered the second is the exact failure this whole
 * mechanism exists to avoid, and "the check failed so carry on" is how it
 * happens. So an unreachable check holds, every time, and the page says which
 * one and why.
 *
 * AN OPT-OUT IS NOT ONE OF THE SUBSCRIBABLE CONDITIONS. It is checked first and
 * unconditionally, whatever `stop_on` says, because an opt-out a sequence could
 * opt out of is not an opt-out. The other three are the owner's to choose.
 */
export function verdict(
  observed: Observed,
  stopOn: readonly string[],
): { stop: StopCondition; why: string } | { hold: string } | { go: true } {
  const wants = (c: StopCondition) => stopOn.includes(c);
  if (observed.optedOut)
    return { stop: "unsubscribed", why: "they asked not to be written to again" };
  if (observed.paying === true && wants("purchased"))
    return { stop: "purchased", why: "the product's own users document now reports them as paying" };
  if (observed.repliedAt && wants("replied"))
    return { stop: "replied", why: `they replied on ${observed.repliedAt.slice(0, 10)}` };
  if (observed.dismissedDraft && wants("dismissed"))
    return { stop: "dismissed", why: "you dismissed a draft written for this person" };
  if (observed.unreachable) return { hold: observed.unreachable };
  return { go: true };
}
