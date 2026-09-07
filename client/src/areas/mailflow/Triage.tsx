import { Link } from "react-router-dom";
import { useState } from "react";
import { Check, Clock, Loader2, RefreshCw } from "lucide-react";
import { ago, when } from "@/lib/format";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import {
  mailflowApi,
  type TriageDoc,
  type TriageThread,
} from "@/lib/api/mailflow";

/**
 * TRIAGE — the inbox re-ordered by what the mail IS rather than when it came.
 *
 * FIVE GROUPS, AND THE FIFTH IS THE HONEST ONE. Four are the model's
 * categories; `unscored` is every thread it has not read — arrived since the
 * last pass, or a pass with no provider behind it. It is drawn LAST but it is
 * drawn, with its own count and its own sentence, because a page that quietly
 * folded those into "noise" would be hiding mail on the grounds that nobody
 * had looked at it. That is the one failure this screen is built to make
 * impossible.
 *
 * EVERY CATEGORY CARRIES ITS REASON ON THE ROW. Not in a tooltip and not
 * behind a click: the category is a guess made from a subject line and 180
 * characters of snippet, and a guess shown without its argument is an oracle.
 * Where the model's venture guess was used rather than a domain match, the tag
 * says "guess" — a venture matched by host is a fact and the two must not look
 * the same.
 *
 * DONE AND SNOOZE CHANGE THIS LIST AND NOTHING IN GMAIL. That is written under
 * the header rather than left to be discovered, because every other button
 * that looks like this one — in Gmail, in every mail client — archives
 * something.
 *
 * THE PAGE COSTS A GMAIL ROUND TRIP PER THREAD, which is why it loads fifty
 * and says so. The mail itself is never stored on this box: only the
 * judgement is, and the subject lines below arrive live and are forgotten.
 */

const GROUPS: { key: string; label: string; hint: string; tone: string }[] = [
  {
    key: "needs_reply",
    label: "Needs a reply",
    hint: "Somebody is waiting on you.",
    tone: "bg-destructive",
  },
  {
    key: "waiting_on_them",
    label: "Waiting on them",
    hint: "You have answered; the ball is on the other side.",
    tone: "bg-warn",
  },
  {
    key: "fyi",
    label: "Worth knowing",
    hint: "Real, but nobody is waiting.",
    tone: "bg-ok",
  },
  { key: "noise", label: "Noise", hint: "You would never answer these.", tone: "bg-muted" },
  {
    key: "unscored",
    label: "Not scored",
    hint: "The model has not read these. That is not a verdict of noise.",
    tone: "bg-muted",
  },
];

function Row({
  t,
  busy,
  onDone,
  onSnooze,
}: {
  t: TriageThread;
  busy: boolean;
  onDone: () => void;
  onSnooze: () => void;
}) {
  return (
    <div className="border-line-soft group flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-[14.5px]",
              t.unread ? "font-medium" : "text-foreground/90",
            )}
          >
            {t.subject || "(no subject)"}
          </span>
          {t.messages > 1 && (
            <span className="text-muted-foreground shrink-0 text-[12.5px]">
              ({t.messages})
            </span>
          )}
        </div>

        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
          <span className="truncate">{t.fromName || t.from || "unknown sender"}</span>
          <Link className="underline" to={`/mail/email?thread=${encodeURIComponent(t.id)}&account=${t.accountId}`}>Open</Link>
          <Link className="underline" to="/mail/outbox" state={{ reply: { to: t.from, subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`, account: t.accountId, thread: t.id, venture: t.venture, back: "/mail/triage" } }}>Draft reply</Link>
          <span>·</span>
          <span>{ago(t.at, { nullText: "no date" })}</span>
          {t.urgency && t.urgency !== "normal" && (
            <>
          <span>·</span>
          <span className={t.urgency === "high" ? "text-destructive" : ""}>
            {t.urgency} urgency
          </span>
            </>
          )}
          {t.ventureName && (
            <>
              <span>·</span>
              {/* A host match is a fact; a model match is a guess. They must
                  not look the same. */}
              <span className="border-line-soft rounded border px-1 py-px">
                {t.ventureName}
                {t.ventureBy === "model" && (
                  <span className="text-muted-foreground/70"> · guess</span>
                )}
              </span>
            </>
          )}
          {t.stale && (
            <>
              <span>·</span>
              <span className="text-warn">
                replied to since it was scored — the reason is out of date
              </span>
            </>
          )}
        </div>

        {t.reason ? (
          <p className="text-muted-foreground mt-1 text-[13.5px] italic">{t.reason}</p>
        ) : (
          <p className="text-muted-foreground/70 mt-1 text-[13.5px] italic">
            Not scored — the model has not read this thread.
          </p>
        )}
        <p className="text-muted-foreground/60 mt-0.5 line-clamp-1 text-[12.5px]">
          {t.snippet}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button size="xs" variant="ghost" disabled={busy} onClick={onSnooze} title="Hide for a day. Nothing changes in Gmail.">
          <Clock /> Snooze
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={onDone} title="Take it off this list. Nothing changes in Gmail.">
          <Check /> Done
        </Button>
      </div>
    </div>
  );
}

export function Triage() {
  const doc = useApi<TriageDoc>(() => mailflowApi.triage(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  async function act(threadId: string, what: "done" | "snooze") {
    setBusy(threadId);
    setRefused(null);
    try {
      if (what === "done") await mailflowApi.done(threadId, { account: doc.data?.account.id });
      else await mailflowApi.snooze(threadId, { days: 1, account: doc.data?.account.id });
      /* The row leaves the list without a refetch: a refetch is fifty Gmail
         round trips to redraw a list that lost one row. */
      doc.setData((d) => {
        if (!d) return d;
        const groups = Object.fromEntries(
          Object.entries(d.groups).map(([k, v]) => [k, v.filter((t) => t.id !== threadId)]),
        );
        return { ...d, groups };
      });
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function scan() {
    setScanning(true);
    setRefused(null);
    try {
      const run = await mailflowApi.runTriage({});
      if (run.error) setRefused(run.error);
      doc.reload();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  const d = doc.data;

  return (
    <PageShell
      title="Triage"
      sub={
        <>
          {d
            ? `${d.window.threads} threads from the last ${d.window.days} days of ${d.account.label ?? "the inbox"}, sorted by what they are. Done and Snooze change this list and nothing in Gmail.`
            : "The last few days of the inbox, sorted by what needs you."}
        </>
      }
      action={
        <Button size="sm" variant="outline" onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {scanning ? "Scoring…" : "Score new mail"}
        </Button>
      }
    >
      {doc.error && (
        <p className="text-muted-foreground mb-4 text-[14px]">
          The inbox could not be read.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      )}
      {refused && (
        <p className="text-destructive mb-4 text-[14px]">{refused}</p>
      )}

      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Reading the inbox. Every thread is its own Gmail request, so fifty of
          them take a few seconds.
        </p>
      )}

      {d && (
        <>
          {/* The last pass, stated. Figures of unknown age are worse than no
              figures: a category made an hour ago describes an hour-old
              inbox. */}
          <p className="text-muted-foreground mb-5 text-[12.5px]">
            {d.lastRun
              ? `Last scored ${when(d.lastRun.ranAt, { year: true })} — ${d.lastRun.note ?? ""}${d.lastRun.error ? ` · ${d.lastRun.error}` : ""}`
              : "Nothing has been scored yet. The pass runs by itself every half hour, or press Score new mail."}
            {d.counts.unscored > 0 &&
              ` · ${d.counts.unscored} thread${d.counts.unscored === 1 ? "" : "s"} on this page ${d.counts.unscored === 1 ? "has" : "have"} not been read by the model.`}
          </p>

          {GROUPS.map((g) => {
            const items = d.groups[g.key] ?? [];
            if (!items.length) return null;
            return (
              <section key={g.key} className="mb-6">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className={cn("size-2 rounded-full", g.tone)} />
                  <h2 className="text-[15px] font-medium tracking-tight">{g.label}</h2>
                  <span className="text-muted-foreground text-[12.5px]">
                    {items.length} · {g.hint}
                  </span>
                </div>
                <div className="bg-card border-line-soft rounded-xl">
                  {items.map((t) => (
                    <Row
                      key={t.id}
                      t={t}
                      busy={busy === t.id}
                      onDone={() => void act(t.id, "done")}
                      onSnooze={() => void act(t.id, "snooze")}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {!GROUPS.some((g) => (d.groups[g.key] ?? []).length) && (
            <p className="text-muted-foreground text-[14px]">
              Nothing on this list. {d.counts.done} done and {d.counts.snoozed}{" "}
              snoozed are hidden; both are still in Gmail.
            </p>
          )}

          <p className="text-muted-foreground/70 mt-8 text-[12.5px] leading-relaxed">
            {d.note}
          </p>
        </>
      )}
    </PageShell>
  );
}
