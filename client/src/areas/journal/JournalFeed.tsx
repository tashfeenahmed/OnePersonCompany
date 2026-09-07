import { useMemo, useState } from "react";
import { Check, ExternalLink, Flame, Loader2, Plus, Target, Trash2 } from "lucide-react";
import { WindowPicker } from "@/components/WindowPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { day } from "@/lib/format";
import { cn } from "@/lib/utils";
import { journalApi, type JournalEntry, type Streak } from "@/lib/api/journal";
import { alertsApi } from "@/lib/api/proactive";

/**
 * THE JOURNAL, AS ONE COMPOSER AND ONE LIST.
 *
 * THE COMPOSER IS ONE LINE AND EVERYTHING ELSE IS OPTIONAL, which is the only
 * design decision here that matters. This table competes with not bothering.
 * A form with a venture, a kind, a date, a link and a result on it is a form
 * that gets filled in for a fortnight and then never again, and an empty
 * journal is worth less than a scrappy one — so the sentence and the kind are
 * the whole of the required path, the date is prefilled with today, and the
 * link and the venture are two controls sitting beside it that can be ignored.
 *
 * THE KINDS ARE CHIPS AND NOT A DROPDOWN. Six of them, one click, and the
 * choice is visible while the sentence is being typed rather than hidden
 * behind a closed select — a `posted` typed as a `did` is a row that will not
 * show up when the owner asks what he has published.
 *
 * ENTRIES ARE GROUPED BY DAY, newest first, and a day heading appears even for
 * a day with one entry. The question this page answers is "what did I do last
 * week", and a flat list ordered by date answers it far worse than a set of
 * days does — the shape of the week is the finding.
 *
 * NOTHING ON THIS PAGE IS A MEASUREMENT and the page says so once, at the
 * bottom, in the same words the route's `definitions` use. Everything else on
 * this dashboard was read off a service; every row here was typed by the
 * person reading it, and a count of them proves that sentences were written.
 *
 * "TRACK OUTCOME" APPEARS ONLY WHERE THE SERVER SAYS IT MAY. `trackable` is
 * computed on the server from the kind and the link, and this file does not
 * re-derive it: a client that decided for itself would draw a button the
 * server refuses.
 */

const KIND_LABEL: Record<string, string> = {
  did: "did",
  shipped: "shipped",
  posted: "posted",
  met: "met",
  decided: "decided",
  other: "other",
};

/** Chips, not colour-coded state: these are categories of work, and painting
 *  six of them six colours would say something about severity that none of
 *  them means. The selected one is filled; the rest are outlined. */
const KIND_ORDER = ["did", "shipped", "posted", "met", "decided", "other"];

const SOURCE_NOTE: Record<string, string> = {
  ui: "typed here",
  telegram: "sent from Telegram",
  agent: "filed by the agent from something you said",
};

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(iso: string): string {
  const t = todayLocal();
  if (iso === t) return "Today";
  const y = new Date(`${t}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (iso === y.toISOString().slice(0, 10)) return "Yesterday";
  return day(iso, { long: true });
}

export function JournalFeed({
  /** A venture slug pins the whole page to one venture: the composer files
   *  against it and the filter disappears. Absent is the portfolio view. */
  ventureSlug,
}: {
  ventureSlug?: string;
}) {
  const { state } = useStore();
  const [kind, setKind] = useState<string>("");
  const [days, setDays] = useState<string>("90");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const doc = useApi(
    () => journalApi.list({ venture: ventureSlug, kind: kind || undefined, days }),
    [ventureSlug, kind, days],
  );

  const groups = useMemo(() => {
    const out: { day: string; entries: JournalEntry[] }[] = [];
    for (const e of doc.data?.entries ?? []) {
      const last = out[out.length - 1];
      if (last && last.day === e.at) last.entries.push(e);
      else out.push({ day: e.at, entries: [e] });
    }
    return out;
  }, [doc.data]);

  /** Returns the promise so a caller can clear its own form ON SUCCESS. */
  const act = (what: string, p: Promise<unknown>) => {
    setBusy(what);
    setFailure(null);
    return p
      .catch((e: unknown) => {
        setFailure(e instanceof Error ? e.message : String(e));
        throw e;
      })
      .finally(() => {
        setBusy(null);
        doc.reload();
      });
  };

  return (
    <div className="grid gap-4">
      <Composer
        ventures={state.ventures.map((v) => ({ slug: v.slug, name: v.name }))}
        pinnedVenture={ventureSlug ?? null}
        onAdd={(body) => act("add", journalApi.add(body))}
        busy={busy === "add"}
      />

      <div className="flex flex-wrap items-center gap-2">
        <StreakBadge streak={doc.data?.streak ?? null} />
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="border-input bg-background h-8 rounded-lg border px-2 text-[13.5px]"
            aria-label="Filter by kind"
          >
            <option value="">Every kind</option>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {/* "all" IS ONE OF THE OPTIONS, not a separate control: the journal
              genuinely has an everything reading and a number cannot say it. */}
          <WindowPicker
            value={days === "all" ? "all" : Number(days)}
            onChange={(d) => setDays(String(d))}
            options={[...(doc.data?.windows ?? [7, 30, 90, 365]), "all"]}
          />
          <Button asChild size="sm" variant="ghost">
            <a href={journalApi.exportHref("csv", ventureSlug)}>CSV</a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={journalApi.exportHref("json", ventureSlug)}>JSON</a>
          </Button>
        </div>
      </div>

      {failure && <p className="text-destructive text-[13px]">{failure}</p>}
      {doc.error && <p className="text-destructive text-[13px]">{doc.error}</p>}
      {doc.loading && !doc.data && (
        <p className="text-muted-foreground text-[13.5px]">Reading the journal…</p>
      )}

      {doc.data && !doc.data.entries.length && (
        <p className="text-muted-foreground max-w-[560px] text-[13.5px]">
          Nothing logged in this window. This is the record of work that leaves
          no trace anywhere else — a call, a page rewritten by hand, a post
          somewhere with no API. You can also send{" "}
          <code className="text-[12.5px]">/did …</code> to your Telegram bot.
        </p>
      )}

      {groups.map((g) => (
        <div key={g.day} className="grid gap-1.5">
          <div className="text-muted-foreground flex items-baseline gap-2 text-[12.5px]">
            <span className="font-medium">{dayLabel(g.day)}</span>
            <span className="tabular-nums">{g.day}</span>
            <span>
              {g.entries.length} {g.entries.length === 1 ? "entry" : "entries"}
            </span>
          </div>
          {g.entries.map((e) => (
            <Entry
              key={e.id}
              entry={e}
              busy={busy}
              onDelete={() => act(e.id, journalApi.remove(e.id))}
              onResult={(text) => act(e.id, journalApi.setResult(e.id, text || null))}
              onTracked={() => doc.reload()}
            />
          ))}
        </div>
      ))}

      {doc.data && (
        <p className="text-muted-foreground border-line-soft max-w-[620px] border-t pt-3 text-[12px] leading-relaxed">
          {doc.data.definitions.source} {doc.data.definitions.streak}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the composer */

function Composer({
  ventures,
  pinnedVenture,
  onAdd,
  busy,
}: {
  ventures: { slug: string; name: string }[];
  pinnedVenture: string | null;
  /** Resolves when the entry is filed and REJECTS when the server refused it.
   *  The composer needs to know which: see `submit`. */
  onAdd: (body: {
    kind: string;
    text: string;
    venture?: string;
    url?: string;
    at?: string;
  }) => Promise<unknown>;
  busy: boolean;
}) {
  const [kind, setKind] = useState("did");
  const [text, setText] = useState("");
  const [venture, setVenture] = useState(pinnedVenture ?? "");
  const [url, setUrl] = useState("");
  const [at, setAt] = useState(todayLocal());

  /**
   * CLEARED ON SUCCESS ONLY, and that is not a nicety.
   *
   * These two lines used to run synchronously after the call, before the POST
   * had resolved — so a refusal ("url must be an http(s) link") threw away the
   * sentence the owner had just typed and left him a red line and an empty box.
   * For a feature whose whole thesis is that it competes with not bothering,
   * losing somebody's words is the one failure that cannot be afforded. A
   * rejection now leaves the composer exactly as it was, with the reason above
   * it, so fixing the link is an edit rather than a retype.
   */
  const submit = () => {
    if (!text.trim() || busy) return;
    void onAdd({
      kind,
      text: text.trim(),
      venture: (pinnedVenture ?? venture) || undefined,
      url: url.trim() || undefined,
      at,
    })
      .then(() => {
        setText("");
        setUrl("");
      })
      .catch(() => {
        /* Already reported above the composer by `act`. The words stay. */
      });
  };

  return (
    <div className="border-line-soft bg-card grid gap-2 rounded-[14px] p-4">
      <div className="flex flex-wrap items-center gap-1">
        {KIND_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={cn(
              "rounded-full px-2.5 py-1 text-[13px] transition-colors",
              kind === k
                ? "bg-foreground text-background"
                : "border-line-soft text-muted-foreground hover:text-foreground border",
            )}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          /* Enter files it. The composer is one line and the sentence is one
             line; a form that needed the mouse for the last step would be a
             form used less. */
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="What did you do? — “rewrote the pricing page and shipped it”"
        className="text-[14.5px]"
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {!pinnedVenture && (
          <select
            value={venture}
            onChange={(e) => setVenture(e.target.value)}
            className="border-input bg-background h-8 rounded-lg border px-2 text-[13.5px]"
            aria-label="Venture"
          >
            <option value="">No venture</option>
            {ventures.map((v) => (
              <option key={v.slug} value={v.slug}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Link (optional) — what makes a shipped or posted entry trackable"
          className="h-8 max-w-[380px] text-[13.5px]"
        />
        <Input
          type="date"
          value={at}
          max={todayLocal()}
          onChange={(e) => setAt(e.target.value)}
          className="h-8 w-[150px] text-[13.5px]"
          aria-label="The day it happened"
        />
        <Button size="sm" onClick={submit} disabled={!text.trim() || busy} className="ml-auto">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Log it
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the streak */

function StreakBadge({ streak }: { streak: Streak | null }) {
  if (!streak || !streak.days)
    return (
      <span className="text-muted-foreground text-[12.5px]">
        {streak?.agentFiled
          ? `No entries of your own yet — ${streak.agentFiled} filed by the agent.`
          : "No entries yet."}
      </span>
    );
  return (
    <span
      className="text-muted-foreground flex items-center gap-1.5 text-[12.5px]"
      /* Deliberately small and deliberately captioned. A streak counts days on
         which a sentence was typed; drawn large it would read as a measure of
         how much work was done, which it is not and cannot be. */
      title={
        "Consecutive days on which YOU filed an entry — from this page or from Telegram. " +
        "Rows the agent filed are not counted. It measures logging, not work."
      }
    >
      <Flame className="size-3.5" strokeWidth={1.6} />
      {streak.current > 0 ? (
        <>
          <b className="text-foreground font-medium tabular-nums">{streak.current}</b>
          <span>
            day{streak.current === 1 ? "" : "s"} in a row
            {streak.today ? "" : " — nothing yet today"}
          </span>
        </>
      ) : (
        <span>No run right now; last entry {streak.lastDay}.</span>
      )}
      <span className="tabular-nums">
        · longest {streak.longest} · {streak.days} days logged
      </span>
      {/* Said, not hidden: the run leaves the agent's rows out, so the page has
          to admit they exist rather than let the number stand for everything. */}
      {!!streak.agentFiled && (
        <span>· {streak.agentFiled} filed by the agent, not counted</span>
      )}
    </span>
  );
}

/* ----------------------------------------------------------------- one entry */

function Entry({
  entry,
  busy,
  onDelete,
  onResult,
  onTracked,
}: {
  entry: JournalEntry;
  busy: string | null;
  onDelete: () => void;
  onResult: (text: string) => void;
  onTracked: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.result ?? "");
  const [tracking, setTracking] = useState(false);

  return (
    <div className="border-line-soft bg-card grid gap-1 rounded-[14px] p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="border-line-soft rounded-full border px-1.5 py-0.5 text-[11.5px]">
          {KIND_LABEL[entry.kind] ?? entry.kind}
        </span>
        <span className="text-[14.5px]">{entry.text}</span>
        {entry.venture && (
          <span className="text-muted-foreground text-[12.5px]">{entry.venture.name}</span>
        )}
        {entry.url && (
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[12.5px]"
          >
            link <ExternalLink className="size-3" strokeWidth={1.6} />
          </a>
        )}
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[12px]">
        <span>{SOURCE_NOTE[entry.source] ?? entry.source}</span>
        {entry.backdated && (
          <span title={`Written on ${entry.createdAt.slice(0, 10)}, filed for ${entry.at}`}>
            back-dated
          </span>
        )}
        {entry.outcomeId && (
          <span className="text-ok">tracked as {entry.outcomeId}</span>
        )}
        {entry.trackable && !tracking && (
          <button
            type="button"
            onClick={() => setTracking(true)}
            className="hover:text-foreground flex items-center gap-1 underline-offset-2 hover:underline"
          >
            <Target className="size-3" strokeWidth={1.6} /> track outcome
          </button>
        )}
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="hover:text-foreground underline-offset-2 hover:underline"
          >
            {entry.result ? "edit result" : "add result"}
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={busy === entry.id}
          className="hover:text-destructive ml-auto flex items-center gap-1"
          aria-label="Delete this entry"
        >
          <Trash2 className="size-3" strokeWidth={1.6} />
        </button>
      </div>

      {entry.result && !editing && (
        <p className="text-muted-foreground border-line-soft mt-0.5 border-l pl-2 text-[13px]">
          {entry.result}
        </p>
      )}

      {editing && (
        <div className="mt-1 flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What came of it, in your words. Nothing here computes this."
            className="h-8 text-[13.5px]"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onResult(draft.trim());
              setEditing(false);
            }}
          >
            <Check className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}

      {tracking && (
        <TrackOutcome
          entry={entry}
          onClose={() => setTracking(false)}
          onDone={() => {
            setTracking(false);
            onTracked();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------- the outcome hand-off */

/**
 * THE METRIC IS AN ADDRESS AND THE OWNER CHOOSES IT.
 *
 * The same picker the Outcomes tab uses, for the same reason: only the person
 * looking at a document knows which field in it this piece of work should have
 * moved. Nothing is prefilled beyond the entry itself — a default address would
 * take a baseline against a figure nobody picked and hand back a verdict about
 * it a month later.
 */
function TrackOutcome({
  entry,
  onClose,
  onDone,
}: {
  entry: JournalEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  const cat = useApi(() => alertsApi.catalogue(), []);
  const [skill, setSkill] = useState("");
  const [view, setView] = useState("default");
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const skills = cat.data?.skills ?? [];
  const chosen = skills.find((s) => s.id === skill) ?? null;

  return (
    <div className="border-line-soft mt-2 grid gap-2 rounded-[11px] border border-dashed p-2.5">
      <p className="text-muted-foreground text-[12.5px] leading-snug">
        Pick the figure this should have moved. A reading is taken now and again
        at 7, 14 and 30 days after {entry.at}. Two numbers either side of a date
        is correlation — nothing here will claim a cause.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
          className="border-input bg-background h-8 rounded-lg border px-2 text-[13.5px]"
          aria-label="Which document"
        >
          <option value="">Which document…</option>
          {skills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
              {s.connected ? "" : " (not connected)"}
            </option>
          ))}
        </select>
        <select
          value={view}
          onChange={(e) => setView(e.target.value)}
          className="border-input bg-background h-8 rounded-lg border px-2 text-[13.5px]"
          aria-label="Which view"
        >
          {(chosen?.views ?? [{ key: "default" }]).map((v) => (
            <option key={v.key} value={v.key}>
              {v.key}
            </option>
          ))}
        </select>
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="totals.visitors"
          className="h-8 w-[200px] text-[13.5px]"
          aria-label="The field in it, dotted"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !skill || !path.trim()}
          onClick={() => {
            setSaving(true);
            setFailure(null);
            journalApi
              .track(entry.id, { skill, view, path: path.trim() })
              .then(() => onDone())
              .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
              .finally(() => setSaving(false));
          }}
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Take the baseline
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {failure && <p className="text-destructive text-[12.5px]">{failure}</p>}
    </div>
  );
}
