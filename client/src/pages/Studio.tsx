import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Clapperboard,
  Film,
  Image as ImageIcon,
  Loader2,
  Scissors,
  Send,
  Shapes,
  Sparkles,
  Timer,
  Tv,
  Video as VideoIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VentureSelect } from "@/components/VentureSelect";
import { PostCard } from "@/components/studio/PostCard";
import { ReadinessBanner } from "@/components/studio/ReadinessBanner";
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
import { autopilotApi, stewieApi, videoApi, type VideoJob } from "@/lib/api/video";
import { motionApi } from "@/lib/api/motion";
import { isLive, runsApi, type RunDetail, type RunSummary } from "@/lib/api/runs";

/**
 * THE STUDIO — every way this box makes a post or a video, on one page.
 *
 * It was a still-post page with a UGC button on it, and the five video
 * pipelines each had a page of their own: the Video run form, the Motion
 * editor, Autopilot, Publishing. Those pages still exist and still work — a
 * run's own page is still where its steps, its retries and its note live —
 * but the DOOR to all of them is here now, because the owner reaching for
 * "make something" should not first have to know which of six pages makes
 * it.
 *
 * THE SHAPE. A title, one row of tabs — Image post, UGC clip, Faceless,
 * Shorts, Reel, Motion — and under the chosen tab the fewest fields that
 * pipeline needs. Everything ever made, of every kind, sits in the rail on
 * the left, newest first, with Autopilot and Publishing at the top of it:
 * the thing that fills the rail on a schedule, and the place a finished
 * piece goes next. Choosing a row opens it under the form.
 *
 * WHAT EACH TAB ACTUALLY CALLS, because the six are three different things
 * on the server. An image post is one request that holds the line until the
 * picture exists (`studioApi.create`). A UGC clip is queued through the
 * socialfeed area's own route, which names what will be spent before the
 * run starts. The other four are `video` RUNS on the shared queue — one
 * `runsApi.start` with a `format` — and they finish in the background, so
 * the rail polls while anything is moving and stops when nothing is.
 *
 * NOTHING HERE POSTS ANYTHING ANYWHERE. A finished post is sent to
 * Publishing as a draft from its card, and a finished video lands on its run
 * page; the queue is where somebody approves a thing against a real account.
 */

type Make = "image" | "ugc" | "faceless" | "shorts" | "reel" | "motion" | "stewie";

const MAKES: { key: Make; label: string; icon: typeof Sparkles; about: string }[] = [
  { key: "image", label: "Image post", icon: ImageIcon, about: "A caption and a picture in the venture's own brand." },
  { key: "ugc", label: "UGC clip", icon: Clapperboard, about: "The product, from its own reference pictures, put in a scene and animated." },
  { key: "faceless", label: "Faceless video", icon: VideoIcon, about: "A script from the venture over stock footage, captions burned in." },
  { key: "shorts", label: "Shorts", icon: Scissors, about: "Two to four vertical clips cut out of a long video." },
  { key: "reel", label: "Reel", icon: Film, about: "Two voices walking through the venture's own pages, scrolling." },
  { key: "motion", label: "Motion", icon: Shapes, about: "Animated typography from a scene list, in the venture's colours." },
  { key: "stewie", label: "Stewie", icon: Tv, about: "Peter explains, Stewie interrupts, over gameplay footage — cloned voices, rendered by Workdash on the Dell." },
];

const PLATFORMS = ["Instagram", "LinkedIn", "X", "Facebook", "TikTok"];
const SHAPES: { key: StudioFormat; ratio: string }[] = [
  { key: "square", ratio: "1:1" },
  { key: "story", ratio: "9:16" },
  { key: "landscape", ratio: "16:9" },
];
const ASPECTS = ["9:16", "1:1", "16:9"];

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
  | { key: string; kind: "run"; ts: string; run: RunSummary; job: (VideoJob & { clipCount: number }) | null; input: Record<string, string> | null };

const FORMAT_LABEL: Record<string, string> = { image: "Image post", ugc: "UGC clip", faceless: "Faceless video", shorts: "Shorts", reel: "Reel", motion: "Motion", stewie: "Stewie" };

function isMake(v: string | null): v is Make {
  return MAKES.some((m) => m.key === v);
}

export function Studio() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [params, setParams] = useSearchParams();

  /* WHICH TAB AND WHICH ROW ARE IN THE ADDRESS, so a link to "make a reel"
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
  const liveIds = runRows.filter((r) => isLive(r.status)).map((r) => r.id).join(",");
  const liveDetails = useApi(
    () => Promise.all(liveIds.split(",").filter(Boolean).map((id) => runsApi.get(id).catch(() => null))),
    [liveIds],
  );

  const generations = useMemo<Generation[]>(() => {
    const jobs = new Map((videos.data?.videos ?? []).map((v) => [v.runId, v]));
    const inputs = new Map((liveDetails.data ?? []).filter((d): d is RunDetail => !!d).map((d) => [d.id, d.input]));
    const rows: Generation[] = [
      ...(posts.data?.posts ?? []).map((post) => ({ key: `post:${post.id}`, kind: "post" as const, ts: post.ts, post })),
      ...(runs.data?.runs ?? []).map((run) => ({ key: `run:${run.id}`, kind: "run" as const, ts: run.queuedAt, run, job: jobs.get(run.id) ?? null, input: inputs.get(run.id) ?? null })),
    ];
    return rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  }, [posts.data, runs.data, videos.data, liveDetails.data]);
  const open = generations.find((g) => g.key === openKey) ?? null;

  function replacePost(post: StudioPost) {
    posts.setData((d) => (d ? { ...d, posts: d.posts.map((p) => (p.id === post.id ? post : p)) } : d));
  }
  function forgetPost(id: string) {
    posts.setData((d) => (d ? { ...d, posts: d.posts.filter((p) => p.id !== id) } : d));
    if (openKey === `post:${id}`) setParam("open", null);
  }

  return (
    <div className="flex min-h-0 flex-1">
      <Rail
        ventures={ventures}
        railVenture={railVenture}
        onRailVenture={setRailVenture}
        generations={generations}
        loading={posts.loading || runs.loading}
        openKey={openKey}
        onOpen={(key) => setParam("open", key)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-3 pb-20">
        <div className="mx-auto w-full max-w-[760px]">
          <h1 className="mt-10 mb-6 text-center text-[30px] font-normal tracking-[-0.025em]">
            Create anything with AI
          </h1>

          <Tabs value={make} onValueChange={(v) => setParam("make", v)} className="items-center">
            <TabsList variant="line" className="flex-wrap justify-center">
              {MAKES.map((m) => (
                <TabsTrigger key={m.key} value={m.key} className="flex-none px-2.5">
                  <m.icon data-icon="inline-start" className="size-3.5" strokeWidth={1.8} />
                  {m.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <p className="text-muted-foreground mt-3 mb-5 text-center text-[13.5px]">
            {MAKES.find((m) => m.key === make)?.about}
          </p>

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
          )}

          {open && (
            <div className="mt-8">
              {open.kind === "post" ? (
                <PostCard
                  post={open.post}
                  palette={(() => { const v = ventures.find((x) => x.id === open.post.ventureId); return v ? palette(v) : undefined; })()}
                  onChanged={replacePost}
                  onDeleted={forgetPost}
                />
              ) : (
                <RunPanel run={open.run} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ rail */

function Rail({ ventures, railVenture, onRailVenture, generations, loading, openKey, onOpen }: {
  ventures: Venture[];
  railVenture: string | null;
  onRailVenture: (id: string | null) => void;
  generations: Generation[];
  loading: boolean;
  openKey: string | null;
  onOpen: (key: string) => void;
}) {
  /* The two doors at the top: what fills this rail on its own, and where a
     finished piece goes next. Each carries one fact so the row says whether
     it needs looking at. */
  const autopilot = useApi(() => autopilotApi.read().catch(() => null), []);
  const queue = useApi(() => publishingApi.items({ status: "draft" }).catch(() => null), []);
  const drafts = queue.data?.counts?.draft;

  return (
    <aside className="bg-sidebar/40 border-line-soft flex w-[272px] shrink-0 flex-col border-r">
      <div className="border-line-soft grid gap-0.5 border-b p-2.5">
        <Link to="/social/autopilot" className="hover:bg-accent flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors">
          <Timer className="size-4 shrink-0" strokeWidth={1.7} />
          <span className="text-[13.5px]">Autopilot</span>
          <span className="text-muted-foreground ml-auto truncate text-[12px]">
            {autopilot.data
              ? autopilot.data.schedule.enabled
                ? `on · next ${when(autopilot.data.nextRunAt)}`
                : "off"
              : ""}
          </span>
        </Link>
        <Link to="/social/publishing" className="hover:bg-accent flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors">
          <Send className="size-4 shrink-0" strokeWidth={1.7} />
          <span className="text-[13.5px]">Publishing</span>
          <span className="text-muted-foreground ml-auto text-[12px]">
            {drafts ? `${drafts} draft${drafts === 1 ? "" : "s"}` : ""}
          </span>
        </Link>
      </div>

      <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <span className="text-muted-foreground text-[11.5px] font-medium tracking-[0.08em] uppercase">Generations</span>
        <span className="text-muted-foreground ml-auto text-[12px]">{loading ? "loading…" : generations.length || ""}</span>
      </div>
      <div className="px-2.5 pb-2">
        <VentureSelect ventures={ventures} value={railVenture} onChange={onRailVenture} none="Every venture" className="h-8 w-full text-[13px]" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!loading && generations.length === 0 && (
          <p className="text-muted-foreground px-2 py-2 text-[12.5px] leading-relaxed">
            Nothing made yet. Whatever you make above lands here, and Autopilot adds to it on a schedule.
          </p>
        )}
        <div className="grid gap-px">
          {generations.map((g) => (
            <GenerationRow key={g.key} generation={g} active={g.key === openKey} onClick={() => onOpen(g.key)} />
          ))}
        </div>
      </div>
    </aside>
  );
}

const FORMAT_ICON: Record<string, typeof Film> = { ugc: Clapperboard, faceless: VideoIcon, shorts: Scissors, reel: Film, motion: Shapes, stewie: Tv };

function GenerationRow({ generation: g, active, onClick }: { generation: Generation; active: boolean; onClick: () => void }) {
  if (g.kind === "post") {
    const p = g.post;
    return (
      <button onClick={onClick} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors", active ? "bg-accent" : "hover:bg-accent/60")}>
        {p.image && p.imageOnDisk ? (
          <img src={p.image} alt="" className="size-9 shrink-0 rounded-md object-cover" />
        ) : (
          <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md"><ImageIcon className="text-muted-foreground size-4" strokeWidth={1.6} /></span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{p.caption?.split("\n")[0] || p.brief}</span>
          <span className="text-muted-foreground block truncate text-[11.5px]">
            Image post · {p.format}{p.error ? " · problem" : ""} · {ago(p.ts)}
          </span>
        </span>
      </button>
    );
  }
  const r = g.run;
  const format = g.job?.format ?? g.input?.format ?? "";
  const Icon = FORMAT_ICON[format] ?? VideoIcon;
  const live = isLive(r.status);
  const title =
    g.job?.script?.title ?? g.job?.script?.brief ?? g.input?.brief ?? g.input?.url ?? r.ventureName ?? "Video";
  const what = FORMAT_LABEL[format] ?? "Video";
  const clips = g.job && g.job.clipCount > 0 ? ` · ${g.job.clipCount} clips` : "";
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors", active ? "bg-accent" : "hover:bg-accent/60")}>
      <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md">
        {live ? <Loader2 className="text-muted-foreground size-4 animate-spin" strokeWidth={1.6} /> : <Icon className="text-muted-foreground size-4" strokeWidth={1.6} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{title}</span>
        <span className={cn("block truncate text-[11.5px]", r.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {what}{clips} · {live ? r.status : r.status === "done" ? (g.job?.onDisk === false ? "file gone" : "done") : r.status} · {ago(r.queuedAt)}
        </span>
      </span>
    </button>
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

function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { key: T; label: string; sub?: string; title?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
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
  const [platform, setPlatform] = useState<string | null>(null);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [aspect, setAspect] = useState("9:16");
  const [fit, setFit] = useState("cover");
  const [seconds, setSeconds] = useState(make === "shorts" ? "45" : "30");
  const [clips, setClips] = useState("3");
  const [url, setUrl] = useState("");
  const [spec, setSpec] = useState("");
  const [voiceover, setVoiceover] = useState(false);
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
  const [stewieMode, setStewieMode] = useState<"images" | "pages">("images");
  const [background, setBackground] = useState("");

  const needsVenture = make !== "shorts" && make !== "stewie";
  const ready =
    !busy &&
    (!needsVenture || !!venture) &&
    (make === "image" ? brief.trim().length > 0 : true) &&
    (make === "ugc" ? assets.length > 0 : true) &&
    (make === "shorts" ? url.trim().length > 0 : true) &&
    (make === "stewie" ? (stewie.data?.configured ?? false) && !stewie.data?.running && (stewieMode === "pages" ? url.trim().length > 0 : brief.trim().length > 0) : true);

  async function go() {
    if (!ready) return;
    setBusy(true);
    setRefused(null);
    setSaid(null);
    try {
      if (make === "image") {
        const res = await studioApi.create({ ventureId: venture!.id, brief: brief.trim(), format: shape, platform, assetIds });
        onPost(res.post);
        setBrief("");
      } else if (make === "ugc") {
        const res = await socialfeedApi.startUgc({ venture: venture!.slug, brief: brief.trim(), assets: assetIds, aspect });
        setSaid(`Queued. Image: ${res.spend.image}. Video: ${res.spend.video}.`);
        onRun(res.run.id);
      } else {
        const input: Record<string, string> = { format: make, brief: brief.trim(), aspect };
        if (make === "faceless") Object.assign(input, { seconds, fit });
        if (make === "shorts") Object.assign(input, { url: url.trim(), seconds, clips, fit });
        if (make === "reel") Object.assign(input, { url: url.trim(), seconds });
        if (make === "motion") Object.assign(input, { spec, voiceover: voiceover ? "true" : "false" });
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

  const cost = {
    image: readiness?.image.ready
      ? "About twenty seconds, and a fraction of a cent on Replicate."
      : "About five seconds. Without Replicate the post is stored with its words and no picture.",
    ugc: "One image prediction always, and one image-to-video prediction if a model is set under Integrations → Social feed. With none set it makes a still and spends nothing on video.",
    faceless: "A model turn for the script, Pexels for the footage, ffmpeg on this machine. A minute or two.",
    shorts: "yt-dlp fetches the source, a model picks the moments where it can, ffmpeg cuts. A few minutes for a long source.",
    reel: "Headless Chrome captures each page, a model writes the two voices, the voice plugin speaks them if it is on.",
    motion: "A model drafts the scene list unless you pick a saved one; Chrome renders the frames. Silent unless the voice plugin is on.",
    stewie: "Handed to Workdash's Pi, which wakes the Dell if it is asleep (about ninety seconds), writes the two-hander there, clones both voices and renders. A few minutes, and real power while the Dell is up.",
  }[make];

  return (
    <div className="bg-card grid gap-3.5 rounded-[14px] p-4.5">
      {(make === "image" || make === "ugc") && readiness && <ReadinessBanner readiness={readiness} />}

      <Field label={needsVenture ? "For which venture" : "For which venture (optional)"}>
        <VentureSelect ventures={ventures} value={venture?.id ?? null} onChange={(id) => { onVenture(id); setAssetIds([]); setSpec(""); }} none={needsVenture ? null : "No venture"} />
      </Field>

      {make === "shorts" && (
        <Field label="Source video" hint="A YouTube address or a direct link to a video file.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" className="text-[14px]" />
        </Field>
      )}

      {make === "stewie" && (
        <div className="grid gap-3.5">
          {stewie.data && (
            <p className={cn("text-[12.5px]", stewie.data.configured ? "text-muted-foreground" : "text-destructive")}>
              {stewie.data.configured ? stewie.data.note : <>{stewie.data.note} <Link to="/integrations/workdash" className="underline decoration-dotted">Connect it</Link>.</>}
              {stewie.data.running ? " A reel is rendering on the Pi right now; it does one at a time." : ""}
            </p>
          )}
          <Field label="Pictures behind them" hint={stewieMode === "pages" ? "Real screenshots of the pages you list, scrolling — the mode for showing a product." : "A searched picture per line — fine for explaining a concept, useless for showing a product."}>
            <Chips value={stewieMode} onChange={setStewieMode} options={[{ key: "images", label: "Searched images" }, { key: "pages", label: "Your pages" }]} />
          </Field>
          {stewieMode === "pages" && (
            <Field label="Pages to show" hint="One address per line, up to eight. The page titles become the topic when the brief is empty.">
              <Textarea value={url} onChange={(e) => setUrl(e.target.value)} rows={3} placeholder="https://…" className="text-[14px]" />
            </Field>
          )}
          {(stewie.data?.worker?.backgrounds?.length ?? 0) > 0 ? (
            <Field label="Gameplay footage">
              <Chips
                value={background}
                onChange={setBackground}
                options={[{ key: "", label: "Worker's default" }, ...stewie.data!.worker!.backgrounds!.map((b) => ({ key: b, label: b.replace(/_/g, " ") }))]}
              />
            </Field>
          ) : (
            <Field label="Gameplay footage (optional)" hint="The worker is asleep, so its clip list is not known. Name one it holds, or leave it for the default.">
              <Input value={background} onChange={(e) => setBackground(e.target.value)} placeholder="subway_surfers" className="w-64 text-[14px]" />
            </Field>
          )}
        </div>
      )}

      {make === "reel" && (
        <Field label="Pages to walk through" hint="One address per line. Empty uses the venture's own website.">
          <Textarea value={url} onChange={(e) => setUrl(e.target.value)} rows={2} placeholder="https://…" className="text-[14px]" />
        </Field>
      )}

      {make === "motion" && (specs.data?.specs.length ?? 0) > 0 && (
        <Field label="Scene list" hint="A saved list renders as written. Drafting one from the brief is a model call, and its numbers are claims to read before you publish.">
          <select value={spec} onChange={(e) => setSpec(e.target.value)} className="border-line-soft h-9 rounded-[12px] border bg-transparent px-2.5 text-[13.5px]">
            <option value="">Draft one from the brief</option>
            {specs.data!.specs.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.scenes} scenes · {s.aspect}</option>
            ))}
          </select>
        </Field>
      )}

      {!(make === "motion" && spec) && (
        <Field
          label={make === "image" ? "What the post is about" : make === "shorts" ? "What to look for (optional)" : make === "stewie" ? (stewieMode === "pages" ? "What they should explain (optional)" : "What they should explain") : "What it is about"}
          hint={make === "image" ? undefined : make === "stewie" ? "One or two lines. In pages mode this can be a whole pitch pasted in for the script to lean on." : "Empty makes the general case for the venture."}
        >
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={make === "image" ? 3 : 2}
            maxLength={2000}
            placeholder={make === "image" ? "One line. “We shipped weekly digests” — not the post itself." : make === "shorts" ? "The moments worth keeping." : "One or two lines."}
            className="text-[14.5px]"
          />
        </Field>
      )}

      {wantsAssets && venture && (
        <Field
          label={make === "ugc" ? "Product pictures" : "Take visual direction from"}
          hint={assets.length ? (make === "ugc" ? "The clip is made from these. Empty uses the library, up to four." : library.data?.imageModel.note) : undefined}
        >
          {assets.length === 0 ? (
            <p className="text-muted-foreground text-[12.5px]">
              {venture.name} has no assets yet{make === "ugc" ? ", and a UGC clip is a picture of a real product" : ""}. Upload one under{" "}
              <Link to="/social/publishing?tab=assets" className="underline decoration-dotted">Publishing → Assets</Link>.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {assets.slice(0, 12).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={a.prompt ?? a.name ?? a.kind}
                  onClick={() => setAssetIds((prev) => (prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id].slice(0, 4)))}
                  className={cn("overflow-hidden rounded-[11px] border transition-colors", assetIds.includes(a.id) ? "border-foreground" : "hover:border-line-strong")}
                >
                  {a.onDisk ? <img src={a.url} alt="" className="size-12 object-cover" /> : <span className="text-muted-foreground flex size-12 items-center justify-center text-[11px]">missing</span>}
                </button>
              ))}
            </div>
          )}
        </Field>
      )}

      {make === "image" ? (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Shape">
            <Chips value={shape} onChange={setShape} options={SHAPES.map((s) => ({ key: s.key, label: s.key, sub: s.ratio }))} />
          </Field>
          <Field label="Written for">
            <Chips
              value={platform ?? ""}
              onChange={(v) => setPlatform(v || null)}
              options={[{ key: "", label: "Any" }, ...PLATFORMS.map((p) => ({ key: p, label: p }))]}
            />
          </Field>
        </div>
      ) : make === "stewie" ? null : (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Shape">
            <Chips value={aspect} onChange={setAspect} options={ASPECTS.map((a) => ({ key: a, label: a }))} />
          </Field>
          {(make === "faceless" || make === "reel") && (
            <Field label="Length in seconds" hint={make === "faceless" ? "10 to 120." : "10 to 120; decides how many lines of dialogue there are."}>
              <Input type="number" min={10} max={120} value={seconds} onChange={(e) => setSeconds(e.target.value)} className="w-28" />
            </Field>
          )}
          {make === "shorts" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Clips" hint="Two to four.">
                <Input type="number" min={2} max={4} value={clips} onChange={(e) => setClips(e.target.value)} className="w-20" />
              </Field>
              <Field label="Max seconds" hint="15 to 90 each.">
                <Input type="number" min={15} max={90} value={seconds} onChange={(e) => setSeconds(e.target.value)} className="w-24" />
              </Field>
            </div>
          )}
          {make === "motion" && (
            <Field label="Narration">
              <label className="flex h-9 items-center gap-2.5 text-[13.5px]">
                <Switch checked={voiceover} onCheckedChange={setVoiceover} />
                {voiceover ? "Spoken, if the voice plugin has speech on" : "Silent"}
              </label>
            </Field>
          )}
          {(make === "faceless" || make === "shorts") && (
            <Field label="Fit">
              <Chips value={fit} onChange={setFit} options={[{ key: "cover", label: "Centre crop" }, { key: "letterbox", label: "Letterbox" }]} />
            </Field>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <Button disabled={!ready} onClick={() => void go()}>
          {busy ? <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} /> : <Sparkles className="size-[15px]" strokeWidth={1.8} />}
          {busy ? (make === "image" ? "Making it…" : "Queueing…") : `Make ${MAKES.find((m) => m.key === make)!.label.toLowerCase()}`}
        </Button>
        <span className="text-muted-foreground text-[13px]">{cost}</span>
      </div>
      {said && <p className="text-[13.5px]">{said}</p>}
      {refused && <p className="text-destructive text-[13.5px] leading-relaxed">{refused}</p>}
    </div>
  );
}

/* ------------------------------------------------------------- run panel */

/** A video run under the form: its state while it moves, the file once it
 *  has stopped, and the door to its own page for everything else. */
function RunPanel({ run }: { run: RunSummary }) {
  const live = isLive(run.status);
  const detail = useApi(() => runsApi.get(run.id).catch(() => null), [run.id, run.status]);
  const reload = detail.reload;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => reload(), 2000);
    return () => clearInterval(t);
  }, [live, reload]);
  const d = detail.data;
  return (
    <div className="bg-card grid gap-3 rounded-[14px] p-4.5">
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
      {live && (!d || d.steps.length === 0) && (
        <p className="text-muted-foreground text-[13px]">
          {run.status === "queued" ? "Waiting its turn. The queue runs one at a time." : "Working. The steps appear here as it goes."}
        </p>
      )}
      {!live && <VideoResult runId={run.id} />}
    </div>
  );
}
