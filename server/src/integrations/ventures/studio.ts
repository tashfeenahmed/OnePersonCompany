/**
 * THE STUDIO — a post for a venture: words from the model provider, a picture
 * from Replicate, both in the venture's own brand.
 *
 * WHY THIS IS A VENTURE ROUTE AND NOT A "SOCIAL" INTEGRATION. Nothing here
 * measures anything and nothing here publishes anything — which is STILL TRUE
 * after `integrations/publishing/` arrived: a finished post is FILED there as
 * a draft by a button on the page, and every route in this file remains unable
 * to send anything anywhere. It takes what the box
 * already KNOWS about a business — the name, the sentence the owner wrote, the
 * stage it is at, the palette and the fonts read off its own site — and turns
 * a one-line brief into a caption and an image that look like they came from
 * that business rather than from a stock library. The venture record is the
 * whole input; without it this would be a prompt box.
 *
 * THE TWO HALVES FAIL SEPARATELY AND THE ROW KEEPS BOTH. A caption needs a
 * model provider; an image needs a Replicate token. A box with the first and
 * not the second produces a post with words, no picture, and an `error` saying
 * exactly which credential is missing — which is a useful post and a true
 * record. The reverse is not offered: an image with no caption is a picture,
 * and this is not a picture generator.
 *
 * THE IMAGE COSTS MONEY AND THE ROUTE SAYS SO BEFORE IT SPENDS ANY. `GET
 * /api/studio` reports readiness — is a provider live, is Replicate connected,
 * which model — so a page can offer the button honestly rather than discover
 * the failure after the owner pressed it. flux-schnell is the default because
 * it is the cheapest thing on Replicate that produces something usable; the
 * model is a setting because "cheapest usable" is a judgement that changes.
 *
 * REPLICATE IS CALLED WITH `Prefer: wait` AND THEN POLLED IF IT DOES NOT
 * FINISH IN TIME — see `tools/replicate-run.ts` for why abandoning it instead
 * is the worse of the two outcomes. The poll here is bounded much tighter
 * than for a video, because this route is one somebody is waiting on in a
 * browser — see `makeImage`.
 *
 * NO COST IS REPORTED, and providers/replicate.ts's header explains at length
 * why there is none to report: Replicate publishes no price anywhere in its
 * API and a prediction record carries no hardware and no rate. `ms` is the
 * wall clock this took. It is not money and is not labelled as if it were.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { DATA_DIR } from "../../config.ts";
import { configValue, db, now, ventureRow, ventureRowById, type VentureRow } from "../../db.ts";
import { readBrand } from "../../ventures/enrich.ts";
import { factsForPrompt } from "../knowledge/store.ts";
import { guidePrompt, guideVisuals } from "../references/guide.ts";
import { tokenAccounts } from "../../providers/replicate.ts";
import { download, firstUrl, predict } from "../../tools/replicate-run.ts";
import { ASPECTS } from "../video/assemble.ts";
import { activeProvider, complete, NoProviderError } from "../../models/provider.ts";

export const studioRoutes = new Hono();

/** The pseudo-plugin the image model hangs off — `chat` and `models` do the
 *  same one layer up, and for the same foreign-key reason. */
export const STUDIO_PLUGIN = "studio";

export const STUDIO_DIR = resolve(DATA_DIR, "studio");

/* ------------------------------------------------- reference images (2026-09-06)
 *
 * THE STUDIO CAN NOW BE HANDED A VENTURE'S OWN PICTURES — a logo, a reference,
 * a screenshot out of the asset library — and it reaches them through a
 * FUNCTION SOMEBODY ELSE INSTALLS rather than by importing the library.
 *
 * That is not politeness. The library stores its files under this module's
 * STUDIO_DIR and therefore imports this file; an import back would be a cycle,
 * and a cycle through a module that `integrations/index.ts` loads at import
 * time does not start the process at all. So the publishing area calls
 * `setReferenceResolver` from its manifest, and this file never learns what an
 * asset is.
 *
 * THE THREE-VALUED ANSWER IS THE POINT. `field` names the input property the
 * image model actually takes a picture in — read off that model's own schema,
 * not guessed from its name — and a model that has none gets `field: null`,
 * the pictures DESCRIBED IN WORDS in the prompt, and a note saying so on the
 * post. A reference silently dropped would be the worst of the three
 * outcomes, because the post would look like it had been used.
 */
export type ResolvedReferences = {
  /** `data:` URIs, in the order the caller asked for them. Empty when the
   *  model cannot take an image at all. */
  dataUrls: string[];
  /** The model's own input property for an image, or null. */
  field: string | null;
  /** Whether that property takes a list rather than one image. */
  many: boolean;
  /** One sentence per asset, for the prompt, when the model takes no image. */
  texts: string[];
  /** What happened, in words, for the post's `error`/note. */
  note: string;
};

export type ReferenceResolver = (
  ventureId: string,
  assetIds: string[],
  model: string,
) => Promise<ResolvedReferences>;

let referenceResolver: ReferenceResolver | null = null;

/** Installed by the publishing area's manifest. Absent, `assetIds` is refused
 *  with a sentence rather than ignored. */
export function setReferenceResolver(fn: ReferenceResolver) {
  referenceResolver = fn;
}

async function resolveReferences(
  ventureId: string,
  assetIds: string[],
  model: string,
): Promise<ResolvedReferences> {
  if (!referenceResolver)
    return {
      dataUrls: [],
      field: null,
      many: false,
      texts: [],
      note: "No asset library is installed on this server, so no reference was used.",
    };
  return referenceResolver(ventureId, assetIds, model);
}

/**
 * The default image model.
 *
 * flux-schnell: four steps, a second or two, a fraction of a cent, and good
 * enough for a social card. Named as `owner/name` because that is the shape
 * Replicate's model-predictions endpoint takes in its path.
 */
export const DEFAULT_MODEL = "black-forest-labs/flux-schnell";

/** How long Replicate is allowed to hold the connection open under
 *  `Prefer: wait`, plus a little. Its own ceiling is 60 seconds. */
const REPLICATE_MS = 75_000;
/** Downloading the finished image. */
const DOWNLOAD_MS = 30_000;
/** An image bigger than this is not a social card. */
const IMAGE_CAP = 12 * 1024 * 1024;
/** How long a queued prediction is followed. See `makeImage`. */
const POLL_FOR_MS = 3 * 60_000;

/**
 * THE FRAME SHAPES A POST CAN BE, named for what the post IS.
 *
 * `ratio` is a key of ASPECTS — video/assemble.ts's list of the shapes this
 * box renders — and it is checked against it below rather than typed twice.
 * The Studio's names ("story") and the renderer's shapes ("9:16") are two
 * vocabularies for one thing; typing this map's ratios by hand risks a
 * fourth aspect being accepted by the video routes and silently rendered
 * portrait here.
 */
const FORMATS = {
  square: { ratio: "1:1", about: "1:1 — a feed post on Instagram, LinkedIn or X." },
  story: { ratio: "9:16", about: "9:16 — a story or a reel cover." },
  landscape: { ratio: "16:9", about: "16:9 — a link preview, a blog header, a YouTube thumbnail." },
} as const;

export type Format = keyof typeof FORMATS;

/**
 * The Studio's name for a frame shape, or null when it has none.
 *
 * NULL RATHER THAN A DEFAULT, and that is the whole point of exporting it. The
 * copy this replaces ended `: "story"`, so an aspect the Studio did not know
 * became a portrait picture with nothing anywhere saying so. A caller that
 * gets null is being told the truth — this box renders that shape and the
 * Studio cannot compose for it — and can refuse the job or say so on the run.
 */
export function formatForAspect(aspect: string): Format | null {
  for (const [name, f] of Object.entries(FORMATS))
    if (f.ratio === aspect) return name as Format;
  return null;
}

/** Every shape the renderer supports that the Studio cannot compose for. Empty
 *  on a healthy box; a non-empty list is the drift this pairing exists to make
 *  visible, and `GET /api/studio` prints it rather than hiding it. */
export const unnamedAspects = (): string[] =>
  Object.keys(ASPECTS).filter((a) => formatForAspect(a) === null);

const MAX_BRIEF = 2_000;
const MAX_PLATFORM = 40;

/* ------------------------------------------------------------------ rows */

export type PostRow = {
  id: string;
  venture_id: string;
  ts: string;
  brief: string;
  platform: string | null;
  format: string;
  caption: string | null;
  hashtags: string | null;
  image_prompt: string | null;
  image_path: string | null;
  model: string | null;
  ms: number | null;
  error: string | null;
};

function shape(r: PostRow) {
  return {
    id: r.id,
    ventureId: r.venture_id,
    ts: r.ts,
    brief: r.brief,
    platform: r.platform,
    format: r.format,
    caption: r.caption,
    /* A list rather than the stored line, because every caller wants them
       separately and splitting a string in four places is four rules. */
    hashtags: r.hashtags ? r.hashtags.split(/\s+/).filter(Boolean) : [],
    imagePrompt: r.image_prompt,
    image: r.image_path && existsSync(r.image_path) ? `/api/studio/posts/${r.id}/image` : null,
    imageOnDisk: r.image_path ? existsSync(r.image_path) : false,
    model: r.model,
    ms: r.ms,
    error: r.error,
  };
}

function postRow(id: string): PostRow | undefined {
  return db.prepare("SELECT * FROM studio_posts WHERE id = ?").get(id) as PostRow | undefined;
}

function newId(): string {
  for (;;) {
    const id = `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!postRow(id)) return id;
  }
}

/* --------------------------------------------------------------- the brief */

/**
 * WHAT THE MODEL IS TOLD ABOUT THE BUSINESS.
 *
 * Every fact in here is one the owner or a measurement already produced, and
 * each is labelled with which it is: the name, the sentence and the stage are
 * the OWNER'S, the palette and the fonts were READ OFF THE SITE. That
 * distinction is on the wire in routes/ventures.ts and it is kept here,
 * because a model told "your brand colour is #44AA44" will write about the
 * brand colour, and what is true is that the site's strongest colour reads as
 * that.
 *
 * THE STAGE CHANGES WHAT A POST IS FOR. An idea has nothing to sell yet and a
 * launched business does; a post that says "try it now" about a thing that
 * does not exist is the most expensive kind of wrong here, because somebody
 * clicks it.
 */
const STAGE_VOICE: Record<string, string> = {
  idea: "This is an IDEA — it is not built and there is nothing to sign up for. A post about it can share the problem, ask a question, or gather interest. It must not say the product exists, invite anybody to try it, or imply a price.",
  "pre-launch": "This is PRE-LAUNCH — being built, not yet available. A post can build anticipation, show progress or collect a waiting list. It must not read as if the product were on sale today.",
  launched: "This is LAUNCHED and serving people. A post can point at the product, name what it does for someone, and invite them to use it.",
};

function brandFacts(v: VentureRow): string[] {
  const brand = readBrand(v.brand);
  const facts: string[] = [
    `Name (the owner's): ${v.name}`,
    `What it is (the owner's own words): ${v.description || "— he has not written one."}`,
    `Stage (the owner's declaration): ${v.stage}. ${STAGE_VOICE[v.stage] ?? ""}`,
    `Website: ${v.website ?? "none yet"}`,
  ];
  const hexes = [brand.palette.primary, brand.palette.secondary, brand.palette.accent].filter(
    (h): h is string => !!h,
  );
  if (hexes.length)
    facts.push(
      `Colours MEASURED FROM THE SITE (not chosen by anyone): ${hexes.join(", ")}` +
        (brand.palette.background ? `, on ${brand.palette.background}` : ""),
    );
  else if (v.color_source === "owner") facts.push(`Colour the owner chose: ${v.color}`);
  if (brand.fonts.length) facts.push(`Fonts seen in the site's CSS: ${brand.fonts.join(", ")}`);
  if (brand.title) facts.push(`The site's own title: ${brand.title}`);
  return facts;
}

function captionTurns(v: VentureRow, brief: string, platform: string | null, format: Format) {
  const system =
    "You write social posts for a one-person software business. You are given " +
    "facts about the business and a brief. Answer with exactly two blocks and " +
    "nothing else:\n" +
    "CAPTION:\n<the post, ready to publish, no surrounding quotes>\n" +
    "HASHTAGS:\n<between three and six hashtags on one line, space separated, each starting with #>\n\n" +
    "Rules: write in the owner's register, not a marketing agency's. No emoji " +
    "unless the brief asks for them. Never invent a feature, a price, a " +
    "customer, a statistic or a launch date — you may only use what the facts " +
    "below say. Do not describe the image; the caption stands beside one." +
    (platform ? ` The post is for ${platform}; write to that platform's length and register.` : "") +
    ` The image beside it is ${FORMATS[format].about}`;

  /* WHAT IS KNOWN ABOUT THE PRODUCT, WITH THE EVIDENCE — added beside the
     brand facts rather than mixed into them, because the two are different
     kinds of claim: the block above is the owner's words and a reading of the
     site, and this one carries a tier and a date per line. It is capped small
     and excludes unconfirmed proposals, which matters more here than anywhere
     else on this box: a caption is published, and a proposal turned into a
     marketing sentence is a claim made to a customer. See
     integrations/knowledge/store.ts. */
  /* 1,400 rather than 900. The block's own header is 457 characters of rules
     about tiers, so a 900-character budget left about 440 for the facts — three
     or four of them — and a caption written from four facts about a product
     with twenty is a caption that reaches for the marketing page instead. */
  const known = factsForPrompt(v.id, ["capability", "pricing", "integration", "limitation"], 1_400);

  /* THE OWNER'S OWN STYLE GUIDE, LAST AND LABELLED — see
     integrations/references/guide.ts. It goes AFTER the facts rather than
     among them because it is a different kind of sentence: everything above is
     something that is true about the business, and this is an instruction
     about how to write. Its own header says so, and says that it never
     licenses a claim the facts did not carry — otherwise "warm, confident"
     reads as permission to be warm and confident about a feature nobody
     shipped. Null when nothing has been written, which costs the prompt
     nothing at all. */
  const guide = guidePrompt(v.id);
  const user =
    `The business:\n${brandFacts(v).map((f) => `- ${f}`).join("\n")}\n\n` +
    (known ? `${known}\n\n` : "") +
    (guide ? `${guide}\n\n` : "") +
    `The brief: ${brief}`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/**
 * The caption and the hashtags, out of whatever shape the model answered in.
 *
 * MARKERS FIRST, THEN A FALLBACK, because the two-block format is what was
 * asked for and most models comply — but a model that answered with a caption
 * and a trailing line of hashtags has done the job, and throwing that away
 * over a missing header would be this code being right at the owner's expense.
 */
export function splitCaption(text: string): { caption: string; hashtags: string[] } {
  const marked = /CAPTION:\s*([\s\S]*?)(?:\n\s*HASHTAGS:\s*([\s\S]*))?$/i.exec(text.trim());
  let caption = (marked?.[1] ?? text).trim();
  let tagLine = (marked?.[2] ?? "").trim();

  if (!tagLine) {
    const lines = caption.split(/\n/);
    const last = lines[lines.length - 1]?.trim() ?? "";
    /* A trailing line that is nothing but hashtags is the hashtags. A line
       with one hashtag in a sentence is a sentence. */
    if (last.startsWith("#") && last.split(/\s+/).every((t) => t.startsWith("#"))) {
      tagLine = last;
      caption = lines.slice(0, -1).join("\n").trim();
    }
  }

  const hashtags = [...tagLine.matchAll(/#[\wÀ-ɏ]+/g)].map((m) => m[0]!);
  return { caption: caption.replace(/^["“]|["”]$/g, "").trim(), hashtags };
}

/**
 * THE IMAGE PROMPT, built from the same facts as the caption.
 *
 * "No text in the image" is not a preference: every diffusion model renders
 * lettering as approximate glyphs, and a social card with a misspelt product
 * name on it is worse than no card. The words go in the caption, where they
 * are spelled correctly by construction.
 *
 * WHICH IS WHY THE BUSINESS'S NAME IS NOT IN THIS PROMPT, and that is the one
 * thing here that was changed after watching it fail. The first version opened
 * "A clean, modern social graphic for <the business's name>, …" and
 * flux-schnell wrote that name across the middle of the picture in two
 * colours, beside a line of invented lettering — with "no text, no words, no lettering" in the same
 * prompt. Naming a brand in an image prompt IS an instruction to render the
 * brand, and a negative clause does not outrank it in a model that has no
 * negative prompt at all. So the subject is described and never named; the
 * name belongs in the caption, which is the half that can spell it.
 */
function imagePrompt(v: VentureRow, brief: string, format: Format): string {
  const brand = readBrand(v.brand);
  const hexes = [brand.palette.primary, brand.palette.secondary, brand.palette.accent]
    .filter((h): h is string => !!h)
    .slice(0, 3);
  const palette = hexes.length
    ? `Colour palette ${hexes.join(", ")}${brand.palette.background ? ` on ${brand.palette.background}` : ""}.`
    : `Colour palette ${v.color}.`;

  /* The subject, with the brand's own name stripped out of both halves it
     could arrive in — the description the owner wrote and the brief he typed.
     A word boundary and a case-insensitive match, because a brand name in
     title case, in lower case and in capitals are the same instruction to a
     diffusion model. */
  const strip = (text: string) =>
    text
      .replace(new RegExp(`\\b${v.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "the product")
      .trim();

  const subject = [strip(v.description || "a small software product"), strip(brief)]
    .filter(Boolean)
    .join(". ");

  /* THE OWNER'S OWN WORD ON COLOUR, AFTER THE MEASURED PALETTE AND NOT
     INSTEAD OF IT. The palette above is what a browser saw on the site, which
     is right until the site is out of date — "the green is the old logo, use
     the navy" is a sentence with no column shape and no hex, and it is the
     only thing that can correct a measurement here. The fonts note is
     deliberately NOT passed: this prompt forbids lettering outright, so a
     typeface is an instruction with nothing to act on. */
  const owner = guideVisuals(v.id).colours;

  return (
    `A clean, modern editorial illustration about: ${subject}. ${palette} ` +
    (owner ? `The owner's own instruction about colour, which overrides the palette above: ${owner} ` : "") +
    "Flat vector style, generous negative space, soft even lighting. " +
    "Absolutely no text, no words, no letters, no numbers, no captions, no " +
    "logos, no signage, no watermark, no user interface screenshots — the " +
    "picture must contain no writing of any kind. " +
    `Composed for a ${FORMATS[format].ratio} frame.`
  );
}

/* ------------------------------------------------------------- replicate */

export type ImageResult = {
  ok: boolean;
  path: string | null;
  model: string;
  ms: number;
  error: string | null;
};

export function imageModel(): string {
  return (configValue(STUDIO_PLUGIN, "imageModel") ?? "").trim() || DEFAULT_MODEL;
}

/**
 * One prediction, run to completion.
 *
 * The endpoint, the wait header, the poll, the output walker and the capped
 * download are all tools/replicate-run.ts's — they were written twice, and the
 * two copies disagreed about whether a still-queued prediction was worth
 * waiting for. What is this file's is the INPUT: which model, which aspect
 * ratio, four steps, PNG, and where the file lands.
 */
export async function makeImage(
  prompt: string,
  format: Format,
  id: string,
  /** What the asset library resolved, when a caller selected references. The
   *  images go into the model's OWN image field; a model with none gets
   *  nothing here and the words in the prompt instead. */
  refs?: { dataUrls: string[]; field: string | null; many: boolean },
): Promise<ImageResult> {
  const model = imageModel();
  const started = Date.now();
  const fail = (error: string): ImageResult => ({
    ok: false, path: null, model, ms: Date.now() - started, error,
  });

  /* The sentence is this area's and stays this area's — it names the button
     the owner would press next, which the shared runner cannot know. */
  const pairs = tokenAccounts("studio_image");
  if (!pairs.length)
    return fail(
      "Replicate is not connected, so there is no image. Paste an `r8_…` API token " +
        "under Integrations → Replicate and regenerate this post's image.",
    );

  const run = await predict({
    token: pairs[0]!.token,
    model,
    input: {
      prompt,
      /* THE REFERENCE, UNDER THE NAME THIS MODEL ACTUALLY USES. Spread rather
         than assigned so a model with no image field gets a body
         byte-identical to the one it got before this existed — a new key
         holding `undefined` is a key Replicate would reject. */
      ...(refs?.field && refs.dataUrls.length
        ? { [refs.field]: refs.many ? refs.dataUrls : refs.dataUrls[0] }
        : {}),
      aspect_ratio: FORMATS[format].ratio,
      /* PNG rather than the WebP default: the file is served to a browser and
         stored in a backup, and a format every tool opens is worth a few
         hundred kilobytes. */
      output_format: "png",
      num_outputs: 1,
      /* Flux-schnell's own maximum. Four steps is what makes it schnell. */
      num_inference_steps: 4,
      disable_safety_checker: false,
    },
    waitMs: REPLICATE_MS,
    /* THREE MINUTES, NOT THE TWELVE A VIDEO GETS. This runs inside a request
       the owner is watching a spinner for, and a four-step image that has not
       finished in three minutes is not going to. The prediction may still
       land at Replicate afterwards, and the sentence says so. */
    poll: { forMs: POLL_FOR_MS },
  });
  if (!run.ok) return fail(run.error);

  const url = firstUrl(run.output);
  if (!url) return fail("The prediction succeeded and produced no image URL this could read.");

  const got = await download({ url, cap: IMAGE_CAP, what: "image", timeoutMs: DOWNLOAD_MS });
  if (!got.ok) return fail(got.error);

  mkdirSync(STUDIO_DIR, { recursive: true });
  const path = resolve(STUDIO_DIR, `${id}.png`);
  /* Written whole rather than streamed: it is one file of a few hundred
     kilobytes that is already entirely in memory. */
  writeFileSync(path, got.bytes);
  return { ok: true, path, model, ms: Date.now() - started, error: null };
}

/* --------------------------------------------------------------- readiness */

function readiness() {
  const provider = activeProvider();
  const replicate = tokenAccounts("studio_readiness");
  const model = imageModel();
  return {
    caption: {
      ready: provider !== null,
      provider: provider?.id ?? null,
      label: provider?.label ?? null,
      model: provider?.defaultModel ?? null,
      note: provider
        ? `Captions come from ${provider.label}, under its own concurrency policy.`
        : "No model provider is live, so no caption can be written. Choose one under Integrations → Models.",
    },
    image: {
      ready: replicate.length > 0,
      accounts: replicate.length,
      model,
      isDefault: model === DEFAULT_MODEL,
      note: replicate.length
        ? `Images come from ${model} on Replicate, called with \`Prefer: wait\` and then followed for ` +
          `up to ${POLL_FOR_MS / 60_000} minutes if it queues. ` +
          "Replicate publishes no price in its API, so nothing here can tell you what a " +
          "post cost — see the Costs page for what it does report."
        : "Replicate is not connected, so a post will be stored with its caption and no image.",
    },
    formats: Object.entries(FORMATS).map(([key, f]) => ({ key, ratio: f.ratio, about: f.about })),
    /* Empty on a healthy box. A shape the renderer supports and the Studio has
       no name for is drift between two lists that describe one thing, and it
       is printed rather than defaulted away. */
    aspectsWithNoFormat: unnamedAspects(),
    note:
      "A post needs the caption half. Without a model provider nothing is created; " +
      "without Replicate a post is created with words and an error where the picture goes.",
  };
}

studioRoutes.get("/", (c) => c.json(readiness()));

/* ------------------------------------------------------------------ posts */

studioRoutes.get("/posts", (c) => {
  const key = c.req.query("venture");
  let rows: PostRow[];
  let venture: VentureRow | undefined;
  if (key) {
    venture = ventureRow(key);
    if (!venture) return c.json({ error: "No venture by that id or slug." }, 404);
    rows = db
      .prepare("SELECT * FROM studio_posts WHERE venture_id = ? ORDER BY ts DESC LIMIT 200")
      .all(venture.id) as unknown as PostRow[];
  } else {
    rows = db
      .prepare("SELECT * FROM studio_posts ORDER BY ts DESC LIMIT 200")
      .all() as unknown as PostRow[];
  }
  return c.json({
    venture: venture ? { id: venture.id, slug: venture.slug, name: venture.name } : null,
    posts: rows.map(shape),
    readiness: readiness(),
  });
});

/* ------------------------------------------------------------ making one */

export type CreatePostInput = {
  /** A venture's id or slug. */
  ventureId: string;
  brief: string;
  /** Defaults to `square`. */
  format?: string;
  platform?: string | null;
  /** Asset-library ids, at most four. */
  assetIds?: string[];
};

export type CreatePostResult =
  | {
      ok: true;
      post: ReturnType<typeof shape>;
      venture: { id: string; slug: string; name: string };
      imageMs: number;
      /** What did not work. Empty when both halves did. */
      problems: string[];
    }
  | { ok: false; error: string; status: 400 | 404 };

/**
 * ONE STUDIO POST — the whole of what a post IS, in one callable place.
 *
 * CALLED DIRECTLY RATHER THAN THROUGH A REQUEST BUILT AGAINST THE ROUTE, so
 * every caller shares one definition of what a post is, one format list and
 * one way of unwrapping a failure, instead of each growing its own copy that
 * a change to the reply shape would have to catch up with individually.
 *
 * IT NEVER THROWS. Every refusal is a `{ ok: false, error, status }` — the
 * status is there so the route can pass it straight through, and the sentence
 * is there so a run's report can print it. A caller that wants the HTTP
 * surface still has one; a caller that just wants a post no longer has to
 * build a Request to get it.
 */
export async function createPost(input: CreatePostInput): Promise<CreatePostResult> {
  const key = input.ventureId.trim();
  const v = key ? ventureRow(key) : undefined;
  if (!v)
    return {
      ok: false,
      status: 400,
      error: "Expected { ventureId, brief, format } — ventureId is a venture's id or slug.",
    };

  const brief = input.brief.trim();
  if (!brief)
    return { ok: false, status: 400, error: "A brief is required — one line saying what the post is about." };
  if (brief.length > MAX_BRIEF)
    return { ok: false, status: 400, error: `A brief is at most ${MAX_BRIEF} characters.` };

  const format = (input.format ?? "square") as Format;
  if (!(format in FORMATS))
    return { ok: false, status: 400, error: `A format is one of ${Object.keys(FORMATS).join(", ")}.` };

  const platform = (input.platform ?? "").trim().slice(0, MAX_PLATFORM) || null;
  const assetIds = (input.assetIds ?? []).slice(0, 4);

  const started = Date.now();
  const id = newId();

  /* THE REFERENCES ARE RESOLVED BEFORE THE PROMPT IS BUILT, because whether
     the model can be handed a picture decides whether the picture has to be
     DESCRIBED in the prompt instead. See setReferenceResolver above. */
  const refs = assetIds.length ? await resolveReferences(v.id, assetIds, imageModel()) : null;
  const prompt =
    imagePrompt(v, brief, format) +
    (refs && refs.texts.length ? ` Take visual direction from ${refs.texts.join("; ")}.` : "");

  /* --- the caption, which is the half without which there is no post --- */
  let caption: string | null = null;
  let hashtags: string[] = [];
  let captionModel: string | null = null;
  const problems: string[] = [];
  try {
    const reply = await complete(captionTurns(v, brief, platform, format));
    const split = splitCaption(reply.text);
    caption = split.caption || null;
    hashtags = split.hashtags;
    captionModel = reply.model;
    if (!caption) problems.push("The model answered with no caption text.");
  } catch (err) {
    if (err instanceof NoProviderError)
      return {
        ok: false,
        status: 400,
        error:
          "No model provider is live, so there is no caption and no post. Choose one " +
          "under Integrations → Models — the image half alone is a picture, not a post.",
      };
    problems.push(`The caption failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  /* --- the image, which may legitimately not happen ------------------- */
  const image = await makeImage(prompt, format, id, refs ?? undefined);
  if (!image.ok && image.error) problems.push(image.error);
  /* A reference that could not be passed is recorded on the post rather than
     forgotten: a picture the owner selected and the model never saw is the one
     outcome that must not look like success. */
  if (refs && !refs.field && assetIds.length) problems.push(refs.note);

  db.prepare(
    `INSERT INTO studio_posts
       (id, venture_id, ts, brief, platform, format, caption, hashtags,
        image_prompt, image_path, model, ms, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, v.id, now(), brief, platform, format,
    caption, hashtags.join(" ") || null,
    prompt, image.path,
    [captionModel, image.ok ? image.model : null].filter(Boolean).join(" + ") || null,
    Date.now() - started,
    problems.length ? problems.join(" ") : null,
  );

  return {
    ok: true,
    post: shape(postRow(id)!),
    venture: { id: v.id, slug: v.slug, name: v.name },
    imageMs: image.ms,
    problems,
  };
}

studioRoutes.post("/posts", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    ventureId?: unknown;
    brief?: unknown;
    format?: unknown;
    platform?: unknown;
    assetIds?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);
  if (body.platform !== undefined && body.platform !== null && typeof body.platform !== "string")
    return c.json({ error: "A platform is text — instagram, linkedin, x." }, 400);

  const made = await createPost({
    ventureId: typeof body.ventureId === "string" ? body.ventureId : "",
    brief: typeof body.brief === "string" ? body.brief : "",
    format: body.format === undefined ? undefined : String(body.format),
    platform: typeof body.platform === "string" ? body.platform : null,
    assetIds: Array.isArray(body.assetIds)
      ? body.assetIds.filter((a): a is string => typeof a === "string")
      : [],
  });
  if (!made.ok) return c.json({ error: made.error }, made.status);

  return c.json(
    {
      post: made.post,
      venture: made.venture,
      imageMs: made.imageMs,
      note: made.problems.length
        ? "The post was stored with what worked. `error` says what did not."
        : "Both halves worked.",
    },
    201,
  );
});

studioRoutes.get("/posts/:id/image", (c) => {
  const row = postRow(c.req.param("id"));
  if (!row) return c.json({ error: "No post by that id." }, 404);
  if (!row.image_path)
    return c.json(
      {
        error: row.error
          ? `That post has no image — ${row.error}`
          : "That post has no image.",
      },
      404,
    );
  if (!existsSync(row.image_path))
    return c.json({ error: "The image file is no longer on disk." }, 404);

  const bytes = readFileSync(row.image_path);
  return c.body(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    200,
    {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=3600",
    },
  );
});

/**
 * Make one half again.
 *
 * A NEW CAPTION REPLACES THE OLD ONE AND SO DOES A NEW IMAGE, because a post
 * is a draft and a draft with a history of rejected captions is a table nobody
 * asked for. The brief is what is kept; regenerate is "try again with the same
 * instruction", and a different instruction is a different post.
 */
studioRoutes.post("/posts/:id/regenerate", async (c) => {
  const row = postRow(c.req.param("id"));
  if (!row) return c.json({ error: "No post by that id." }, 404);
  const v = ventureRowById(row.venture_id);
  if (!v)
    return c.json(
      { error: "That post's venture no longer exists, so there is nothing to regenerate from." },
      404,
    );

  const body = (await c.req.json().catch(() => null)) as { what?: unknown; assetIds?: unknown } | null;
  const what = String(body?.what ?? "");
  if (what !== "caption" && what !== "image")
    return c.json({ error: 'Expected { what: "caption" } or { what: "image" }.' }, 400);

  const started = Date.now();
  const format = (row.format in FORMATS ? row.format : "square") as Format;

  if (what === "caption") {
    try {
      const reply = await complete(captionTurns(v, row.brief, row.platform, format));
      const split = splitCaption(reply.text);
      db.prepare(
        "UPDATE studio_posts SET caption = ?, hashtags = ?, ms = ?, error = ? WHERE id = ?",
      ).run(
        split.caption || null,
        split.hashtags.join(" ") || null,
        Date.now() - started,
        /* The old error was about the old attempt. Whatever was wrong with the
           image is still wrong, so only the caption's half of it is cleared. */
        row.error && row.image_path === null ? row.error : null,
        row.id,
      );
      return c.json({ post: shape(postRow(row.id)!), ms: Date.now() - started });
    } catch (err) {
      const error =
        err instanceof NoProviderError
          ? err.message
          : `The caption failed — ${err instanceof Error ? err.message : String(err)}`;
      db.prepare("UPDATE studio_posts SET error = ? WHERE id = ?").run(error, row.id);
      return c.json({ post: shape(postRow(row.id)!), error }, 200);
    }
  }

  const assetIds = Array.isArray(body?.assetIds)
    ? body.assetIds.filter((a): a is string => typeof a === "string").slice(0, 4)
    : [];
  const refs = assetIds.length ? await resolveReferences(v.id, assetIds, imageModel()) : null;
  const prompt =
    imagePrompt(v, row.brief, format) +
    (refs && refs.texts.length ? ` Take visual direction from ${refs.texts.join("; ")}.` : "");
  const image = await makeImage(prompt, format, row.id, refs ?? undefined);
  db.prepare(
    "UPDATE studio_posts SET image_prompt = ?, image_path = ?, model = ?, ms = ?, error = ? WHERE id = ?",
  ).run(
    prompt,
    image.ok ? image.path : row.image_path,
    image.ok ? image.model : row.model,
    image.ms,
    image.error,
    row.id,
  );
  return c.json({ post: shape(postRow(row.id)!), ms: image.ms, error: image.error });
});

/**
 * Gone, and the file with it.
 *
 * THE PICTURE IS DELETED HERE AND NOT LEFT BEHIND, which is the opposite of
 * what the schema's cascade can do: SQLite can drop a row and cannot unlink a
 * file, so a venture deleted from the Ventures page leaves its posts' images
 * on disk while this route does not. That asymmetry is real and is named in
 * 063's comment rather than pretended away.
 */
studioRoutes.delete("/posts/:id", (c) => {
  const row = postRow(c.req.param("id"));
  if (!row) return c.json({ error: "No post by that id." }, 404);
  if (row.image_path && existsSync(row.image_path)) {
    try {
      unlinkSync(row.image_path);
    } catch {
      /* a file that will not delete is not a reason to keep the row */
    }
  }
  db.prepare("DELETE FROM studio_posts WHERE id = ?").run(row.id);
  return c.json({ ok: true, deleted: row.id });
});
