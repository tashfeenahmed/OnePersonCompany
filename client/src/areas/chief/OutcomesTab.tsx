import { useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { count, pct } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { outcomesApi, type Outcome } from "@/lib/api/chief";
import { alertsApi } from "@/lib/api/proactive";

/**
 * DID THE THING HE DID ACTUALLY DO ANYTHING?
 *
 * THE CAVEAT IS ON THE PAGE AND NOT IN A TOOLTIP. Everything here is two
 * figures either side of a date; nothing controls for anything else that
 * happened in the window. That sentence is printed above the list rather than
 * hidden behind a question mark, because a page of green arrows with the
 * disclaimer one hover away is a page that teaches the opposite of what it
 * says.
 *
 * A NULL READING IS A GAP IN THE LINE, NEVER A ZERO. The sparkline below is
 * written here rather than borrowed from `components/charts` for exactly that
 * reason: the shared one takes `number[]` and has nowhere to put "the plugin
 * was disconnected that day". A floor drawn at zero would read as a collapse in
 * the business.
 *
 * THE METRIC PICKER READS THE LIVE CATALOGUE. A hard-coded list of trackable
 * figures would be out of date the first time an area shipped a route, so the
 * form offers what `/api/skills` says exists, connected ones first, and the
 * path is typed — because only the owner looking at the document knows which
 * field in it is the one they mean.
 */
export function OutcomesTab() {
  const doc = useApi(() => outcomesApi.all(), []);
  const cat = useApi(() => alertsApi.catalogue(), []);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (doc.error) return <p className="text-destructive text-[13.5px]">{doc.error}</p>;
  if (!doc.data)
    return <p className="text-muted-foreground text-[13.5px]">Reading the outcomes…</p>;

  const { outcomes, summary, schedule } = doc.data;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-[12.5px]">
        One thing you did, one metric, a baseline taken when the link was made
        and readings at {schedule.offsetsDays.join(", ")} days after the action.
        <strong className="text-foreground font-medium">
          {" "}
          This is correlation, not causation
        </strong>{" "}
        — two figures either side of a date, with nothing controlled for.
        Anything inside ±{schedule.flatBandPct}% reads as flat, because a small
        site's numbers move that much between Tuesdays.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}>
          <Plus className="size-3.5" strokeWidth={1.6} />
          Track something
        </Button>
        <span className="text-muted-foreground text-[11.5px] tabular-nums">
          {summary.up} up · {summary.down} down · {summary.flat} flat ·{" "}
          {summary.pending} too early · {summary.unreadable} unreadable
        </span>
      </div>

      {adding && (
        <TrackForm
          skills={cat.data?.skills ?? []}
          onDone={() => {
            setAdding(false);
            doc.reload();
          }}
        />
      )}

      {failure && <p className="text-destructive text-[12.5px]">{failure}</p>}

      {outcomes.length === 0 ? (
        <p className="text-muted-foreground text-[13.5px]">
          Nothing is being tracked. Link a thing you did to a number and this
          page will read it again in a week.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {outcomes.map((o) => (
            <OutcomeCard
              key={o.id}
              outcome={o}
              busy={busy === o.id}
              onRead={() => {
                setBusy(o.id);
                setFailure(null);
                outcomesApi
                  .read(o.id)
                  .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
                  .finally(() => {
                    setBusy(null);
                    doc.reload();
                  });
              }}
              onRemove={() => {
                setBusy(o.id);
                outcomesApi
                  .remove(o.id)
                  .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
                  .finally(() => {
                    setBusy(null);
                    doc.reload();
                  });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const VERDICT: Record<Outcome["verdict"], { word: string; tone: string }> = {
  up: { word: "up", tone: "text-ok" },
  down: { word: "down", tone: "text-destructive" },
  flat: { word: "flat", tone: "text-muted-foreground" },
  /* NOT "no change". Too early and no change are different findings and the
     one thing this page must never do is turn the first into the second. */
  pending: { word: "too early", tone: "text-muted-foreground" },
  unreadable: { word: "not measured", tone: "text-warn-foreground" },
};

function OutcomeCard({
  outcome,
  busy,
  onRead,
  onRemove,
}: {
  outcome: Outcome;
  busy: boolean;
  onRead: () => void;
  onRemove: () => void;
}) {
  const v = VERDICT[outcome.verdict];
  const nextDue = outcome.due.find((d) => !d.overdue) ?? null;

  return (
    <div className="border-line-soft bg-card rounded-[10px] border p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-medium">{outcome.title}</span>
        {outcome.ventureName && (
          <span className="text-muted-foreground text-[11.5px]">{outcome.ventureName}</span>
        )}
        <span className={cn("ml-auto text-[12.5px] font-medium", v.tone)}>{v.word}</span>
      </div>

      <p className="text-muted-foreground mt-0.5 text-[11.5px]">
        {outcome.action.text} · done {outcome.action.at.slice(0, 10)} (
        {outcome.action.daysAgo} days ago) · metric{" "}
        <code className="text-[11px]">{outcome.metric.address}</code>
        {outcome.metric.unit && ` · ${outcome.metric.unit}`}
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-6">
        <Figure label="Before" value={outcome.before} />
        <Figure label="After" value={outcome.after} />
        <div>
          <div className="text-muted-foreground text-[11px]">Change</div>
          <div className="text-[15px] tabular-nums">
            {outcome.delta === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <>
                {outcome.delta > 0 ? "+" : ""}
                {fmt(outcome.delta)}
                {/* Null pct is a real answer: a percentage of a zero baseline
                    is not a percentage, and the delta stands on its own. */}
                {outcome.pct !== null && (
                  <span className="text-muted-foreground ml-1.5 text-[12px]">
                    {outcome.pct > 0 ? "+" : ""}
                    {pct(outcome.pct / 100)}
                  </span>
                )}
                {outcome.pct === null && outcome.before === 0 && (
                  <span className="text-muted-foreground ml-1.5 text-[12px]">
                    from nothing — no percentage
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="min-w-[140px] flex-1">
          <Gapline readings={outcome.readings} />
        </div>
      </div>

      <p className="text-muted-foreground mt-2 text-[11px] leading-snug">
        {outcome.window}{" "}
        {nextDue &&
          `Next reading due ${nextDue.dueAt.slice(0, 10)} (day ${nextDue.dayOffset}).`}
      </p>
      {outcome.baseline?.error && (
        <p className="text-warn-foreground mt-1 text-[11px]">
          Baseline: {outcome.baseline.error}
        </p>
      )}

      <div className="mt-2 flex gap-1.5">
        <Button size="xs" variant="ghost" disabled={busy} onClick={onRead}>
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" strokeWidth={1.6} />
          )}
          Read it now
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onRemove}>
          <Trash2 className="size-3" strokeWidth={1.6} />
          Stop tracking
        </Button>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="text-muted-foreground text-[11px]">{label}</div>
      <div className="text-[15px] tabular-nums">
        {/* NOT ZERO. An em dash for a figure this box could not read. */}
        {value === null ? <span className="text-muted-foreground">—</span> : fmt(value)}
      </div>
    </div>
  );
}

/**
 * An outcome reading, which is NOT always a count — a conversion ratio is 3.14
 * and rounding it to "3" would be this page deciding what was measured. So
 * small figures keep two decimals; above a thousand the decimals are noise and
 * it is `count` from `@/lib/format`, the same separators as everywhere else.
 */
function fmt(n: number): string {
  return Math.abs(n) >= 1000 ? count(n) : String(Number(n.toFixed(2)));
}

/**
 * A SPARKLINE WITH HOLES IN IT.
 *
 * Every reading in order, with a null drawn as a BREAK in the line rather than
 * as a point on the floor. That is the whole reason this is twenty lines here
 * instead of the shared `Sparkline`, which takes `number[]` and has nowhere to
 * put "not measured". Fewer than two readable points draws nothing at all: one
 * dot is not a shape, and a line that implies a trend from a single value is
 * the same lie in a different medium.
 */
function Gapline({ readings }: { readings: { value: number | null }[] }) {
  const pts = useMemo(() => {
    const values = readings.map((r) => r.value);
    const real = values.filter((v): v is number => v !== null);
    if (real.length < 2) return null;
    const min = Math.min(...real);
    const max = Math.max(...real);
    const span = max - min || 1;
    const W = 140;
    const H = 26;
    const segments: string[] = [];
    let current: string[] = [];
    values.forEach((v, i) => {
      if (v === null) {
        if (current.length > 1) segments.push(current.join(" "));
        current = [];
        return;
      }
      const x = values.length > 1 ? (i / (values.length - 1)) * W : W / 2;
      const y = H - ((v - min) / span) * H;
      current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    if (current.length > 1) segments.push(current.join(" "));
    return { segments, W, H, count: real.length, gaps: values.length - real.length };
  }, [readings]);

  if (!pts)
    return (
      <span className="text-muted-foreground text-[11px]">
        Not enough readings to draw a shape yet.
      </span>
    );

  return (
    <div>
      <svg
        width="100%"
        height={pts.H}
        viewBox={`0 0 ${pts.W} ${pts.H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${pts.count} readings${pts.gaps ? `, ${pts.gaps} not measured` : ""}`}
        className="text-foreground/60 block"
      >
        {pts.segments.map((s, i) => (
          <polyline
            key={i}
            points={s}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {pts.gaps > 0 && (
        <span className="text-muted-foreground text-[11px]">
          {pts.gaps} reading{pts.gaps === 1 ? "" : "s"} could not be taken — the
          line breaks rather than dropping to zero.
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the form */

function TrackForm({
  skills,
  onDone,
}: {
  skills: { id: string; title: string; connected: boolean; views: { key: string }[] }[];
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    title: "",
    actionText: "",
    actionAt: new Date().toISOString().slice(0, 10),
    venture: "",
    skill: "",
    view: "default",
    params: "",
    path: "",
    unit: "",
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const chosen = skills.find((s) => s.id === form.skill) ?? null;

  return (
    <div className="border-line-soft bg-card rounded-[10px] border p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="What you did" hint="The line you will read in a month.">
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Row>
        <Row label="The day you did it" hint="YYYY-MM-DD. Every reading is offset from this, not from today.">
          <Input value={form.actionAt} onChange={(e) => set("actionAt", e.target.value)} />
        </Row>
        <Row label="Venture" hint="Its slug, or leave empty for work that is not about one.">
          <Input value={form.venture} onChange={(e) => set("venture", e.target.value)} />
        </Row>
        <Row label="Unit" hint="What the figure is counted in. Left empty it stays null — nothing here will guess it.">
          <Input value={form.unit} onChange={(e) => set("unit", e.target.value)} />
        </Row>
        <Row label="Metric — which document" hint="From the live skills catalogue. A disconnected one will fail its baseline and say so.">
          <select
            value={form.skill}
            onChange={(e) => set("skill", e.target.value)}
            className="border-input bg-background h-8 rounded-lg border px-2 text-[13px]"
          >
            <option value="">Choose a skill…</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
                {s.connected ? "" : " (not connected)"}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Which view" hint="Most documents have one. Some have several cuts of the same data.">
          <select
            value={form.view}
            onChange={(e) => set("view", e.target.value)}
            className="border-input bg-background h-8 rounded-lg border px-2 text-[13px]"
          >
            {(chosen?.views ?? [{ key: "default" }]).map((v) => (
              <option key={v.key} value={v.key}>
                {v.key}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="The field in it"
          hint="Dotted, with [n] for arrays: portfolio.window.visits. Open the document first and copy the path — a guessed one records a baseline that says the field does not exist."
        >
          <Input value={form.path} onChange={(e) => set("path", e.target.value)} placeholder="totals.visitors" />
        </Row>
        <Row label="Parameters" hint='JSON, sent on every reading so the window never changes: {"days":"30"}'>
          <Input value={form.params} onChange={(e) => set("params", e.target.value)} placeholder="{}" />
        </Row>
      </div>

      <Row label="What was done, at more length" hint="Optional. Defaults to the title.">
        <Input value={form.actionText} onChange={(e) => set("actionText", e.target.value)} />
      </Row>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !form.title.trim() || !form.skill || !form.path.trim()}
          onClick={() => {
            setSaving(true);
            setFailure(null);
            let params: Record<string, string> | undefined;
            if (form.params.trim()) {
              try {
                params = JSON.parse(form.params) as Record<string, string>;
              } catch {
                setFailure("Parameters must be JSON, like {\"days\":\"30\"}.");
                setSaving(false);
                return;
              }
            }
            outcomesApi
              .track({
                title: form.title.trim(),
                actionText: form.actionText.trim() || undefined,
                actionAt: form.actionAt.trim(),
                venture: form.venture.trim() || undefined,
                skill: form.skill,
                view: form.view,
                params,
                path: form.path.trim(),
                unit: form.unit.trim() || undefined,
              })
              .then(() => onDone())
              .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
              .finally(() => setSaving(false));
          }}
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Take the baseline and track it
        </Button>
        {failure && <span className="text-destructive text-[11.5px]">{failure}</span>}
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 grid gap-1 first:mt-0">
      <span className="text-[12.5px] font-medium">{label}</span>
      {children}
      <span className="text-muted-foreground text-[11px] leading-snug">{hint}</span>
    </div>
  );
}
