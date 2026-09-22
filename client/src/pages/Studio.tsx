import { SelectField, SelectOption } from "@/components/ui/select-field";
import studioHeader from "@/assets/studio/digital-studio.webp";
import { Suspense, lazy, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Clapperboard,
  ChevronDown,
  Film,
  GalleryHorizontal,
  Image as ImageIcon,
  Loader2,
  Menu,
  Play,
  Scissors,
  Search,
  Send,
  Shapes,
  Palette,
  Sparkles,
  Timer,
  Tv,
  Video as VideoIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { MotionNarration } from "@/components/studio/MotionNarration";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VentureSelect } from "@/components/VentureSelect";
import { GenerationMenu } from "@/components/studio/GenerationMenu";
import { PostCard } from "@/components/studio/PostCard";
import { ReadinessBanner } from "@/components/studio/ReadinessBanner";
import { ShapePicker } from "@/components/studio/ShapePicker";
import { ASPECT_OPTIONS } from "@/data/mediaShapes";
import { SocialPlatformLabel } from "@/components/SocialPlatform";
import { GameplayPicker } from "@/components/studio/GameplayPicker";
import { gameplayLabel } from "../../../shared/gameplay";
import { shortsClipCount } from "../../../shared/studioInputs";
import { MotionReadinessNote, NewSceneListButton, SceneListEditor } from "@/components/studio/SceneListEditor";
import { RunSteps } from "@/components/runs/RunSteps";
import { VideoResult } from "@/areas/video/VideoResult";
import { useApi } from "@/hooks/useApi";
import { publishingApi } from "@/areas/publishing/api";
import { socialfeedApi } from "@/areas/socialfeed/api";
import { useStore, type Venture } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ago, when } from "@/lib/format";
import { appPage } from "../../../shared/navigation";
import { studioApi, type StudioFormat, type StudioPost, type StudioReadiness } from "@/lib/api/studio";
import { autopilotApi, stewieApi, videoApi, youtubeApi, type VideoJob, type YoutubeHit } from "@/lib/api/video";
import { motionApi } from "@/lib/api/motion";
import { carouselApi, type Carousel } from "@/lib/api/carousel";
import { CarouselResult } from "@/components/studio/CarouselResult";
import { CAROUSEL_SIZES, DEFAULT_CAROUSEL_SIZE, type CarouselSize } from "../../../shared/carousel";
import { isLive, runsApi, type RunDetail, type RunSummary } from "@/lib/api/runs";

/* THE THREE PAGES THE RAIL OPENS BESIDE ITSELF, loaded when one is asked for
   rather than with the Studio: somebody who came here to make a picture
   should not wait for the publishing queue's code. Each is the same component
   its own address used to render — nothing was forked. */
const Autopilot = lazy(() => import("@/areas/video/Autopilot").then((m) => ({ default: m.Autopilot })));
const Publishing = lazy(() => import("@/areas/publishing/Publishing").then((m) => ({ default: m.Publishing })));
const References = lazy(() => import("@/pages/References").then((m) => ({ default: m.References })));

/**
 * THE STUDIO — every way this box makes a post or a video, on one page.
 *
 * It was a still-post page with a UGC button on it, and the five video
 * pipelines each had a page of their own: the Video run form, the Motion
 * editor, Autopilot, Publishing. A run's own page is still where its steps,
 * its retries and its note live, and Autopilot and Publishing still draw as
 * themselves — in this page's column now — but the DOOR to all of them is
 * here, because the owner reaching for "make something" should not first have
 * to know which of six pages makes it. The Motion editor has stopped being a
 * page at all: it is drawn under this page's Motion tab and its address
 * redirects here (see App.tsx).
 *
 * THE SHAPE. A title, one row of tabs — Image post, Carousel, UGC clip,
 * Faceless, Shorts, Motion, Stewie — and under the chosen tab the fewest fields that
 * pipeline needs. Everything ever made, of every kind, sits in the rail on
 * the left, newest first, with Autopilot and Publishing at the top of it:
 * the thing that fills the rail on a schedule, and the place a finished
 * piece goes next. Choosing a row opens only that generation’s details.
 *
 * THE RAIL IS THIS PAGE'S OWN NAVIGATION, AND IT NEVER MOVES. Create,
 * Autopilot, Publishing and References are four addresses under
 * /social/studio, and the last three draw INSIDE the column to the right of
 * the rail rather than replacing the screen — so the list of everything ever
 * made stays where it was, still polling the runs that are moving, while the
 * schedule or the queue is read beside it. That is what the nested `Routes`
 * below are: one mounted rail, four things that can be to the right of it.
 * The pages themselves are untouched and still carry their own PageShell
 * header; their old addresses redirect here (see App.tsx).
 *
 * NO TOP BAR. Every other section page gets the slim strip with its name on
 * it — see pages/SectionPages.tsx — and this one is routed on its own,
 * outside that wrapper, because the rail already says where you are and a
 * strip above it would push the whole page down by its height for nothing.
 *
 * WHAT EACH TAB ACTUALLY CALLS, because the seven are three different things
 * on the server. An image post is one request that holds the line until the
 * picture exists (`studioApi.create`). A UGC clip is queued through the
 * socialfeed area's own route, which names what will be spent before the
 * run starts. The other five are `video` RUNS on the shared queue — one
 * `runsApi.start` with a `format` — and they finish in the background, so
 * the rail polls while anything is moving and stops when nothing is.
 *
 * THE CAROUSEL IS A RUN EVEN THOUGH IT MAKES NO VIDEO. Six slides, each coded
 * as HTML, drawn by headless Chrome, measured and looked at by a vision model
 * with up to two fixes apiece, is minutes of work — the image post's
 * hold-the-line request would time out under it. So it is `format:
 * "carousel"` on the same queue, and the rail learns which runs are carousels
 * (and their first slide, for the thumbnail) from `carouselApi.list`, the way
 * it learns a video's from `videoApi.list`.
 *
 * THE YOUTUBE TAB IS THE SHORTS TAB WITH THE SEARCH PUT BACK IN. Cutting
 * clips has always taken a URL, which assumed the choosing had already
 * happened somewhere this box could not see — in a YouTube tab, by eye, and
 * then copied across one address at a time. So that half is here now: a search
 * that costs nothing (yt-dlp reading metadata, no key, no quota), a wall of
 * results with their lengths on them, and YouTube's own player for previewing
 * one without downloading a byte. It starts NO new kind of work — ticking
 * three videos starts three ordinary `shorts` runs on the same queue, which is
 * why there is no `youtube` format on the server and nothing new on a run
 * page. The split between the two tabs is the split between having an address
 * and needing to find one.
 *
 * NOTHING HERE POSTS ANYTHING ANYWHERE. A finished post is sent to
 * Publishing as a draft from its card, and a finished video lands on its run
 * page; the queue is where somebody approves a thing against a real account.
 */

// Reel creation is retired from Studio; existing Reel runs remain in history.
type Make = "image" | "carousel" | "ugc" | "faceless" | "youtube" | "motion" | "stewie";

const MAKES: { key: Make; label: string; icon: typeof Sparkles; about: string }[] = [
  { key: "image", label: "Image post", icon: ImageIcon, about: "A caption and a picture in the venture's own brand." },
  { key: "carousel", label: "Carousel", icon: GalleryHorizontal, about: "Six slides in the venture's own brand — a hook, four points and a comment-bait ask — coded as HTML, drawn by the browser and checked by a vision model." },
  { key: "ugc", label: "UGC clip", icon: Clapperboard, about: "The product, from its own reference pictures, put in a scene and animated." },
  { key: "faceless", label: "Faceless video", icon: VideoIcon, about: "A script from the venture over stock footage, captions burned in." },
  /* Lucide has no YouTube mark in the version installed here, and drawing
     somebody else's logo by hand is not a thing to do in a tab strip. A
     magnifying glass is the honest icon anyway: what this tab adds is the
     SEARCH — the cutting is the row above. */
  { key: "youtube", label: "YouTube Shorts", icon: Scissors, about: "One to five vertical clips cut out of a long video — search YouTube and tick the keepers, or paste a link." },
  { key: "motion", label: "Motion", icon: Shapes, about: "Animated typography from a scene list, in the venture's colours." },
  { key: "stewie", label: "Stewie", icon: Tv, about: "Peter explains, Stewie interrupts, over gameplay footage — cloned voices, rendered by OPC's worker on the Dell." },
];

const PLATFORMS = ["Instagram", "LinkedIn", "X", "Facebook", "TikTok"];
const SHAPES: { key: StudioFormat; label: string; ratio: string }[] = [
  { key: "square", label: "Square", ratio: "1:1" },
  { key: "story", label: "Story", ratio: "9:16" },
  { key: "landscape", label: "Landscape", ratio: "16:9" },
];

/** The venture's palette as it reads today, for the posts whose own prompt
 *  named no colours. The order matches the prompt's: the three roles, then
 *  the background. */
function palette(v: Venture): string[] {
  const p = v.brand.palette;
  const hexes = [p.primary, p.secondary, p.accent, p.background].filter((h): h is string => !!h);
  return hexes.length ? hexes : [v.color];
}

/** One row of the rail, whichever kind of thing it is. A run row carries what
 *  is known about the video beside it: the finished job's row for a settled
 *  run, the typed inputs for one still moving — the run row itself is titled
 *  after the venture and says nothing about the format. */
type Generation =
  | { key: string; kind: "post"; ts: string; post: StudioPost }
  | { key: string; kind: "run"; ts: string; run: RunSummary; job: (VideoJob & { clipCount: number }) | null; carousel: Carousel | null; input: Record<string, string> | null };

const FORMAT_LABEL: Record<string, string> = { image: "Image post", carousel: "Carousel", ugc: "UGC clip", faceless: "Faceless video", shorts: "YouTube Shorts", reel: "Reel", motion: "Motion", stewie: "Stewie" };

function isMake(v: string | null): v is Make {
  return MAKES.some((m) => m.key === v);
}

/** Where the Studio lives, spelled once: the rail's four rows, the address a
 *  generation is opened at, and the parent of the three nested pages. */
const STUDIO = "/social/studio";

export function Studio() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /* WHICH TAB AND WHICH ROW ARE IN THE ADDRESS, so a link to "make a video"
     or to one finished post is a link. */
  const make: Make = isMake(params.get("make")) ? (params.get("make") as Make) : "image";
  const openKey = params.get("open");
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };

  /* WHICH VENTURE, BY ID — so the choice survives a rename, and falls back to
     the first venture when the one it held was deleted. The workspace's own
     default is the opening choice, which is the same venture the composer
     starts a chat against. */
  const [chosen, setChosen] = useState<string | null>(state.workspace.defaultVentureId);
  const venture = ventures.find((v) => v.id === chosen) ?? ventures[0] ?? null;

  /* The rail can show one venture's work or everyone's. Null is everyone. */
  const [railVenture, setRailVenture] = useState<string | null>(null);
  const [mobileRail, setMobileRail] = useState(false);

  const posts = useApi(() => studioApi.posts(railVenture), [railVenture]);
  const runs = useApi(() => runsApi.list({ kind: "video", venture: railVenture, limit: 60 }), [railVenture]);

  /* Anything moving anywhere means keep asking; nothing moving means stop. */
  const anyLive = (runs.data?.runs ?? []).some((r) => isLive(r.status)) || (runs.data?.queued ?? 0) > 0;
  const reloadRuns = runs.reload;
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => reloadRuns(), 2000);
    return () => clearInterval(t);
  }, [anyLive, reloadRuns]);

  /* The finished jobs, re-read whenever the count of settled runs changes —
     which is the moment a new file exists — and the inputs of the live ones,
     fetched once per set of live ids. Neither is polled on its own. */
  const runRows = runs.data?.runs ?? [];
  const settledCount = runRows.filter((r) => !isLive(r.status)).length;
  const videos = useApi(() => videoApi.list(railVenture).catch(() => null), [railVenture, settledCount]);
  /* Which runs are carousels, and each one's title and first slide. Re-read on
     the same beat as the videos — a carousel row exists from its first step,
     but its thumbnail is only worth fetching again when a run settles. */
  const carousels = useApi(() => carouselApi.list(railVenture).catch(() => null), [railVenture, settledCount]);
  const liveIds = runRows.filter((r) => isLive(r.status)).map((r) => r.id).join(",");
  const liveDetails = useApi(
    () => Promise.all(liveIds.split(",").filter(Boolean).map((id) => runsApi.get(id).catch(() => null))),
    [liveIds],
  );

  const generations = useMemo<Generation[]>(() => {
    const jobs = new Map((videos.data?.videos ?? []).map((v) => [v.runId, v]));
    const decks = new Map((carousels.data?.carousels ?? []).map((c) => [c.runId, c]));
    const inputs = new Map((liveDetails.data ?? []).filter((d): d is RunDetail => !!d).map((d) => [d.id, d.input]));
    const rows: Generation[] = [
      ...(posts.data?.posts ?? []).map((post) => ({ key: `post:${post.id}`, kind: "post" as const, ts: post.ts, post })),
      ...(runs.data?.runs ?? []).map((run) => ({ key: `run:${run.id}`, kind: "run" as const, ts: run.queuedAt, run, job: jobs.get(run.id) ?? null, carousel: decks.get(run.id) ?? null, input: inputs.get(run.id) ?? null })),
    ];
    return rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  }, [posts.data, runs.data, videos.data, carousels.data, liveDetails.data]);
  const open = generations.find((g) => g.key === openKey) ?? null;

  function replacePost(post: StudioPost) {
    posts.setData((d) => (d ? { ...d, posts: d.posts.map((p) => (p.id === post.id ? post : p)) } : d));
  }
  function forgetPost(id: string) {
    posts.setData((d) => (d ? { ...d, posts: d.posts.filter((p) => p.id !== id) } : d));
    if (openKey === `post:${id}`) setParam("open", null);
  }

  async function deleteRun(id: string) {
    await runsApi.remove(id);
    runs.setData((d) => d ? { ...d, runs: d.runs.filter((r) => r.id !== id) } : d);
    videos.setData((d) => d ? { ...d, videos: d.videos.filter((v) => v.runId !== id) } : d);
    carousels.setData((d) => d ? { ...d, carousels: d.carousels.filter((c) => c.runId !== id) } : d);
    if (openKey === `run:${id}`) setParam("open", null);
    runs.reload();
    videos.reload();
    carousels.reload();
  }

  async function deleteGeneration(g: Generation) {
    if (g.kind === "post") {
      await studioApi.remove(g.post.id);
      forgetPost(g.post.id);
      posts.reload();
    } else {
      await deleteRun(g.run.id);
    }
  }

  /* A generation is its own view, including when opened from a sub-page.
     Keep the URL shareable and let Back return to the previous Studio view. */
  function openGeneration(key: string) {
    const search = new URLSearchParams();
    const m = params.get("make");
    if (m) search.set("make", m);
    search.set("open", key);
    navigate({ pathname: STUDIO, search: search.toString() });
  }

  const create = (
    <CreateColumn
      make={make}
      /* Changing tab drops the scene list with it: `?spec=` belongs to the
         Motion tab, and leaving it on the address while an image post is
         being written is a parameter nothing on screen accounts for. */
      onMake={(v) => {
        const next = new URLSearchParams(params);
        next.set("make", v);
        next.delete("spec");
        next.delete("open");
        setParams(next, { replace: true });
      }}
      ventures={ventures}
      venture={venture}
      onVenture={setChosen}
      readiness={posts.data?.readiness ?? null}
      onPost={(post) => {
        posts.setData((d) => (d ? { ...d, posts: [post, ...d.posts] } : d));
        setParam("open", `post:${post.id}`);
      }}
      onRun={(id) => {
        reloadRuns();
        setParam("open", `run:${id}`);
      }}
    />
  );
  const column = openKey ? (
    <GenerationColumn key={openKey} openKey={openKey} generation={open} ventures={ventures}
      onChangedPost={replacePost} onDeletedPost={forgetPost} onDeleteRun={deleteRun} />
  ) : create;

  const rail = <Rail
    ventures={ventures} railVenture={railVenture} onRailVenture={setRailVenture}
    generations={generations} loading={posts.loading || runs.loading}
    openKey={pathname === STUDIO ? openKey : null}
    onOpen={key => { openGeneration(key); setMobileRail(false); }}
    onDelete={deleteGeneration} onNavigate={() => setMobileRail(false)}
  />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <div className="border-line-soft shrink-0 border-b px-4 py-2 md:hidden">
        <Button size="sm" variant="ghost" onClick={() => setMobileRail(true)}><Menu className="size-4" />Studio menu</Button>
      </div>
      <div className="hidden min-h-0 shrink-0 md:flex">{rail}</div>
      <Sheet open={mobileRail} onOpenChange={setMobileRail}>
        <SheetContent side="left" className="w-[min(320px,90vw)]! gap-0 p-0 pt-10" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Studio navigation and generations</SheetTitle>
          {rail}
        </SheetContent>
      </Sheet>

      {/*
        THE COLUMN, AND THE FOUR THINGS THAT CAN BE IN IT. Relative paths,
        because this component is mounted at /social/studio/* — see App.tsx.

        Each element brings its own scrolling box: Create's is written below
        and the other three get PageShell's, which is the same `min-h-0 flex-1
        overflow-y-auto`. That is what keeps the rail full height and still
        while the column scrolls under it.

        `references` is declared twice rather than as an optional segment so
        the page keeps reading its tab out of `:tab` exactly as it does at its
        own address, and `publishing/:runId` is here because a campaign run is
        read on that page.
      */}
      <Suspense fallback={<p role="status" className="p-6">Loading page…</p>}>
        <Routes>
          <Route index element={column} />
          <Route path="autopilot" element={<Autopilot />} />
          <Route path="publishing" element={<Publishing />} />
          <Route path="publishing/:runId" element={<Publishing />} />
          <Route path="references" element={<References />} />
          <Route path="references/:tab" element={<References />} />
          {/* Anything else under the Studio is the Studio. */}
          <Route path="*" element={column} />
        </Routes>
      </Suspense>
    </div>
  );
}

/* ---------------------------------------------------------------- create */

/** Creation has its own view; selected generations never mount this form. */
function CreateColumn({ make, onMake, ventures, venture, onVenture, readiness, onPost, onRun }: {
  make: Make;
  onMake: (v: string) => void;
  ventures: Venture[];
  venture: Venture | null;
  onVenture: (id: string | null) => void;
  readiness: StudioReadiness | null;
  onPost: (post: StudioPost) => void;
  onRun: (id: string) => void;
}) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-3 pb-20 sm:px-8">
      <div className="mx-auto w-full max-w-[820px]">
        <div className="mt-5">
          <img
            src={studioHeader}
            alt="A colorful creative studio with filmmakers, a video editing desk and social post designs"
            width={1440}
            height={480}
            decoding="async"
            className="block aspect-[3/1] w-full object-contain"
          />
        </div>
        <h1 className="mt-5 mb-6 text-center text-[30px] font-normal tracking-[-0.025em]">
          Create anything with AI
        </h1>

        <Tabs value={make} onValueChange={onMake} className="items-center">
          {/* `h-auto`: the primitive fixes a horizontal list at one row's
              height, and eight tabs wrap at this width — a wrapped row
              inside a fixed-height list overflows onto the sentence below. */}
          <TabsList variant="line" className="h-auto! flex-wrap justify-center gap-x-0.5 gap-y-1.5">
            {MAKES.map((m) => (
              <TabsTrigger key={m.key} value={m.key} className="flex-none px-2.5">
                <m.icon data-icon="inline-start" className="size-3.5" strokeWidth={1.8} />
                {m.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {ventures.length === 0 ? (
          <p className="text-muted-foreground text-center text-[14px]">
            There are no ventures yet, and everything here is made out of one — the name,
            the sentence you wrote, the stage and the colours read off the site. Add a
            venture first.
          </p>
        ) : (
          <Composer
            key={make}
            make={make}
            ventures={ventures}
            venture={venture}
            onVenture={onVenture}
            readiness={readiness}
            onPost={onPost}
            onRun={onRun}
          />
        )}

      </div>
    </div>
  );
}

/* -------------------------------------------------------- generation view */

function GenerationColumn({ openKey, generation, ventures, onChangedPost, onDeletedPost, onDeleteRun }: {
  openKey: string;
  generation: Generation | null;
  ventures: Venture[];
  onChangedPost: (post: StudioPost) => void;
  onDeletedPost: (id: string) => void;
  onDeleteRun: (id: string) => Promise<void>;
}) {
  const runId = openKey.startsWith("run:") ? openKey.slice(4) : "";
  const postId = openKey.startsWith("post:") ? openKey.slice(5) : "";
  const post = generation?.kind === "post" ? generation.post : null;
  // A venture filter may hide the selected post in the rail. It must not
  // replace its details with Create or prevent a direct link from opening.
  const fallback = useApi(() => postId && !post
    ? studioApi.posts().then((result) => result.posts.find((p) => p.id === postId) ?? null)
    : Promise.resolve(null), [postId, !!post]);
  const selectedPost = post ?? fallback.data;
  return (
    <section aria-label="Generation details" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 pb-20 sm:px-8">
      <div className="mx-auto w-full max-w-[820px]">
        {runId ? <RunPanel key={runId} runId={runId} onDelete={() => onDeleteRun(runId)} /> : selectedPost ? (
          <PostCard post={selectedPost}
            palette={(() => { const v = ventures.find((x) => x.id === selectedPost.ventureId); return v ? palette(v) : undefined; })()}
            onChanged={(next) => { fallback.setData(next); onChangedPost(next); }} onDeleted={onDeletedPost} />
        ) : postId && fallback.loading ? (
          <p role="status" className="text-muted-foreground">Loading generation…</p>
        ) : (
          <div className="bg-card grid gap-3 rounded-[14px] p-4.5">
            <p role="alert">{fallback.error ?? "This generation could not be found."}</p>
            {fallback.error && <Button variant="outline" onClick={fallback.reload}>Try again</Button>}
            <Link to={STUDIO} className="text-muted-foreground text-sm underline decoration-dotted">Back to Create</Link>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ rail */

function Rail({ ventures, railVenture, onRailVenture, generations, loading, openKey, onOpen, onDelete, onNavigate }: {
  ventures: Venture[];
  railVenture: string | null;
  onRailVenture: (id: string | null) => void;
  generations: Generation[];
  loading: boolean;
  openKey: string | null;
  onOpen: (key: string) => void;
  onDelete: (generation: Generation) => Promise<void>;
  onNavigate: () => void;
}) {
  /* The doors at the top: the screen this page opens on, what fills the rail
     on its own, where a finished piece goes next, and what every generator is
     handed before it draws. Each carries one fact so the row says whether it
     needs looking at. */
  const autopilot = useApi(() => autopilotApi.read().catch(() => null), []);
  const queue = useApi(() => publishingApi.items({ status: "draft" }).catch(() => null), []);
  const drafts = queue.data?.counts?.draft;
  const { pathname } = useLocation();

  const doors: { to: string; end?: boolean; label: string; icon: typeof Timer; note: string }[] = [
    /* `end`, so Create stops being the lit row the moment one of the other
       three is open — every path below is a path under this one. */
    { to: STUDIO, end: true, label: "Create", icon: Sparkles, note: "" },
    {
      to: `${STUDIO}/autopilot`,
      label: "Autopilot",
      icon: Timer,
      note: autopilot.data ? (autopilot.data.schedule.enabled ? `on · next ${when(autopilot.data.nextRunAt)}` : "off") : "",
    },
    {
      to: `${STUDIO}/publishing`,
      label: "Publishing",
      icon: Send,
      note: drafts ? `${drafts} draft${drafts === 1 ? "" : "s"}` : "",
    },
    /* What every generator draws on: the logos, reference pictures and
       the written style guide, per venture. */
    { to: `${STUDIO}/references`, label: "References", icon: Palette, note: "logos · photos · style" },
  ];

  return (
    /* A SOLID PANEL RATHER THAN A WASH. This was `bg-sidebar/40`, which let
       the page through and read as a tint on the column beside it; the rail
       is a place you navigate from, so it gets a surface of its own — white
       in the light theme, and the card token in the dark one, because a rail
       painted literal white in the dark is a lamp. */
    <aside aria-label="Studio navigation" className="border-line-soft dark:bg-card flex h-full w-full min-w-0 shrink-0 flex-col border-r md:w-[272px] bg-white">
      <div className="border-line-soft grid gap-0.5 border-b p-2.5">
        {doors.map((d) => {
          const active = d.end ? pathname === d.to && !openKey : pathname === d.to || pathname.startsWith(`${d.to}/`);
          return (
            <Link key={d.to} to={d.to} onClick={onNavigate} aria-current={active ? "page" : undefined}
              className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors", active ? "bg-accent font-medium" : "hover:bg-accent")}>
              <d.icon className="size-4 shrink-0" strokeWidth={1.7} />
              <span className="text-[13.5px]">{d.label}</span>
              <span className="text-muted-foreground ml-auto truncate text-[12px] font-normal">{d.note}</span>
            </Link>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <span className="text-muted-foreground text-[11.5px] font-medium tracking-[0.08em] uppercase">Generations</span>
        <span className="text-muted-foreground ml-auto text-[12px]">{loading ? "loading…" : generations.length || ""}</span>
      </div>
      <div className="px-2.5 pb-2">
        <VentureSelect ventures={ventures} value={railVenture} onChange={onRailVenture} none="Every venture" className="h-8 w-full text-[13px]" />
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
        {!loading && generations.length === 0 && (
          <p className="text-muted-foreground px-2 py-2 text-[12.5px] leading-relaxed">
            Nothing made yet. Whatever you make above lands here, and Autopilot adds to it on a schedule.
          </p>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-px">
          {generations.map((g) => (
            <GenerationRow key={g.key} generation={g} active={g.key === openKey} onClick={() => onOpen(g.key)} onDelete={() => onDelete(g)} />
          ))}
        </div>
      </div>
    </aside>
  );
}

const FORMAT_ICON: Record<string, typeof Film> = { carousel: GalleryHorizontal, ugc: Clapperboard, faceless: VideoIcon, shorts: Scissors, reel: Film, motion: Shapes, stewie: Tv };

function GenerationThumbnail({ src, children }: { src?: string | null; children: ReactNode }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span className="bg-muted grid size-9 shrink-0 place-items-center overflow-hidden rounded-md">
      {src && src !== failedSource ? (
        <img src={src} alt="" width={36} height={36} loading="lazy" decoding="async"
          onError={() => setFailedSource(src)} className="size-full object-cover" />
      ) : children}
    </span>
  );
}

function GenerationRow({ generation: g, active, onClick, onDelete }: { generation: Generation; active: boolean; onClick: () => void; onDelete: () => Promise<void> }) {
  if (g.kind === "post") {
    const p = g.post;
    return (
      <div className={cn("sidebar-row flex min-w-0 items-center rounded-lg", active ? "bg-accent" : "hover:bg-accent/60")}>
        <button onClick={onClick} aria-current={active ? "true" : undefined} title={p.caption?.split("\n")[0] || p.brief} className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left">
          <GenerationThumbnail src={p.imageOnDisk ? p.image : null}>
            <ImageIcon className="text-muted-foreground size-4" strokeWidth={1.6} />
          </GenerationThumbnail>
          <span className="min-w-0 flex-1 overflow-hidden">
            <span className="block truncate text-[13px]">{p.caption?.split("\n")[0] || p.brief}</span>
            <span className="text-muted-foreground block truncate text-[11.5px]">
              Image post · {p.format}{p.error ? " · problem" : ""} · {ago(p.ts)}
            </span>
          </span>
        </button>
        <GenerationMenu title={p.caption?.split("\n")[0] || p.brief} live={false} onDelete={onDelete} />
      </div>
    );
  }
  const r = g.run;
  const format = g.carousel ? "carousel" : g.job?.format ?? g.input?.format ?? "";
  const Icon = FORMAT_ICON[format] ?? VideoIcon;
  const live = isLive(r.status);
  const title =
    g.carousel?.title ?? g.job?.script?.title ?? g.job?.script?.brief ?? g.input?.brief ?? g.input?.url ?? r.ventureName ?? "Video";
  const what = FORMAT_LABEL[format] ?? "Video";
  const clips = g.job && g.job.clipCount > 0 ? ` · ${g.job.clipCount} clips`
    : g.carousel && g.carousel.slides.length ? ` · ${g.carousel.slides.length} slides` : "";
  const details = `${what}${clips} · ${live ? r.status : r.status === "done" ? (g.job?.onDisk === false ? "file gone" : "done") : r.status} · ${ago(r.queuedAt)}`;
  return (
    <div className={cn("sidebar-row flex min-w-0 items-center rounded-lg", active ? "bg-accent" : "hover:bg-accent/60")}>
      <button onClick={onClick} aria-current={active ? "true" : undefined} title={`${title}\n${details}`} className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left">
        <GenerationThumbnail src={live ? null : g.carousel?.thumbnailUrl ?? g.job?.thumbnailUrl}>
          {live ? <Loader2 className="text-muted-foreground size-4 animate-spin" strokeWidth={1.6} /> : <Icon className="text-muted-foreground size-4" strokeWidth={1.6} />}
        </GenerationThumbnail>
        <span className="min-w-0 flex-1 overflow-hidden">
          <span className="block truncate text-[13px]">{title}</span>
          <span className={cn("block truncate text-[11.5px]", r.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
            {details}
          </span>
        </span>
      </button>
      <GenerationMenu title={title} live={live} onDelete={onDelete} />
    </div>
  );
}


/* -------------------------------------------------------------- composer */

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">{label}</div>
      {children}
      {hint && <p className="text-muted-foreground text-[12.5px]">{hint}</p>}
    </div>
  );
}

function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { key: T; label: ReactNode; sub?: string; title?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn("rounded-[12px] border px-2.5 py-1.5 text-[13.5px] transition-colors", value === o.key ? "border-foreground" : "hover:border-line-strong")}
        >
          {o.label}
          {o.sub && <span className="text-muted-foreground ml-1.5">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

function Composer({ make, ventures, venture, onVenture, readiness, onPost, onRun }: {
  make: Make;
  ventures: Venture[];
  venture: Venture | null;
  onVenture: (id: string | null) => void;
  readiness: StudioReadiness | null;
  onPost: (post: StudioPost) => void;
  onRun: (id: string) => void;
}) {
  const [brief, setBrief] = useState("");
  const [shape, setShape] = useState<StudioFormat>("square");
  const [size, setSize] = useState<CarouselSize>(DEFAULT_CAROUSEL_SIZE);
  const [platform, setPlatform] = useState<string | null>(null);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [autoReferences, setAutoReferences] = useState(true);
  const [aspect, setAspect] = useState("9:16");
  const [aspectChanged, setAspectChanged] = useState(false);
  const [fit, setFit] = useState("cover");
  const [seconds, setSeconds] = useState(make === "youtube" ? "45" : make === "faceless" ? "" : "30");
  const [clips, setClips] = useState("1");
  const [url, setUrl] = useState("");
  /* THE YOUTUBE TAB'S ONLY STATE UP HERE IS WHAT WAS TICKED. The query, the
     results and which one is playing all belong to the picker below and are
     none of this function's business; what the button needs is the addresses
     and how many clips each should give. Keyed by video id so ticking the same
     result twice cannot queue it twice. */
  const [keeps, setKeeps] = useState<Record<string, Keep>>({});
  /* THE OPEN SCENE LIST IS IN THE ADDRESS, as it was on the page this editor
     came from: a spec somebody is editing is a place, the way a run and a
     dashboard are, so `?spec=<id>` beside `?make=motion` is a link that opens
     what they were looking at rather than the empty picker. It is the only
     one of this form's fields that is, because it is the only one naming
     something saved on the server. */
  const [params, setParams] = useSearchParams();
  const spec = make === "motion" ? (params.get("spec") ?? "") : "";
  const setSpec = (id: string) => {
    setAspectChanged(false);
    const next = new URLSearchParams(params);
    if (id) next.set("spec", id); else next.delete("spec");
    setParams(next, { replace: true });
  };
  const [optionsOpen, setOptionsOpen] = useState(!!spec);
  useEffect(() => { if (spec) setOptionsOpen(true); }, [spec]);
  const [voiceover, setVoiceover] = useState(false);
  const [narrationReady, setNarrationReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const wantsAssets = make === "image" || make === "ugc";
  const library = useApi(
    () => (wantsAssets && venture ? publishingApi.assets({ venture: venture.id }) : Promise.resolve(null)),
    [wantsAssets, venture?.id ?? null],
  );
  const assets = library.data?.assets ?? [];
  const specs = useApi(
    () => (make === "motion" ? motionApi.list(venture?.id ?? null).catch(() => null) : Promise.resolve(null)),
    [make, venture?.id ?? null],
  );
  /* What the Pi and the Dell can do right now. Asking wakes nothing. */
  const stewie = useApi(() => (make === "stewie" ? stewieApi.read().catch(() => null) : Promise.resolve(null)), [make]);
  const footage = useApi(() => (make === "stewie" ? stewieApi.backgrounds().catch(() => null) : Promise.resolve(null)), [make]);
  const [stewieMode, setStewieMode] = useState<"images" | "pages">("images");
  const [background, setBackground] = useState("");
  const gameplay = stewie.data?.backgrounds ?? footage.data?.backgrounds ?? (stewie.data?.worker?.backgrounds ?? []).map(id => ({ id, label: gameplayLabel(id), thumbnailUrl: null }));

  const needsVenture = make === "image" || make === "ugc" || make === "carousel";
  const ready =
    !busy && (make !== "motion" || !voiceover || narrationReady) &&
    (!needsVenture || !!venture) &&
    ((make === "motion" || make === "faceless") ? !!venture || !!spec || brief.trim().length > 0 : true) &&
    (make === "ugc" ? assets.some(a => a.onDisk) || brief.trim().length > 0 : true) &&
    (make === "youtube" ? Object.keys(keeps).length > 0 || url.trim().length > 0 : true) &&
    (make === "stewie" ? (stewie.data?.configured ?? false) && !stewie.data?.running
      && (!background || gameplay.some(item => item.id === background))
      && (stewieMode === "pages" ? url.trim().length > 0 : brief.trim().length > 0) : true);

  async function go() {
    if (!ready) return;
    setBusy(true);
    setRefused(null);
    setSaid(null);
    try {
      if (make === "image") {
        const res = await studioApi.create({ ventureId: venture!.id, brief: brief.trim(), format: shape, platform, assetIds: autoReferences ? undefined : assetIds });
        onPost(res.post);
        setBrief("");
      } else if (make === "carousel") {
        /* A video RUN with no video in it — see the header. The prompt is the
           angle; empty lets the model choose one from the venture's facts. */
        const run = await runsApi.start({ kind: "video", ventureId: venture!.id, input: { format: "carousel", brief: brief.trim(), size } });
        setSaid(run.status === "running" ? "Started. Each slide appears in the rail's carousel as it is checked." : "Queued behind the runs ahead of it.");
        setBrief("");
        onRun(run.id);
      } else if (make === "ugc") {
        const res = await socialfeedApi.startUgc({ venture: venture!.slug, brief: brief.trim(), assets: assetIds, aspect });
        setSaid(`Queued. Image: ${res.spend.image}. Video: ${res.spend.video}.`);
        onRun(res.run.id);
      } else if (make === "youtube") {
        /*
          ONE RUN PER TICKED VIDEO, STARTED ONE AFTER THE OTHER.

          There is no batch route and there should not be: a `shorts` run is
          already the unit of work the queue, the rail and the run page all
          understand, and a job that held five of them would need its own row,
          its own page and its own idea of half-failing. Five runs is five
          rows, each cancellable and retryable on its own.

          SEQUENTIALLY, because the queue takes them one at a time anyway and
          firing five POSTs at once only makes the ORDER they land in a race —
          and the order is the one thing the owner expressed by ticking them.
          The last one started is the one opened, so the rail lands on the
          bottom of what was just queued rather than the top.
        */
        /* A pasted link is one more source beside the ticked ones — the same
           run, with the clip count from its own field. */
        const sources = [
          ...Object.values(keeps).map((k) => ({ url: k.url, clips: k.clips })),
          ...(url.trim() ? [{ url: url.trim(), clips: shortsClipCount(clips) }] : []),
        ];
        let last: string | null = null;
        for (const src of sources) {
          const run = await runsApi.start({
            kind: "video",
            ventureId: venture?.id ?? null,
            input: { format: "shorts", url: src.url, brief: brief.trim(), aspect, fit, seconds, clips: String(src.clips) },
          });
          last = run.id;
        }
        const n = sources.length;
        setUrl("");
        setSaid(`${n} shorts run${n === 1 ? "" : "s"} queued. They run one at a time and appear in the rail as they go.`);
        setKeeps({});
        if (last) onRun(last);
      } else {
        const input: Record<string, string> = { format: make, brief: brief.trim(), aspect };
        if (make === "faceless") Object.assign(input, { seconds, fit });
        if (make === "motion") Object.assign(input, { spec, aspect: spec && !aspectChanged ? "" : aspect, voiceover: voiceover ? "true" : "false" });
        if (make === "stewie") Object.assign(input, { url: stewieMode === "pages" ? url.trim() : "", background });
        const run = await runsApi.start({ kind: "video", ventureId: venture?.id ?? null, input });
        setSaid(run.status === "running" ? "Started. It shows in the rail while it works." : "Queued behind the runs ahead of it.");
        onRun(run.id);
      }
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const ventureField = (
    <Field label={needsVenture ? "For which venture" : "Venture (optional)"}>
      <VentureSelect ventures={ventures} value={venture?.id ?? null} onChange={(id) => { onVenture(id); setAssetIds([]); setSpec(""); }} none={needsVenture ? null : "No venture"} />
    </Field>
  );
  const briefField = (
    <Field
      label={make === "image" ? "What should the post be about? (optional)" : make === "carousel" ? "What should the carousel be about? (optional)" : make === "youtube" ? "What to look for (optional)" : make === "ugc" ? "Describe the opening shot" : make === "stewie" ? `What should they explain?${stewieMode === "pages" ? " (optional)" : ""}` : "What should the video be about?"}
      hint={make === "image" ? "Leave this empty and AI picks an angle from the venture’s saved facts and brand." : make === "carousel" ? "An angle or a topic. Leave it empty and AI picks one from the venture’s saved facts." : make === "youtube" ? "Optional direction for the moments AI selects." : make === "ugc" ? "The person, the setting, and what happens. Reference pictures are optional." : make === "motion" ? "AI writes the scenes and chooses their timing. A saved scene list is optional." : make === "faceless" ? "AI writes the narration and finds matching footage. Length follows the script unless you set a target." : undefined}
    >
      <Textarea aria-label={make === "youtube" ? "What to look for" : "Generation brief"} value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} maxLength={make === "stewie" ? 2500 : 2000}
        placeholder={make === "image" ? "For example, introduce our weekly digests" : make === "carousel" ? "For example, five mistakes people make choosing an LLM API" : make === "youtube" ? "For example, practical advice for first-time founders" : make === "ugc" ? "A person at their desk, holding the product up to the camera…" : make === "faceless" ? "For example, five hidden gems in Lisbon" : make === "motion" ? "For example, three reasons to try our new app" : "One or two lines…"}
        className="text-[14.5px]" />
    </Field>
  );
  const assetsField = wantsAssets && venture ? (
    <Field label={make === "ugc" ? "Reference pictures (optional)" : "Visual references (optional)"}
      hint={assets.length ? (make === "ugc" ? "Choose up to four, or let OPC use available pictures from this venture." : "Choose up to four pictures to guide the look.") : undefined}>
      {make === "image" && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={autoReferences} onChange={e => { setAutoReferences(e.target.checked); if (e.target.checked) setAssetIds([]); }} />Choose references automatically, rotating through this venture's library</label>}
      {assets.length === 0 ? (
        <p className="text-muted-foreground text-[12.5px]">
          <Link to={`${STUDIO}/references`} className="underline decoration-dotted">Add reference pictures</Link> to guide the look or show a specific product.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {assets.slice(0, 12).map((a) => (
            <button key={a.id} type="button" title={a.prompt ?? a.name ?? a.kind} aria-pressed={assetIds.includes(a.id)} disabled={!a.onDisk}
              onClick={() => { setAutoReferences(false); setAssetIds((prev) => (prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id].slice(0, 4))); }}
              className={cn("overflow-hidden rounded-[11px] border transition-colors", assetIds.includes(a.id) ? "border-foreground" : "hover:border-line-strong")}>
              {a.onDisk ? <img src={a.url} alt={a.name ?? a.kind} className="size-12 object-cover" /> : <span className="text-muted-foreground flex size-12 items-center justify-center text-[11px]">missing</span>}
            </button>
          ))}
        </div>
      )}
    </Field>
  ) : null;
  const shownAspect = make === "motion" && spec && !aspectChanged ? specs.data?.specs.find(item => item.id === spec)?.aspect ?? aspect : aspect;
  const shapeField = <Field label="Shape"><ShapePicker value={shownAspect} onChange={(value) => { setAspect(value); setAspectChanged(true); }} options={ASPECT_OPTIONS} /></Field>;
  const cost = {
    image: readiness?.image.ready ? `One image, billed through ${readiness.image.providerLabel}.` : "Connect an image provider to include a picture. Otherwise, only the caption is saved.",
    carousel: "Your workspace AI plans six slides and codes them as one strip; the browser on this box draws it once and cuts it into six. Each slide is measured for text outside its frame and, if the model can see, looked at for overlap, contrast and typos — up to two revisions. Icons and fonts are built in; no image provider is used.",
    ugc: "Creates a still, then animates it if a video model is connected. Generation uses the connected providers’ credits.",
    faceless: "Your workspace AI writes the script; stock footage and narration are assembled into a video.",
    youtube: "AI selects complete moments from the transcript. Clips are vertical by default; missing transcript or framing support is noted in the result.",
    motion: "AI writes the scene list from your brief. Vertical and silent by default.",
    stewie: "AI writes both voices. The render worker wakes the Dell if needed; rendering takes a few minutes.",
  }[make];

  return (
    <div data-studio-composer={make} className="bg-card mt-5 grid gap-3.5 rounded-[14px] p-4.5">
      <p className="text-muted-foreground text-[13.5px]">{MAKES.find((item) => item.key === make)?.about}</p>
      {(make === "image" || make === "ugc") && readiness && <ReadinessBanner readiness={readiness} />}
      {needsVenture && ventureField}

      {make === "youtube" && <>
        <YoutubePicker keeps={keeps} onKeeps={setKeeps} />
        <Field label="Or paste a video link">
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Video link" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" className="min-w-0 flex-1 text-[14px]" />
            <label className="text-muted-foreground flex items-center gap-2 text-[12.5px]">Clips
              <Input aria-label="Clips from pasted video" type="number" min={1} max={5} value={clips} onChange={(e) => setClips(e.target.value)} onBlur={() => setClips(String(shortsClipCount(clips)))} className="w-16" />
            </label>
          </div>
        </Field>
      </>}

      {make === "stewie" && <>
        {stewie.data && (!stewie.data.configured || stewie.data.running) && (
          <p className={cn("text-[12.5px]", stewie.data.configured ? "text-muted-foreground" : "text-destructive")}>
            {stewie.data.configured ? stewie.data.note : <>{stewie.data.note} <Link to="/integrations/workdash" className="underline decoration-dotted">Connect it</Link>.</>}
          </p>
        )}
        <Field label="Pictures behind them">
          <Chips value={stewieMode} onChange={setStewieMode} options={[{ key: "images", label: "Searched images" }, { key: "pages", label: "Your pages" }]} />
        </Field>
        {stewieMode === "pages" && <Field label="Pages to show" hint="One address per line, up to eight. Leave the brief empty to explain what these pages do.">
          <Textarea aria-label="Pages to show" value={url} onChange={(e) => setUrl(e.target.value)} rows={3} placeholder="https://…" className="text-[14px]" />
        </Field>}
      </>}

      {make !== "youtube" && !(make === "motion" && spec) && briefField}
      {make === "motion" && spec && <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span>Using a saved scene list</span><Button variant="ghost" size="sm" onClick={() => setSpec("")}>Write from a prompt instead</Button>
      </div>}
      {make === "motion" && specs.data && <MotionReadinessNote readiness={specs.data.readiness} />}
      {make === "motion" && <MotionNarration checked={voiceover} onCheckedChange={setVoiceover} onReadyChange={setNarrationReady} />}
      {make === "ugc" && assetsField}
      {make === "faceless" && shapeField}
      {make === "stewie" && <GameplayPicker backgrounds={gameplay} value={background} onChange={setBackground} loading={footage.loading && stewie.loading} />}
      {make === "carousel" && <Field label="Size">
        <ShapePicker value={size} onChange={setSize} label="Carousel size"
          options={(Object.keys(CAROUSEL_SIZES) as CarouselSize[]).map((key) => ({ key, label: CAROUSEL_SIZES[key].label, ratio: CAROUSEL_SIZES[key].ratio }))} />
        <p className="text-muted-foreground text-[12.5px]">{CAROUSEL_SIZES[size].width}×{CAROUSEL_SIZES[size].height} pixels per slide.</p>
      </Field>}
      {make === "image" && <Field label="Written for">
        <Chips value={platform ?? ""} onChange={(v) => setPlatform(v || null)} options={["", ...PLATFORMS].map((p) => ({ key: p, label: <SocialPlatformLabel platform={p} /> }))} />
      </Field>}

      {make !== "carousel" && <details open={optionsOpen} onToggle={(e) => setOptionsOpen(e.currentTarget.open)} className="group/options border-line-soft border-t pt-3">
        <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-2 text-[13px] [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-3.5 transition-transform group-open/options:rotate-180" />
          Optional settings{!needsVenture && venture ? ` · ${venture.name}` : ""}
        </summary>
        <div className="grid gap-3.5 pt-4">
          {!needsVenture && ventureField}
          {make === "youtube" && briefField}
          {make === "image" ? <>
            <Field label="Shape"><ShapePicker value={shape} onChange={setShape} options={SHAPES} /></Field>
            {assetsField}
          </> : make !== "stewie" && make !== "faceless" && shapeField}
          {(make === "faceless" || make === "youtube") && <Field label={make === "youtube" ? "Maximum clip length" : "Target length (optional)"} hint={make === "faceless" ? "Empty lets AI plan the shots and their timing. Set 10–120 seconds to override." : "An upper limit, not an exact length. AI chooses where each thought starts and ends."}>
            <div className="flex items-center gap-2"><Input aria-label={make === "youtube" ? "Maximum clip length" : "Target length"} type="number" min={make === "youtube" ? 15 : 10} max={make === "youtube" ? 90 : 120} value={seconds} onChange={(e) => setSeconds(e.target.value)} placeholder="Auto" className="w-28" /><span className="text-muted-foreground text-[12px]">seconds</span></div>
          </Field>}
          {(make === "faceless" || make === "youtube") && <Field label="Framing">
            <Chips value={fit} onChange={setFit} options={[{ key: "cover", label: "Fill the frame" }, { key: "letterbox", label: "Keep the full picture" }]} />
          </Field>}
          {make === "motion" && <>
            <Field label="Use a saved scene list" hint="Optional. Use this to edit exact scenes instead of asking AI to write them.">
              <div className="flex flex-wrap items-center gap-2">
                <SelectField aria-label="Scene list" value={spec} onValueChange={setSpec} className="min-w-0 max-w-full">
                  <SelectOption value="">Let AI write it from the brief</SelectOption>
                  {(specs.data?.specs ?? []).map((s) => <SelectOption key={s.id} value={s.id}>{s.name} · {s.scenes} scenes · {s.aspect}</SelectOption>)}
                </SelectField>
                <NewSceneListButton ventureId={venture?.id ?? null} onCreated={(id) => { setSpec(id); specs.reload(); }} />
              </div>
            </Field>
            {spec && <SceneListEditor key={spec} id={spec} onChanged={() => specs.reload()} onDeleted={() => { setSpec(""); specs.reload(); }} />}
          </>}
        </div>
      </details>}

      <div className="flex flex-wrap items-center gap-2.5">
        <Button disabled={!ready} onClick={() => void go()}>
          {busy ? <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} /> : <Sparkles className="size-[15px]" strokeWidth={1.8} />}
          {busy ? make === "image" ? "Making it…" : "Queueing…" : make === "youtube" ? (() => { const n = Object.keys(keeps).length + (url.trim() ? 1 : 0); return `Cut ${n || ""} video${n === 1 ? "" : "s"}`; })() : `Make ${MAKES.find((m) => m.key === make)!.label.toLowerCase()}`}
        </Button>
      </div>
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">{cost}</p>
      {said && <p className="text-[13.5px]">{said}</p>}
      {refused && <p className="text-destructive text-[13.5px] leading-relaxed">{refused}</p>}
    </div>
  );
}

/* --------------------------------------------------------- youtube picker */

/** What one ticked result carries into `runsApi.start`. The URL is the
 *  server's own spelling of it and is never rebuilt from the id here — one
 *  speller of an address is the whole reason the search route returns it. */
type Keep = { url: string; title: string; clips: number };

/** mm:ss, or a dash. A null length is one yt-dlp did not report and is NOT a
 *  zero-length video — the difference matters on a wall where length is most
 *  of what you are choosing on. */
function clock(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Views, shortened. Null draws nothing at all rather than "0 views": a video
 *  whose count was not reported is not a video nobody watched. */
function views(n: number | null): string {
  if (n === null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K views`;
  return `${n} view${n === 1 ? "" : "s"}`;
}

/**
 * SEARCH, WATCH, TICK. The half of choosing a source that used to happen in
 * another tab.
 *
 * THE TWO HALVES COST DIFFERENT THINGS AND THE PANEL SAYS SO. Searching is
 * yt-dlp reading metadata with no key and no quota; previewing is YouTube's
 * own player in this browser, and this box never sees the video. Neither
 * downloads a byte. The button below the panel is the one that queues real
 * work, and it belongs to the composer rather than to this.
 *
 * THE PLAYER IS BUILT ON CLICK AND THERE IS ONLY EVER ONE. Twelve mounted
 * iframes would be twelve connections to YouTube on every search, for a wall
 * that is meant to be cheap to browse; and two playing at once is two people
 * talking. So the id being previewed is a single piece of state, and choosing
 * another swaps it.
 *
 * A NEW SEARCH CLEARS WHAT WAS TICKED, on purpose. A tick means "this one",
 * and a tick left over from a query whose results are no longer on the screen
 * is a video about to be cut that nobody can see they chose.
 */
function YoutubePicker({ keeps, onKeeps }: { keeps: Record<string, Keep>; onKeeps: Dispatch<SetStateAction<Record<string, Keep>>> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<YoutubeHit[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function search() {
    if (!q.trim() || searching) return;
    setSearching(true);
    setProblem(null);
    setPlaying(null);
    onKeeps({});
    try {
      const res = await youtubeApi.search(q.trim(), 12);
      setHits(res.results);
      if (res.results.length === 0) setProblem("Nothing came back for that.");
    } catch (err) {
      setHits(null);
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  const total = Object.values(keeps).reduce((n, k) => n + k.clips, 0);

  return (
    <Field label="Search YouTube" hint="Free — this reads metadata and plays previews from YouTube. Nothing is downloaded until you press the button below.">
      <div className="flex flex-wrap gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
          maxLength={200}
          placeholder="What are you looking for? “why tokens matter for LLMs”"
          className="min-w-56 flex-1 text-[14px]"
        />
        <Button variant="outline" disabled={searching || !q.trim()} onClick={() => void search()}>
          {searching ? <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} /> : <Search className="size-[15px]" strokeWidth={1.8} />}
          {searching ? "Searching…" : "Search"}
        </Button>
      </div>

      {problem && <p className="text-destructive text-[12.5px] leading-relaxed">{problem}</p>}

      {hits && hits.length > 0 && (
        <div className="mt-1 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {hits.map((h) => {
            const keep = keeps[h.id];
            /* The source-length limit lives in the Video settings and defaults
               to ninety minutes; a run that is going to be refused for it
               should say so on the card rather than three minutes into the
               queue. */
            const tooLong = (h.durationS ?? 0) > 5400;
            return (
              <div
                key={h.id}
                className={cn("rounded-[12px] border p-2 transition-colors", keep ? "border-foreground" : "border-line-soft")}
              >
                <div className="bg-muted relative aspect-video overflow-hidden rounded-[8px]">
                  {playing === h.id ? (
                    <iframe
                      src={`https://www.youtube-nocookie.com/embed/${h.id}?autoplay=1`}
                      title={h.title}
                      allow="autoplay; encrypted-media"
                      allowFullScreen
                      className="size-full border-0"
                    />
                  ) : (
                    <button type="button" onClick={() => setPlaying(h.id)} className="group size-full" title="Watch it here">
                      <img src={h.thumbnail} alt="" loading="lazy" className="size-full object-cover" />
                      <span className="absolute inset-0 grid place-items-center bg-black/25 opacity-80 transition-opacity group-hover:opacity-100">
                        <Play className="size-6 text-white" strokeWidth={1.8} />
                      </span>
                    </button>
                  )}
                  <span className="absolute right-1 bottom-1 rounded-[5px] bg-black/70 px-1 text-[11px] tabular-nums text-white">
                    {clock(h.durationS)}
                  </span>
                </div>

                <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug" title={h.title}>{h.title}</p>
                <p className="text-muted-foreground truncate text-[11.5px]">
                  {[h.channel, views(h.viewCount)].filter(Boolean).join(" · ") || "—"}
                </p>
                {tooLong && (
                  <p className="text-muted-foreground text-[11.5px]">Over 90 minutes — a run refuses a source past the limit in the Video settings.</p>
                )}

                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    /* THE UPDATE IS A FUNCTION OF WHAT WAS THERE and not of
                       `keeps` as this render saw it. Two ticks inside one
                       React batch — which is what a fast pair of clicks is —
                       both read the same stale object, and the second one
                       silently threw away the first. */
                    onClick={() =>
                      onKeeps((prev) => {
                        const next = { ...prev };
                        if (next[h.id]) delete next[h.id];
                        else next[h.id] = { url: h.url, title: h.title, clips: 1 };
                        return next;
                      })
                    }
                    className={cn("rounded-[10px] border px-2 py-1 text-[12.5px] transition-colors", keep ? "border-foreground" : "hover:border-line-strong")}
                  >
                    {keep ? "Keeping" : "Keep"}
                  </button>
                  {keep && (
                    <label className="text-muted-foreground ml-auto flex items-center gap-1.5 text-[11.5px]">
                      clips
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        value={keep.clips}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          const clips = shortsClipCount(n);
                          onKeeps((prev) => (prev[h.id] ? { ...prev, [h.id]: { ...prev[h.id]!, clips } } : prev));
                        }}
                        className="h-7 w-14 px-1.5 text-[12.5px] tabular-nums"
                      />
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {total > 0 && (
        <p className="text-muted-foreground text-[12.5px]">
          {Object.keys(keeps).length} video{Object.keys(keeps).length === 1 ? "" : "s"} ticked · {total} clip{total === 1 ? "" : "s"} in total, cut one run at a time.
        </p>
      )}
    </Field>
  );
}

/* ------------------------------------------------------------- run panel */

/** Read the run directly, so links also work outside the rail's latest 60. */
function RunPanel({ runId, onDelete }: { runId: string; onDelete: () => Promise<void> }) {
  const detail = useApi(() => runsApi.get(runId), [runId]);
  const run = detail.data;
  const live = run ? isLive(run.status) : false;
  const reload = detail.reload;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => reload(), 2000);
    return () => clearInterval(t);
  }, [live, reload]);
  const d = detail.data;
  const carousel = d?.input?.format === "carousel";
  if (!run) return (
    <div className="bg-card grid gap-3 rounded-[14px] p-4.5">
      {detail.error ? <><p role="alert">{detail.error}</p><Button variant="outline" onClick={reload}>Try again</Button></>
        : <p role="status" className="text-muted-foreground">Loading generation…</p>}
    </div>
  );
  return (
    <div className="bg-card grid gap-3 rounded-[14px] p-4.5">
      {detail.error && <p role="alert" className="text-destructive text-sm">Could not refresh this run. {detail.error}</p>}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-medium">{run.title}</span>
        <span className={cn("text-[12.5px]", run.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {run.status}
          {d?.queuePosition ? ` · ${d.queuePosition} in the queue` : ""}
          {run.ventureName ? ` · ${run.ventureName}` : ""} · {ago(run.queuedAt)}
        </span>
        <Link to={appPage("video", run.id)} className="text-muted-foreground ml-auto text-[12.5px] underline decoration-dotted">
          Open the run
        </Link>
      </div>
      {run.error && <p className="text-destructive text-[13.5px] leading-relaxed">{run.error}</p>}
      {live && d && d.steps.length > 0 && <RunSteps steps={d.steps} />}
      {/* A carousel is drawn while it is still moving, a slide at a time:
          `version` is the count of finished steps, so it is re-read exactly
          when a slide lands. */}
      {carousel && <CarouselResult runId={run.id} version={d?.steps.filter((s) => s.finishedAt).length ?? 0}
        onDelete={live ? undefined : onDelete} />}
      {live && (!d || d.steps.length === 0) && (
        <p className="text-muted-foreground text-[13px]">
          {run.status === "queued" ? "Waiting its turn. The queue runs one at a time." : "Working. The steps appear here as it goes."}
        </p>
      )}
      {!live && !carousel && <VideoResult runId={run.id} />}
    </div>
  );
}
