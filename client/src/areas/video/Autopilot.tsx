import { useState } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, CircleSlash, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StagePill } from "@/components/VentureChrome";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/live";
import type { VentureStage } from "@/lib/api";
import { autopilotApi, type AutopilotDoc, type AutopilotEntry } from "@/lib/api/video";
import { cn } from "@/lib/utils";

/**
 * THE AUTOPILOT PAGE — what is scheduled, what it has done, and why it did
 * nothing.
 *
 * THE THIRD QUESTION IS THE ONE THIS PAGE EXISTS FOR. A schedule that is
 * working correctly looks identical, from the outside, to one that is broken:
 * in both cases nothing happened. So the log is the biggest thing here and it
 * draws SKIPS as prominently as it draws work — a quiet stage, a cadence
 * already met, a day's cap already spent are the three most common lines and
 * each says which. A page that only listed what was made would answer "why is
 * there no video for Example App 1" with an empty table.
 *
 * THE THREE ACTIONS ARE THREE COLOURS AND NEVER TWO. `queued` is work that now
 * exists. `skipped` is a rule being obeyed and is drawn in the muted tone,
 * because it is not a problem. `failed` is the only one that gets the
 * destructive colour. Folding skipped into failed would turn a correctly quiet
 * week into an outage on screen.
 *
 * NOTHING ON THIS PAGE PUBLISHES ANYTHING, and it says so where somebody
 * reading a schedule would expect to find out otherwise. That sentence is not
 * decoration: "an automation that posts for you" is what a page like this
 * usually is, and this one is deliberately not.
 *
 * THE SETTINGS ARE SHOWN AND NOT EDITED HERE. They are plugin config, they
 * live behind the checked settings registry every other setting on this box
 * uses, and duplicating the form would be a second place for a bad value to
 * get in. The page shows what they resolve to and links to the page that
 * changes them.
 */
export function Autopilot() {
  const doc = useApi(() => autopilotApi.read(), []);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  async function now() {
    setBusy(true);
    setSaid(null);
    try {
      const res = await autopilotApi.runNow();
      setSaid(res.ran ? res.why : `Nothing ran. ${res.why}`);
      doc.reload();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const d = doc.data;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
      <div className="mx-auto w-full max-w-[940px]">
        <div className="mt-2 mb-6">
          <h1 className="mb-1 text-[25px] font-normal tracking-[-0.025em]">Autopilot</h1>
          <p className="text-muted-foreground text-[13.5px]">
            Once a day it queues Studio posts and videos for each venture, up to
            a cadence you set. It never publishes any of it — a post lands in the{" "}
            <Link to="/social/studio" className="underline decoration-dotted">
              Studio gallery
            </Link>{" "}
            and a video on its{" "}
            <Link to="/social/video" className="underline decoration-dotted">
              run page
            </Link>
            , for you.
          </p>
        </div>

        {doc.error && (
          <p className="text-muted-foreground mb-4 text-[13px]">
            The autopilot API did not answer.{" "}
            <span className="text-destructive">{doc.error}</span>
          </p>
        )}
        {!d && !doc.error && <p className="text-muted-foreground text-[13px]">Reading the schedule…</p>}

        {d && (
          <>
            <Schedule doc={d} />

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Button disabled={busy} onClick={() => void now()}>
                {busy ? (
                  <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />
                ) : (
                  <Play className="size-[15px]" strokeWidth={1.8} />
                )}
                Run a pass now
              </Button>
              <span className="text-muted-foreground text-[12px]">
                {busy
                  ? "Writing captions and pictures takes about twenty seconds each."
                  : "The same pass the clock runs, with the same limits. It spends Replicate credit and Pexels quota."}
              </span>
            </div>
            {said && <p className="mt-2 text-[12.5px]">{said}</p>}

            {/* --------------------------------------------- the ventures */}
            <div className="mt-7 mb-2 text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
              This week, per venture
            </div>
            {d.ventures.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                There are no ventures yet, and the autopilot works venture by venture.
              </p>
            ) : (
              <div className="flex flex-col gap-px">
                {d.ventures.map((v) => (
                  <div
                    key={v.id}
                    className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1 text-[12.5px]"
                  >
                    <span className="min-w-[150px] flex-1 truncate">{v.name}</span>
                    {/* The wire type is a string because the route sends the
                        column; the three the pill knows are the three the
                        column is checked against, and anything else is drawn
                        as plain text rather than as a pill it cannot colour. */}
                    {isStage(v.stage) ? (
                      <StagePill stage={v.stage} />
                    ) : (
                      <span className="text-muted-foreground text-[11.5px]">{v.stage}</span>
                    )}
                    {v.quiet ? (
                      <span className="text-muted-foreground text-[11.5px]">
                        skipped — “{v.stage}” is on the quiet list
                      </span>
                    ) : (
                      <>
                        <Tally label="posts" made={v.posts.made} cadence={v.posts.cadence} />
                        <Tally label="videos" made={v.videos.made} cadence={v.videos.cadence} />
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="text-muted-foreground mt-1.5 text-[11.5px]">
              Counted over the last seven days, rolling — not a calendar week. Only
              what the autopilot queued itself is counted: a post you made by hand
              does not use up the cadence.
            </p>

            {/* -------------------------------------------------- the log */}
            <div className="mt-7 mb-2 text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
              Every decision it has taken
            </div>
            {d.log.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                It has never run. {d.schedule.enabled ? "The next pass is above." : "It is switched off."}
              </p>
            ) : (
              <div className="flex flex-col gap-px">
                {d.log.map((e) => (
                  <LogLine key={e.id} entry={e} />
                ))}
              </div>
            )}
            <p className="text-muted-foreground mt-2 text-[11.5px] leading-relaxed">{d.note}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Tally({ label, made, cadence }: { label: string; made: number; cadence: number }) {
  return (
    <span
      className={cn(
        "text-[11.5px]",
        cadence === 0 ? "text-muted-foreground" : made >= cadence ? "text-muted-foreground" : "",
      )}
    >
      {cadence === 0 ? `no ${label}` : `${made}/${cadence} ${label}`}
    </span>
  );
}

function Schedule({ doc }: { doc: AutopilotDoc }) {
  const s = doc.schedule;
  const rows: { key: string; ready: boolean; title: string; note: string; fix?: { to: string; label: string } }[] = [
    {
      key: "switch",
      ready: s.enabled,
      title: s.enabled
        ? `On — ${String(s.hour).padStart(2, "0")}:00 ${s.timezone}`
        : "Switched off",
      note: s.enabled
        ? doc.nextRunAt
          ? `Next pass ${ago(doc.nextRunAt)}. It is ${String(doc.now.local.hour).padStart(2, "0")}:00 there now.`
          : "On, but no next pass could be worked out."
        : "Nothing is queued while it is off. `nextRunAt` is null, which means off rather than unknown.",
      fix: { to: "/integrations/autopilot", label: s.enabled ? "Settings" : "Turn it on" },
    },
    {
      key: "cadence",
      ready: s.postsPerVenturePerWeek > 0 || s.videosPerVenturePerWeek > 0,
      title:
        s.postsPerVenturePerWeek + s.videosPerVenturePerWeek === 0
          ? "Both cadences are zero"
          : `${s.postsPerVenturePerWeek} posts and ${s.videosPerVenturePerWeek} videos per venture per week`,
      note:
        s.postsPerVenturePerWeek + s.videosPerVenturePerWeek === 0
          ? "So a pass queues nothing, even switched on. Set a cadence in the settings."
          : `At most ${s.dailyCap} things in any one day across every venture, and videos are not added while the run queue already has work waiting.`,
      fix:
        s.postsPerVenturePerWeek + s.videosPerVenturePerWeek === 0
          ? { to: "/integrations/autopilot", label: "Set a cadence" }
          : undefined,
    },
    {
      key: "model",
      ready: doc.ready.model !== null,
      title: doc.ready.model ? `Topics from ${doc.ready.model}` : "No model provider is live",
      note: doc.ready.note,
      fix: doc.ready.model ? undefined : { to: "/settings", label: "Choose a provider" },
    },
  ];

  return (
    <div className="bg-card grid gap-2.5 rounded-[10px] border p-3.5">
      {rows.map((r) => (
        <div key={r.key} className="flex gap-2.5">
          {r.ready ? (
            <CircleCheck className="text-ok mt-[2px] size-[14px] shrink-0" strokeWidth={1.8} />
          ) : (
            <CircleSlash className="text-muted-foreground mt-[2px] size-[14px] shrink-0" strokeWidth={1.8} />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px]">{r.title}</div>
            <div className="text-muted-foreground text-[11.5px] leading-relaxed">{r.note}</div>
          </div>
          {r.fix && (
            <Link
              to={r.fix.to}
              className="text-muted-foreground hover:text-foreground shrink-0 text-[11.5px] underline decoration-dotted"
            >
              {r.fix.label}
            </Link>
          )}
        </div>
      ))}
      {s.quietStages.length > 0 && s.quietStages[0] !== "none" && (
        <div className="text-muted-foreground text-[11.5px]">
          Ventures at stage {s.quietStages.join(" or ")} are skipped whatever the cadence says.
        </div>
      )}
    </div>
  );
}

function LogLine({ entry }: { entry: AutopilotEntry }) {
  const to =
    entry.kind === "video" && entry.ref
      ? `/social/video/${entry.ref}`
      : entry.kind === "post" && entry.ref
        ? `/social/studio`
        : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5 text-[12px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          entry.action === "queued"
            ? "bg-ok"
            : entry.action === "failed"
              ? "bg-destructive"
              : "bg-line-strong",
        )}
      />
      <span className="text-muted-foreground w-[76px] shrink-0 text-[11.5px]">
        {ago(entry.ts)}
      </span>
      <span className="w-[100px] shrink-0 truncate">{entry.ventureName ?? "—"}</span>
      <span className="text-muted-foreground w-[52px] shrink-0 text-[11.5px]">{entry.kind}</span>
      <span
        className={cn(
          "w-[58px] shrink-0 text-[11.5px]",
          entry.action === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {entry.action}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 text-[11.5px]">
        {entry.note}
        {to && (
          <>
            {" "}
            <Link to={to} className="hover:text-foreground underline decoration-dotted">
              open
            </Link>
          </>
        )}
      </span>
    </div>
  );
}

const isStage = (s: string): s is VentureStage =>
  s === "idea" || s === "pre-launch" || s === "launched";
