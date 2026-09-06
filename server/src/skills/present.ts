/**
 * RICH ANSWERS — how an agent puts a chart, a row of cards or a table into the
 * chat, and how every other surface reads the same answer as plain text.
 *
 * The chat page renders five fenced blocks as live widgets: ```cards```,
 * ```chart```, ```bars```, ```meters``` and ```table```, each holding one JSON
 * object. They are ordinary markdown to everything that is not the chat page,
 * which is the whole reason the syntax is a fence and not a tag: a transcript
 * reloaded from the database, a paste into an email and a Telegram reply all
 * still carry the figures, and only the page that knows how to draw them does.
 *
 * ONE TEXT, THREE DOORS. The guide below is the body of the `rich-answers`
 * Hermes pack, the tail of the system-prompt preamble a remote agent gets, and
 * what `opc present` prints — so the agent that learned the syntax from any of
 * the three learned the same syntax. The schemas here are what
 * client/src/components/RichBlock.tsx parses; a field added to one without the
 * other is a widget that draws nothing, so change both.
 *
 * THE RULES ARE THE POINT, AS THEY ARE FOR EVERY SKILL. A chart is a stronger
 * claim than a sentence — a reader trusts a drawn line more than a quoted
 * number — so the honesty rules the registry carries for figures apply harder
 * here, and the guide repeats the ones that a widget makes easy to break: a
 * smoothed line, a blended total, a de-duplicated figure summed into a card.
 *
 * This module imports NOTHING from the server: the CLI prints it, and the CLI
 * is a client of the API that must not open the database.
 */

/** The fence languages the chat page draws. Exported so the Telegram fallback
 *  and the client can agree on the list without a third copy. */
export const RICH_LANGS = ["cards", "chart", "bars", "meters", "table"] as const;
export type RichLang = (typeof RICH_LANGS)[number];

const SCHEMAS = `\
\`\`\`cards
{"title": "Stripe, last 30 days (EUR)",
 "cards": [
   {"label": "MRR", "value": 1240, "unit": "EUR", "delta": "+3.1% vs prior 30d", "tone": "ok"},
   {"label": "Active subscriptions", "value": 31},
   {"label": "Failed payments", "value": 4, "tone": "warn", "note": "2 declined, 2 blocked by Radar"}
 ]}
\`\`\`

\`\`\`chart
{"title": "Pageviews per day, acme.ie, last 14 days", "unit": "count",
 "series": [{"label": "pageviews", "points": [{"ts": "2026-08-23", "value": 61}, {"ts": "2026-08-24", "value": 74}]}],
 "caption": "Umami; a day with no row was not measured and is left out."}
\`\`\`

\`\`\`bars
{"title": "OpenRouter spend by model, last 30 days (USD)", "unit": "USD",
 "bars": [{"label": "claude-sonnet-4", "value": 18.4}, {"label": "gpt-4.1-mini", "value": 6.2}]}
\`\`\`

\`\`\`meters
{"title": "Disk, now",
 "meters": [{"label": "acme-api /", "value": 81, "warn": 70, "crit": 90, "note": "62 GB of 76 GB"}]}
\`\`\`

\`\`\`table
{"title": "Domains expiring within 60 days",
 "columns": ["domain", "expires", "registrar", "auto-renew"],
 "rows": [["acme.so", "2026-10-02", "Dynadot", "on"], ["example-app-8.example.test", "2026-10-19", "Spaceship", "unknown"]]}
\`\`\``;

/**
 * The guide, whole. Markdown, written for an agent. It is the pack body and the
 * `opc present` output; PRESENT_BRIEF below is the same thing at preamble size.
 */
export const PRESENT_GUIDE = `\
# Rich answers — cards, charts, bars, meters and tables in the chat

## When to use

Whenever an answer carries figures. The chat renders five fenced code blocks as \
live widgets, and a widget is read faster and remembered better than the same \
numbers in a sentence. Use them in the chat; on every other surface (Telegram, \
a copied transcript) the same block is shown as plain text automatically, so \
there is never a reason to hold back.

## Pick the form by the data's job

- **One or a handful of headline figures** — MRR, visitors this week, cards \
open — → \`cards\`. Never a one-bar bar chart.
- **How something moved over time** — pageviews per day, spend per day, load \
per minute → \`chart\`. Dated points, two or more, one line per series, at most \
four series.
- **A few categories compared** — spend by project, downloads by package, top \
pages → \`bars\`. At most twelve bars; more than that is a \`table\`.
- **A reading against a limit** — disk full, quota used, budget burned → \
\`meters\`. Percentages only.
- **Many rows, or several columns that all matter** — expiring domains, the \
week's payouts, every repo → \`table\`.

## How to write one

A fenced code block whose language tag is one of \`cards\`, \`chart\`, \
\`bars\`, \`meters\`, \`table\`, holding ONE JSON object. Put a sentence of your \
own before it saying what it shows, keep it at the top level of the answer — \
not inside a list item or a quote — with a blank line before and after. The \
JSON must be valid: double quotes, no trailing commas, no comments. A block \
that does not parse is shown as code, which is honest but not what you meant.

Schemas (\`?\` marks optional):

- cards: \`{"title"?, "cards": [{"label", "value": string|number, "unit"?, "delta"?, "tone"?: "ok"|"warn"|"bad", "note"?}]}\`
- chart: \`{"title"?, "unit"?: "count"|"usd"|"percent"|"bytes", "series": [{"label", "points": [{"ts": "YYYY-MM-DD" or ISO, "value": number}]}], "caption"?}\`
- bars: \`{"title"?, "unit"?, "bars": [{"label", "value": number, "note"?}], "caption"?}\`
- meters: \`{"title"?, "meters": [{"label", "value": 0–100, "warn"?: 70, "crit"?: 90, "note"?}]}\`
- table: \`{"title"?, "columns": [string], "rows": [[string|number|null]], "caption"?}\`

\`unit\` on a chart is one of four words the axis knows how to label; \`usd\` \
means dollars and nothing else. For any other currency or unit, leave \`unit\` \
out and name it in the title — "(EUR)" — as the examples do. On cards and bars \
\`unit\` is free text and is shown beside the value.

## Examples

${SCHEMAS}

## The rules — these are not optional

- Every number in a block comes from a document you just read with \`opc\`. \
Never a number from memory, never a point invented to smooth a line, never a \
series extended past the window the document covered.
- The title names the window and the unit exactly as the document did. A \
chart with no window is a claim about all time.
- One currency per block. Never a blended total, never two currencies in one \
series or one card row; two currencies are two blocks.
- A figure the source de-duplicated — unique visitors, Cloudflare uniques, \
Meta reach — is never summed into a card or a bar. Show the document's own \
figure for the document's own window.
- \`null\` in the document is a point left out and a note in the caption. It is \
never drawn as zero.
- One idea per block and at most three blocks in an answer. If the answer needs \
more, it needs a shorter answer.
- Say what you used: the skill, the view and the window, in the caption or the \
sentence before.
`;

/**
 * The preamble-sized version, for an agent with no packs: the syntax and the
 * rules a widget makes easy to break, in about 700 characters. It is appended
 * to `preamble()` in the registry and is not trimmed there.
 */
export const PRESENT_BRIEF = `\
Rich answers: the chat draws five fenced blocks as widgets — write a fenced code \
block with language cards, chart, bars, meters or table holding one JSON object. \
cards {"title","cards":[{"label","value","unit"?,"delta"?,"tone"?:"ok"|"warn"|"bad","note"?}]}; \
chart {"title","unit"?:"count"|"usd"|"percent"|"bytes","series":[{"label","points":[{"ts","value"}]}],"caption"?}; \
bars {"title","unit"?,"bars":[{"label","value","note"?}]}; \
meters {"title","meters":[{"label","value":0-100,"warn"?,"crit"?,"note"?}]}; \
table {"title","columns":[…],"rows":[[…]]}. \
Headline figures → cards; over time → chart; categories → bars (≤12); against a \
limit → meters; many rows → table. Every number from a document you read this \
turn; the title names the window and unit; one currency per block; nothing \
de-duplicated is summed; null is left out, never drawn as 0; at most three blocks.`;

/* ------------------------------------------------------ the plain fallback */

/**
 * The same answer with every rich block turned into text, for a surface that
 * cannot draw one. Telegram gets this; the chat page never does.
 *
 * Lossy on purpose and in one direction: a card becomes "label: value (delta)",
 * a table becomes rows of " · "-joined cells, a chart becomes its first and
 * last reading per series — the figures survive and the drawing does not. A
 * block that does not parse is left exactly as written, because a fence the
 * agent got wrong is still the agent's words.
 */
export function plainRich(text: string): string {
  const re = /```(cards|chart|bars|meters|table)[ \t]*\n([\s\S]*?)\n```/g;
  return text.replace(re, (whole, lang: RichLang, body: string) => {
    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      return whole;
    }
    const lines = plainLines(lang, doc);
    return lines ? lines.join("\n") : whole;
  });
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string =>
  v === null || v === undefined ? "—" : typeof v === "string" ? v : typeof v === "number" ? fmt(v) : String(v);
const fmt = (n: number): string =>
  Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });

function plainLines(lang: RichLang, doc: unknown): string[] | null {
  if (!isObj(doc)) return null;
  const out: string[] = [];
  const title = typeof doc.title === "string" ? doc.title.trim() : "";
  if (title) out.push(title);
  const caption = typeof doc.caption === "string" ? doc.caption.trim() : "";

  if (lang === "cards" && Array.isArray(doc.cards)) {
    for (const c of doc.cards) {
      if (!isObj(c)) continue;
      const unit = typeof c.unit === "string" && c.unit ? ` ${c.unit}` : "";
      const delta = typeof c.delta === "string" && c.delta ? ` (${c.delta})` : "";
      const note = typeof c.note === "string" && c.note ? ` — ${c.note}` : "";
      out.push(`${str(c.label)}: ${str(c.value)}${unit}${delta}${note}`);
    }
  } else if (lang === "chart" && Array.isArray(doc.series)) {
    for (const s of doc.series) {
      if (!isObj(s) || !Array.isArray(s.points) || !s.points.length) continue;
      const pts = s.points.filter(isObj);
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (!first || !last) continue;
      out.push(
        `${str(s.label)}: ${str(first.value)} (${str(first.ts)}) → ${str(last.value)} (${str(last.ts)}), ${pts.length} points`,
      );
    }
  } else if (lang === "bars" && Array.isArray(doc.bars)) {
    const unit = typeof doc.unit === "string" && doc.unit ? ` ${doc.unit}` : "";
    for (const b of doc.bars) {
      if (!isObj(b)) continue;
      const note = typeof b.note === "string" && b.note ? ` — ${b.note}` : "";
      out.push(`${str(b.label)}: ${str(b.value)}${unit}${note}`);
    }
  } else if (lang === "meters" && Array.isArray(doc.meters)) {
    for (const m of doc.meters) {
      if (!isObj(m)) continue;
      const note = typeof m.note === "string" && m.note ? ` — ${m.note}` : "";
      out.push(`${str(m.label)}: ${str(m.value)}%${note}`);
    }
  } else if (lang === "table" && Array.isArray(doc.columns) && Array.isArray(doc.rows)) {
    out.push(doc.columns.map(str).join(" · "));
    for (const r of doc.rows) if (Array.isArray(r)) out.push(r.map(str).join(" · "));
  } else {
    return null;
  }

  if (caption) out.push(caption);
  return out.length ? out : null;
}
