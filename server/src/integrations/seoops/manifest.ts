/**
 * SEO OPS — the off-page half of looking after a small site, as an area.
 *
 * FOUR FEATURES THAT SHARE NOTHING BUT A JOB. A URL's Search Console history
 * after a change was made; a directory checklist the owner works through; a
 * model's opinion of a screenshot; a browser's reading of what a page is
 * actually painted with. None of them sums with any other and the routes say
 * so. They are one area because they are one afternoon's work — the things a
 * one-person company does about a website that are not writing the website.
 *
 * ONE CONFIG-ONLY PSEUDO-PLUGIN AND NO CREDENTIAL. Everything here reads
 * something another plugin already collects (Search Console through `gsc`, the
 * off-site probes through `presence`) or something on this machine (the
 * browser, the active model provider). Declaring config on `gsc` or `presence`
 * would have been the obvious thing and would have been a bug: manifest config
 * entries are merged BY PLUGIN ID across areas, so an area that puts settings
 * on somebody else's plugin silently clobbers theirs.
 *
 * NO COLLECTOR, EITHER, AND THAT IS THE SAME LESSON ONE DOOR ALONG.
 * `manifestCollectors()` merges by plugin id over the built-ins, so a
 * collector registered under `gsc` would REPLACE the one that reads the
 * traffic. The scheduled work here is a PIPELINE STAGE where that registry
 * exists and a timer where it does not — see `onStart`.
 *
 * EVERYTHING THAT COSTS MONEY IS OFF BY DEFAULT. The follow-up sweep spends a
 * Search Console call per new URL and at most one model call per due reading;
 * vision spends a model call per changed screenshot; the rendered brand pass
 * spends a browser and a page load. The first is on because it is cheap and is
 * the point of the area; the other two are opt-in per venture with an empty
 * list as the default, which means nothing at all happens until the owner
 * names a venture.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";
import { seoopsRoutes } from "./routes.ts";
import { skills } from "./skills.ts";
import { DEFAULT_OFFSETS, DEFAULT_TAG, SEOOPS_PLUGIN, parseOffsets, settings, venturesFor } from "./settings.ts";
import { runDue, sweep } from "./followup.ts";
import { detect } from "./listings.ts";
import { lookAt } from "./vision.ts";
import { measureVenture } from "./brand.ts";
import { LISTING_STATES } from "./listings.ts";

/* ---------------------------------------------------------------- settings */

const config = {
  [SEOOPS_PLUGIN]: {
    keys: {
      tag: {
        label: "SEO card tag",
        hint:
          `The word that marks a finished board card as SEO work. Default ${DEFAULT_TAG}. ` +
          `A card counts only when its title or body carries this tag AND names at ` +
          `least one http(s) URL — both, because the tag says you meant it and the ` +
          `URL says which page to measure. Matched as a whole token, so ${DEFAULT_TAG} ` +
          `does not fire on "#seowriting".`,
        ph: DEFAULT_TAG,
        check(value: string) {
          const v = value.trim();
          if (!v) return null;
          if (/\s/.test(v)) return "One tag, with no spaces in it.";
          if (v.length > 40) return "That is too long to be a tag.";
          return null;
        },
      },
      offsets: {
        label: "Follow-up offsets (days)",
        hint:
          `When to re-read a page after the work was marked done, in days after that ` +
          `date. Default ${DEFAULT_OFFSETS.join(", ")}. Not 7/14/30 like the generic ` +
          `outcomes: Search Console's window is 28 days and its reporting lag is three, ` +
          `so a reading at day seven compares a window with 21 days of BEFORE in it ` +
          `against one with 28 and mostly measures the overlap. Each baseline stores ` +
          `the offsets it was given, so changing this affects new ones and leaves old ` +
          `ones honest about the schedule they were on.`,
        ph: DEFAULT_OFFSETS.join(", "),
        check(value: string) {
          const raw = value.split(/[\s,]+/).filter(Boolean);
          if (!raw.length) return null;
          const parsed = parseOffsets(value);
          if (parsed.length !== new Set(raw).size)
            return "Whole numbers of days between 1 and 365, separated by commas.";
          return null;
        },
      },
      vision_ventures: {
        label: "Vision ventures",
        hint:
          "Which ventures may have their screenshot shown to a model, by slug, " +
          "separated by commas. `all` means every one. EMPTY IS THE DEFAULT AND " +
          "MEANS NOBODY: a vision call is a bill, and a dashboard that starts " +
          "spending because it could is one somebody switches off entirely. A " +
          "verdict is reused whenever the picture's bytes have not changed, so a " +
          "site nobody touched costs nothing after the first look.",
        ph: "all, or two slugs like acme-app, second-product",
        check: ventureListCheck,
      },
      rendered_ventures: {
        label: "Rendered-brand ventures",
        hint:
          "Which ventures get their brand measured in a real browser — computed " +
          "styles, colours ranked by painted area, the fonts the headings actually " +
          "resolved to — by slug, separated by commas. `all` means every one. Empty " +
          "is the default: it costs a headless Chromium and a page load per venture, " +
          "and the static reading in `ventures/enrich.ts` remains the fallback and is " +
          "never overwritten by this.",
        ph: "all, or a slug like acme-app",
        check: ventureListCheck,
      },
      directories: {
        label: "Directories",
        hint:
          "JSON that is MERGED over the shipped directory catalogue: " +
          '`{"directories":[{"id":"myindex","name":"My Index","url":"https://…",' +
          '"tier":"saas","detect":null,"note":"…"}]}`. An entry whose id already ' +
          "exists replaces it; `\"drop\": true` removes one; anything else is added. " +
          "Merging rather than replacing means you can add one directory without " +
          "pasting the other twenty-two back in. Leave it empty to use the shipped " +
          "list as it is.",
        ph: '{"directories":[]}',
        check(value: string) {
          const raw = value.trim();
          if (!raw) return null;
          try {
            const parsed: unknown = JSON.parse(raw);
            const entries = Array.isArray(parsed)
              ? parsed
              : ((parsed as { directories?: unknown[] })?.directories ?? null);
            if (!Array.isArray(entries))
              return 'Expected {"directories":[…]} or a bare array of directory objects.';
            for (const e of entries) {
              const id = (e as { id?: unknown })?.id;
              if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(id))
                return "Every entry needs an `id` of letters, digits, dots, dashes or underscores.";
            }
            return null;
          } catch {
            return "That is not valid JSON.";
          }
        },
      },
    },
    /* CONNECTED IS ALWAYS TRUE, because this plugin holds no credential and
       needs none: the follow-up sweep works the moment there is a finished
       card, and the listing ledger works the moment there is a venture. The
       features that need something else — Search Console, a model, a browser —
       say so on their own documents rather than by making the plugin look
       disconnected. */
    after() {
      upsertPlugin(SEOOPS_PLUGIN, true, null);
    },
  },
};

function ventureListCheck(value: string): string | null {
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 60) return "That is more than sixty entries. Use `all` if you mean all of them.";
  for (const p of parts)
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(p))
      return `“${p.slice(0, 30)}” is not a venture slug. Use the slug from the venture's address, or \`all\`.`;
  return null;
}

/* ------------------------------------------------------------- the schedule */

/**
 * ONE NIGHTLY PASS, REGISTERED WITH THE PIPELINE WHERE THERE IS ONE.
 *
 * The order inside it is the dependency order and it is not arbitrary: the
 * sweep finds new work before the follow-ups are read (so a card finished
 * today has a baseline before anything asks whether it moved), and the
 * listings detection runs after both because it reads the presence collector's
 * rows and cares about neither.
 *
 * A DRY RUN DOES NOTHING AND SAYS WHAT IT WOULD HAVE DONE. The pipeline's own
 * contract: a dry run that spends money is worse than no dry run, because the
 * owner will use it to find out what tonight costs. So a dry night reports the
 * COUNTS — how many cards are candidates, how many readings are due, how many
 * ventures are opted in to the two paid passes — and reaches nothing.
 *
 * GUARDED IMPORT, for the reason at the top of `integrations/index.ts`: a
 * manifest that statically imported the pipeline registry would be importing a
 * module that reaches the config registry at load time, and the server would
 * not boot. If the registry is not there, a plain timer runs the same work.
 */
const EVERY_HOURS = 6;
let timer: ReturnType<typeof setInterval> | null = null;

async function nightly(dry: boolean): Promise<{ note: string; counts: Record<string, number> }> {
  const s = settings();
  if (dry) {
    const { dueFollowUps, doneCards, tagged, urlsIn } = await import("./followup.ts");
    const candidates = doneCards(200).filter((card) => tagged(`${card.title}\n${card.body ?? ""}`, s.tag));
    const urls = candidates.reduce((n, card) => n + urlsIn(`${card.title}\n${card.body ?? ""}`).length, 0);
    const counts = {
      taggedCards: candidates.length,
      urlsOnThem: urls,
      readingsDue: dueFollowUps().length,
      visionVentures: venturesFor(s.visionVentures).length,
      renderedVentures: venturesFor(s.renderedVentures).length,
    };
    return {
      note:
        `Would sweep ${counts.taggedCards} tagged card(s) carrying ${counts.urlsOnThem} URL(s), take ` +
        `${counts.readingsDue} due reading(s), look at ${counts.visionVentures} venture(s) with the model and ` +
        `re-measure ${counts.renderedVentures} brand(s) in the browser. Nothing was asked and nothing was spent.`,
      counts,
    };
  }

  const swept = await sweep();
  const ran = await runDue(true);
  const detected = detect();

  let looked = 0;
  let reused = 0;
  for (const v of venturesFor(s.visionVentures)) {
    const r = await lookAt(v);
    looked += 1;
    if (r.reused) reused += 1;
  }

  let measured = 0;
  for (const v of venturesFor(s.renderedVentures)) {
    await measureVenture(v);
    measured += 1;
  }

  const counts = {
    baselinesCreated: swept.created.length,
    readingsTaken: ran.length,
    unmeasuredReadings: ran.filter((r) => !r.reading.measured).length,
    listingsMoved: detected.moved.length,
    visionLooked: looked,
    visionReused: reused,
    brandsMeasured: measured,
  };
  return {
    note:
      `${counts.baselinesCreated} new baseline(s), ${counts.readingsTaken} follow-up reading(s) ` +
      `(${counts.unmeasuredReadings} unmeasured — not zero), ${counts.listingsMoved} listing row(s) ratcheted ` +
      `forward, ${counts.visionLooked} visual verdict(s) (${counts.visionReused} reused), ` +
      `${counts.brandsMeasured} brand(s) re-measured in the browser.`,
    counts,
  };
}

function start() {
  upsertPlugin(SEOOPS_PLUGIN, true, null);

  void (async () => {
    try {
      const registry = await import("../pipeline/registry.ts");
      registry.registerStage({
        id: "seo-ops",
        area: "seoops",
        title: "SEO follow-ups, listings, visual QA and rendered brands",
        about:
          "Capture a Search Console baseline for every finished SEO card that has " +
          "none, take the follow-up readings that are due and diagnose them, ratchet " +
          "the directory ledger forward from the presence probes, and — only for the " +
          "ventures opted in — ask the model about each screenshot and re-measure " +
          "each brand in a headless browser. The first two halves cost one Search " +
          "Console call per URL and at most one model call per due reading; the last " +
          "two cost nothing at all unless a venture is named in the settings.",
        deps: ["collect"],
        defaultEnabled: true,
        defaultCadence: "daily",
        defaultWindow: null,
        budget: { maxMinutes: 10 },
        async run(ctx) {
          try {
            const out = await nightly(ctx.dry);
            return { outcome: "completed", note: out.note, counts: out.counts };
          } catch (err) {
            return {
              outcome: "failed",
              error: err instanceof Error ? err.message.slice(0, 300) : "the SEO ops pass threw",
            };
          }
        },
      });
      console.log("[seoops] registered the nightly stage with the pipeline");
    } catch {
      /* NO PIPELINE ON THIS BOX — a timer, then. Six-hourly rather than
         nightly because a timer has no memory of whether it ran, and the work
         is idempotent: the sweep skips tracked cards, a reading fills a slot
         only once, and detection may only ratchet. Four no-ops a day is
         cheaper than a missed night. */
      if (timer) return;
      timer = setInterval(() => {
        void nightly(false).catch((err) => console.error("[seoops] pass failed", err));
      }, EVERY_HOURS * 3_600_000);
      timer.unref?.();
      console.log("[seoops] no pipeline registry — running the pass on a six-hourly timer");
    }
  })();
}

/* ---------------------------------------------------------------- manifest */

export const manifest: IntegrationManifest = {
  id: "seoops",
  config,
  routes: [{ path: "/api/seoops", app: seoopsRoutes }],
  skills,
  packs: {
    "seo-followup": { name: "seo-followup", category: "marketing" },
    listings: { name: "directory-listings", category: "marketing" },
    visualqa: { name: "visual-qa", category: "development" },
  },
  onStart: start,
};

/* Exported for the tests and for the presence page, which renders the same
   vocabulary this area writes. */
export { LISTING_STATES };
