/**
 * PUBLISHING — the page where something the Studio made becomes a post, or
 * does not.
 *
 * FIVE TABS AND ONE ADDRESS EACH, via `?tab=`. They are five cuts of one list
 * and the URL is the selection, so a queue somebody is looking at can be sent
 * to somebody else. The venture picker sits above them, because every one of
 * the five is per venture and moving between tabs must not lose it.
 *
 * THE APPROVE BUTTON IS THE POINT OF THE WHOLE SCREEN. Everything else here is
 * arranged to make the moment before pressing it informative: the caption as
 * it will be sent, the picture as it will be sent, the account it is going to,
 * and — the part that does not exist anywhere else — the list of things that
 * would stop it, computed by the server on every read. An item with problems
 * has no approve button at all; it has the sentences instead.
 *
 * NOTHING ON THIS PAGE PUBLISHES BY ACCIDENT. Approve authorises; Schedule
 * dates; Publish now sends, and is the only red button. Rehearse runs the
 * whole pipeline against a mock and posts nothing, which is what somebody
 * should press first.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Megaphone,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VentureSelect } from "@/components/VentureSelect";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  publishingApi,
  type Asset,
  type Campaign,
  type Destination,
  type PublishItem,
  type PublishResult,
  type Readiness,
} from "./api";

const TABS = [
  { key: "queue", label: "Queue" },
  { key: "calendar", label: "Calendar" },
  { key: "destinations", label: "Destinations" },
  { key: "campaigns", label: "Campaigns" },
  { key: "assets", label: "Assets" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const STATUS_TONE: Record<string, string> = {
  draft: "text-muted-foreground",
  approved: "text-ok",
  scheduled: "text-ok",
  publishing: "text-warn",
  published: "text-ok",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Publishing() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") ?? "queue") as TabKey;

  /* THE VENTURE IS IN THE URL TOO, and for the tab's reason: a queue somebody
     is looking at is a queue they will want to send to somebody, and half an
     address is not an address. `?venture=` is a SLUG rather than an id,
     because a slug survives being read out loud. Absent, the workspace's own
     default, which is the venture the composer starts a chat against. */
  const chosenSlug = params.get("venture");
  const venture =
    ventures.find((v) => v.slug === chosenSlug) ??
    (chosenSlug === "all"
      ? null
      : (ventures.find((v) => v.id === state.workspace.defaultVentureId) ?? ventures[0] ?? null));

  const ready = useApi(() => publishingApi.readiness(), []);

  function go(next: TabKey) {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  }

  function pick(id: string | null) {
    const p = new URLSearchParams(params);
    p.set("venture", id ? (ventures.find((v) => v.id === id)?.slug ?? id) : "all");
    setParams(p, { replace: true });
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
      <div className="mx-auto w-full max-w-[1040px]">
        <div className="mt-2 mb-5">
          <h1 className="mb-1 text-[25px] font-normal tracking-[-0.025em]">Publishing</h1>
          <p className="text-muted-foreground text-[13.5px]">
            Where a draft becomes a post. Nothing goes out that you have not approved, and
            nothing is scheduled that is not approved.
          </p>
        </div>

        {ready.data && <ReadinessStrip ready={ready.data} />}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <VentureSelect ventures={ventures} value={venture?.id ?? null} onChange={pick} none="Every venture" />
          <div className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => go(t.key)}
                aria-current={tab === t.key ? "page" : undefined}
                className={cn(
                  "hover:bg-accent rounded-lg px-2.5 py-1.5 text-[12.5px]",
                  tab === t.key && "bg-accent font-medium",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {ready.error && (
          <p className="text-destructive mb-4 text-[13px]">
            The publishing API did not answer: {ready.error}
          </p>
        )}

        {tab === "queue" && <QueueTab ventureId={venture?.id ?? null} onChanged={ready.reload} />}
        {tab === "calendar" && <CalendarTab ventureId={venture?.id ?? null} />}
        {tab === "destinations" && (
          <DestinationsTab ventureId={venture?.id ?? null} onChanged={ready.reload} />
        )}
        {tab === "campaigns" && <CampaignsTab ventureId={venture?.id ?? null} />}
        {tab === "assets" && <AssetsTab ventureId={venture?.id ?? null} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- header */

function ReadinessStrip({ ready }: { ready: Readiness }) {
  return (
    <div className="bg-card border-line-soft mb-4 grid gap-2 rounded-[10px] border p-3.5">
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[12.5px]">
        <Fact label="Destinations" value={`${ready.destinations.canPublish} of ${ready.destinations.total} can publish`} />
        <Fact label="Waiting" value={`${ready.counts.draft} draft · ${ready.counts.approved} approved · ${ready.counts.scheduled} scheduled`} />
        <Fact label="Published" value={String(ready.counts.published)} />
        {ready.counts.failed > 0 && (
          <Fact label="Failed" value={String(ready.counts.failed)} tone="text-destructive" />
        )}
        <Fact label="Timezone" value={ready.settings.timezone} />
      </div>
      <p className="text-muted-foreground text-[11.5px] leading-relaxed">{ready.publicMedia.note}</p>
      {ready.settings.blackout.length > 0 && (
        <p className="text-muted-foreground text-[11.5px]">
          Blackout: {ready.settings.blackout.join(" · ")}. A due post inside one is held, not skipped.
        </p>
      )}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span>
      <span className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">{label}</span>{" "}
      <span className={cn("ml-1", tone)}>{value}</span>
    </span>
  );
}

/* ----------------------------------------------------------------- queue */

function QueueTab({ ventureId, onChanged }: { ventureId: string | null; onChanged: () => void }) {
  const [status, setStatus] = useState<string | null>(null);
  const doc = useApi(
    () => publishingApi.items({ venture: ventureId, status }),
    [ventureId, status],
  );
  const dests = useApi(() => publishingApi.destinations(ventureId), [ventureId]);

  const items = doc.data?.items ?? [];

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {[null, "draft", "approved", "scheduled", "published", "failed", "cancelled"].map((s) => (
          <button
            key={s ?? "all"}
            onClick={() => setStatus(s)}
            className={cn(
              "rounded-[9px] border px-2.5 py-1 text-[12px] transition-colors",
              status === s ? "border-foreground" : "hover:border-line-strong",
            )}
          >
            {s ?? "all"}
            {s && doc.data ? (
              <span className="text-muted-foreground ml-1.5">
                {doc.data.counts[s as keyof typeof doc.data.counts]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {doc.loading && <p className="text-muted-foreground text-[13px]">loading…</p>}
      {doc.error && <p className="text-destructive text-[13px]">{doc.error}</p>}
      {!doc.loading && items.length === 0 && (
        <p className="text-muted-foreground text-[13px]">
          Nothing in the queue. A Studio post gets here with “Send to publishing”, the Autopilot
          files what it makes, and a campaign files every variant it writes.
        </p>
      )}

      {items.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          destinations={dests.data?.destinations ?? []}
          onChanged={() => {
            doc.reload();
            onChanged();
          }}
        />
      ))}
    </div>
  );
}

function ItemCard({
  item,
  destinations,
  onChanged,
}: {
  item: PublishItem;
  destinations: Destination[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [at, setAt] = useState("");
  /* TWO CLICKS FOR EITHER BUTTON THAT REACHES AN AUDIENCE. Publishing cannot
     be undone from here — deleting the post afterwards is a different act on a
     different site — and one stray click was, in this area's own history, all
     it took. Retry is armed for a sharper reason: an item can now be `failed`
     because the outcome was UNKNOWN, and retrying one of those is how a silent
     success becomes two posts. One flag for both, so arming one disarms the
     other rather than leaving a primed button behind. */
  const [armed, setArmed] = useState<"publish" | "retry" | null>(null);

  async function act(name: string, fn: () => Promise<{ note?: string | null } | unknown>) {
    setBusy(name);
    setRefused(null);
    setSaid(null);
    try {
      const res = (await fn()) as { note?: string | null } | null;
      if (res && typeof res === "object" && typeof res.note === "string") setSaid(res.note);
      onChanged();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setArmed(null);
    }
  }

  const canApprove =
    item.problems.length === 0 &&
    (item.status === "draft" || item.status === "failed" || item.status === "cancelled") &&
    !item.externalId;

  return (
    <div className="bg-card border-line-soft grid gap-2.5 rounded-[10px] border p-3.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={cn("font-medium", STATUS_TONE[item.status])}>{item.status}</span>
        <span className="text-muted-foreground">·</span>
        <span>{item.destination ? `${item.destination.label} — ${item.destination.handle ?? item.destination.id}` : "no destination"}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{item.venture?.name ?? item.ventureId}</span>
        {item.scheduledFor && (
          <>
            <span className="text-muted-foreground">·</span>
            <span>{when(item.scheduledFor)}</span>
          </>
        )}
        {item.attempts > 0 && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{item.attempts} attempt(s)</span>
          </>
        )}
        <span className="text-muted-foreground ml-auto text-[11.5px]">{item.id}</span>
      </div>

      <div className="flex gap-3">
        {item.media.kind === "image" && item.media.onDisk && (
          <img
            src={item.media.url ?? ""}
            alt=""
            className="border-line-soft h-24 w-24 shrink-0 rounded-[8px] border object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">
            {item.caption ?? <span className="text-muted-foreground">no caption</span>}
          </p>
          <p className="text-muted-foreground mt-1 text-[11.5px]">
            {item.media.kind === "none"
              ? "no media"
              : `${item.media.kind}${item.media.mime ? `, ${item.media.mime}` : ""}${
                  item.media.bytes ? `, ${Math.round(item.media.bytes / 1024)} KB` : ""
                }${item.media.onDisk ? "" : " — the file is no longer on disk"}`}
            {item.caption ? ` · ${item.caption.length} characters` : ""}
          </p>
        </div>
      </div>

      {item.problems.length > 0 && (
        <ul className="grid gap-1">
          {item.problems.map((p, i) => (
            <li key={i} className="text-warn flex items-start gap-1.5 text-[12.5px] leading-relaxed">
              <AlertTriangle className="mt-0.5 size-[13px] shrink-0" strokeWidth={1.8} />
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}

      {item.error && <p className="text-destructive text-[12.5px] leading-relaxed">{item.error}</p>}
      {item.note && <p className="text-muted-foreground text-[12px] leading-relaxed">{item.note}</p>}
      {item.permalink && (
        <a
          href={item.permalink}
          target="_blank"
          rel="noreferrer"
          className="text-[12.5px] underline decoration-dotted"
        >
          {item.permalink}
        </a>
      )}

      {!item.destination && destinations.length > 0 && item.status !== "published" && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">Send to</span>
          {destinations
            .filter((d) => d.enabled && d.ventureId === item.ventureId)
            .map((d) => (
              <button
                key={d.id}
                onClick={() => void act("dest", () => publishingApi.patchItem(item.id, { destinationId: d.id }))}
                className="hover:border-line-strong rounded-[9px] border px-2.5 py-1 text-[12px]"
              >
                {d.label} — {d.handle}
              </button>
            ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canApprove && (
          <Button size="sm" onClick={() => void act("approve", () => publishingApi.approve(item.id))}>
            {busy === "approve" ? (
              <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} />
            ) : (
              <CheckCircle2 className="size-[14px]" strokeWidth={1.8} />
            )}
            Approve
          </Button>
        )}
        {(item.status === "approved" || item.status === "scheduled") && (
          <>
            <Input
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className="h-8 w-[200px] text-[12.5px]"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!at}
              onClick={() =>
                void act("schedule", () =>
                  publishingApi.schedule(item.id, new Date(at).toISOString()),
                )
              }
            >
              <CalendarDays className="size-[14px]" strokeWidth={1.8} />
              Schedule
            </Button>
          </>
        )}
        {item.status === "scheduled" && (
          <Button size="sm" variant="ghost" onClick={() => void act("unschedule", () => publishingApi.unschedule(item.id))}>
            Unschedule
          </Button>
        )}
        {item.status !== "published" && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void act("dry", async () => {
                const r = await publishingApi.rehearse(item.id);
                setResult(r.result);
              })
            }
          >
            {busy === "dry" ? (
              <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} />
            ) : (
              <RefreshCw className="size-[14px]" strokeWidth={1.8} />
            )}
            Rehearse
          </Button>
        )}
        {(item.status === "approved" || item.status === "scheduled") && (
          <Button
            size="sm"
            variant={armed === "publish" ? "destructive" : "outline"}
            onBlur={() => setArmed(null)}
            onClick={() => {
              if (armed !== "publish") {
                setArmed("publish");
                return;
              }
              void act("publish", async () => {
                const r = await publishingApi.publish(item.id);
                setResult(r.result);
                return null;
              });
            }}
          >
            {busy === "publish" ? (
              <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} />
            ) : (
              <Send className="size-[14px]" strokeWidth={1.8} />
            )}
            {armed === "publish"
              ? `Send it to ${item.destination?.handle ?? "that account"} — this cannot be undone`
              : "Publish now"}
          </Button>
        )}
        {item.status === "failed" && !item.externalId && (
          <Button
            size="sm"
            variant={armed === "retry" ? "destructive" : "secondary"}
            onBlur={() => setArmed(null)}
            onClick={() => {
              if (armed !== "retry") {
                setArmed("retry");
                return;
              }
              void act("retry", () => publishingApi.retry(item.id));
            }}
          >
            {armed === "retry"
              ? "Send it again — check the account first if the outcome was unknown"
              : "Retry"}
          </Button>
        )}
        {item.status !== "published" && item.status !== "cancelled" && (
          <Button size="sm" variant="ghost" onClick={() => void act("cancel", () => publishingApi.cancel(item.id))}>
            Cancel
          </Button>
        )}
      </div>

      {refused && <p className="text-destructive text-[12.5px] leading-relaxed">{refused}</p>}
      {said && <p className="text-warn text-[12.5px] leading-relaxed">{said}</p>}

      {result && (
        <div className="border-line-soft grid gap-1 rounded-[8px] border p-2.5">
          <p className="text-[12.5px]">
            {result.dry ? "Rehearsal" : result.ok ? "Published" : "Refused"} in {result.ms} ms
            {result.error ? ` — ${result.error}` : ""}
          </p>
          {result.note && <p className="text-muted-foreground text-[11.5px]">{result.note}</p>}
          {result.calls.length > 0 && (
            <ul className="grid gap-0.5">
              {result.calls.map((call, i) => (
                <li key={i} className="text-muted-foreground font-mono text-[11px] break-all">
                  {call.method} {call.url} {call.body ? `— ${call.body}` : ""}{" "}
                  {call.status !== null ? `→ ${call.status}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- calendar */

function CalendarTab({ ventureId }: { ventureId: string | null }) {
  const [days, setDays] = useState(14);
  const doc = useApi(() => publishingApi.calendar({ venture: ventureId, days }), [ventureId, days]);
  const [ticking, setTicking] = useState(false);
  const [tickResult, setTickResult] = useState<string | null>(null);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 14, 31].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn(
              "rounded-[9px] border px-2.5 py-1 text-[12px]",
              days === d ? "border-foreground" : "hover:border-line-strong",
            )}
          >
            {d} days
          </button>
        ))}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setTicking(true);
            publishingApi
              .tick()
              .then((r) => setTickResult(r.why))
              .catch((e: unknown) => setTickResult(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                setTicking(false);
                doc.reload();
              });
          }}
        >
          {ticking ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : null}
          Run a tick now
        </Button>
        {doc.data && (
          <span className="text-muted-foreground text-[11.5px]">
            Days are local to {doc.data.timezone}.
          </span>
        )}
      </div>
      {tickResult && <p className="text-muted-foreground text-[12.5px]">{tickResult}</p>}
      {doc.error && <p className="text-destructive text-[13px]">{doc.error}</p>}
      <div className="grid gap-1.5">
        {(doc.data?.calendar ?? []).map((day) => (
          <div key={day.day} className="border-line-soft flex gap-3 rounded-[8px] border p-2.5">
            <span className="text-muted-foreground w-[100px] shrink-0 text-[12px]">{day.day}</span>
            <div className="min-w-0 flex-1">
              {day.items.length === 0 ? (
                <span className="text-muted-foreground text-[12px]">—</span>
              ) : (
                <ul className="grid gap-1">
                  {day.items.map((i) => (
                    <li key={i.id} className="text-[12.5px]">
                      <span className={cn("mr-1.5", STATUS_TONE[i.status])}>{i.status}</span>
                      {when(i.scheduledFor ?? i.publishedAt)} ·{" "}
                      {i.destination?.handle ?? "no destination"} ·{" "}
                      <span className="text-muted-foreground">
                        {(i.caption ?? "").slice(0, 70)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </div>
      {doc.data && doc.data.outside > 0 && (
        <p className="text-muted-foreground text-[12px]">
          {doc.data.outside} more scheduled or published outside this window.
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- destinations */

function DestinationsTab({
  ventureId,
  onChanged,
}: {
  ventureId: string | null;
  onChanged: () => void;
}) {
  const doc = useApi(() => publishingApi.destinations(ventureId), [ventureId]);
  const [probing, setProbing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!ventureId || probing}
          onClick={() => {
            if (!ventureId) return;
            setProbing(true);
            setNote(null);
            publishingApi
              .probe(ventureId)
              .then((r) => setNote(r.note))
              .catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                setProbing(false);
                doc.reload();
                onChanged();
              });
          }}
        >
          {probing ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : null}
          Probe this venture's destinations
        </Button>
        <span className="text-muted-foreground text-[11.5px]">
          {ventureId
            ? "Asks every connected social credential what it can reach, and records what each account can actually post."
            : "Choose a venture — a destination belongs to a business."}
        </span>
      </div>
      {note && <p className="text-muted-foreground text-[12.5px]">{note}</p>}
      {doc.error && <p className="text-destructive text-[13px]">{doc.error}</p>}
      {(doc.data?.destinations ?? []).length === 0 && !doc.loading && (
        <p className="text-muted-foreground text-[13px]">
          No destinations yet. Probing discovers the Facebook Pages, Instagram business accounts,
          LinkedIn pages and TikTok accounts the connected credentials reach.
        </p>
      )}
      {(doc.data?.destinations ?? []).map((d) => (
        <DestinationCard key={d.id} destination={d} onChanged={() => { doc.reload(); onChanged(); }} />
      ))}
    </div>
  );
}

function DestinationCard({
  destination: d,
  onChanged,
}: {
  destination: Destination;
  onChanged: () => void;
}) {
  const caps = [
    ["caption", d.capabilities.text],
    ["photo", d.capabilities.photo],
    ["video", d.capabilities.video],
  ] as const;
  return (
    <div className="bg-card border-line-soft grid gap-2 rounded-[10px] border p-3.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">{d.handle ?? d.externalId}</span>
        <span className="text-muted-foreground">{d.label}</span>
        <span className="text-muted-foreground text-[11.5px]">{d.account}</span>
        <button
          onClick={() => void publishingApi.setDestination(d.id, { enabled: !d.enabled }).then(onChanged)}
          className={cn(
            "ml-auto rounded-[9px] border px-2.5 py-1 text-[12px]",
            d.enabled ? "border-foreground" : "text-muted-foreground",
          )}
        >
          {d.enabled ? "enabled" : "disabled"}
        </button>
      </div>
      <div className="flex flex-wrap gap-3 text-[12px]">
        {caps.map(([name, can]) => (
          <span key={name} className={can ? "text-ok" : "text-muted-foreground"}>
            {can ? "✓" : "✕"} {name}
          </span>
        ))}
        <span className="text-muted-foreground">
          probed {d.probe.at ? when(d.probe.at) : "never"}
        </span>
      </div>
      {d.capabilities.missing.length > 0 && (
        <ul className="grid gap-1">
          {d.capabilities.missing.map((m, i) => (
            <li key={i} className="text-warn text-[12.5px] leading-relaxed">
              Missing: {m}
            </li>
          ))}
        </ul>
      )}
      {d.probe.error && <p className="text-destructive text-[12.5px]">{d.probe.error}</p>}
      <p className="text-muted-foreground text-[11.5px] leading-relaxed">{d.capabilities.note}</p>
    </div>
  );
}

/* ------------------------------------------------------------- campaigns */

function CampaignsTab({ ventureId }: { ventureId: string | null }) {
  const doc = useApi(() => publishingApi.campaigns(ventureId), [ventureId]);
  const suggestions = useApi(
    () => (ventureId ? publishingApi.campaignSuggestions(ventureId) : Promise.resolve(null)),
    [ventureId],
  );
  const [goal, setGoal] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [concepts, setConcepts] = useState(3);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const available = suggestions.data?.channels ?? [];
  const planned = concepts * Math.max(1, channels.length);

  return (
    <div className="grid gap-4">
      <div className="bg-card border-line-soft grid gap-3 rounded-[10px] border p-3.5">
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
            What the campaign is for
          </div>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder="Get the first ten beta users for the planning tool."
            className="text-[13.5px]"
          />
        </div>
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">Channels</div>
          <div className="flex flex-wrap gap-1.5">
            {(available.length ? available.map((c) => c.channel) : ["page", "ig", "linkedin", "tiktok"]).map(
              (c) => (
                <button
                  key={c}
                  onClick={() =>
                    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
                  }
                  className={cn(
                    "rounded-[9px] border px-2.5 py-1 text-[12px]",
                    channels.includes(c) ? "border-foreground" : "hover:border-line-strong",
                  )}
                >
                  {c}
                </button>
              ),
            )}
          </div>
          {suggestions.data && (
            <p className="text-muted-foreground text-[11.5px]">{suggestions.data.note}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">Concepts</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setConcepts(n)}
              className={cn(
                "rounded-[9px] border px-2.5 py-1 text-[12px]",
                concepts === n ? "border-foreground" : "hover:border-line-strong",
              )}
            >
              {n}
            </button>
          ))}
          <span className="text-muted-foreground text-[12px]">
            {planned} variant{planned === 1 ? "" : "s"} — that many model calls and that many image
            renders.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!ventureId || !goal.trim() || channels.length === 0 || busy}
            onClick={() => {
              if (!ventureId) return;
              setBusy(true);
              setNote(null);
              publishingApi
                .startCampaign({ ventureId, goal: goal.trim(), channels, concepts })
                .then((r) => {
                  setNote(r.note);
                  setGoal("");
                })
                .catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
                .finally(() => {
                  setBusy(false);
                  doc.reload();
                });
            }}
          >
            {busy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : <Megaphone className="size-[14px]" strokeWidth={1.8} />}
            Plan a campaign
          </Button>
          <span className="text-muted-foreground text-[12px]">
            It is queued as a run. Every variant arrives as a draft; nothing is approved.
          </span>
        </div>
        {note && <p className="text-muted-foreground text-[12.5px]">{note}</p>}
      </div>

      {(doc.data?.campaigns ?? []).map((c) => (
        <CampaignCard key={c.id} campaign={c} onChanged={doc.reload} />
      ))}
      {!doc.loading && (doc.data?.campaigns ?? []).length === 0 && (
        <p className="text-muted-foreground text-[13px]">No campaigns yet.</p>
      )}
    </div>
  );
}

function CampaignCard({ campaign: c, onChanged }: { campaign: Campaign; onChanged: () => void }) {
  return (
    <div className="bg-card border-line-soft grid gap-2 rounded-[10px] border p-3.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">{c.goal}</span>
        <span className={cn("text-[12px]", c.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {c.status}
        </span>
        {c.stalled && (
          <span className="text-warn text-[12px]">
            the run stopped ({c.runStatus ?? "gone"}) — plan another to finish it
          </span>
        )}
        <span className="text-muted-foreground ml-auto text-[11.5px]">
          {c.progress.produced} of {c.progress.planned || "—"} made
          {c.progress.failed ? `, ${c.progress.failed} failed` : ""}
        </span>
        {/* Deleting a PLAN, not the work: the drafts it made are kept and
            simply stop pointing at it. */}
        <button
          aria-label="Forget this campaign"
          title="Forget the plan. The drafts it made are kept."
          onClick={() => void publishingApi.removeCampaign(c.id).then(onChanged)}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-[13px]" strokeWidth={1.8} />
        </button>
      </div>
      <p className="text-muted-foreground text-[12px]">
        {c.channels.join(", ")} · {when(c.createdAt)}
      </p>
      {c.error && <p className="text-destructive text-[12.5px]">{c.error}</p>}
      {c.concepts.map((con) => (
        <div key={con.id} className="border-line-soft rounded-[8px] border p-2.5">
          <p className="text-[12.5px] font-medium">{con.theme}</p>
          {con.description && (
            <p className="text-muted-foreground text-[12px] leading-relaxed">{con.description}</p>
          )}
          <ul className="mt-1 grid gap-0.5">
            {con.variants.map((v) => (
              <li key={v.id} className="text-[11.5px]">
                <span className="text-muted-foreground">{v.channel}</span>{" "}
                {v.error ? (
                  <span className="text-destructive">{v.error}</span>
                ) : v.itemId ? (
                  <span className="text-ok">queued as {v.itemId}</span>
                ) : (
                  <span className="text-muted-foreground">a Studio draft, no destination</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- assets */

function AssetsTab({ ventureId }: { ventureId: string | null }) {
  const doc = useApi(() => publishingApi.assets({ venture: ventureId }), [ventureId]);
  const [kind, setKind] = useState("reference");
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const support = doc.data?.imageModel;
  const assets = doc.data?.assets ?? [];
  const cap = useMemo(() => Math.round((doc.data?.uploadCap ?? 0) / 1024 / 1024), [doc.data]);

  async function add(fn: () => Promise<unknown>) {
    if (!ventureId) return;
    setBusy(true);
    setRefused(null);
    try {
      await fn();
      setUrl("");
      setPrompt("");
      doc.reload();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      {support && (
        <div className="border-line-soft rounded-[10px] border p-3 text-[12.5px] leading-relaxed">
          <span className="text-muted-foreground">Image model: </span>
          <span className="font-mono text-[12px]">{support.model}</span>
          <p className="text-muted-foreground mt-1 text-[12px]">{support.note}</p>
        </div>
      )}

      <div className="bg-card border-line-soft grid gap-2.5 rounded-[10px] border p-3.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {(doc.data?.kinds ?? ["logo", "reference", "screenshot", "other"]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn(
                "rounded-[9px] border px-2.5 py-1 text-[12px]",
                kind === k ? "border-foreground" : "hover:border-line-strong",
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="An instruction that travels with it — “keep the palette cold”, not a description."
          className="h-8 text-[12.5px]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={!ventureId || busy}
            className="text-[12px]"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file || !ventureId) return;
              void add(() => publishingApi.uploadAsset({ ventureId, kind, file, prompt }));
              e.target.value = "";
            }}
          />
          <span className="text-muted-foreground text-[11.5px]">up to {cap} MB</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="…or paste an image URL"
            className="h-8 max-w-[420px] text-[12.5px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!ventureId || !url.trim() || busy}
            onClick={() => void add(() => publishingApi.importAsset({ ventureId: ventureId!, kind, url: url.trim(), prompt }))}
          >
            {busy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : <ImageIcon className="size-[14px]" strokeWidth={1.8} />}
            Import
          </Button>
        </div>
        {refused && <p className="text-destructive text-[12.5px]">{refused}</p>}
        {!ventureId && (
          <p className="text-muted-foreground text-[12px]">Choose a venture — an asset belongs to one.</p>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {assets.map((a) => (
          <AssetCard key={a.id} asset={a} onChanged={doc.reload} />
        ))}
      </div>
      {!doc.loading && assets.length === 0 && (
        <p className="text-muted-foreground text-[13px]">
          No assets yet. A logo, a reference picture or a screenshot is stored once and reused.
        </p>
      )}
    </div>
  );
}

function AssetCard({ asset: a, onChanged }: { asset: Asset; onChanged: () => void }) {
  return (
    <div className="bg-card border-line-soft flex gap-3 rounded-[10px] border p-3">
      {a.onDisk ? (
        <img src={a.url} alt="" className="border-line-soft h-20 w-20 shrink-0 rounded-[8px] border object-cover" />
      ) : (
        <div className="border-line-soft text-muted-foreground flex h-20 w-20 shrink-0 items-center justify-center rounded-[8px] border text-[11px]">
          missing
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[13px]">{a.name ?? a.id}</p>
        <p className="text-muted-foreground text-[11.5px]">
          {a.kind} · {a.source} · {a.width && a.height ? `${a.width}×${a.height}` : "size not measured"} ·{" "}
          {a.bytes ? `${Math.round(a.bytes / 1024)} KB` : "—"}
        </p>
        {a.prompt && <p className="text-muted-foreground mt-1 text-[11.5px]">{a.prompt}</p>}
        <p className="text-muted-foreground mt-1 text-[11px]">used {a.usedCount}×</p>
      </div>
      <button
        aria-label="Delete asset"
        onClick={() => void publishingApi.removeAsset(a.id).then(onChanged)}
        className="text-muted-foreground hover:text-destructive self-start"
      >
        <Trash2 className="size-[14px]" strokeWidth={1.8} />
      </button>
    </div>
  );
}
