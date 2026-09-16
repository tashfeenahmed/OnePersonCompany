/**
 * THE TIMELINE READ BACK FROM META — the return leg of Publishing.
 *
 * WHY THIS IS A COMPONENT AND NOT A PAGE. Publishing is the queue: what this
 * box made and where it is going. This is what came back, and the two are
 * joined on the post's own id, so a draft generated here can finally be looked
 * at next to what it did. That is one screen's worth of argument, not two, so
 * the timeline lives here and the Publishing page shows it as its own tab; the
 * old Posts page renders exactly this and nothing else.
 *
 * THE METRIC NAMES ARE META'S AND ARE DRAWN AS SUCH. There is no "reach"
 * column and there will not be one. `post_media_view` counts renders,
 * Instagram's `reach` counts unique accounts, and a shared column head would
 * be this component asserting they are the same figure. So the chips under a
 * post carry the platform's own spelling, and a metric that is absent has no
 * chip at all rather than a zero.
 *
 * THE ACCOUNTS STRIP IS ABOVE THE POSTS ON PURPOSE. A Page that failed its
 * last read still shows its old posts, and a list of stale posts with no
 * warning above it is the failure mode this has to avoid. Two dates — last
 * read, last tried — because a failing Page keeps the date it last worked, and
 * one date could not say that.
 *
 * THE VENTURE IS THE CALLER'S. Publishing already carries one in its URL and
 * every one of its tabs is per venture; this takes the id it chose (null being
 * every venture) and turns it into the slug the API filters on. It draws no
 * picker of its own — a page with two of them for one list is a page that can
 * disagree with itself — but it will put whatever control the caller hands it
 * as `lead` at the head of its own toolbar row, so the picker and the collect
 * button stay on one line where a page does have its own.
 */
import { when } from "@/lib/format";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { SocialPlatformLabel } from "@/components/SocialPlatform";
import { socialfeedApi, type SocialAccount, type SocialPost } from "./api";

export function PublishedTimeline({
  ventureId,
  lead,
}: {
  /** The venture whose timeline to read, or null for every venture. */
  ventureId: string | null;
  /** A control to sit at the head of the toolbar row — a venture picker, for a
   *  caller that has its own. */
  lead?: ReactNode;
}) {
  const { state } = useStore();
  const ventures = state.ventures;
  /* THE API FILTERS BY SLUG, the caller speaks in ids. A slug survives being
     read out loud, which is why the URL carries one; an id is what every other
     component here passes around. */
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
  /* THE STRIP IS ABOUT THE VENTURE IN VIEW. The server filters the POSTS by
     venture and sends EVERY account it has ever read, which was invisible while
     this defaulted to every venture and is not here: Publishing opens on one
     business, and three other businesses' Pages standing above that business's
     empty list would be the screen answering a question nobody asked. Filtered
     on this side, where the choice was made — the server's document is right,
     it just answers a wider question than this tab is asking. */
  const accounts = useMemo(
    () => (ventureId ? (d?.accounts ?? []).filter((a) => a.ventureId === ventureId) : (d?.accounts ?? [])),
    [d, ventureId],
  );
  const problems = useMemo(() => accounts.filter((a) => a.error || a.insightsError), [accounts]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {lead}
        <Button variant="outline" disabled={busy} onClick={() => void collect()}>
          {busy ? <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} /> : <RefreshCw className="size-[15px]" strokeWidth={1.8} />}
          Read the timelines
        </Button>
        <span className="text-muted-foreground text-[12.5px]">
          {d?.lastReadAt ? `Last read ${when(d.lastReadAt, { year: true })}` : "Not read since this server started"}
        </span>
        {said && <span className="text-[12.5px]">{said}</span>}
      </div>

      {doc.error && (
        <p className="text-muted-foreground mb-4 text-[14px]">
          The posts API did not answer. <span className="text-destructive">{doc.error}</span>
        </p>
      )}
      {!d && !doc.error && <p className="text-muted-foreground text-[14px]">Reading…</p>}

      {d && (
        <>
          {/* ------------------------------------------- the accounts */}
          <div className="text-muted-foreground mt-1 mb-2 text-[12px] tracking-[0.06em] uppercase">
            Where these were read from
          </div>
          {accounts.length === 0 ? (
            <p className="text-muted-foreground text-[14px]">
              {ventureId
                ? "No Page is mapped to this venture, so nothing has been read for it. "
                : "No Page has been read yet. "}
              A Page is only read once it is mapped to a venture under{" "}
              <Link to="/social/studio/publishing?tab=destinations" className="underline decoration-dotted">
                Publishing → Destinations
              </Link>{" "}
              — a Meta token can administer Pages belonging to businesses this box has never heard of.
            </p>
          ) : (
            <div className="flex flex-col gap-px">
              {accounts.map((a) => (
                <AccountLine key={`${a.platform}:${a.pageId}`} account={a} />
              ))}
            </div>
          )}
          {/* THE COVERAGE LINE IS ABOUT "THESE PAGES", so it is drawn only when
              there are some. With a venture chosen and no Page mapped to it the
              line above has already said everything there is to say, and this
              one would be pointing at an empty list. */}
          {(accounts.length > 0 || !ventureId) && (
            <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">
              {/* NULL IS NOT ZERO. Before anything has been read this knows
                  nothing about Instagram, and saying "none is linked" then
                  would be a claim about Meta made out of an empty table. */}
              {d.coverage.instagramLinked === null
                ? "Nothing has been read yet, so whether any Instagram business account is linked is not known."
                : d.coverage.instagramLinked === 0
                  ? "No Instagram business account is linked to any of these Pages, so there is no Instagram media here. That is “not linked”, not “no posts”."
                  : `${d.coverage.instagramLinked} Instagram account${d.coverage.instagramLinked === 1 ? "" : "s"} linked.`}{" "}
              {d.coverage.note}
            </p>
          )}

          {problems.length > 0 && (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              {problems.length} account{problems.length === 1 ? "" : "s"} reported a problem — Meta's own words are on
              each row above. (#210) wants a Page token, (#100) means the metric no longer exists and (#190) means the
              wrong kind of token; they are three different fixes.
            </p>
          )}

          {/* ---------------------------------------------- the posts */}
          <div className="text-muted-foreground mt-7 mb-2 text-[12px] tracking-[0.06em] uppercase">
            {d.posts.length} post{d.posts.length === 1 ? "" : "s"}
          </div>
          {d.posts.length === 0 ? (
            <p className="text-muted-foreground text-[14px]">
              Nothing has been read yet. Press “Read the timelines”.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {d.posts.map((p) => (
                <PostCard key={`${p.platform}:${p.id}`} post={p} />
              ))}
            </div>
          )}

          <div className="text-muted-foreground mt-6 space-y-1.5 text-[12.5px] leading-relaxed">
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
  );
}

function AccountLine({ account: a }: { account: SocialAccount }) {
  const bad = Boolean(a.error);
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1 text-[13.5px]">
      <span className={cn("size-1.5 shrink-0 rounded-full", bad ? "bg-destructive" : a.lastOkAt ? "bg-ok" : "bg-warn")} />
      <span className="min-w-[140px] truncate">{a.pageName ?? a.pageId}</span>
      <SocialPlatformLabel platform={a.platform} className="text-muted-foreground text-[12.5px]" />
      {a.ventureName && <span className="text-muted-foreground text-[12.5px]">{a.ventureName}</span>}
      <span className="text-muted-foreground text-[12.5px]">
        {a.posts === null ? "no posts read" : `${a.posts} posts`}
      </span>
      {/* TWO DATES, because a failing Page keeps the date it last worked and
          one date could not say that. */}
      <span className="text-muted-foreground text-[12.5px]">
        read {when(a.lastOkAt, { year: true })}
        {a.lastTriedAt && a.lastTriedAt !== a.lastOkAt ? ` · tried ${when(a.lastTriedAt, { year: true })}` : ""}
      </span>
      {a.error && <span className="text-destructive w-full text-[12.5px]">{a.error}</span>}
      {a.insightsError && <span className="text-warn w-full text-[12.5px]">{a.insightsError}</span>}
    </div>
  );
}

function PostCard({ post: p }: { post: SocialPost }) {
  const metrics = Object.entries(p.metrics);
  return (
    <div className="bg-card border-line-soft rounded-xl p-4">
      <div className="flex gap-3">
        {p.imageUrl && (
          /* The platform's own render. It is not proxied: these are public CDN
             URLs on a post that is already public. */
          <img src={p.imageUrl} alt="" className="border-line-soft size-16 shrink-0 rounded-lg border object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
            <SocialPlatformLabel platform={p.platform} className="text-muted-foreground" />
            {p.pageName && <span className="text-muted-foreground">{p.pageName}</span>}
            {p.mediaType && <span className="text-muted-foreground">{p.mediaType}</span>}
            <span className="text-muted-foreground">{when(p.createdTime, { year: true })}</span>
            {p.fromDraft && (
              <Link to="/social/studio/publishing?tab=queue" className="text-ok underline decoration-dotted">
                from draft {p.fromDraft.id}
              </Link>
            )}
            {p.permalink && (
              <a href={p.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-dotted">
                open <ExternalLink className="size-3" strokeWidth={1.8} />
              </a>
            )}
          </div>
          <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{p.text ?? <span className="text-muted-foreground">No text.</span>}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {metrics.length === 0 ? (
              <span className="text-muted-foreground text-[12.5px]">
                No metric came back for this post. That is a Page permission, not zero engagement.
              </span>
            ) : (
              metrics.map(([name, value]) => (
                /* THE PLATFORM'S OWN NAME, in a monospace chip so it reads as a
                   field name rather than as a label somebody wrote. */
                <span key={name} className="bg-accent rounded-md px-1.5 py-0.5 font-mono text-[12px]">
                  {name} {value}
                </span>
              ))
            )}
          </div>
          {p.note && <p className="text-muted-foreground mt-1 text-[12.5px]">{p.note}</p>}
        </div>
      </div>
    </div>
  );
}
