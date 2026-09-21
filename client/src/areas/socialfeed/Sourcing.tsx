/**
 * SOURCES AND HISTORY — the two panels the Autopilot page grew when the gate
 * landed.
 *
 * THEY ARE HERE RATHER THAN IN THE AUTOPILOT PAGE because they are this area's
 * data and this area's vocabulary; the Autopilot page imports them and adds a
 * tab strip. That keeps the diff on a file another area owns to a handful of
 * lines and keeps every sentence about refusals in one place.
 *
 * A REFUSAL IS DRAWN IN THE MUTED TONE AND NOT THE DESTRUCTIVE ONE, which is
 * the whole design of both panels. "Refused: 62% of this topic's words were
 * already used on 12 August" is the feature working — a duplicate video was
 * not made and nothing was spent — and colouring it red would turn a correctly
 * quiet week into what looks like an outage. Only a `failed` is red, and
 * neither of these panels has one, because a gate cannot fail: it can only
 * allow or refuse.
 */
import { when } from "@/lib/format";
import { useState } from "react";
import { Archive, ExternalLink, Loader2, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VentureSelect } from "@/components/VentureSelect";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { socialfeedApi, type Candidate, type HistoryEntry, type SourcingDoc, type Verdict } from "./api";

const mins = (s: number | null) => (s === null ? null : `${Math.round(s / 60)} min`);

/* ------------------------------------------------------------- the sources */

export function Sources() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [ventureId, setVentureId] = useState<string | null>(null);
  const slug = ventures.find((v) => v.id === ventureId)?.slug;
  const doc = useApi(() => socialfeedApi.sourcing({ venture: slug, limit: 120 }), [slug]);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  async function search() {
    if (!slug) {
      setSaid("Choose a venture. Discovery searches for footage this business's audience would watch.");
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      const res = await socialfeedApi.discover(slug, topic);
      setSaid(
        res.error ??
          `${res.why}${res.enginesRefused.length ? ` · engines that refused: ${res.enginesRefused.map((e) => `${e.engine} (${e.reason})`).join(", ")}` : ""}`,
      );
      doc.reload();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const d = doc.data;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <VentureSelect ventures={ventures} value={ventureId} onChange={setVentureId} none="Every venture" />
        <Input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="What should the footage be about? The problem, not the product."
          className="h-9 max-w-[420px] flex-1 text-[13.5px]"
        />
        <Button variant="outline" disabled={busy} onClick={() => void search()}>
          {busy ? <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} /> : <Search className="size-[15px]" strokeWidth={1.8} />}
          Find sources
        </Button>
      </div>
      <p className="text-muted-foreground mb-3 text-[12.5px]">
        One or two searches on your own SearXNG node and a handful of yt-dlp metadata reads. Nothing is downloaded and no
        model is called, so this costs nothing.
      </p>
      {said && <p className="mb-3 text-[13.5px]">{said}</p>}

      {doc.error && (
        <p className="text-muted-foreground mb-3 text-[14px]">
          The sourcing API did not answer. <span className="text-destructive">{doc.error}</span>
        </p>
      )}

      {d && (
        <>
          <SettingsLine doc={d} />
          <div className="text-muted-foreground mt-5 mb-2 text-[12px] tracking-[0.06em] uppercase">
            {d.candidates.length} candidate{d.candidates.length === 1 ? "" : "s"} from the last search
          </div>
          {d.candidates.length === 0 ? (
            <p className="text-muted-foreground text-[14px]">
              No search has been run yet. A shorts job needs a source video, and this is where one is found.
            </p>
          ) : (
            <div className="flex flex-col gap-px">
              {d.candidates.map((c) => (
                <CandidateLine key={c.id} candidate={c} />
              ))}
            </div>
          )}
          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
            Ranked by duration fit, recency where a date exists and how many engines carried the link — arithmetic, not a
            model. A duration marked <code>searxng</code> is the engine's own string and is sometimes wrong;{" "}
            <code>yt-dlp</code> is the file's real metadata and is only read for the top few.
          </p>
        </>
      )}
    </>
  );
}

function SettingsLine({ doc: d }: { doc: SourcingDoc }) {
  return (
    <p className="text-muted-foreground text-[12.5px] leading-relaxed">
      Sources between {d.settings.minMinutes} and {d.settings.maxMinutes} minutes; the top {d.settings.probeTop} get
      their real duration read with yt-dlp.{" "}
      {d.settings.channels.length
        ? `Own channels named for: ${d.settings.channels.map((c) => c.venture).join(", ")}.`
        : "No venture names its own video channel, so every search is of the open web only."}
    </p>
  );
}

function CandidateLine({ candidate: c }: { candidate: Candidate }) {
  const refused = c.verdict === "refused";
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1 text-[13.5px]">
      <span className={cn("w-6 shrink-0 text-right text-[12.5px]", refused ? "text-muted-foreground" : "")}>{c.rank ?? "—"}</span>
      <a
        href={c.url}
        target="_blank"
        rel="noreferrer"
        className={cn("min-w-[180px] flex-1 truncate underline decoration-dotted", refused && "text-muted-foreground")}
      >
        {c.title ?? c.url}
      </a>
      {c.author && <span className="text-muted-foreground text-[12.5px]">{c.author}</span>}
      <span className="text-muted-foreground text-[12.5px]">
        {mins(c.durationS) ?? "length unknown"}
        {c.durationFrom ? ` (${c.durationFrom})` : ""}
      </span>
      {c.engine && <span className="text-muted-foreground text-[12.5px]">{c.engine}</span>}
      {/* A REFUSAL IS MUTED AND NEVER RED — see the header. */}
      {refused ? (
        <span className="text-muted-foreground text-[12.5px]">refused — {c.reason}</span>
      ) : (
        <span className="text-ok text-[12.5px]">{c.score !== null ? c.score.toFixed(2) : "—"}</span>
      )}
      <a href={c.url} target="_blank" rel="noreferrer" className="text-muted-foreground">
        <ExternalLink className="size-3" strokeWidth={1.8} />
      </a>
    </div>
  );
}

/* ------------------------------------------------------------- the history */

export function History() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [ventureId, setVentureId] = useState<string | null>(null);
  const slug = ventures.find((v) => v.id === ventureId)?.slug;
  const doc = useApi(() => socialfeedApi.sourcing({ venture: slug, limit: 120 }), [slug]);
  const [said, setSaid] = useState<string | null>(null);
  /* THE ROW THE NEXT CLICK WILL ARCHIVE. One click arms, the second acts —
     because this changes what the gate will let through, and a single click
     beside a sentence explaining the consequence is not a decision. */
  const [arming, setArming] = useState<number | null>(null);

  async function archive(id: number) {
    setSaid(null);
    setArming(null);
    try {
      const res = await socialfeedApi.forget(id);
      setSaid(res.already ? "That entry was already archived." : res.note);
      doc.reload();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    }
  }

  async function restore(id: number) {
    setSaid(null);
    try {
      const res = await socialfeedApi.restore(id);
      setSaid(res.note);
      doc.reload();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    }
  }

  const d = doc.data;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <VentureSelect ventures={ventures} value={ventureId} onChange={setVentureId} none="Every venture" />
        {d && (
          <span className="text-muted-foreground text-[12.5px]">
            A topic is put to a model against everything made in the last {d.settings.noveltyDays} days and refused only
            if it judges it the same piece of work. A source video is refused forever — for the venture that used it.
            Finished work is announced on {d.settings.deliverTo === "off" ? "nothing; the delivery message is switched off" : d.settings.deliverTo}.
          </span>
        )}
      </div>
      {said && <p className="mb-3 text-[13.5px]">{said}</p>}

      {doc.error && (
        <p className="text-muted-foreground mb-3 text-[14px]">
          The sourcing API did not answer. <span className="text-destructive">{doc.error}</span>
        </p>
      )}

      {d && (
        <>
          <div className="text-muted-foreground mb-2 text-[12px] tracking-[0.06em] uppercase">
            Every verdict the gate has given
          </div>
          {d.verdicts.length === 0 ? (
            <p className="text-muted-foreground text-[14px]">
              The gate has never been asked. It runs when the autopilot derives a topic, before anything is generated.
            </p>
          ) : (
            <div className="flex flex-col gap-px">
              {d.verdicts.map((v) => (
                <VerdictLine key={v.id} verdict={v} />
              ))}
            </div>
          )}

          <div className="text-muted-foreground mt-7 mb-2 text-[12px] tracking-[0.06em] uppercase">
            What has already been made
          </div>
          {d.history.length === 0 ? (
            <p className="text-muted-foreground text-[14px]">
              Nothing yet. A row is written the moment work is queued — not when it finishes, because a run that failed
              still used up its topic.
            </p>
          ) : (
            <div className="flex flex-col gap-px">
              {d.history.map((h) => (
                <HistoryLine
                  key={h.id}
                  entry={h}
                  armed={arming === h.id}
                  onArm={() => setArming(h.id)}
                  onArchive={() => void archive(h.id)}
                  onRestore={() => void restore(h.id)}
                />
              ))}
            </div>
          )}
          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
            Archiving an entry is how the gate is overruled: the topic it was blocking is allowed again. The row is
            <em> not</em> deleted — it stays here, greyed, and Restore puts it back.
          </p>

          {d.deliveries.length > 0 && (
            <>
              <div className="text-muted-foreground mt-7 mb-2 text-[12px] tracking-[0.06em] uppercase">
                Finished work handed over
              </div>
              <div className="flex flex-col gap-px">
                {d.deliveries.map((x) => (
                  <div key={x.ref} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1 text-[13.5px]">
                    <span className={cn("size-1.5 shrink-0 rounded-full", x.sent ? "bg-ok" : "bg-warn")} />
                    <span className="min-w-[110px]">{x.ref}</span>
                    <span className="text-muted-foreground text-[12.5px]">{when(x.at)}</span>
                    <span className="text-muted-foreground text-[12.5px]">
                      {x.sent ? `sent on ${x.channel}` : `not sent — ${x.reason ?? "no reason recorded"}`}
                    </span>
                    {x.publishItem && <span className="text-ok text-[12.5px]">draft {x.publishItem}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function VerdictLine({ verdict: v }: { verdict: Verdict }) {
  const refused = v.verdict === "refuse";
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 py-1 text-[13.5px]">
      <span className={cn("w-[52px] shrink-0 text-[12.5px]", refused ? "text-muted-foreground" : "text-ok")}>
        {refused ? "refused" : "allowed"}
      </span>
      <span className="text-muted-foreground w-[46px] shrink-0 text-[12.5px]">{v.kind}</span>
      <span className="min-w-[180px] flex-1 truncate">{v.value}</span>
      <span className="text-muted-foreground text-[12.5px]">{when(v.ts)}</span>
      {v.reason && <span className="text-muted-foreground w-full text-[12.5px] leading-relaxed">{v.reason}</span>}
    </div>
  );
}

function HistoryLine({
  entry: h,
  armed,
  onArm,
  onArchive,
  onRestore,
}: {
  entry: HistoryEntry;
  armed: boolean;
  onArm: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const archived = h.archivedAt !== null;
  return (
    <div className="group flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1 text-[13.5px]">
      <span className="text-muted-foreground w-[62px] shrink-0 text-[12.5px]">{h.format}</span>
      {/* An archived row stays in the list and reads as set aside rather than
          as gone, which is the whole point of archiving instead of deleting. */}
      <span className={cn("min-w-[180px] flex-1 truncate", archived && "text-muted-foreground line-through")}>
        {h.topic}
      </span>
      {h.ventureName && <span className="text-muted-foreground text-[12.5px]">{h.ventureName}</span>}
      {h.sourceUrl && (
        <a href={h.sourceUrl} target="_blank" rel="noreferrer" className="text-muted-foreground text-[12.5px] underline decoration-dotted">
          source
        </a>
      )}
      <span className="text-muted-foreground text-[12.5px]">{when(h.createdAt)}</span>
      {archived ? (
        <button
          onClick={onRestore}
          title="Count this again, so its topic is refused as a repeat"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[12.5px]"
        >
          <RotateCcw className="size-3.5" strokeWidth={1.8} /> restore
        </button>
      ) : armed ? (
        <button
          onClick={onArchive}
          className="text-destructive inline-flex items-center gap-1 text-[12.5px]"
          title="Archive it — the row stays and the gate stops counting it"
        >
          <Archive className="size-3.5" strokeWidth={1.8} /> archive it?
        </button>
      ) : (
        <button
          onClick={onArm}
          title="Archive this, so the topic it blocks is allowed again"
          className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Archive className="size-3.5" strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}
