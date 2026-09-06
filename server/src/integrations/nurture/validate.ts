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
 * WHAT THE NUMBER CHECK IS AND IS NOT, because the difference is easy to
 * overstate and every surface that quotes this file was quoting it too warmly.
 * The number set is POOLED AND UNIT-BLIND: every figure anywhere in the packet
 * — inside a verbatim commitment sentence, inside a venture description, the
 * day, month and year of every date — joins ONE set, and membership of that set
 * is the whole test. So a packet carrying "31 days quiet" licenses "31% growth"
 * and "we have 31 customers". The honest sentence is "every number in the
 * message appears somewhere in the facts", not "every number was checked
 * against the fact it belongs to". MONEY is the one class checked with its
 * unit, which is why it is a separate class at all. This is a floor on
 * fabrication rather than a proof of correctness, and the routes, the skill
 * rules and the card all say it that way.
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

/**
 * THE CURRENCY CODES, AND WHY THE MONEY REGEX IS BUILT OUT OF THEM RATHER THAN
 * OUT OF `[A-Za-z]{3}`.
 *
 * It used to match any three letters beside a number and then discard the
 * non-currency matches in the loop below. That was wrong twice over, and the
 * second way was the dangerous one:
 *
 *   1. THE STRIP RAN ANYWAY. Every `<number> <three letters>` was removed from
 *      the text before the date and number checks, so "We saved you 500 per
 *      month", "You have 300 new users" and "The trial ends 12 Sep" all passed
 *      an EMPTY fact packet. In ordinary English prose most numbers and every
 *      abbreviated date sit next to a three-letter word, which made the gate
 *      this file exists to be largely inoperative.
 *   2. A NON-CURRENCY MATCH ATE THE REAL ONE. `String.matchAll` continues from
 *      the end of each match, so in "we refunded you 4000 usd" the engine
 *      consumed "you 4000", skipped it as not-a-currency, and never saw
 *      "4000 usd" at all — the currency check silently did not happen.
 *
 * Narrowing the pattern to the actual codes fixes both by construction: there
 * is no spurious match to discard and none to be eaten by. The strip below is
 * ALSO written as a conditional callback, so that a future widening of this
 * pattern cannot quietly reintroduce (1).
 */
const CODES = [
  "usd", "eur", "gbp", "jpy", "cad", "aud", "chf", "sek", "nok", "dkk",
  "pln", "inr", "nzd", "sgd", "brl", "mxn", "zar",
];
const CODE = new RegExp(`^(?:${CODES.join("|")})$`, "i");

const EMAIL_RE = /[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]+/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
/**
 * A HOST WRITTEN WITHOUT A SCHEME, which is how a link usually appears in
 * prose and which every mail client autolinks.
 *
 * Without this, `URL_RE` above was the only host check and
 * "read more at competitor-phish.com/deal" passed an empty packet — while
 * `allowedFrom` was already collecting bare hosts on the FACT side, so the
 * gate was open in exactly one direction.
 *
 * THE FALSE POSITIVE IS ACCEPTED DELIBERATELY, the way the digit rule is. A
 * missing space after a full stop — "that is helpful.We also…" — reads as the
 * host `helpful.we`, and the draft falls back to the deterministic template
 * with the refusal printed on the card. That is a comprehensible outcome on
 * the safe side; the alternative is a TLD allow-list that goes stale and lets
 * a real domain through the day somebody registers a new suffix.
 */
const BARE_HOST_RE =
  /(?<![\w@./-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(?![\w@-])/gi;
/** `€29`, `€ 29.50`, `29 EUR`, `EUR 29`. */
const MONEY_SYMBOL_RE = /([€£$¥])\s?(\d[\d,]*(?:\.\d+)?)/g;
const MONEY_CODE_RE = new RegExp(
  `\\b(?:(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${CODES.join("|")})|(${CODES.join("|")})\\s?(\\d[\\d,]*(?:\\.\\d+)?))\\b`,
  "gi",
);
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

  /* THE SAME CHECK FOR A HOST WITH NO SCHEME, after the addresses and the
     schemed links have gone — `mary@example.com` must not be read as a link to
     example.com, because it has already been checked as an address. Stripped
     as well as checked, so the digits in a host like `web3.io` are not read a
     second time as a naked number. */
  for (const m of text.matchAll(BARE_HOST_RE)) {
    const host = m[1]!.toLowerCase();
    if (!allowed.hosts.has(host))
      return `it wrote a link to ${host}, and no fact here carries that host`;
  }
  text = text.replace(BARE_HOST_RE, " ");

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
  /* THE STRIP IS CONDITIONAL, and it is written this way even though
     `MONEY_CODE_RE` can no longer match a non-currency triple. It is the second
     wall around the bug described at CODES above: if somebody ever widens that
     pattern back to `[A-Za-z]{3}`, a match that is not a currency stays in the
     text and is caught by the date and number checks below instead of
     vanishing before them. */
  text = text
    .replace(MONEY_SYMBOL_RE, " ")
    .replace(MONEY_CODE_RE, (whole, _a1, c1, c2) =>
      CODE.test(String(c1 ?? c2 ?? "")) ? " " : String(whole),
    );

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

/* --------------------------------------------------------------- booleans */

/**
 * A FLAG AS IT ACTUALLY ARRIVES, WHICH IS OFTEN A STRING.
 *
 * `routes/skills.ts` forwards an action's arguments verbatim, and the CLI and
 * the pack both hand it what the caller typed — so a parameter published as a
 * string arrives as `"true"`, never as `true`. A `=== true` check on such a
 * parameter is not a strict check, it is a check that never fires: `dryRun`
 * read that way meant an action documented as "prepare everything and file
 * nothing" filed a real outbox row, which then held that address down for the
 * whole per-address floor and refused the real draft afterwards.
 *
 * ANYTHING UNRECOGNISED IS FALSE, and that is the safe direction for both
 * callers of this: an unreadable `dryRun` writes the draft the caller asked
 * for, and an unreadable `force` declines to run a second pass in a day.
 */
export function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return ["true", "yes", "on", "1"].includes(value.trim().toLowerCase());
}

/* ------------------------------------------------- the purchase question */

/**
 * Can the purchase question even be ASKED, for a sequence that stops on it?
 *
 * Returns the hold sentence when it cannot, or null. This exists because
 * `paying: null` has two meanings and only one of them is safe to carry on
 * from: "this address is not in a connected product's users document" is a
 * fact about the person, while "no product on this install publishes a users
 * document at all" is the question being unanswerable. Folding them together
 * meant a sequence subscribed to `purchased` kept drafting when nothing on the
 * box could tell whether the recipient had already bought — the exact failure
 * `verdict`'s header says must not happen, and which the reply check next door
 * already gets right.
 *
 * `reason` is `productUser().reason` verbatim; the marker is the phrase that
 * function uses for the unanswerable case, checked rather than re-derived so
 * the two cannot drift into agreeing about nothing.
 */
export const NO_USERS_DOCUMENT = "no product on this install publishes a users document";

export function purchaseUnreachable(stopOn: readonly string[], reason: string | null): string | null {
  if (!stopOn.includes("purchased")) return null;
  if (!reason || !reason.startsWith(NO_USERS_DOCUMENT)) return null;
  return `cannot check whether they have bought — ${reason}`;
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
    const w = words[n]!.replace(/^[^A-Za-z'-]+|[^A-Za-z'-]+$/g, "");
    if (!w || w === "I" || /^I'[a-z]+$/.test(w)) continue;
    /* ANY capitalised word mid-rule, not just `Xxxx`. The narrower pattern let
       `Example App 4`, `Jane-Smith` and `ACME` through — a product name and two
       shapes of person's name, which are exactly what this is for. An acronym
       a rule might legitimately want ("use a clear CTA") is refused with them;
       that is the same trade the digit rule makes, made in the same direction. */
    if (/^[A-Z][A-Za-z'-]*$/.test(w))
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
