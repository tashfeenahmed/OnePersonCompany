import { useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { pct } from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { announceAlerts } from "@/hooks/useOpenAlerts";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { briefingApi, type Briefing, type BriefingFacts } from "@/lib/api/proactive";

/**
 * THE BRIEFING, AND UNDER IT THE FACTS IT WAS MADE FROM.
 *
 * THE FACTS ARE ON THE PAGE ON PURPOSE, and it is the only interesting
 * decision here. A daily digest written by a model is the easiest place in a
 * product like this to end up with confident paragraphs that nobody can check.
 * The server stores the assembled facts in the same row as the prose; this
 * draws both, so any sentence can be traced to a figure that was read — and a
 * sentence with nothing behind it is visible as such.
 *
 * A BRIEFING WITH NO PROSE IS STILL A BRIEFING. When no model provider is
 * connected the markdown is empty and a note says so; the facts are the half
 * that is always real, and they are shown exactly as they would be otherwise.
 *
 * IT IS RENDERED WITH THE SAME `Markdown` THE CHAT USES, which means the rich
 * blocks the model was asked to write — cards, bars, tables — are drawn here
 * as widgets rather than as fenced code.
 */

export function BriefingPanel() {
  const [tick, setTick] = useState(0);
  const doc = useApi(() => briefingApi.latest(), [tick]);
  const settings = useApi(() => briefingApi.settings(), [tick]);
  const [building, setBuilding] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const b = doc.data?.briefing ?? null;
  const s = settings.data ?? null;

  function buildNow() {
    setBuilding(true);
    setSaid(null);
    void briefingApi
      .now()
      .then((r) =>
        setSaid(
          `Built ${r.briefing.day} · ` +
            (r.delivery.chat ? "filed in the briefing chat" : "not filed in the chat") +
            (r.delivery.telegram
              ? " · pushed to Telegram"
              : r.delivery.note
                ? ` · ${r.delivery.note}`
                : ""),
        ),
      )
      .catch((e: unknown) => setSaid(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBuilding(false);
        setTick((n) => n + 1);
        announceAlerts();
      });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Button
          onClick={buildNow}
          disabled={building}
          className="h-8 gap-2 text-[13.5px]"
        >
          <RefreshCw className={cn("size-3.5", building && "animate-spin")} strokeWidth={1.6} />
          {building ? "Building…" : "Build now"}
        </Button>
        {s && (
          <span className="text-muted-foreground text-[12.5px]">
            Scheduled for {String(s.hour).padStart(2, "0")}:00 {s.timezone} ·{" "}
            {s.telegram ? "pushed to Telegram" : "not pushed to Telegram"} ·{" "}
            <Link to="/integrations/briefing" className="hover:text-foreground underline">
              settings
            </Link>
          </span>
        )}
      </div>

      {said && <p className="text-muted-foreground mb-3 text-[13px]">{said}</p>}

      {doc.error ? (
        <p className="text-muted-foreground text-[14px]">
          The briefing could not be read.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      ) : !b ? (
        <p className="text-muted-foreground text-[14px]">
          {doc.loading
            ? "Reading the latest briefing…"
            : (doc.data?.note ??
              "No briefing has been built yet.")}
        </p>
      ) : (
        <>
          <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-2 text-[12.5px]">
            <span className="text-foreground text-[14px]">{b.day}</span>
            <span>· built {ago(b.builtAt)}</span>
            {/* WHICH MODEL WROTE IT, always said. A reader is entitled to know
                whose sentences these are, and null is "nobody wrote them". */}
            <span>· {b.model ? `written by ${b.model}` : "no model wrote it"}</span>
            <span>
              ·{" "}
              {b.delivered.chat ? (
                <Link to="/chat/briefing" className="hover:text-foreground underline">
                  in the briefing chat
                </Link>
              ) : (
                "not filed in the chat"
              )}
            </span>
            {b.delivered.telegram && <span>· pushed to Telegram</span>}
          </div>

          {b.markdown.trim() ? (
            <Markdown text={b.markdown} />
          ) : (
            <p className="text-muted-foreground text-[14px]">
              {b.note ?? "No write-up was produced."} The facts below were still
              assembled and are what the write-up would have been made from.
            </p>
          )}

          <Facts facts={b.facts} />
        </>
      )}
    </div>
  );
}

/**
 * WHAT THE PROSE WAS MADE FROM.
 *
 * Every section says one of three things and never a fourth: it was switched
 * off, it had nothing in it and here is why, or here is what was in it. A
 * section that had nothing is deliberately not hidden — "the board had nothing
 * due" is a fact somebody wants, and an absent section would make it
 * indistinguishable from a section that failed.
 */
function Facts({ facts }: { facts: BriefingFacts }) {
  if (!facts?.day) return null;
  return (
    <details className="border-line-soft mt-6 rounded-[14px] border">
      <summary className="text-muted-foreground cursor-pointer px-3.5 py-2.5 text-[13px]">
        The facts this was built from — read {facts.since ? `since ${facts.since.slice(0, 16).replace("T", " ")}` : ""}
      </summary>
      <div className="border-line-soft flex flex-col gap-3.5 border-t px-3.5 py-3">
        <Section title="Alerts" included={facts.alerts?.included} note={facts.alerts?.note}>
          {facts.alerts?.trips?.length || facts.alerts?.unreadable?.length ? (
            <ul className="flex flex-col gap-1">
              {facts.alerts.trips?.map((t, i) => (
                <li key={`t${i}`} className="text-[13px] leading-[1.5]">
                  <span className="text-muted-foreground">{t.ts.slice(11, 16)} </span>
                  {t.message}
                </li>
              ))}
              {facts.alerts.unreadable?.map((u, i) => (
                <li key={`u${i}`} className="text-destructive text-[13px] leading-[1.5]">
                  <span className="opacity-70">{u.ts.slice(11, 16)} </span>
                  {u.rule} — could not be read: {u.message}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing was raised.</Empty>
          )}
          {facts.alerts?.openTotal !== null && facts.alerts?.openTotal !== undefined && (
            <Empty>{facts.alerts.openTotal} still unacknowledged.</Empty>
          )}
        </Section>

        <Section title="What moved, over 24 hours" included={facts.movement?.included} note={facts.movement?.note}>
          {facts.movement?.skills?.length ? (
            <div className="flex flex-col gap-2">
              {facts.movement.skills.map((sk) => (
                <div key={sk.skill}>
                  <div className="text-muted-foreground text-[12px] tracking-[0.04em] uppercase">
                    {sk.skill}
                  </div>
                  <ul className="mt-0.5 flex flex-col gap-px">
                    {sk.moved.map((m) => (
                      <li key={m.path} className="font-mono text-[12.5px] tabular-nums">
                        <span className="text-muted-foreground">{m.path}</span>{" "}
                        {m.before} → {m.after}
                        {m.changePct !== null && (
                          <span className="text-muted-foreground">
                            {" "}
                            ({m.changePct > 0 ? "+" : ""}
                            {pct(m.changePct / 100)})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </Section>

        <Section title="Runs that finished" included={facts.runs?.included} note={facts.runs?.note}>
          {facts.runs?.finished?.length ? (
            <ul className="flex flex-col gap-px">
              {facts.runs.finished.slice(0, 20).map((r) => (
                <li key={r.id} className="text-[13px]">
                  <span className="text-muted-foreground">{r.status}</span> · {r.title}
                  {r.venture ? ` · ${r.venture}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>None finished in the window.</Empty>
          )}
        </Section>

        <Section title="Board" included={facts.board?.included} note={facts.board?.note}>
          {facts.board?.overdue?.length || facts.board?.dueSoon?.length ? (
            <ul className="flex flex-col gap-px">
              {facts.board.overdue?.map((c, i) => (
                <li key={`o${i}`} className="text-[13px]">
                  <span className="text-destructive">overdue {c.due}</span> · {c.title}
                  {c.venture ? ` · ${c.venture}` : ""}
                </li>
              ))}
              {facts.board.dueSoon?.map((c, i) => (
                <li key={`d${i}`} className="text-[13px]">
                  <span className="text-muted-foreground">due {c.due}</span> · {c.title}
                  {c.venture ? ` · ${c.venture}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section title="Ventures" included={facts.ventures?.included} note={facts.ventures?.note}>
          {facts.ventures?.lines?.length ? (
            <ul className="flex flex-col gap-px">
              {facts.ventures.lines.map((v) => (
                <li key={v.id} className="text-[13px]">
                  {v.name}{" "}
                  <span className="text-muted-foreground">
                    · {v.stage} · {v.openAlerts} open alert
                    {v.openAlerts === 1 ? "" : "s"} · {v.runsFinished} run
                    {v.runsFinished === 1 ? "" : "s"} finished
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      </div>
    </details>
  );
}

function Section({
  title,
  included,
  note,
  children,
}: {
  title: string;
  included: boolean | undefined;
  note: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[13.5px] font-medium">{title}</div>
      {included === false ? (
        /* SWITCHED OFF IS NOT EMPTY. Saying "nothing" here would be a claim
           about the business made by a setting. */
        <Empty>Switched off in settings, so nobody asked.</Empty>
      ) : (
        <>
          {children}
          {note && <Empty>{note}</Empty>}
        </>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-[12.5px] leading-[1.5]">{children}</p>;
}

export type { Briefing };
