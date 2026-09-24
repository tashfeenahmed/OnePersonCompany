/**
 * AN ALERT AS A PERSON WOULD SAY IT — the words the phone and `/alerts` share.
 *
 * The engine's sentence is written for the Alerts page, beside the rule that
 * produced it: "totals.fullestDisk.percent is 86.6 — the rule trips when it is
 * > 85, and it is." Exact, and useless on a lock screen: which box? which
 * sites? A person says "💾 Disk is 87% full on Demo box".
 *
 * THE SPECIFICS COME FROM THE SNAPSHOT, NOT FROM A GUESS. The engine keeps the
 * document each rule read (`alert_snapshots`), taken in the same cycle as the
 * trip, so the box that was fullest, the sites that were down and the venture
 * whose MRR moved are read from what the rule actually saw. A rule this file
 * has no reading for, or a snapshot that has been pruned, falls back to the
 * rule's own name and the figure against its line — never to a JSON path.
 *
 * PURE. The snapshot is passed in; `docAt` is the one reader, and it cannot
 * throw.
 */
import { snapshotAtOrBefore } from "./store.ts";
import { cash, clip, duration, num, plural, relativeDay, someOf } from "../../shared/phone.ts";
import type { AlertContext } from "../../../../shared/alertContext.ts";

export type TripFacts = {
  rule: string;
  skill: string;
  path: string;
  op: string;
  threshold: number | null;
  window_minutes: number | null;
  observed: number | null;
  previous: number | null;
  message: string;
  context: string | null;
  ts: string;
  cleared_at: string | null;
  recovery_message: string | null;
  /** The venture's display name, already resolved. */
  venture: string | null;
};

export type Words = { emoji: string; head: string; lines: string[] };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The document a rule read at or just before a moment, or null. */
export function docAt(skill: string, at: string | null): unknown {
  if (!at) return null;
  try {
    return snapshotAtOrBefore(skill, at)?.doc ?? null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- readers */

/** One site's failure, in words. */
function siteCause(current: Obj): string | null {
  const status = n(current.status);
  const err = s(current.error) ?? "";
  if (status && status >= 400) return `it answered with error ${status}`;
  if (/EAI_AGAIN|ENOTFOUND|getaddrinfo/i.test(err)) return "its address lookup (DNS) failed";
  if (/timed? ?out|ETIMEDOUT|abort/i.test(err)) return "it timed out";
  if (/ECONNREFUSED/i.test(err)) return "the connection was refused";
  if (/certificate|CERT_|SSL|TLS/i.test(err)) return "its HTTPS certificate failed";
  return err ? clip(err, 120) : null;
}

const ANOMALY = /^(.+?) · (\w+): ([\d.,]+) (\w+) on (\d{4}-\d{2}-\d{2}); expected ([\d.]+)–([\d.]+)/;
const BASELINE = /^(.+?) · (\w+) returned to its baseline range: ([\d.,]+) (\w+) on (\d{4}-\d{2}-\d{2})/;
const noun = (unit: string) => (unit === "views" ? "page views" : unit);

function pctMove(t: TripFacts): { pct: number; up: boolean } | null {
  if (t.observed === null || t.previous === null || t.previous === 0) return null;
  const pct = ((t.observed - t.previous) / Math.abs(t.previous)) * 100;
  return { pct: Math.abs(Math.round(pct)), up: pct > 0 };
}

const since = (minutes: number | null) =>
  minutes === 10_080 ? "on last week" : minutes === 1_440 ? "on yesterday" : minutes ? `over ${duration(minutes * 60_000)}` : "";

/** The figure against the rule's line, for a rule with no reading of its own. */
function generic(t: TripFacts): Words {
  const o = t.observed;
  const th = t.threshold;
  const lines: string[] = [];
  if (o !== null) {
    if ((t.op === ">" || t.op === ">=") && th !== null) lines.push(`It's at ${num(o)}, above your limit of ${num(th)}.`);
    else if ((t.op === "<" || t.op === "<=") && th !== null) lines.push(`It's at ${num(o)}, below your limit of ${num(th)}.`);
    else if (t.op === "changed" && t.previous !== null) lines.push(`It went from ${num(t.previous)} to ${num(o)}.`);
    else if (t.op === "dropped_by_pct" || t.op === "rose_by_pct") {
      const m = pctMove(t);
      if (m) lines.push(`${m.up ? "Up" : "Down"} ${m.pct}% ${since(t.window_minutes)}: ${num(t.previous!)} → ${num(o)}.`.replace(/ {2}/g, " "));
    } else lines.push(`It's at ${num(o)}.`);
  }
  const head = t.venture && !t.rule.toLowerCase().includes(t.venture.toLowerCase()) ? `${t.rule} (${t.venture})` : t.rule;
  return { emoji: "⚠️", head, lines };
}

/**
 * A trip, as a headline and at most a line or two of detail.
 *
 * `now` is the moment of sending, for "yesterday"; `doc` is the snapshot the
 * rule read when it tripped (see `docAt`).
 */
export function tripWords(t: TripFacts, doc: unknown, zone: string, now = new Date()): Words {
  const d = obj(doc);

  if (t.skill === "fleet" && t.path.endsWith("fullestDisk.percent")) {
    const fd = obj(obj(d.totals).fullestDisk);
    const pct = n(fd.percent) ?? t.observed;
    const box = s(fd.box);
    const mount = s(fd.mount);
    if (pct !== null)
      return {
        emoji: "💾",
        head: `Disk is ${Math.round(pct)}% full${box ? ` on ${box}` : " on one of your boxes"}${mount && mount !== "/" ? ` (${mount})` : ""}`,
        lines: [],
      };
  }

  if (t.skill === "uptime" && t.path === "summary.down") {
    const down = arr(d.hosts).filter((h) => obj(h.current).ok === false);
    const count = t.observed ?? down.length;
    const names = down.map((h) => s(h.host)).filter((x): x is string => !!x);
    const head =
      count === 1 && names.length === 1
        ? `${names[0]} isn't responding`
        : `${plural(count, "site")} ${count === 1 ? "isn't" : "aren't"} responding${names.length ? `: ${someOf(names)}` : ""}`;
    const causes = down.map((h) => siteCause(obj(h.current)));
    const lines: string[] = [];
    const dns = causes.length >= 3 && causes.every((c) => c?.startsWith("its address lookup"));
    if (dns) lines.push("Every check failed at the address lookup, so it's probably this box's internet rather than the sites.");
    else if (causes.length === 1 && causes[0]) lines.push(`${causes[0][0]!.toUpperCase()}${causes[0].slice(1)}.`);
    return { emoji: "🔴", head, lines };
  }

  const mrr = t.skill === "stripe" ? /^byVenture\.([^.]+)\.mrrAbsDelta$/.exec(t.path) : null;
  if (mrr) {
    const v = obj(obj(d.byVenture)[mrr[1]!]);
    const name = s(v.name) ?? t.venture ?? "A venture";
    const cur = s(v.currency) ?? "usd";
    const delta = n(v.mrrDelta);
    const now_ = n(v.mrr);
    const was = n(v.previousMrr);
    if (delta !== null && now_ !== null && was !== null)
      return {
        emoji: delta < 0 ? "📉" : "📈",
        head: `${name} MRR is ${delta < 0 ? "down" : "up"} ${cash(Math.abs(delta), cur)}/mo`,
        lines: [`Now ${cash(now_, cur)}/mo, was ${cash(was, cur)}/mo.`],
      };
    if (t.observed !== null)
      return { emoji: "📊", head: `${name} MRR moved by ${cash(t.observed, cur)}/mo`, lines: [] };
  }

  if (t.skill === "stripe" && /^charges\[0\]\.failed$/.test(t.path) && t.observed !== null) {
    const c = arr(d.charges)[0] ?? {};
    const blocked = n(c.blocked);
    const declined = n(c.declined);
    const lines =
      blocked !== null && declined !== null && blocked + declined === t.observed && t.observed > 1
        ? [`${num(blocked)} blocked by Stripe's fraud checks, ${num(declined)} declined by the bank.`]
        : [];
    return {
      emoji: "❌",
      head: t.observed === 1 ? "A payment failed today" : `${num(t.observed)} payments failed today`,
      lines,
    };
  }

  if (t.skill === "domains" && t.path === "summary.expiring30") {
    const soon = arr(d.domains)
      .filter((x) => n(x.expiresInDays) !== null && n(x.expiresInDays)! <= 30)
      .sort((a, b) => n(a.expiresInDays)! - n(b.expiresInDays)!);
    if (soon.length === 1) {
      const x = soon[0]!;
      const days = n(x.expiresInDays)!;
      return {
        emoji: "📅",
        head: `${s(x.name)} expires ${days <= 0 ? "today" : `in ${plural(days, "day")}`}`,
        lines: x.autoRenew === false ? ["Auto-renew is off."] : [],
      };
    }
    const count = t.observed ?? soon.length;
    return {
      emoji: "📅",
      head: `${plural(count, "domain")} ${count === 1 ? "expires" : "expire"} within 30 days${soon.length ? `: ${someOf(soon.map((x) => s(x.name) ?? "?"))}` : ""}`,
      lines: [],
    };
  }

  const a = ANOMALY.exec(t.message);
  if (a) {
    const [, label, , value, unit, day, lo, hi] = a;
    const v = Number(value!.replace(/,/g, ""));
    const up = v > Number(hi);
    const range = `${num(Number(lo), 0)}–${num(Number(hi), 0)}`;
    return {
      emoji: up ? "📈" : "📉",
      head: `${label} had ${num(v, 0)} ${noun(unit!)} ${relativeDay(day!, now, zone)}`,
      lines: [`${up ? "More" : "Fewer"} than usual: normally ${range} a day.`],
    };
  }

  if (t.skill === "stability" && t.context) {
    try {
      const ctx = JSON.parse(t.context) as AlertContext;
      const app = ctx.apps?.[0];
      const m = pctMove(t);
      if (app && !app.reason)
        return {
          emoji: "💥",
          head: `Crashes are up for ${app.name}${app.store ? ` (${app.store === "play" ? "Android" : app.store === "appstore" ? "iOS" : app.store})` : ""}`,
          lines: m ? [`Up ${m.pct}% ${since(t.window_minutes)}.`.replace(/ {2}/g, " ")] : [],
        };
      if (ctx.title) return { emoji: "⚠️", head: ctx.title, lines: ctx.summary ? [ctx.summary] : [] };
    } catch {
      /* A context that does not parse is no context. */
    }
  }

  return generic(t);
}

/**
 * A recovery, as one line. `doc` is the snapshot at the moment it cleared and
 * `tripDoc` the one it tripped on — the box that filled up is named from the
 * trip, since by the time it clears another box may be the fullest.
 */
export function clearWords(t: TripFacts, doc: unknown, zone: string, now = new Date(), tripDoc: unknown = null): Words {
  const d = obj(doc);
  const lasted = t.cleared_at ? duration(Date.parse(t.cleared_at) - Date.parse(t.ts)) : null;
  const lines = lasted ? [`It lasted ${lasted}.`] : [];

  if (t.skill === "fleet" && t.path.endsWith("fullestDisk.percent")) {
    const box = s(obj(obj(obj(tripDoc).totals).fullestDisk).box);
    const line = t.threshold !== null ? `back under ${num(t.threshold)}%` : "fine again";
    return { emoji: "✅", head: box ? `Disk on ${box} is ${line}` : `Disk space is ${line}`, lines };
  }
  if (t.skill === "uptime" && t.path === "summary.down")
    return { emoji: "✅", head: "All sites are answering again", lines };
  const mrr = t.skill === "stripe" ? /^byVenture\.([^.]+)\.mrrAbsDelta$/.exec(t.path) : null;
  if (mrr) return { emoji: "✅", head: `${s(obj(obj(d.byVenture)[mrr[1]!]).name) ?? t.venture ?? "MRR"} MRR is steady again`, lines: [] };
  if (t.skill === "stripe" && /^charges\[0\]\.failed$/.test(t.path))
    return { emoji: "✅", head: "No failed payments so far today", lines: [] };
  if (t.skill === "domains" && t.path === "summary.expiring30")
    return { emoji: "✅", head: "No domains expire within 30 days now", lines: [] };
  const b = BASELINE.exec(t.recovery_message ?? "");
  if (b) {
    const [, label, metric, value, unit, day] = b;
    return {
      emoji: "✅",
      head: `${label} ${metric === "pageviews" ? "page views" : metric} are back to normal (${num(Number(value!.replace(/,/g, "")), 0)} ${noun(unit!)} ${relativeDay(day!, now, zone)})`,
      lines: [],
    };
  }
  return { emoji: "✅", head: `Back to normal: ${generic(t).head}`, lines };
}
