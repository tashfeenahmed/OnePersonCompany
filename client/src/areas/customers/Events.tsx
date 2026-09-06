import { useState } from "react";
import { BellOff, Send } from "lucide-react";
import { WindowPicker } from "@/components/WindowPicker";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { customersApi, type BusinessEvent } from "@/lib/api/customers";
import { Empty, Notes, Problem, Stats } from "./Customers";

/**
 * EVENTS — and the column nobody else on this dashboard has: whether the owner
 * was actually told.
 *
 * THE DELIVERY LINE IS NEVER A TICK OR A CROSS. Four different things stop a
 * message and they are not interchangeable — a backlog from before the cursor
 * existed, a collapse of repeated failures for one customer, an aggregate
 * alert that already covered the class, and a muted type — so the row prints
 * the server's own sentence. A row that was ATTEMPTED and refused is the only
 * one drawn as a failure, and it keeps its attempt count.
 *
 * MUTING IS PER TYPE AND IS DRAWN BESIDE THE COUNT, because the decision the
 * owner is making is "I do not want to hear about this KIND of thing", and the
 * count is how they judge it.
 */

export function EventsTab({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [days, setDays] = useState(7);
  const [onlyUndelivered, setOnlyUndelivered] = useState(false);
  const q = useApi(() => customersApi.events({ days, limit: 200 }), [days, tick]);
  const u = useApi(() => customersApi.undelivered(), [tick]);
  const d = q.data;

  const stats: [string, string][] = [
    [d ? String(d.counts.inWindow) : "—", `events in ${days}d`],
    [d ? String(d.counts.delivered) : "—", "delivered"],
    [d ? String(d.counts.suppressed) : "—", "suppressed"],
    [u.data ? String(u.data.counts.total) : "—", "waiting"],
  ];

  const rows = onlyUndelivered ? (u.data?.items ?? []) : (d?.items ?? []);

  return (
    <>
      <Stats items={stats} />

      {d && !d.settings.telegram && (
        <div className="border-line-soft text-muted-foreground mb-4 rounded-[10px] border px-3.5 py-2.5 text-[12.5px]">
          Pushing to Telegram is off, so nothing here becomes a message. Events are still
          collected, deduplicated and readable on this page. Turn it on under Integrations →
          Customers.
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-0.5">
        {/* WAITING ONLY IS NOT A WINDOW. It cuts across every span, so it sits
            beside the picker rather than inside it — and choosing a span
            switches it off, because "the last day, of the waiting ones" is a
            question neither control was asked. */}
        <WindowPicker
          value={onlyUndelivered ? -1 : days}
          onChange={(w) => {
            setDays(Number(w));
            setOnlyUndelivered(false);
          }}
          options={[1, 7, 30]}
        />
        <button
          onClick={() => setOnlyUndelivered((v) => !v)}
          className={cn(
            "text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2.5 py-1.5 text-[12.5px]",
            onlyUndelivered && "bg-accent text-foreground font-medium",
          )}
        >
          Waiting only
        </button>
        {d && (
          <span className="text-muted-foreground ml-auto text-[11.5px]">
            quiet hours {d.settings.quietHours ?? "off"} · {d.settings.timezone} · collapse{" "}
            {d.settings.collapseMinutes}m
          </span>
        )}
      </div>

      {d && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {d.watched.map((t) => {
            const muted = d.settings.mutedTypes.includes(t);
            return (
              <button
                key={t}
                onClick={() => {
                  void (muted ? customersApi.unmute(t) : customersApi.mute(t)).finally(onChanged);
                }}
                title={muted ? "Muted — click to let it produce messages again" : "Click to mute this type"}
                className={cn(
                  "border-line-soft text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px]",
                  muted && "opacity-50",
                )}
              >
                {muted && <BellOff className="size-3" strokeWidth={1.6} />}
                {t}
                <span className="tabular-nums opacity-60">{d.counts.byType[t] ?? 0}</span>
              </button>
            );
          })}
        </div>
      )}

      {q.error && <Problem error={q.error} />}
      {!q.error && rows.length === 0 && (
        <Empty>
          {onlyUndelivered
            ? "Nothing is waiting. Every event has been delivered or has a recorded reason for not being."
            : "No events in this window. Stripe keeps events for thirty days; anything from before the first collection was never seen."}
        </Empty>
      )}

      <div className="space-y-1.5">
        {rows.map((e) => (
          <EventRow key={e.id} e={e} onChanged={onChanged} />
        ))}
      </div>

      {d && <Notes title="What this feed will not tell you" lines={d.cannot} />}
    </>
  );
}

function EventRow({ e, onChanged }: { e: BusinessEvent; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="bg-card rounded-[10px] border px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-muted-foreground text-[11.5px]">{e.type}</span>
        <span className="text-[13px]">{e.summary}</span>
        {e.ventureName && (
          <span className="text-muted-foreground text-[11.5px]">· {e.ventureName}</span>
        )}
        <span className="text-muted-foreground ml-auto text-[11.5px] tabular-nums">
          {e.at.slice(0, 16).replace("T", " ")} UTC
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "text-[11.5px]",
            e.delivery.error && !e.delivery.deliveredAt ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {e.delivery.deliveredAt
            ? `Delivered ${e.delivery.deliveredAt.slice(0, 16).replace("T", " ")} UTC`
            : e.delivery.error
              ? `Delivery failed after ${e.delivery.attempts} attempt${e.delivery.attempts === 1 ? "" : "s"}: ${e.delivery.error}`
              : e.delivery.suppressedBy
                ? `No message — ${e.delivery.suppressedBy}`
                : e.delivery.deferredUntil
                  ? `Waiting for the end of quiet hours (${e.delivery.deferredUntil.slice(0, 16).replace("T", " ")} UTC)`
                  : "Waiting for the next delivery pass"}
        </span>
        {!e.delivery.deliveredAt && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void customersApi
                .resend(e.id)
                .finally(() => {
                  setBusy(false);
                  onChanged();
                });
            }}
            className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] disabled:opacity-40"
          >
            <Send className="size-3.5" strokeWidth={1.6} /> Queue again
          </button>
        )}
      </div>
    </div>
  );
}
