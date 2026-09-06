import { useState } from "react";
import { Link } from "react-router-dom";
import { Clapperboard, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { PostCard } from "@/components/studio/PostCard";
import { ReadinessBanner } from "@/components/studio/ReadinessBanner";
import { useApi } from "@/hooks/useApi";
import { publishingApi } from "@/areas/publishing/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  studioApi,
  type StudioFormat,
  type StudioPost,
} from "@/lib/api/studio";
/* THE UGC DOOR, added by the socialfeed area. It is a button rather than a
   second form because a UGC job is not a variation on a post: it is a video
   run, it goes on the run queue, and it belongs on the page that shows runs.
   The button only exists when the venture has reference pictures, because a
   UGC shot is a picture of a real product and there is no substitute. */
import { socialfeedApi } from "@/areas/socialfeed/api";

/**
 * THE STUDIO — a caption and a picture for one venture, in that venture's own
 * brand.
 *
 * WHY IT IS AN APP AND NOT A VENTURE TAB. Everything else about a venture is a
 * reading OF that venture; this makes something new, and the thing it makes is
 * the same thing for every venture. Sitting it beside the board and the
 * mailbox — the other two places in here that produce rather than report —
 * puts it where the eye already goes to do work, and lets the venture be a
 * picker rather than the address.
 *
 * THE VIDEO TABS ARE NOT HERE, not even greyed out. Faceless video, motion,
 * reels and shorts are things this box cannot do: there is no renderer, no
 * voice track and no timeline anywhere in the server. A row of disabled tabs
 * would be a promise made by a layout, and the owner would remember the
 * promise long after forgetting it was greyed. What exists is a still post,
 * so a still post is the whole page.
 *
 * NOTHING HERE POSTS ANYTHING ANYWHERE, and that is still true of this page
 * after publishing arrived. What changed is that a finished post can now be
 * FILED — "Send to publishing" puts it in the queue as a DRAFT, where the
 * owner reads it against a real account, approves it and schedules it. This
 * page still cannot publish and still cannot approve; Copy is still here for
 * the platforms this box has no publisher for.
 *
 * "Platform" remains a hint to the model about length and register. It is not
 * a destination: which account a post goes to is decided in the queue, with
 * that destination's capabilities and the platform's limits on screen.
 *
 * MAKING ONE COSTS MONEY AND TAKES ABOUT TWENTY SECONDS. Both facts are on
 * screen before the button is pressed: the readiness banner carries Replicate's
 * state, and the button says how long it will sit there. The wait is real —
 * Replicate is called with `Prefer: wait`, so the request is held open until
 * the picture exists — and a spinner with no sentence beside it would read as
 * a hung page.
 */

/**
 * The platforms the caption can be written for.
 *
 * A CLOSED LIST OF FIVE, AND FREE TEXT WOULD BE WORSE. The server takes any
 * string up to forty characters and passes it into the prompt, so "for
 * Threads" would work — but a picker of the five that matter is one click
 * instead of a spelling, and the sixth is not worth a text field that mostly
 * collects typos. "None" is first because a brief that is already written for
 * a place does not want a second instruction about register.
 */
const PLATFORMS = ["Instagram", "LinkedIn", "X", "Facebook", "TikTok"];

/** The venture's palette as it reads today, for the posts whose own prompt
 *  named no colours. The order matches the prompt's: the three roles, then
 *  the background. */
function palette(v: {
  brand: {
    palette: {
      primary: string | null;
      secondary: string | null;
      accent: string | null;
      background: string | null;
    };
  };
  color: string;
}): string[] {
  const p = v.brand.palette;
  const hexes = [p.primary, p.secondary, p.accent, p.background].filter(
    (h): h is string => !!h,
  );
  return hexes.length ? hexes : [v.color];
}

export function Studio() {
  const { state } = useStore();
  const ventures = state.ventures;

  /* WHICH VENTURE, BY ID — so the choice survives a rename, and falls back to
     the first venture when the one it held was deleted. The workspace's own
     default is the opening choice, which is the same venture the composer
     starts a chat against. */
  const [chosen, setChosen] = useState<string | null>(
    state.workspace.defaultVentureId,
  );
  const venture =
    ventures.find((v) => v.id === chosen) ?? ventures[0] ?? null;

  const [brief, setBrief] = useState("");
  const [format, setFormat] = useState<StudioFormat>("square");
  const [platform, setPlatform] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ugcBusy, setUgcBusy] = useState(false);
  const [ugcSaid, setUgcSaid] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /* WHICH OF THE VENTURE'S OWN PICTURES THIS POST SHOULD LOOK LIKE. Cleared
     when the venture changes, because an asset belongs to one business. */
  const [assetIds, setAssetIds] = useState<string[]>([]);

  const doc = useApi(
    () => studioApi.posts(venture?.id ?? null),
    [venture?.id ?? null],
  );

  /* The venture's asset library, and — the part that decides whether a
     selection does anything at all — whether the CURRENT image model has an
     input a picture can go in. Read off that model's own schema by the
     server; `checked: false` means it could not be asked. */
  const library = useApi(
    () => publishingApi.assets({ venture: venture?.id ?? null }),
    [venture?.id ?? null],
  );

  async function make() {
    if (!venture || !brief.trim()) return;
    setBusy(true);
    setRefused(null);
    try {
      const res = await studioApi.create({
        ventureId: venture.id,
        brief: brief.trim(),
        format,
        platform,
        assetIds,
      });
      /* The new post goes straight on the front of the list this page is
         already holding rather than triggering a refetch — the reply IS the
         post, and a second round trip would only redraw what is on screen. */
      doc.setData((d) =>
        d ? { ...d, posts: [res.post, ...d.posts] } : d,
      );
      setBrief("");
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function replace(post: StudioPost) {
    doc.setData((d) =>
      d ? { ...d, posts: d.posts.map((p) => (p.id === post.id ? post : p)) } : d,
    );
  }

  function forget(id: string) {
    doc.setData((d) =>
      d ? { ...d, posts: d.posts.filter((p) => p.id !== id) } : d,
    );
  }

  const readiness = doc.data?.readiness ?? null;
  const posts = doc.data?.posts ?? [];

  /* Queued through the socialfeed area's own route rather than through the
     Studio's: a UGC job is a run, and the run queue is not this page's. The
     answer names what will be spent, which is what goes on screen. */
  async function startUgc() {
    if (!venture) return;
    setUgcBusy(true);
    setUgcSaid(null);
    try {
      const res = await socialfeedApi.startUgc({
        venture: venture.slug,
        brief: brief.trim(),
        assets: assetIds,
      });
      setUgcSaid(
        `Queued as run ${res.run.id}. Image: ${res.spend.image}. Video: ${res.spend.video}. It lands on the Video page as a draft.`,
      );
    } catch (err) {
      setUgcSaid(err instanceof Error ? err.message : String(err));
    } finally {
      setUgcBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
      <div className="mx-auto w-full max-w-[940px]">
        <div className="mt-2 mb-6">
          <h1 className="mb-1 text-[25px] font-normal tracking-[-0.025em]">
            Studio
          </h1>
          <p className="text-muted-foreground text-[13.5px]">
            A caption and a picture for one venture, from what this box already
            knows about it. Nothing is published from here — a finished post is
            sent to{" "}
            <Link to="/social/publishing" className="underline decoration-dotted">
              Publishing
            </Link>{" "}
            as a draft, where you approve it.{" "}
            {/* THE TWO THINGS THAT FILL THIS GALLERY WITHOUT SOMEBODY TYPING
                A BRIEF. Autopilot queues posts here on a schedule; Video makes
                the moving half. Both are links rather than tabs because this
                page is where somebody already is when they want either. */}
            <Link to="/social/autopilot" className="underline decoration-dotted">
              Autopilot
            </Link>{" "}
            fills this on a schedule, and{" "}
            <Link to="/social/video" className="underline decoration-dotted">
              Video
            </Link>{" "}
            makes the moving kind.
          </p>
        </div>

        {doc.error && (
          <p className="text-muted-foreground mb-4 text-[13px]">
            The API did not answer, so nothing can be made here right now.{" "}
            <span className="text-destructive">{doc.error}</span>
          </p>
        )}

        {readiness && (
          <div className="mb-5">
            <ReadinessBanner readiness={readiness} />
          </div>
        )}

        {ventures.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            There are no ventures yet, and a post here is made out of one — the
            name, the sentence you wrote, the stage and the colours read off the
            site. Add a venture first.
          </p>
        ) : (
          <>
            {/* ------------------------------------------------ the brief */}
            <div className="bg-card grid gap-3.5 rounded-[10px] border p-3.5">
              <div className="grid gap-1.5">
                <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                  For which venture
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ventures.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => {
                        setChosen(v.id);
                        setAssetIds([]);
                      }}
                      className={cn(
                        "flex items-center gap-1.5 rounded-[9px] border px-2.5 py-1.5 text-[12.5px] transition-colors",
                        venture?.id === v.id
                          ? "border-foreground"
                          : "hover:border-line-strong",
                      )}
                    >
                      <VentureMark venture={v} size={15} />
                      {v.name}
                      <StagePill stage={v.stage} />
                    </button>
                  ))}
                </div>
                {venture && (
                  <p className="text-muted-foreground text-[11.5px]">
                    {/* WHAT THE MODEL IS ACTUALLY TOLD, named here so the
                        caption is never a surprise. The stage is the half
                        that changes what a post is allowed to say. */}
                    The model is given {venture.name}
                    {venture.description ? ", your own description" : ""}, the
                    stage, and the colours read off the site — and is told not
                    to invent a feature, a price or a launch date.
                  </p>
                )}
              </div>

              <div className="grid gap-1.5">
                <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                  What the post is about
                </div>
                <Textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="One line. “We shipped weekly digests” — not the post itself."
                  className="text-[13.5px]"
                />
              </div>

              <div className="grid gap-1.5">
                <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                  Shape
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(readiness?.formats ?? []).map((f) => (
                    <button
                      key={f.key}
                      title={f.about}
                      onClick={() => setFormat(f.key as StudioFormat)}
                      className={cn(
                        "rounded-[9px] border px-2.5 py-1.5 text-[12.5px] transition-colors",
                        format === f.key
                          ? "border-foreground"
                          : "hover:border-line-strong",
                      )}
                    >
                      {f.key}
                      <span className="text-muted-foreground ml-1.5">
                        {f.ratio}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* ------------------------------------------- the references */}
              <div className="grid gap-1.5">
                <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                  Take visual direction from
                </div>
                {(library.data?.assets ?? []).length === 0 ? (
                  <p className="text-muted-foreground text-[11.5px]">
                    {venture?.name} has no assets yet. Upload a logo, a reference picture or a
                    screenshot under{" "}
                    <Link to="/social/publishing?tab=assets" className="underline decoration-dotted">
                      Publishing → Assets
                    </Link>
                    .
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {(library.data?.assets ?? []).slice(0, 12).map((a) => (
                        <button
                          key={a.id}
                          title={a.prompt ?? a.name ?? a.kind}
                          onClick={() =>
                            setAssetIds((prev) =>
                              prev.includes(a.id)
                                ? prev.filter((x) => x !== a.id)
                                : [...prev, a.id].slice(0, 4),
                            )
                          }
                          className={cn(
                            "overflow-hidden rounded-[8px] border transition-colors",
                            assetIds.includes(a.id)
                              ? "border-foreground"
                              : "hover:border-line-strong",
                          )}
                        >
                          {a.onDisk ? (
                            <img src={a.url} alt="" className="size-12 object-cover" />
                          ) : (
                            <span className="text-muted-foreground flex size-12 items-center justify-center text-[10px]">
                              missing
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    {/* THE SENTENCE THAT DECIDES WHETHER THIS DOES ANYTHING.
                        A model with no image input gets the pictures described
                        in words instead, which is much weaker — so it is said
                        before the button is pressed rather than after. */}
                    <p className="text-muted-foreground text-[11.5px]">
                      {library.data?.imageModel.note}
                    </p>
                  </>
                )}
              </div>

              <div className="grid gap-1.5">
                <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                  Written for
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setPlatform(null)}
                    className={cn(
                      "rounded-[9px] border px-2.5 py-1.5 text-[12.5px] transition-colors",
                      platform === null
                        ? "border-foreground"
                        : "hover:border-line-strong",
                    )}
                  >
                    No platform
                  </button>
                  {PLATFORMS.map((p) => (
                    <button
                      key={p}
                      onClick={() => setPlatform(p)}
                      className={cn(
                        "rounded-[9px] border px-2.5 py-1.5 text-[12.5px] transition-colors",
                        platform === p
                          ? "border-foreground"
                          : "hover:border-line-strong",
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <p className="text-muted-foreground text-[11.5px]">
                  A hint about length and register. Nothing here logs into
                  anything.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <Button
                  disabled={busy || !venture || !brief.trim()}
                  onClick={() => void make()}
                >
                  {busy ? (
                    <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />
                  ) : (
                    <Sparkles className="size-[15px]" strokeWidth={1.8} />
                  )}
                  {busy ? "Making it…" : "Make a post"}
                </Button>
                <span className="text-muted-foreground text-[12px]">
                  {busy
                    ? "The caption first, then Replicate holds the line until the picture exists. About twenty seconds."
                    : readiness?.image.ready
                      ? "About twenty seconds, and a fraction of a cent on Replicate."
                      : "About five seconds. Without Replicate the post is stored with its words and no picture."}
                </span>
              </div>

              {refused && (
                <p className="text-destructive text-[12.5px] leading-relaxed">
                  {refused}
                </p>
              )}

              {/* ------------------------------------------------ the UGC job */}
              {venture && (library.data?.assets ?? []).length > 0 && (
                <div className="border-line-soft flex flex-wrap items-center gap-2.5 border-t pt-3">
                  <Button
                    variant="outline"
                    disabled={ugcBusy}
                    onClick={() => void startUgc()}
                  >
                    {ugcBusy ? (
                      <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />
                    ) : (
                      <Clapperboard className="size-[15px]" strokeWidth={1.8} />
                    )}
                    Make a UGC clip instead
                  </Button>
                  <span className="text-muted-foreground text-[12px]">
                    A product shot from {venture.name}'s own pictures, animated. It is queued as a
                    video run and it SPENDS MONEY — one image prediction always, and one
                    image-to-video prediction if a model is configured under Integrations → Social
                    feed. With none configured it makes a still and spends nothing on video.
                  </span>
                  {ugcSaid && <p className="w-full text-[12.5px]">{ugcSaid}</p>}
                </div>
              )}
            </div>

            {/* ---------------------------------------------- the gallery */}
            <div className="mt-7 mb-3 flex items-baseline gap-2">
              <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                Made for {venture?.name}
              </div>
              <span className="text-muted-foreground ml-auto text-[11.5px]">
                {doc.loading
                  ? "loading…"
                  : posts.length === 0
                    ? "nothing yet"
                    : `${posts.length} ${posts.length === 1 ? "post" : "posts"}, newest first`}
              </span>
            </div>

            {posts.length === 0 && !doc.loading ? (
              <p className="text-muted-foreground text-[13px]">
                Nothing has been made for {venture?.name} yet. A post is kept
                until you delete it, and deleting one deletes its picture off
                the disk with it.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {posts.map((p) => (
                  <PostCard
                    key={p.id}
                    post={p}
                    palette={venture ? palette(venture) : undefined}
                    onChanged={replace}
                    onDeleted={forget}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
