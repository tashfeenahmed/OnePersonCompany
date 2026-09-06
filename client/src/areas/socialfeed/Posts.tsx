/**
 * POSTS — what actually went out, read back from the platform.
 *
 * WHY THIS PAGE EXISTS BESIDE PUBLISHING. Publishing is the queue: what this
 * box made and where it is going. This is the return leg — the timeline as
 * Meta reports it — and the two are joined on the post's own id, so a draft
 * generated here can finally be looked at next to what it did. Everything else
 * in this section shows work going out; this is the only screen that shows it
 * coming back.
 *
 * THE METRIC NAMES ARE META'S AND ARE DRAWN AS SUCH. There is no "reach"
 * column and there will not be one. `post_media_view` counts renders,
 * Instagram's `reach` counts unique accounts, and a shared column head would
 * be this page asserting they are the same figure. So the chips under a post
 * carry the platform's own spelling, and a metric that is absent has no chip
 * at all rather than a zero.
 *
 * THE ACCOUNTS STRIP IS ABOVE THE POSTS ON PURPOSE. A Page that failed its
 * last read still shows its old posts, and a list of stale posts with no
 * warning above it is the failure mode this page has to avoid. Two dates —
 * last read, last tried — because a failing Page keeps the date it last
 * worked, and one date could not say that.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VentureSelect } from "@/components/VentureSelect";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { socialfeedApi, type SocialAccount, type SocialPost } from "./api";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function Posts() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [ventureId, setVentureId] = useState<string | null>(null);
  const slug = ventures.find((v) => v.id === ventureId)?.slug;
  const doc = useApi(() => socialfeedApi.posts({ venture: slug, limit: 100 }), [slug]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  async function collect() {
    setBusy(true);
    setSaid(null);
    try {
      const res = await socialfeedApi.collect();
      setSaid(
        res.ok
          ? `${res.posts} posts from ${res.pages} page${res.pages === 1 ? "" : "s"}${res.problems.length ? ` · ${res.problems.length} refused` : ""}`
          : (res.error ?? "nothing was read"),
      );
      doc.reload();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const d = doc.data;
  const problems = useMemo(() => (d?.accounts ?? []).filter((a) => a.error || a.insightsError), [d]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
      <div className="mx-auto w-full max-w-[1040px]">
        <div className="mt-2 mb-5">
          <h1 className="mb-1 text-[25px] font-normal tracking-[-0.025em]">Posts</h1>
          <p className="text-muted-foreground text-[13.5px]">
            The timeline read back from Meta. A post marked <em>from a draft</em> came out of
            something this box made and filed under{" "}
            <Link to="/social/publishing" className="underline decoration-dotted">
              Publishing
            </Link>
            ; everything else was posted somewhere else.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <VentureSelect ventures={ventures} value={ventureId} onChange={setVentureId} none="Every venture" />
          <Button variant="outline" disabled={busy} onClick={() => void collect()}>
            {busy ? <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} /> : <RefreshCw className="size-[15px]" strokeWidth={1.8} />}
            Read the timelines
          </Button>
          <span className="text-muted-foreground text-[11.5px]">
            {d?.lastReadAt ? `Last read ${when(d.lastReadAt)}` : "Not read since this server started"}
          </span>
          {said && <span className="text-[11.5px]">{said}</span>}
        </div>

        {doc.error && (
          <p className="text-muted-foreground mb-4 text-[13px]">
            The posts API did not answer. <span className="text-destructive">{doc.error}</span>
          </p>
        )}
        {!d && !doc.error && <p className="text-muted-foreground text-[13px]">Reading…</p>}

        {d && (
          <>
            {/* ------------------------------------------- the accounts */}
            <div className="text-muted-foreground mt-1 mb-2 text-[11px] tracking-[0.06em] uppercase">
              Where these were read from
            </div>
            {d.accounts.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                No Page has been read yet. A Page is only read once it is mapped to a venture under{" "}
                <Link to="/social/publishing?tab=destinations" className="underline decoration-dotted">
                  Publishing → Destinations
                </Link>{" "}
                — a Meta token can administer Pages belonging to businesses this box has never heard of.
              </p>
            ) : (
              <div className="flex flex-col gap-px">
                {d.accounts.map((a) => (
                  <AccountLine key={`${a.platform}:${a.pageId}`} account={a} />
                ))}
              </div>
            )}
            <p className="text-muted-foreground mt-1.5 text-[11.5px] leading-relaxed">
              {/* NULL IS NOT ZERO. Before anything has been read this page knows
                  nothing about Instagram, and saying "none is linked" then would
                  be a claim about Meta made out of an empty table. */}
              {d.coverage.instagramLinked === null
                ? "Nothing has been read yet, so whether any Instagram business account is linked is not known."
                : d.coverage.instagramLinked === 0
                  ? "No Instagram business account is linked to any of these Pages, so there is no Instagram media here. That is “not linked”, not “no posts”."
                  : `${d.coverage.instagramLinked} Instagram account${d.coverage.instagramLinked === 1 ? "" : "s"} linked.`}{" "}
              {d.coverage.note}
            </p>

            {problems.length > 0 && (
              <p className="text-muted-foreground mt-2 text-[11.5px]">
                {problems.length} account{problems.length === 1 ? "" : "s"} reported a problem — Meta's own words are on
                each row above. (#210) wants a Page token, (#100) means the metric no longer exists and (#190) means the
                wrong kind of token; they are three different fixes.
              </p>
            )}

            {/* ---------------------------------------------- the posts */}
            <div className="text-muted-foreground mt-7 mb-2 text-[11px] tracking-[0.06em] uppercase">
              {d.posts.length} post{d.posts.length === 1 ? "" : "s"}
            </div>
            {d.posts.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                Nothing has been read yet. Press “Read the timelines”.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {d.posts.map((p) => (
                  <PostCard key={`${p.platform}:${p.id}`} post={p} />
                ))}
              </div>
            )}

            <div className="text-muted-foreground mt-6 space-y-1.5 text-[11.5px] leading-relaxed">
              <p>{d.metrics.note}</p>
              <p>
                Still valid on this Graph version: <code>{d.metrics.facebook.join(", ")}</code>. Retired by Meta on 15
                November 2025 and now a hard error rather than a null:{" "}
                <code>{d.metrics.retired.join(", ")}</code>.
              </p>
              <p>{d.note}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AccountLine({ account: a }: { account: SocialAccount }) {
  const bad = Boolean(a.error);
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1 text-[12.5px]">
      <span className={cn("size-1.5 shrink-0 rounded-full", bad ? "bg-destructive" : a.lastOkAt ? "bg-ok" : "bg-warn")} />
      <span className="min-w-[140px] truncate">{a.pageName ?? a.pageId}</span>
      <span className="text-muted-foreground text-[11.5px]">{a.platform}</span>
      {a.ventureName && <span className="text-muted-foreground text-[11.5px]">{a.ventureName}</span>}
      <span className="text-muted-foreground text-[11.5px]">
        {a.posts === null ? "no posts read" : `${a.posts} posts`}
      </span>
      {/* TWO DATES, because a failing Page keeps the date it last worked and
          one date could not say that. */}
      <span className="text-muted-foreground text-[11.5px]">
        read {when(a.lastOkAt)}
        {a.lastTriedAt && a.lastTriedAt !== a.lastOkAt ? ` · tried ${when(a.lastTriedAt)}` : ""}
      </span>
      {a.error && <span className="text-destructive w-full text-[11.5px]">{a.error}</span>}
      {a.insightsError && <span className="text-warn w-full text-[11.5px]">{a.insightsError}</span>}
    </div>
  );
}

function PostCard({ post: p }: { post: SocialPost }) {
  const metrics = Object.entries(p.metrics);
  return (
    <div className="bg-card border-line-soft rounded-xl border p-3">
      <div className="flex gap-3">
        {p.imageUrl && (
          /* The platform's own render. It is not proxied: these are public CDN
             URLs on a post that is already public. */
          <img src={p.imageUrl} alt="" className="border-line-soft size-16 shrink-0 rounded-lg border object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
            <span className="text-muted-foreground">{p.platform}</span>
            {p.pageName && <span className="text-muted-foreground">{p.pageName}</span>}
            {p.mediaType && <span className="text-muted-foreground">{p.mediaType}</span>}
            <span className="text-muted-foreground">{when(p.createdTime)}</span>
            {p.fromDraft && (
              <Link to="/social/publishing" className="text-ok underline decoration-dotted">
                from draft {p.fromDraft.id}
              </Link>
            )}
            {p.permalink && (
              <a href={p.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-dotted">
                open <ExternalLink className="size-3" strokeWidth={1.8} />
              </a>
            )}
          </div>
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{p.text ?? <span className="text-muted-foreground">No text.</span>}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {metrics.length === 0 ? (
              <span className="text-muted-foreground text-[11.5px]">
                No metric came back for this post. That is a Page permission, not zero engagement.
              </span>
            ) : (
              metrics.map(([name, value]) => (
                /* THE PLATFORM'S OWN NAME, in a monospace chip so it reads as a
                   field name rather than as a label somebody wrote. */
                <span key={name} className="bg-accent rounded-md px-1.5 py-0.5 font-mono text-[11px]">
                  {name} {value}
                </span>
              ))
            )}
          </div>
          {p.note && <p className="text-muted-foreground mt-1 text-[11.5px]">{p.note}</p>}
        </div>
      </div>
    </div>
  );
}
