/**
 * THE GROWTH REPORTS' PAGE — the one stylesheet, the header block, the
 * callouts, the tables and the model's analysis, composed HERE.
 *
 * WHY THE SERVER COMPOSES THESE PAGES rather than asking a model for a whole
 * HTML document the way research, competitors and demand do. Those three runs
 * are investigations: what the page holds is what the model found, so the
 * model writing the page is the model reporting its own work. A SERP teardown
 * and a store-listing audit are MEASUREMENTS: word counts read out of HTML by
 * this server, checks computed from a listing document, a score with its
 * arithmetic printed. The old markdown reports composed the tables here for
 * exactly that reason — "a table a model wrote from its own reading of a
 * table would be the instrument marking its own paper" — and moving to a
 * designed page is not a reason to give that up. So the page is built the way
 * the AI-visibility report is (runs/geo.ts): every measured figure is laid
 * into markup by this file, and the model contributes what only a reader can
 * — the finding in one sentence, what the pages above us have that ours does
 * not, and what to do — as JSON that this file renders. The look follows
 * runs/htmlReportSpec.ts's design rules by hand, so the three model-written
 * reports and these two read as one family.
 *
 * THE ANALYSIS IS OPTIONAL, THE MEASUREMENT IS NOT. A model that answers
 * unusably costs the page its prose sections and its cards; the tables are
 * already in hand and the page says, in the place the prose would have been,
 * that the model did not answer. That is the same rule the AI-visibility
 * judge keeps and for the same reason: the run's value is the measurement,
 * and a run that threw its measurement away because a model wrote prose
 * instead of JSON would be a run that failed at the cheap part.
 */
import type { ChatTurn } from "../../chat/backend.ts";
import { fencedJson } from "../runs/kinds.ts";
import type { RunTools } from "./runs.ts";

/* -------------------------------------------------------------- escaping */

/** Every piece of text on the page goes through this on the way in. Nothing
 *  below builds markup out of a string that has not. */
export function h(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A link showing its hostname only — the house rule for every source link,
 *  so a reader scanning a table sees which SITES are in it. */
export function hostLink(url: string, label?: string | null): string {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* not a URL; shown as typed */
  }
  return `<a href="${h(url)}" rel="noopener" title="${h(label ?? url)}">${h(host)}</a>`;
}

/* -------------------------------------------------------------- the model */

export type Analysis = {
  /** One sentence naming the biggest finding — the <h1>. */
  headline: string | null;
  /** One paragraph under the header: the verdict before the qualifications. */
  verdict: string | null;
  /** Prose sections, each a heading naming a finding and its paragraphs. */
  sections: { title: string; paragraphs: string[] }[];
  /** Ranked; each a change somebody could start this week. */
  recommendations: { title: string; why: string; cost: string; change: string }[];
  cards: { title: string; body: string; urgency: number }[];
  /** Why there is no analysis, when there is none. */
  failed: string | null;
};

const EMPTY: Analysis = { headline: null, verdict: null, sections: [], recommendations: [], cards: [], failed: null };

/** The reply shape, spelled out once for both kinds' briefs. */
export const ANALYSIS_REPLY =
  "Reply with ONLY a fenced block, info string exactly `json report`, holding:\n" +
  '{"headline": "one sentence naming the single biggest finding — never \\"Report on X\\"",\n' +
  ' "verdict": "one paragraph: the finding first, the qualifications after",\n' +
  ' "sections": [{"title": "a heading that names a FINDING, not a category", "paragraphs": ["…", "…"]}],\n' +
  ' "recommendations": [{"title": "…", "why": "the figure or row above it comes from", "cost": "what it takes", "change": "which measured figure would move"}],\n' +
  ' "cards": [{"title": "…", "body": "…", "urgency": 0}]}\n' +
  "Two to five sections. Three to six recommendations, ranked, each naming the page or the listing it is about. Three to eight cards, each one action somebody could tick off, urgency 0 (whenever) to 3 (this week). No prose outside the fence.";

const sentence = (v: unknown, max = 800): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /^(null|n\/a|none)$/i.test(s)) return null;
  return s.slice(0, max);
};

/** The model's block, read strictly: a field that is not the shape asked for
 *  is dropped rather than repaired, and a reply with nothing usable in it is
 *  a failure the page states. */
export function readAnalysis(text: string): Analysis {
  const raw = fencedJson(text, "report");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY, failed: "the model did not answer with the report block it was asked for" };
  const o = raw as Record<string, unknown>;
  const sections: Analysis["sections"] = [];
  if (Array.isArray(o.sections))
    for (const s of o.sections) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      const title = sentence(so.title, 160);
      const paragraphs = Array.isArray(so.paragraphs) ? so.paragraphs.map((p) => sentence(p, 2000)).filter((p): p is string => !!p) : [];
      if (title && paragraphs.length) sections.push({ title, paragraphs: paragraphs.slice(0, 8) });
      if (sections.length === 6) break;
    }
  const recommendations: Analysis["recommendations"] = [];
  if (Array.isArray(o.recommendations))
    for (const r of o.recommendations) {
      if (!r || typeof r !== "object") continue;
      const ro = r as Record<string, unknown>;
      const title = sentence(ro.title, 160);
      if (!title) continue;
      recommendations.push({ title, why: sentence(ro.why) ?? "", cost: sentence(ro.cost, 300) ?? "", change: sentence(ro.change, 300) ?? "" });
      if (recommendations.length === 8) break;
    }
  const cards: Analysis["cards"] = [];
  if (Array.isArray(o.cards))
    for (const c of o.cards) {
      if (!c || typeof c !== "object") continue;
      const co = c as Record<string, unknown>;
      const title = sentence(co.title, 160);
      const body = sentence(co.body, 600);
      if (!title || !body) continue;
      const urgency = typeof co.urgency === "number" ? Math.max(0, Math.min(3, Math.round(co.urgency))) : 1;
      cards.push({ title, body, urgency });
      if (cards.length === 8) break;
    }
  const headline = sentence(o.headline, 200);
  const verdict = sentence(o.verdict, 1500);
  if (!headline && !verdict && !sections.length && !recommendations.length)
    return { ...EMPTY, failed: "the model's report block carried nothing usable" };
  return { headline, verdict, sections, recommendations, cards, failed: null };
}

/**
 * One turn for the analysis, on the raw provider when there is one. The
 * `document` flag is the provider's "long structured answer" switch —
 * thinking off where the endpoint takes the knob, the output allowance
 * lifted — without which a local reasoning model spends its budget in the
 * scratchpad and the fence never arrives (every AI-visibility judge on the
 * Dell, 2026-09-18 to 21). A turn that throws is an analysis that failed,
 * not a run that failed: the measurement is already in hand.
 */
export async function askAnalysis(tools: RunTools, turns: ChatTurn[]): Promise<Analysis> {
  try {
    const res = await tools.turn(turns, { toOutput: false, forceProvider: tools.writerUsesProvider, document: true });
    return readAnalysis(res.text);
  } catch (err) {
    return { ...EMPTY, failed: `the model did not answer — ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ----------------------------------------------------------------- the page */

export const STYLE = `
:root { --ink: #14161a; --muted: #6b7280; --rule: #e5e7eb; --accent: #4f63d2; --accent-soft: #eef0fb; --warn: #b45309; }
* { box-sizing: border-box; }
body { margin: 0; padding: 40px 20px 72px; background: #fff; color: var(--ink);
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.page { max-width: 46rem; margin: 0 auto; }
h1 { margin: 0 0 6px; font-size: 26px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.25; }
.dateline { margin: 0; color: var(--muted); font-size: 12.5px; }
.rule { height: 3px; background: var(--accent); margin: 14px 0 28px; }
h2 { margin: 36px 0 12px; font-size: 15px; font-weight: 600; padding-left: 10px; border-left: 3px solid var(--accent); }
h3 { margin: 22px 0 8px; font-size: 14px; font-weight: 600; }
p { margin: 0 0 12px; }
.verdict { font-size: 15px; line-height: 1.55; }
.callouts { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 8px; }
.callout { flex: 1 1 160px; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; }
.callout .big { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; color: var(--accent); }
.callout .of { font-size: 16px; font-weight: 500; color: var(--muted); }
.callout .cap { margin-top: 4px; font-size: 12px; color: var(--muted); }
.callout .plain { font-size: 14px; font-weight: 600; line-height: 1.4; }
table { width: 100%; border-collapse: collapse; margin: 0 0 10px; font-size: 13px; }
th { text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); border-bottom: 1px solid var(--rule); padding: 0 10px 6px 0; }
td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
th.num { text-align: right; }
tr.ours td { background: var(--accent-soft); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.yes { color: var(--accent); font-weight: 600; }
.no { color: var(--ink); }
.nul { color: var(--muted); font-style: italic; }
.warn { color: var(--warn); font-weight: 600; }
.note { color: var(--muted); font-size: 12.5px; line-height: 1.55; margin: 0 0 8px; }
.badge { display: inline-block; border-radius: 6px; padding: 1px 6px; font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; border: 1px solid var(--rule); color: var(--muted); }
.badge-accent { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.badge-warn { border-color: var(--warn); color: var(--warn); }
.card { border: 1px solid var(--rule); border-radius: 12px; padding: 16px 18px; margin: 0 0 14px; }
.cardhead { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }
.cardhead .title { font-size: 15px; font-weight: 600; margin-right: auto; }
.pill { display: inline-block; border: 1px solid var(--rule); border-radius: 8px; padding: 1px 7px; font-size: 11px; color: var(--muted); }
.pill-yes { border-color: var(--accent); color: var(--accent); }
.pill-warn { border-color: var(--warn); color: var(--warn); }
.chip { display: inline-block; background: #f4f5f7; border-radius: 6px; padding: 1px 7px; font-size: 11.5px; color: var(--ink); margin-right: 4px; }
.quote { margin: 18px 0; padding: 12px 16px; border-left: 3px solid var(--accent); background: var(--accent-soft); font-size: 15px; line-height: 1.5; }
ol.recs { margin: 0; padding-left: 20px; }
ol.recs li { margin-bottom: 14px; }
ol.recs .rt { font-weight: 600; }
ol.recs .meta { color: var(--muted); font-size: 12.5px; }
ul.plain { margin: 0 0 12px; padding-left: 20px; }
ul.plain li { margin-bottom: 4px; }
.arith { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); line-height: 1.6; }
footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12px; }
@media print { .card { break-inside: avoid; } }
`;

export function callout(big: string, of: string, captionHtml: string): string {
  return `<div class="callout"><div class="big">${h(big)}${of ? `<span class="of">${h(of)}</span>` : ""}</div><div class="cap">${captionHtml}</div></div>`;
}

export function plainCallout(mainHtml: string, captionHtml: string): string {
  return `<div class="callout"><div class="plain">${mainHtml}</div><div class="cap">${captionHtml}</div></div>`;
}

export function yesNo(v: boolean | null): string {
  if (v === null) return `<span class="nul">not read</span>`;
  return v ? `<span class="yes">yes</span>` : `<span class="no">no</span>`;
}

/** The model's paragraphs: escaped, then **bold** honoured and nothing else
 *  interpreted — the same reading the AI-visibility report gives an answer. */
export function prose(s: string): string {
  return h(s).replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
}

/** The analysis, laid out: the verdict under the header is the caller's to
 *  place; this is the prose sections and the recommendations, or the sentence
 *  that says why there are none. */
export function analysisHtml(a: Analysis, what: string): string {
  const out: string[] = [];
  if (a.failed) {
    out.push(`<h2>What the model made of it</h2>`);
    out.push(`<p class="note">The model was asked to read the ${h(what)} above and say what it means and what to do, and ${h(a.failed)}. The measurement above is unaffected — it was computed by this server and is complete. No board cards were proposed.</p>`);
    return out.join("\n");
  }
  for (const s of a.sections) {
    out.push(`<h2>${h(s.title)}</h2>`);
    for (const p of s.paragraphs) out.push(`<p>${prose(p)}</p>`);
  }
  out.push(`<h2>Recommendations</h2>`);
  if (!a.recommendations.length) out.push(`<p class="note">The model proposed no recommendations for this run.</p>`);
  else {
    out.push(`<ol class="recs">`);
    for (const r of a.recommendations) {
      const bits = [`<div class="rt">${h(r.title)}</div>`];
      if (r.why) bits.push(`<p>${prose(r.why)}</p>`);
      const meta = [r.cost ? `Cost: ${h(r.cost)}` : "", r.change ? `Changes: ${h(r.change)}` : ""].filter(Boolean);
      if (meta.length) bits.push(`<p class="meta">${meta.join(" · ")}</p>`);
      out.push(`<li>${bits.join("")}</li>`);
    }
    out.push(`</ol>`);
  }
  return out.join("\n");
}

/** The whole page. `body` is already markup built by the caller from escaped
 *  pieces; `finding` and `dateline` are text and are escaped here. */
export function page(opts: { finding: string; dateline: string; verdict: string | null; callouts: string[]; body: string; footer: string }): string {
  const out: string[] = [];
  out.push(`<!doctype html>`);
  out.push(`<html lang="en">`);
  out.push(`<head>`);
  out.push(`<meta charset="utf-8">`);
  out.push(`<title>${h(opts.finding)}</title>`);
  out.push(`<style>${STYLE}</style>`);
  out.push(`</head>`);
  out.push(`<body><div class="page">`);
  out.push(`<header><h1>${h(opts.finding)}</h1><p class="dateline">${h(opts.dateline)}</p></header>`);
  out.push(`<div class="rule"></div>`);
  if (opts.verdict) out.push(`<p class="verdict">${prose(opts.verdict)}</p>`);
  if (opts.callouts.length) out.push(`<div class="callouts">${opts.callouts.join("")}</div>`);
  out.push(opts.body);
  out.push(`<footer>${h(opts.footer)}</footer>`);
  out.push(`</div></body></html>`);
  return out.join("\n");
}

/** The cards, appended AFTER the document — the same tail the competitor
 *  sweep and the AI-visibility report carry, which `GET /runs/:id` parses
 *  out and the client strips before framing the page. */
export function cardsFence(cards: Analysis["cards"]): string {
  if (!cards.length) return "";
  return `\n\n\`\`\`json cards\n${JSON.stringify(cards, null, 2)}\n\`\`\`\n`;
}
