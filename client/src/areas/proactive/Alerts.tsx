import { SelectField, SelectOption } from "@/components/ui/select-field";
import { useUndoActions } from "@/components/interactions/UndoActions";
import { AnimatedDetails } from "@/components/interactions/AnimatedDetails";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Check, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { SubTabs } from "@/components/TabStrip";
import { Tiles } from "@/components/integrations/Panel";
import { PageShell, TopBar } from "@/components/PageShell";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/hooks/useApi";
import { announceAlerts } from "@/hooks/useOpenAlerts";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  alertsApi,
  type AlertEvent,
  type AlertRule,
  type TestResult,
} from "@/lib/api/proactive";
import { RuleEditor } from "@/areas/proactive/RuleEditor";
import { BriefingPanel } from "@/areas/proactive/Briefing";

/**
 * ALERTS — the page for the half of this dashboard that speaks first.
 *
 * WHAT IT IS FOR. Everything else here answers a question you thought to ask.
 * This is the list of comparisons you asked to be told about, the ledger of
 * what they said, and the daily assembly of everything at once. Two tabs
 * because they are read at different moments: the rules when you are setting
 * something up, the briefing when you are drinking coffee.
 *
 * TWO THINGS THIS PAGE REFUSES TO DO, and they are the same refusal twice.
 *
 * It does not colour a trip as a problem. A trip means a number crossed a line
 * somebody drew by hand, and the page says which number and which line. Whether
 * that is bad news is a judgement the owner makes; a red banner would be this
 * page making it for them.
 *
 * And it draws `unreadable` in its own row, with its own word, never mixed in
 * with the trips. A rule that cannot read its document has not found anything
 * out about the business — it has stopped working — and those two findings
 * looking alike is the failure mode the whole feature exists to prevent.
 */

const REFRESH_MS = 30_000;

export function Alerts() {
  const { pathname } = useLocation();
  const onBriefing = pathname.startsWith("/alerts/briefing");

  const [tick, setTick] = useState(0);
  const summary = useApi(() => alertsApi.summary(), [tick]);
  const reload = () => {
    setTick((n) => n + 1);
    announceAlerts();
  };

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const s = summary.data;
  const stats: [string, string][] = [
    [s ? String(s.rules.enabled) : "—", s?.rules.enabled === 1 ? "rule watching" : "rules watching"],
    [s ? String(s.open.trips) : "—", s?.open.trips === 1 ? "open trip" : "open trips"],
    [s ? String(s.open.unreadable) : "—", "unreadable"],
    [s?.lastPassAt ? ago(s.lastPassAt) : "never", "last checked"],
  ];

  return (
    <>
      <TopBar label="Alerts">
        <Checker onDone={reload} />
      </TopBar>

      <PageShell
        title="Alerts"
        sub="Comparisons you wrote down, checked against this box's own documents a minute after every collection. A trip is a figure crossing a line you drew — not a judgement — and a document that could not be read is said so in its own words rather than reported as a fall to zero."
        wide
      >
        <SubTabs
          tabs={[
            { key: "rules", to: "/alerts", label: "Rules and events" },
            { key: "briefing", to: "/alerts/briefing", label: "Briefing" },
          ]}
          activeKey={onBriefing ? "briefing" : "rules"}
          rule
        />

        {onBriefing ? (
          <BriefingPanel />
        ) : (
          <>
            <Tiles items={stats.map(([v, k]) => ({ v, k }))} />

            <Rules onChanged={reload} refreshTick={tick} />
            <Events onChanged={reload} tick={tick} />
          </>
        )}
      </PageShell>
    </>
  );
}

/** Run the evaluator now — the same pass the timer runs, so what it reports is
 *  what the timer would have done. */
function Checker({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      {said && <span className="text-muted-foreground text-[12.5px]">{said}</span>}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setSaid(null);
          void alertsApi
            .evaluate()
            .then((r) =>
              setSaid(
                `${r.evaluated} checked · ${r.tripped} tripped · ${r.unreadable} unreadable`,
              ),
            )
            .catch((e: unknown) => setSaid(e instanceof Error ? e.message : String(e)))
            .finally(() => {
              setBusy(false);
              onDone();
            });
        }}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13.5px]"
      >
        <RefreshCw className={cn("size-3.5", busy && "animate-spin")} strokeWidth={1.6} />
        Check now
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- rules */

function Rules({ onChanged, refreshTick }: { onChanged: () => void; refreshTick: number }) {
  const [tick, setTick] = useState(0);
  const doc = useApi(() => alertsApi.rules(), [tick, refreshTick]);
  const cat = useApi(() => alertsApi.catalogue(), []);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [tested, setTested] = useState<Record<number, TestResult | string>>({});

  const rules = doc.data?.rules ?? [];
  const operators = doc.data?.operators ?? [];
  const skills = cat.data?.skills ?? [];

  const refresh = () => {
    setTick((n) => n + 1);
    onChanged();
  };

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Rules
        </div>
        <button
          onClick={() => setEditing(editing === "new" ? null : "new")}
          className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1 text-[12.5px]"
        >
          <Plus className="size-3.5" strokeWidth={1.6} />
          New rule
        </button>
      </div>

      {editing === "new" && (
        <RuleEditor
          rule={null}
          skills={skills}
          operators={operators}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {doc.error ? (
        <p className="text-muted-foreground text-[14px]">
          The rules could not be read.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      ) : !rules.length ? (
        <p className="text-muted-foreground text-[14px]">
          {doc.loading
            ? "Reading the rules…"
            : "No rules yet. This box suggests a few on first start for plugins that are connected; if there are none here, none of those plugins is connected."}
        </p>
      ) : (
        <div className="flex flex-col">
          {rules.map((r) => (
            <div key={r.id}>
              <RuleRow
                rule={r}
                tested={tested[r.id]}
                editing={editing === r.id}
                onToggle={(on) => {
                  void alertsApi.update(r.id, { enabled: on }).then(refresh);
                }}
                onEdit={() => setEditing(editing === r.id ? null : r.id)}
                onTest={() => {
                  void alertsApi
                    .test(r.id)
                    .then((t) => setTested((m) => ({ ...m, [r.id]: t })))
                    .catch((e: unknown) =>
                      setTested((m) => ({
                        ...m,
                        [r.id]: e instanceof Error ? e.message : String(e),
                      })),
                    );
                }}
                onDelete={() => {
                  if (
                    !confirm(
                      `Delete “${r.name}”? Every event it ever raised goes with it. To stop it firing without losing the history, switch it off instead.`,
                    )
                  )
                    return;
                  void alertsApi.remove(r.id).then(refresh);
                }}
              />
              {editing === r.id && (
                <RuleEditor
                  rule={r}
                  skills={skills}
                  operators={operators}
                  onSaved={() => {
                    setEditing(null);
                    refresh();
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** How a rule reads, in one line of the owner's own vocabulary. */
function sentence(r: AlertRule): string {
  if (r.managedSource) return "Complete daily observations compared with their measured baseline";
  const params = Object.entries(r.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const head = `${r.skill}${r.view && r.view !== "default" ? `/${r.view}` : ""}${params ? ` (${params})` : ""} · ${r.path}`;
  if (r.op === "changed") return `${head} changes`;
  if (r.op === "dropped_by_pct")
    return `${head} falls ${r.threshold}% below its reading ${minutes(r.windowMinutes)} earlier`;
  if (r.op === "rose_by_pct")
    return `${head} rises ${r.threshold}% above its reading ${minutes(r.windowMinutes)} earlier`;
  return `${head} ${r.op} ${r.threshold}`;
}

function minutes(m: number | null): string {
  if (!m) return "—";
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

function RuleRow({
  rule,
  tested,
  editing,
  onToggle,
  onEdit,
  onTest,
  onDelete,
}: {
  rule: AlertRule;
  tested: TestResult | string | undefined;
  editing: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "border-line-soft flex flex-col gap-1 border-b py-2.5 last:border-b-0",
        editing && "bg-accent/40 -mx-2 rounded-t-[10px] px-2",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Switch checked={rule.enabled} onCheckedChange={onToggle} aria-label="Enabled" />
        <span className={cn("text-[14px]", !rule.enabled && "text-muted-foreground")}>
          {rule.name}
        </span>
        {rule.seeded && (
          <span
            title={rule.managedSource ? "Automatically watches complete daily data. Configure it in Insights or disable this watch." : "Suggested by this box on first start, not chosen by you. Edit or delete it like any other."}
            className="text-muted-foreground border-line-soft rounded-full border px-1.5 py-px text-[11px]"
          >
            {rule.managedSource ? "automatic" : "suggested"}
          </span>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px] tabular-nums">
          {/* THE LAST VALUE READ, WHICH IS NOT THE LAST VALUE THAT TRIPPED. A
              null with an error beside it is a rule that cannot read its
              document; a null with no error is a rule nothing has asked yet. */}
          {rule.lastError ? (
            <span className="text-destructive">unreadable</span>
          ) : rule.lastValue !== null ? (
            <>reads {rule.lastValue}</>
          ) : (
            "not read yet"
          )}
          {rule.lastEvaluatedAt && ` · ${ago(rule.lastEvaluatedAt)}`}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {!rule.managedSource && <><IconButton title="Read it now" onClick={onTest}>
            <Play className="size-3.5" strokeWidth={1.6} />
          </IconButton>
          <button
            onClick={onEdit}
            className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-[8px] px-1.5 py-1 text-[12.5px]"
          >
            {editing ? "Close" : "Edit"}
          </button></>}
          {rule.managedSource && <Link to="/insights" className="px-2 text-xs text-muted-foreground">Anomaly settings</Link>}
          <IconButton title="Delete this rule and its events" onClick={onDelete}>
            <Trash2 className="size-3.5" strokeWidth={1.6} />
          </IconButton>
        </div>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 pl-[46px] font-mono text-[12.5px]">
        {sentence(rule)}
        {!rule.managedSource && (rule.forMinutes > 0 || rule.consecutive > 1) && <span>· persists {rule.forMinutes}m and {rule.consecutive} checks</span>}
        {rule.pendingSince && <span>· condition present since {ago(rule.pendingSince)} ({rule.pendingHits} checks)</span>}
      </div>

      {rule.lastError && (
        <p className="text-destructive pl-[46px] text-[12.5px]">{rule.lastError}</p>
      )}

      {tested !== undefined && (
        <p className="pl-[46px] text-[12.5px]">
          {typeof tested === "string" ? (
            <span className="text-destructive">{tested}</span>
          ) : !tested.readable ? (
            <span className="text-destructive">{tested.why}</span>
          ) : (
            <span className="text-muted-foreground">
              Read {tested.value}
              {tested.undecidable
                ? ` — ${tested.undecidable}, so it cannot be judged yet.`
                : tested.wouldTrip
                  ? " — this would trip."
                  : " — this would not trip."}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="text-muted-foreground hover:bg-accent hover:text-foreground grid place-items-center rounded-[8px] p-1.5"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ events */

function Events({ onChanged, tick }: { onChanged: () => void; tick: number }) {
  const undo = useUndoActions();
  const [status, setStatus] = useState("all");
  const [days, setDays] = useState(30);
  const [offset, setOffset] = useState(0);
  const [own, setOwn] = useState(0);
  const doc = useApi(
    () => alertsApi.events({ days, limit: 50, offset, open: status === "unseen", status: status === "active" || status === "recovered" ? status : undefined }),
    [status, days, offset, own, tick],
  );
  const events = doc.data?.events ?? [];

  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Incident history
        </div>
        <div className="ml-auto flex flex-wrap gap-2 text-xs">
          <SelectField aria-label="Incident status" className="bg-background rounded border p-1" value={status} onValueChange={(value) => { setStatus(value); setOffset(0); }}><SelectOption value="all">All events</SelectOption><SelectOption value="active">Active incidents</SelectOption><SelectOption value="unseen">Active, unacknowledged</SelectOption><SelectOption value="recovered">Recovered incidents</SelectOption></SelectField>
          <SelectField aria-label="Incident history period" className="bg-background rounded border p-1" value={days} onValueChange={(value) => { setDays(Number(value)); setOffset(0); }}><SelectOption value={14}>14 days</SelectOption><SelectOption value={30}>30 days</SelectOption><SelectOption value={90}>90 days</SelectOption><SelectOption value={400}>400 days</SelectOption></SelectField>
        </div>
      </div>

      {doc.error ? (
        <p className="text-muted-foreground text-[14px]">
          The events could not be read.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      ) : !events.length ? (
        <p className="text-muted-foreground text-[14px]">
          {doc.loading
            ? "Reading the ledger…"
            : "No incidents match this period and status."}
        </p>
      ) : (
        <div className="flex flex-col">
          {events.map((e) => (
            <EventRow
              key={e.id}
              event={undo.handled.has(`alert:${e.id}`) ? { ...e, acknowledgedAt: new Date().toISOString() } : e}
              onAck={() => {
                void undo.perform({ key: `alert:${e.id}`, label: "Alert acknowledged", run: () => alertsApi.ack(e.id), refresh: () => { setOwn(n => n + 1); onChanged(); } });
              }}
            />
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-3 text-xs"><button disabled={offset === 0} className="disabled:opacity-40" onClick={() => setOffset(Math.max(0, offset - 50))}>Newer events</button><button disabled={events.length < 50} className="disabled:opacity-40" onClick={() => setOffset(offset + 50)}>Older events</button></div>
    </section>
  );
}

const KIND_WORD: Record<AlertEvent["kind"], string> = {
  trip: "tripped",
  unreadable: "could not be read",
  test: "tested by hand",
};

function EventRow({ event, onAck }: { event: AlertEvent; onAck: () => void }) {
  return (
    <div className="border-line-soft flex flex-col gap-1 border-b py-2.5 last:border-b-0">
      <div className="grid grid-cols-[6px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-2 sm:grid-cols-[6px_minmax(0,1fr)_auto]">
        {/* The dot says which of the three kinds this is, and the word beside
            it says it in words — a colour alone would make "could not be read"
            and "tripped" a thing to decode. */}
        <span
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            event.clearedAt ? "bg-chart-1" : event.kind === "trip"
              ? "bg-warn"
              : event.kind === "unreadable"
                ? "bg-destructive"
                : "bg-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 break-words text-[14px]">{event.context?.title ?? event.ruleName ?? `rule ${event.ruleId}`}</span>
            <span className="text-muted-foreground text-[12.5px]">
              {event.clearedAt ? "recovered · opened" : KIND_WORD[event.kind]} · {ago(event.ts)}
            </span>
            {event.acknowledgedAt && (
              <span className="text-muted-foreground text-[12.5px]">· acknowledged</span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-[13.5px] leading-[1.5]">
            {event.context?.summary ?? event.message}
          </p>
          {event.clearedAt && <p className="mt-1 text-xs text-muted-foreground">Cleared {ago(event.clearedAt)} · {event.recoveryMessage}</p>}
          {event.context && event.context.apps.length > 0 && (
            <ul className="mt-2 space-y-1 text-[12.5px] leading-[1.5]">
              {event.context.apps.map(app => (
                <li key={`${app.store}:${app.app}`} className="break-words">
                  <span title={app.app}>{app.name}</span>
                  {app.store && <span className="text-muted-foreground"> · {app.store === "play" ? "Android" : app.store === "appstore" ? "iOS" : app.store}</span>}
                  {app.reason && <span className="text-muted-foreground"> — {app.reason}</span>}
                </li>
              ))}
            </ul>
          )}
          {event.context?.summary && (
            <AnimatedDetails className="text-muted-foreground mt-2 text-[12px]">
              <summary className="cursor-pointer">Rule details</summary>
              <p className="mt-1">{event.ruleName}</p>
              <p className="mt-0.5 break-words">{event.message}</p>
            </AnimatedDetails>
          )}
          {/* THE NARRATION, AND THE HONEST ABSENCE OF ONE. A model wrote the
              first from figures that were read; the second says why there is
              none. Neither is ever filled in from memory. */}
          {event.narration ? (
            <p className="border-line-soft mt-1.5 border-l-2 pl-2.5 text-[13.5px] leading-[1.55]">
              {event.narration}
            </p>
          ) : event.narrationNote ? (
            <p className="text-muted-foreground mt-1.5 text-[12.5px]">
              No narration — {event.narrationNote}
            </p>
          ) : null}
        </div>
        {event.kind !== "test" && !event.acknowledgedAt && !event.clearedAt && (
          <button
            onClick={onAck}
            title="Mark as seen. The rule keeps watching."
            className="text-muted-foreground hover:bg-accent hover:text-foreground col-start-2 flex items-center gap-1 justify-self-start rounded-[8px] px-1.5 py-1 text-[12.5px] sm:col-start-3 sm:row-start-1 sm:justify-self-end"
          >
            <Check className="size-3.5" strokeWidth={1.6} />
            Acknowledge
          </button>
        )}
      </div>
    </div>
  );
}
