/**
 * PUBLISHING — the page where something the Studio made becomes a post, or
 * does not.
 *
 * SIX TABS AND ONE ADDRESS EACH, via `?tab=`. Five are cuts of one list — the
 * queue on its way out — and the URL is the selection, so a queue somebody is
 * looking at can be sent to somebody else. The venture picker sits above them,
 * because every one of the six is per venture and moving between tabs must not
 * lose it.
 *
 * THE SIXTH TAB IS THE RETURN LEG. `?tab=published` is the timeline read back
 * from Meta, which used to be a page of its own; it is here because the
 * question it answers — what did the thing I approved actually do — is asked
 * about the queue, and asking it should not mean leaving the queue. It is the
 * one tab that shows the platform's account of things rather than this box's.
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
import { SubTabs } from "@/components/TabStrip";
import { WindowPicker } from "@/components/WindowPicker";
import { bytes, when } from "@/lib/format";
import { PageShell } from "@/components/PageShell";
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
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { VentureSelect } from "@/components/VentureSelect";
import { SocialPlatformIcon, SocialPlatformLabel } from "@/components/SocialPlatform";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PublishedTimeline } from "@/areas/socialfeed/PublishedTimeline";
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
  { key: "published", label: "Published" },
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

export function Publishing() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [params, setParams] = useSearchParams();
  const tab = TABS.find(t => t.key === params.get("tab"))?.key ?? "queue";

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

  /* THE ONLY TAB WITH A FIGURE ON IT, and it is one the header already paid
     for: the readiness call counts every status, so `published` costs nothing
     extra here. Absent until that call answers — a tab that reads "Published 0"
     while the number is still unknown would be stating a fact it does not
     have. */
  const tabs = useMemo(
    () =>
      TABS.map((t) =>
        t.key === "published"
          ? {
              ...t,
              count: ready.data?.counts.published,
              title: "What actually went out, read back from the platform.",
            }
          : t,
      ),
    [ready.data],
  );

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
    <PageShell
      title="Publishing"
      sub={
        <>
          Where a draft becomes a post. Nothing goes out that you have not approved, and
          nothing is scheduled that is not approved.
        </>
      }
      wide
    >
      {ready.data && <ReadinessStrip ready={ready.data} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <VentureSelect ventures={ventures} value={venture?.id ?? null} onChange={pick} none="Every venture" />
        <SubTabs tabs={tabs} activeKey={tab} onSelect={(k) => go(k as TabKey)} className="mb-0" />
      </div>

      {ready.error && (
        <p className="text-destructive mb-4 text-[14px]">
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
      {/* THE VENTURE COMES FROM THE PAGE, not from a picker of its own: the
          timeline is filtered by whatever the strip above already says, and
          "every venture" when the URL says `all`. */}
      {tab === "published" && <PublishedTimeline ventureId={venture?.id ?? null} />}
    </PageShell>
  );
}

/* ---------------------------------------------------------------- header */

function ReadinessStrip({ ready }: { ready: Readiness }) {
  return (
    <div className="bg-card border-line-soft mb-4 grid gap-2 rounded-[14px] p-4.5">
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[13.5px]">
        <Fact label="Destinations" value={`${ready.destinations.canPublish} of ${ready.destinations.total} can publish`} />
        <Fact label="Waiting" value={`${ready.counts.draft} draft · ${ready.counts.approved} approved · ${ready.counts.scheduled} scheduled`} />
        <Fact label="Published" value={String(ready.counts.published)} />
        {ready.counts.failed > 0 && (
          <Fact label="Failed" value={String(ready.counts.failed)} tone="text-destructive" />
        )}
        <Fact label="Timezone" value={ready.settings.timezone} />
      </div>
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">{ready.publicMedia.note}</p>
      {ready.settings.blackout.length > 0 && (
        <p className="text-muted-foreground text-[12.5px]">
          Blackout: {ready.settings.blackout.join(" · ")}. A due post inside one is held, not skipped.
        </p>
      )}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span>
      <span className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">{label}</span>{" "}
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
              "rounded-[12px] border px-2.5 py-1 text-[13px] transition-colors",
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

      {doc.loading && <p className="text-muted-foreground text-[14px]">loading…</p>}
      {doc.error && <p className="text-destructive text-[14px]">{doc.error}</p>}
      {!doc.loading && items.length === 0 && (
        <p className="text-muted-foreground text-[14px]">
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
  const [at, setAt] = useState(() => {
    if (!item.scheduledFor) return "";
    const date = new Date(item.scheduledFor);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(item.caption ?? "");
  const [destinationId, setDestinationId] = useState(item.destinationId ?? "");
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
      return true;
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
      return false;
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
    <div data-publishing-item={item.id} className="bg-card border-line-soft grid gap-2.5 rounded-[14px] p-4.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className={cn("font-medium", STATUS_TONE[item.status])}>{item.status}</span>
        <span className="text-muted-foreground">·</span>
        <span className="inline-flex items-center gap-2">
          {item.destination && <SocialPlatformIcon platform={item.destination.kind} />}
          {item.destination ? `${item.destination.label} — ${item.destination.handle ?? item.destination.id}` : "no destination"}
        </span>
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
        <span className="text-muted-foreground ml-auto text-[12.5px]">{item.id}</span>
      </div>

      <div className="flex gap-3">
        {item.media.kind === "image" && item.media.onDisk && (
          <img
            src={item.media.url ?? ""}
            alt=""
            className="border-line-soft h-24 w-24 shrink-0 rounded-[11px] border object-cover"
          />
        )}
        {item.media.kind === "video" && item.media.onDisk && item.media.url && (
          <video src={item.media.url} controls preload="metadata" className="max-h-56 w-36 shrink-0 rounded-[11px] bg-black" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] leading-relaxed whitespace-pre-wrap">
            {item.caption ?? <span className="text-muted-foreground">no caption</span>}
          </p>
          <p className="text-muted-foreground mt-1 text-[12.5px]">
            {item.media.kind === "none"
              ? "no media"
              : `${item.media.kind}${item.media.mime ? `, ${item.media.mime}` : ""}${
                  item.media.bytes ? `, ${bytes(item.media.bytes)}` : ""
                }${item.media.onDisk ? "" : " — the file is no longer on disk"}`}
            {item.caption ? ` · ${item.caption.length} characters` : ""}
          </p>
        </div>
      </div>

      {editing ? <fieldset disabled={busy !== null} className="grid gap-2.5">
        <Textarea aria-label="Publishing caption" value={caption} onChange={e => setCaption(e.target.value)} rows={5} />
        <SelectField aria-label="Publishing destination" value={destinationId} onValueChange={setDestinationId}>
          <SelectOption value="">Choose a destination</SelectOption>
          {destinations.filter(d => d.ventureId === item.ventureId && (d.enabled || d.id === item.destinationId)).map(d =>
            <SelectOption key={d.id} value={d.id} disabled={!d.enabled}>{d.label} — {d.handle ?? d.id}{!d.enabled ? " (disabled)" : ""}</SelectOption>)}
        </SelectField>
        {(item.status === "approved" || item.status === "scheduled") && <p className="text-muted-foreground text-[12.5px]">Saving changes returns this to a draft and removes its schedule. Review and approve it again when ready.</p>}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void act("edit", () => publishingApi.patchItem(item.id, { caption, destinationId: destinationId || null })).then(ok => { if (ok) setEditing(false); })}>Save changes</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel editing</Button>
        </div>
      </fieldset> : item.status !== "published" && item.status !== "publishing" && !item.externalId && <Button size="sm" variant="outline" disabled={busy !== null} className="justify-self-start" onClick={() => { setCaption(item.caption ?? ""); setDestinationId(item.destinationId ?? ""); setEditing(true); }}>Edit caption & destination</Button>}

      {item.problems.length > 0 && (
        <ul className="grid gap-1">
          {item.problems.map((p, i) => (
            <li key={i} className="text-warn flex items-start gap-1.5 text-[13.5px] leading-relaxed">
              <AlertTriangle className="mt-0.5 size-[13px] shrink-0" strokeWidth={1.8} />
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}

      {item.error && <p className="text-destructive text-[13.5px] leading-relaxed">{item.error}</p>}
      {item.note && <p className="text-muted-foreground text-[13px] leading-relaxed">{item.note}</p>}
      {item.permalink && (
        <a
          href={item.permalink}
          target="_blank"
          rel="noreferrer"
          className="text-[13.5px] underline decoration-dotted"
        >
          {item.permalink}
        </a>
      )}

      {!editing && !item.destination && destinations.length > 0 && item.status !== "published" && item.status !== "publishing" && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">Send to</span>
          {destinations
            .filter((d) => d.enabled && d.ventureId === item.ventureId)
            .map((d) => (
              <button
                key={d.id}
                disabled={busy !== null}
                onClick={() => void act("dest", () => publishingApi.patchItem(item.id, { destinationId: d.id }))}
                className="hover:border-line-strong inline-flex items-center gap-2 rounded-[12px] border px-2.5 py-1 text-[13px]"
              >
                <SocialPlatformIcon platform={d.kind} />
                {d.label} — {d.handle}
              </button>
            ))}
        </div>
      )}

      <fieldset disabled={busy !== null || item.status === "publishing"} className={cn("flex flex-wrap items-center gap-2", editing && "hidden")}>
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
              aria-label="Publish at (your local time)"
              title={`Your local time (${Intl.DateTimeFormat().resolvedOptions().timeZone})`}
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className="h-8 w-[200px] text-[13.5px]"
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
      </fieldset>

      {refused && <p className="text-destructive text-[13.5px] leading-relaxed">{refused}</p>}
      {said && <p className="text-warn text-[13.5px] leading-relaxed">{said}</p>}

      {result && (
        <div className="border-line-soft grid gap-1 rounded-[11px] border p-2.5">
          <p className="text-[13.5px]">
            {result.dry ? "Rehearsal" : result.ok ? "Published" : "Refused"} in {result.ms} ms
            {result.error ? ` — ${result.error}` : ""}
          </p>
          {result.note && <p className="text-muted-foreground text-[12.5px]">{result.note}</p>}
          {result.calls.length > 0 && (
            <ul className="grid gap-0.5">
              {result.calls.map((call, i) => (
                <li key={i} className="text-muted-foreground font-mono text-[12px] break-all">
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
        <WindowPicker value={days} onChange={(d) => setDays(Number(d))} options={[7, 14, 31]} />
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
          <span className="text-muted-foreground text-[12.5px]">
            Days are local to {doc.data.timezone}.
          </span>
        )}
      </div>
      {tickResult && <p className="text-muted-foreground text-[13.5px]">{tickResult}</p>}
      {doc.error && <p className="text-destructive text-[14px]">{doc.error}</p>}
      <div className="grid gap-1.5">
        {(doc.data?.calendar ?? []).map((day) => (
          <div key={day.day} className="border-line-soft flex gap-3 rounded-[11px] border p-2.5">
            <span className="text-muted-foreground w-[100px] shrink-0 text-[13px]">{day.day}</span>
            <div className="min-w-0 flex-1">
              {day.items.length === 0 ? (
                <span className="text-muted-foreground text-[13px]">—</span>
              ) : (
                <ul className="grid gap-1">
                  {day.items.map((i) => (
                    <li key={i.id} className="text-[13.5px]">
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
        <p className="text-muted-foreground text-[13px]">
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
        <span className="text-muted-foreground text-[12.5px]">
          {ventureId
            ? "Asks every connected social credential what it can reach, and records what each account can actually post."
            : "Choose a venture — a destination belongs to a business."}
        </span>
      </div>
      {note && <p className="text-muted-foreground text-[13.5px]">{note}</p>}
      {doc.error && <p className="text-destructive text-[14px]">{doc.error}</p>}
      {(doc.data?.destinations ?? []).length === 0 && !doc.loading && (
        <p className="text-muted-foreground text-[14px]">
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
    <div className="bg-card border-line-soft grid gap-2 rounded-[14px] p-4.5">
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        <SocialPlatformIcon platform={d.kind} />
        <span className="font-medium">{d.handle ?? d.externalId}</span>
        <span className="text-muted-foreground">{d.label}</span>
        <span className="text-muted-foreground text-[12.5px]">{d.account}</span>
        <button
          onClick={() => void publishingApi.setDestination(d.id, { enabled: !d.enabled }).then(onChanged)}
          className={cn(
            "ml-auto rounded-[12px] border px-2.5 py-1 text-[13px]",
            d.enabled ? "border-foreground" : "text-muted-foreground",
          )}
        >
          {d.enabled ? "enabled" : "disabled"}
        </button>
      </div>
      <div className="flex flex-wrap gap-3 text-[13px]">
        {caps.map(([name, can]) => (
          <span key={name} className={can ? "text-ok" : "text-muted-foreground"}>
            {can ? "✓" : "✕"} {name}
          </span>
        ))}
        <span className="text-muted-foreground">
          probed {when(d.probe.at, { nullText: "never" })}
        </span>
      </div>
      {d.capabilities.missing.length > 0 && (
        <ul className="grid gap-1">
          {d.capabilities.missing.map((m, i) => (
            <li key={i} className="text-warn text-[13.5px] leading-relaxed">
              Missing: {m}
            </li>
          ))}
        </ul>
      )}
      {d.probe.error && <p className="text-destructive text-[13.5px]">{d.probe.error}</p>}
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">{d.capabilities.note}</p>
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
      <div className="bg-card border-line-soft grid gap-3 rounded-[14px] p-4.5">
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            What the campaign is for
          </div>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder="Get the first ten beta users for the planning tool."
            className="text-[14.5px]"
          />
        </div>
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">Channels</div>
          <div className="flex flex-wrap gap-1.5">
            {(available.length ? available.map((c) => c.channel) : ["page", "ig", "linkedin", "tiktok"]).map(
              (c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={channels.includes(c)}
                  onClick={() =>
                    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
                  }
                  className={cn(
                    "rounded-[12px] border px-2.5 py-1 text-[13px]",
                    channels.includes(c) ? "border-foreground" : "hover:border-line-strong",
                  )}
                >
                  <SocialPlatformLabel platform={c} />
                </button>
              ),
            )}
          </div>
          {suggestions.data && (
            <p className="text-muted-foreground text-[12.5px]">{suggestions.data.note}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">Concepts</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setConcepts(n)}
              className={cn(
                "rounded-[12px] border px-2.5 py-1 text-[13px]",
                concepts === n ? "border-foreground" : "hover:border-line-strong",
              )}
            >
              {n}
            </button>
          ))}
          <span className="text-muted-foreground text-[13px]">
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
          <span className="text-muted-foreground text-[13px]">
            It is queued as a run. Every variant arrives as a draft; nothing is approved.
          </span>
        </div>
        {note && <p className="text-muted-foreground text-[13.5px]">{note}</p>}
      </div>

      {(doc.data?.campaigns ?? []).map((c) => (
        <CampaignCard key={c.id} campaign={c} onChanged={doc.reload} />
      ))}
      {!doc.loading && (doc.data?.campaigns ?? []).length === 0 && (
        <p className="text-muted-foreground text-[14px]">No campaigns yet.</p>
      )}
    </div>
  );
}

function CampaignCard({ campaign: c, onChanged }: { campaign: Campaign; onChanged: () => void }) {
  return (
    <div className="bg-card border-line-soft grid gap-2 rounded-[14px] p-4.5">
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        <span className="font-medium">{c.goal}</span>
        <span className={cn("text-[13px]", c.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {c.status}
        </span>
        {c.stalled && (
          <span className="text-warn text-[13px]">
            the run stopped ({c.runStatus ?? "gone"}) — plan another to finish it
          </span>
        )}
        <span className="text-muted-foreground ml-auto text-[12.5px]">
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
      <p className="text-muted-foreground text-[13px]">
        {c.channels.join(", ")} · {when(c.createdAt)}
      </p>
      {c.error && <p className="text-destructive text-[13.5px]">{c.error}</p>}
      {c.concepts.map((con) => (
        <div key={con.id} className="border-line-soft rounded-[11px] border p-2.5">
          <p className="text-[13.5px] font-medium">{con.theme}</p>
          {con.description && (
            <p className="text-muted-foreground text-[13px] leading-relaxed">{con.description}</p>
          )}
          <ul className="mt-1 grid gap-0.5">
            {con.variants.map((v) => (
              <li key={v.id} className="text-[12.5px]">
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
        <div className="border-line-soft rounded-[14px] border p-3 text-[13.5px] leading-relaxed">
          <span className="text-muted-foreground">Image model: </span>
          <span className="font-mono text-[13px]">{support.model}</span>
          <p className="text-muted-foreground mt-1 text-[13px]">{support.note}</p>
        </div>
      )}

      <div className="bg-card border-line-soft grid gap-2.5 rounded-[14px] p-4.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {(doc.data?.kinds ?? ["logo", "reference", "screenshot", "other"]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn(
                "rounded-[12px] border px-2.5 py-1 text-[13px]",
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
          className="h-8 text-[13.5px]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={!ventureId || busy}
            className="text-[13px]"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file || !ventureId) return;
              void add(() => publishingApi.uploadAsset({ ventureId, kind, file, prompt }));
              e.target.value = "";
            }}
          />
          <span className="text-muted-foreground text-[12.5px]">up to {cap} MB</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="…or paste an image URL"
            className="h-8 max-w-[420px] text-[13.5px]"
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
        {refused && <p className="text-destructive text-[13.5px]">{refused}</p>}
        {!ventureId && (
          <p className="text-muted-foreground text-[13px]">Choose a venture — an asset belongs to one.</p>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {assets.map((a) => (
          <AssetCard key={a.id} asset={a} onChanged={doc.reload} />
        ))}
      </div>
      {!doc.loading && assets.length === 0 && (
        <p className="text-muted-foreground text-[14px]">
          No assets yet. A logo, a reference picture or a screenshot is stored once and reused.
        </p>
      )}
    </div>
  );
}

function AssetCard({ asset: a, onChanged }: { asset: Asset; onChanged: () => void }) {
  return (
    <div className="bg-card border-line-soft flex gap-3 rounded-[14px] p-4">
      {a.onDisk ? (
        <img src={a.url} alt="" className="border-line-soft h-20 w-20 shrink-0 rounded-[11px] border object-cover" />
      ) : (
        <div className="border-line-soft text-muted-foreground flex h-20 w-20 shrink-0 items-center justify-center rounded-[11px] border text-[12px]">
          missing
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[14px]">{a.name ?? a.id}</p>
        <p className="text-muted-foreground text-[12.5px]">
          {a.kind} · {a.source} · {a.width && a.height ? `${a.width}×${a.height}` : "size not measured"} ·{" "}
          {bytes(a.bytes)}
        </p>
        {a.prompt && <p className="text-muted-foreground mt-1 text-[12.5px]">{a.prompt}</p>}
        <p className="text-muted-foreground mt-1 text-[12px]">used {a.usedCount}×</p>
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
