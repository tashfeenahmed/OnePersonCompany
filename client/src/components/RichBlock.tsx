/**
 * RICH BLOCKS — the five fences an agent writes that this page draws.
 *
 * ```cards```, ```chart```, ```bars```, ```meters``` and ```table```, each holding
 * one JSON object, are ordinary fenced code to every other reader of the
 * transcript and widgets here. The contract — which fields, which units — is
 * server/src/skills/present.ts, the guide the agent learned it from; this file
 * is that guide's other half and must parse exactly what it promises.
 *
 * FALLING BACK IS THE NORMAL CASE, NOT THE ERROR CASE. An answer streams in,
 * and for most of a block's life its JSON is a prefix of itself: unparseable.
 * So a body that does not parse is shown as the code it is, and the widget
 * appears on the delta that closes the object. The same path handles a block
 * the agent got wrong — a trailing comma, a missing quote — which is then
 * visible as exactly what was written rather than as nothing, so the owner
 * can see the mistake and the agent can be told about it.
 *
 * NOTHING HERE ADDS UP. Every figure drawn is a figure the agent wrote; there
 * is no total row, no summed series, no derived percentage, because the rules
 * the agent answers under say those are its decisions to make from the
 * document and this component has never seen the document.
 *
 * The drawings reuse the dashboard's own: the time-series Chart, MeterRow and
 * the Figures table, so a chart in an answer is the chart on the widget the
 * answer is about. Cards and bars are drawn here, small, in the transcript's
 * type scale; a stat tile per the dataviz form rules — label, value, delta,
 * note — and a bar list rather than a bar chart, because a label beside a bar
 * reads in a 600px column and a label under one does not.
 */
import { Chart, Figures, MeterRow, type ChartUnit } from "@/components/charts";
import { CodeBlock } from "@/components/CodeBlock";
import { cn } from "@/lib/utils";
import type { ChartSeries, Meter, StatusTone } from "@/data/widgets";
import type { RichLang } from "@/lib/rich";

/* ------------------------------------------------------------------ parse */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const tone = (v: unknown): StatusTone | null =>
  v === "ok" || v === "warn" || v === "bad" ? v : null;

function parseDoc(text: string): Obj | null {
  try {
    const doc = JSON.parse(text) as unknown;
    return isObj(doc) ? doc : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- format */

const CURRENCY: Record<string, string> = { usd: "$", eur: "€", gbp: "£" };

/** 1,284 · 12.9K · 4.2M — the stat tile's auto-compact, with the unit as a
 *  prefix when it is a currency symbol and a suffix otherwise. */
function fmt(value: unknown, unit: string | null): string {
  if (typeof value === "string") return unit ? `${value} ${unit}` : value;
  const n = num(value);
  if (n === null) return "—";
  const key = unit?.toLowerCase() ?? "";
  const money = key in CURRENCY;
  const abs = Math.abs(n);
  let s: string;
  if (abs >= 1e6) s = `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  else if (abs >= 1e4) s = `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, "")}K`;
  /* Money keeps its cents below a thousand — $28.15 is a figure and $28.2 is
     a rounding the agent did not do. Counts drop decimals as they grow. */
  else if (money && abs < 1000) s = n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else s = n.toLocaleString("en-GB", { maximumFractionDigits: abs < 10 ? 2 : abs < 100 ? 1 : 0 });
  if (!unit) return s;
  if (key === "percent" || key === "%") return `${s}%`;
  if (money) return `${CURRENCY[key]}${s}`;
  return `${s} ${unit}`;
}

const TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-[var(--ok)]",
  warn: "text-[var(--warn)]",
  bad: "text-destructive",
};

/* ------------------------------------------------------------------ frame */

function Frame({
  title,
  caption,
  children,
}: {
  title: string | null;
  caption: string | null;
  children: React.ReactNode;
}) {
  return (
    <figure className="border-line-soft my-2.5 rounded-[10px] border px-3.5 py-3">
      {title && (
        <figcaption className="mb-1.5 text-[12.5px] font-medium tracking-tight">{title}</figcaption>
      )}
      {children}
      {caption && (
        <p className="text-muted-foreground mt-2 text-[11.5px] leading-snug">{caption}</p>
      )}
    </figure>
  );
}

/* ------------------------------------------------------------------- cards */

function Cards({ doc }: { doc: Obj }) {
  const cards = (Array.isArray(doc.cards) ? doc.cards : []).filter(isObj);
  if (!cards.length) return null;
  return (
    <Frame title={str(doc.title)} caption={str(doc.caption)}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {cards.slice(0, 12).map((c, i) => {
          const t = tone(c.tone);
          const delta = str(c.delta);
          const note = str(c.note);
          return (
            <div key={i} className="min-w-0">
              <div className="text-muted-foreground truncate text-[11.5px]">{str(c.label) ?? "—"}</div>
              <div className={cn("text-[18px] font-semibold tracking-tight tabular-nums", t && TONE_TEXT[t])}>
                {fmt(c.value, str(c.unit))}
              </div>
              {(delta || note) && (
                <div className="text-muted-foreground truncate text-[11px] leading-snug">
                  {delta && <span className={cn("tabular-nums", t && TONE_TEXT[t])}>{delta}</span>}
                  {delta && note && " · "}
                  {note}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------- chart */

const UNITS: ChartUnit[] = ["count", "usd", "percent", "bytes"];

function TimeChart({ doc }: { doc: Obj }) {
  const raw = (Array.isArray(doc.series) ? doc.series : []).filter(isObj);
  const series: ChartSeries[] = [];
  for (const s of raw.slice(0, 4)) {
    const pts = (Array.isArray(s.points) ? s.points : []).filter(isObj);
    const points: { ts: string; value: number }[] = [];
    for (const p of pts) {
      const ts = str(p.ts) ?? str(p.x);
      const value = num(p.value) ?? num(p.y);
      if (!ts || value === null || Number.isNaN(Date.parse(ts))) continue;
      points.push({ ts, value });
    }
    if (points.length) series.push({ label: str(s.label) ?? `series ${series.length + 1}`, points });
  }
  if (!series.length) return null;
  const u = str(doc.unit)?.toLowerCase();
  const unit: ChartUnit = u && (UNITS as string[]).includes(u) ? (u as ChartUnit) : "count";
  return (
    <Frame title={str(doc.title)} caption={str(doc.caption)}>
      <Chart series={series} unit={unit} />
    </Frame>
  );
}

/* -------------------------------------------------------------------- bars */

function BarList({ doc }: { doc: Obj }) {
  const bars = (Array.isArray(doc.bars) ? doc.bars : [])
    .filter(isObj)
    .map((b) => ({ label: str(b.label) ?? "—", value: num(b.value), note: str(b.note) }))
    .filter((b): b is { label: string; value: number; note: string | null } => b.value !== null)
    .slice(0, 12);
  if (!bars.length) return null;
  const unit = str(doc.unit);
  const max = Math.max(...bars.map((b) => Math.abs(b.value)), 0) || 1;
  return (
    <Frame title={str(doc.title)} caption={str(doc.caption)}>
      <div className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-x-3 gap-y-1.5 text-[12px]">
        {bars.map((b, i) => (
          <div key={i} className="contents">
            <div className="truncate" title={b.note ? `${b.label} — ${b.note}` : b.label}>
              {b.label}
            </div>
            <div className="bg-muted/60 h-[7px] overflow-hidden rounded-full">
              <div
                className="bg-foreground/70 h-full rounded-full"
                style={{ width: `${Math.max(1, Math.round((Math.abs(b.value) / max) * 100))}%` }}
              />
            </div>
            <div className="text-right tabular-nums">{fmt(b.value, unit)}</div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ meters */

function Meters({ doc }: { doc: Obj }) {
  const meters: Meter[] = (Array.isArray(doc.meters) ? doc.meters : [])
    .filter(isObj)
    .map((m) => ({
      label: str(m.label) ?? "—",
      value: num(m.value) ?? NaN,
      warn: num(m.warn) ?? 70,
      crit: num(m.crit) ?? 90,
      note: str(m.note) ?? undefined,
    }))
    .filter((m) => Number.isFinite(m.value))
    .slice(0, 12);
  if (!meters.length) return null;
  return (
    <Frame title={str(doc.title)} caption={str(doc.caption)}>
      <div className="space-y-0.5">
        {meters.map((m, i) => (
          <MeterRow key={i} meter={m} />
        ))}
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------- table */

function Table({ doc }: { doc: Obj }) {
  const columns = (Array.isArray(doc.columns) ? doc.columns : []).map((c) => str(c) ?? "");
  const rows = (Array.isArray(doc.rows) ? doc.rows : [])
    .filter(Array.isArray)
    .map((r) => (r as unknown[]).map((cell) => (typeof cell === "number" ? fmt(cell, null) : (str(cell) ?? "—"))));
  if (!columns.length || !rows.length) return null;
  return (
    <Frame title={str(doc.title)} caption={str(doc.caption)}>
      <Figures headers={columns} rows={rows.slice(0, 60)} />
      {rows.length > 60 && (
        <p className="text-muted-foreground mt-1 text-[11px]">First 60 of {rows.length} rows.</p>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------------- entry */

export function RichBlock({ lang, text }: { lang: RichLang; text: string }) {
  const doc = parseDoc(text);
  let drawn: React.ReactNode = null;
  if (doc) {
    if (lang === "cards") drawn = <Cards doc={doc} />;
    else if (lang === "chart") drawn = <TimeChart doc={doc} />;
    else if (lang === "bars") drawn = <BarList doc={doc} />;
    else if (lang === "meters") drawn = <Meters doc={doc} />;
    else drawn = <Table doc={doc} />;
  }
  /* Unparsed, or parsed into nothing drawable: the text, as code. */
  return drawn ?? <CodeBlock text={text} />;
}
