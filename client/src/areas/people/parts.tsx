import { Link } from "react-router-dom";
import { Chart } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";
import type {
  Commitment,
  Person,
  PersonDay,
  Temperature,
} from "@/lib/api/people";

/**
 * THE PIECES THE PEOPLE PAGE IS MADE OF.
 *
 * THE RULE EVERY ONE OF THEM FOLLOWS: a figure that was not measured is drawn
 * as not measured. `temperature: null` gets the word "no rhythm yet" and a
 * grey dot, never the cold colour; `cadenceDays: null` is an em dash with the
 * server's own sentence under it; an open promise with no stated deadline says
 * "no date stated" rather than being sorted into "overdue".
 */

/* ------------------------------------------------------------- temperature */

/**
 * The dot and the word.
 *
 * FOUR STATES AND NOT THREE. "No rhythm yet" is the absence of a measurement
 * and gets its own grey; giving it the cold colour would draw an unmeasured
 * relationship as a broken one, which is the single most likely way for this
 * page to mislead somebody.
 */
export function TempDot({ t }: { t: Temperature }) {
  const look =
    t === "warm"
      ? "bg-ok"
      : t === "cooling"
        ? "bg-warn"
        : t === "cold"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
  return <span className={cn("inline-block size-[7px] shrink-0 rounded-full", look)} />;
}

const tempWord = (t: Temperature) => (t === null ? "no rhythm yet" : t);

/* ------------------------------------------------------------ venture badge */

/** The DERIVED link, drawn so the guess is visible. The word "domain" is in
 *  the badge and the whole reason is on the tooltip: this says where their
 *  address is, not who they work for. */
export function VentureBadge({ p }: { p: Person }) {
  if (!p.link) return null;
  return (
    <Link
      to={`/ventures/${p.link.slug}`}
      title={p.link.why}
      className="border-line-soft text-muted-foreground hover:text-foreground rounded-md border px-1.5 py-px text-[10.5px] whitespace-nowrap"
    >
      {p.link.ventureName} · by domain
    </Link>
  );
}

/* ----------------------------------------------------------------- one row */

export function ContactRow({
  p,
  open,
  onToggle,
}: {
  p: Person;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "hover:bg-accent/60 flex w-full items-center gap-2.5 px-3 py-2 text-left",
        open && "bg-accent/40",
      )}
    >
      <TempDot t={p.temperature} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px]">
          {p.name ?? p.address}
          {p.name && (
            <span className="text-muted-foreground ml-1.5 text-[11.5px]">{p.address}</span>
          )}
        </span>
        <span className="text-muted-foreground block truncate text-[11.5px]">
          {p.received} in · {p.sent} out · {p.threads}{" "}
          {p.threads === 1 ? "thread" : "threads"} ·{" "}
          {p.cadenceDays === null ? "no rhythm yet" : `usually every ${p.cadenceDays}d`}
        </span>
      </span>
      <VentureBadge p={p} />
      {p.stale && (
        <span className="border-line-soft text-muted-foreground rounded-md border px-1.5 py-px text-[10.5px]">
          stale
        </span>
      )}
      <span className="text-muted-foreground w-[86px] shrink-0 text-right text-[11.5px] tabular-nums">
        {p.lastAt ? ago(p.lastAt) : "no dated mail"}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------- the panel */

/**
 * One contact, opened.
 *
 * THE CHART IS TWO SERIES AND NOT ONE, because "they write and I do not" is
 * the shape this whole page exists to show, and a single "messages" line
 * hides it completely. Days with no mail are simply absent — the series is
 * the days on which something happened, and drawing a zero for every silent
 * day would turn a correspondence into a picture of a calendar.
 */
export function ContactPanel({
  p,
  days,
  loading,
}: {
  p: Person;
  days: PersonDay[];
  loading: boolean;
}) {
  const series = [
    {
      label: "received",
      points: days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.received })),
    },
    {
      label: "sent",
      points: days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.sent })),
    },
  ];

  return (
    <div className="border-line-soft bg-card/40 border-t px-3 py-3">
      <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Figure label="last heard from" value={p.lastReceived ? ago(p.lastReceived) : "—"} />
        <Figure label="last written to" value={p.lastSent ? ago(p.lastSent) : "—"} />
        <Figure
          label="usual gap"
          value={p.cadenceDays === null ? "—" : `${p.cadenceDays} days`}
          note={
            p.cadenceDays === null
              ? `${p.cadenceGaps} measurable gaps — not enough to claim a rhythm`
              : `median over ${p.cadenceGaps} gaps, ${p.contactDays} days of contact`
          }
        />
        <Figure
          label="temperature"
          value={tempWord(p.temperature)}
          note={p.ratio === null ? undefined : `${p.ratio}× their usual gap`}
        />
      </div>

      <p className="text-muted-foreground mb-2 text-[11.5px]">{p.why}</p>

      {loading ? (
        <p className="text-muted-foreground text-[11.5px]">Reading the day series…</p>
      ) : days.length > 1 ? (
        <Chart
          series={series}
          unit="count"
          caption="Messages a day, each direction. Only days with mail appear."
        />
      ) : (
        <p className="text-muted-foreground text-[11.5px]">
          {days.length
            ? "One day of contact — there is no shape to draw yet."
            : "No day series: a chart is kept only for contacts that met the minimum each way."}
        </p>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground text-[11px]">{label}</div>
      <div className="text-[13.5px]">{value}</div>
      {note && <div className="text-muted-foreground text-[11px]">{note}</div>}
    </div>
  );
}

/* --------------------------------------------------------- one commitment */

/**
 * A promise, with its evidence.
 *
 * THE SENTENCE IS THE ROW, and `what` is the heading over it. That is the
 * right way round: the summary is a model's shortest span of the sentence and
 * the sentence is what he typed, so a reader who trusts only one of them
 * should be trusting the one underneath.
 */
export function CommitmentRow({
  c,
  busy,
  onDecide,
}: {
  c: Commitment;
  busy: boolean;
  onDecide: (action: "done" | "dismiss" | "reopen") => void;
}) {
  const overdue =
    c.status === "open" && c.due !== null && c.due < new Date().toISOString().slice(0, 10);
  return (
    <div className="border-line-soft border-b px-3 py-2.5 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px]">{c.what}</div>
          <blockquote className="border-line-soft text-muted-foreground mt-1 border-l-2 pl-2 text-[12px] italic">
            “{c.sentence}”
          </blockquote>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px]">
            <span>to {c.toName ?? c.to}</span>
            {c.subject && <span className="truncate">· {c.subject}</span>}
            <span>· {c.sentAt ? ago(c.sentAt) : "no date on the message"}</span>
            <span
              className={cn(
                "border-line-soft rounded-md border px-1.5 py-px",
                overdue && "text-destructive",
              )}
            >
              {c.dueText
                ? `he said “${c.dueText}”${c.due ? ` — ${c.due}` : " — no date this can resolve"}`
                : "no date stated"}
            </span>
            {c.status !== "open" && (
              <span className="border-line-soft rounded-md border px-1.5 py-px">{c.status}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {c.status === "open" ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide("done")}>
                Done
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onDecide("dismiss")}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide("reopen")}>
              Reopen
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
