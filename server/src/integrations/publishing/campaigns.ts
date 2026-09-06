/**
 * A CAMPAIGN: one argument, made in several rooms.
 *
 * WHAT A CAMPAIGN IS AND WHY IT IS NOT A LOOP OVER THE STUDIO. Pressing "make
 * a post" nine times gives nine posts about nine things. A campaign gives one
 * GOAL, split by the model into a small number of CONCEPTS that must not
 * overlap, and then each concept written once per channel — so nine posts that
 * are three arguments in three registers. The structure is the product; the
 * fan-out is the easy half.
 *
 * IT IS A RUN KIND, AND THAT IS THE ARCHITECTURE RATHER THAN A PREFERENCE. A
 * campaign of nine variants is nine model calls and nine Replicate renders:
 * minutes of work that must survive the tab being closed, be visible while it
 * happens, be cancellable, and be queued behind whatever else the box is
 * doing. That is exactly what `integrations/runs/` already is. A route that
 * blocked for ten minutes would be the wrong shape twice over.
 *
 * THE PLAN IS SAVED BEFORE ANYTHING IS RENDERED. A fan-out that dies half way
 * leaves a campaign somebody can read and re-run, rather than a lost model
 * call — and the counters mean a partly-produced campaign says so instead of
 * showing nine or none.
 *
 * NOTHING HERE PUBLISHES. Each variant becomes a Studio post and, where the
 * venture has a destination for that channel, a publish item in `draft`. The
 * owner still approves every one of them. A campaign that queued nine approved
 * posts would be the automation this whole area refuses to be.
 *
 * ORDER IS CONCEPT-MAJOR, so a run cut short by a cancel leaves WHOLE concepts
 * finished rather than one post on each — a campaign of two complete arguments
 * is usable and a campaign of six first drafts is not.
 */
import { randomUUID } from "node:crypto";
import { db, now, type VentureRow } from "../../db.ts";
import { studioRoutes } from "../ventures/studio.ts";
import { createItem } from "./items.ts";
import { destinationRows } from "./destinations.ts";
import { LIMITS, type DestinationKind } from "./limits.ts";

export type CampaignRow = {
  id: string;
  venture_id: string;
  run_id: string | null;
  goal: string;
  brief: string;
  audience: string | null;
  channels: string;
  starts_on: string | null;
  ends_on: string | null;
  status: string;
  planned: number;
  produced: number;
  failed: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ConceptRow = {
  id: string;
  campaign_id: string;
  idx: number;
  theme: string;
  description: string | null;
  image_note: string | null;
  created_at: string;
};

export type VariantRow = {
  id: string;
  campaign_id: string;
  concept_id: string;
  channel: string;
  post_id: string | null;
  item_id: string | null;
  error: string | null;
  created_at: string;
};

export function campaignRow(id: string): CampaignRow | undefined {
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
}

export function campaignRows(ventureId?: string | null): CampaignRow[] {
  return (
    ventureId
      ? db.prepare("SELECT * FROM campaigns WHERE venture_id = ? ORDER BY created_at DESC LIMIT 100").all(ventureId)
      : db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 100").all()
  ) as unknown as CampaignRow[];
}

export function conceptRows(campaignId: string): ConceptRow[] {
  return db
    .prepare("SELECT * FROM campaign_concepts WHERE campaign_id = ? ORDER BY idx")
    .all(campaignId) as unknown as ConceptRow[];
}

export function variantRows(campaignId: string): VariantRow[] {
  return db
    .prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? ORDER BY created_at")
    .all(campaignId) as unknown as VariantRow[];
}

/**
 * A campaign whose RUN is over while the campaign still says it is working.
 *
 * This happens for a real and ordinary reason: the server restarts on every
 * file save, and a run in flight is marked `interrupted` by the executor's own
 * reconciliation. The campaign row is durable and knows nothing about that, so
 * without this it would say "producing" for ever.
 *
 * The STORED status is not rewritten. What is added is a reading — `stalled`,
 * with the run's real status beside it — because "the plan exists and the
 * fan-out stopped" is a state somebody can act on (start another run) and
 * silently flipping the row to `failed` would lose the concepts' meaning.
 */
function runState(r: CampaignRow): { runStatus: string | null; stalled: boolean } {
  if (!r.run_id) return { runStatus: null, stalled: false };
  const row = db.prepare("SELECT status FROM agent_runs WHERE id = ?").get(r.run_id) as
    | { status: string }
    | undefined;
  const runStatus = row?.status ?? null;
  const working = r.status === "planning" || r.status === "producing";
  const live = runStatus === "queued" || runStatus === "running";
  return { runStatus, stalled: working && !live };
}

export function shapeCampaign(r: CampaignRow) {
  const concepts = conceptRows(r.id);
  const variants = variantRows(r.id);
  const run = runState(r);
  let channels: string[] = [];
  let brief: string[] = [];
  try {
    channels = JSON.parse(r.channels) as string[];
  } catch { /* an unreadable list is an empty one, not a crash */ }
  try {
    brief = JSON.parse(r.brief) as string[];
  } catch { /* same */ }
  return {
    id: r.id,
    ventureId: r.venture_id,
    runId: r.run_id,
    goal: r.goal,
    audience: r.audience,
    channels,
    brief,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    status: r.status,
    runStatus: run.runStatus,
    /** The run that was producing this is over and the campaign is not. See
     *  `runState` — the commonest cause is this server restarting on a save. */
    stalled: run.stalled,
    progress: {
      /** How many variants the plan calls for. Zero until the concepts exist —
       *  a campaign still planning has no denominator and says so. */
      planned: r.planned,
      produced: r.produced,
      failed: r.failed,
      remaining: Math.max(0, r.planned - r.produced - r.failed),
    },
    concepts: concepts.map((c) => ({
      id: c.id,
      idx: c.idx,
      theme: c.theme,
      description: c.description,
      imageNote: c.image_note,
      variants: variants
        .filter((v) => v.concept_id === c.id)
        .map((v) => ({ id: v.id, channel: v.channel, postId: v.post_id, itemId: v.item_id, error: v.error })),
    })),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ----------------------------------------------------------- the channels */

/**
 * The channels a campaign may name.
 *
 * A DESTINATION KIND IS A CHANNEL AND SO IS A BARE PLATFORM NAME. A venture
 * with a Facebook Page destination has `page` as a channel and the variants
 * for it can become publish items; a venture that wants a campaign written for
 * X, which this box cannot publish to, names `x` and gets Studio drafts with
 * no publish item. Refusing to WRITE for a platform this cannot publish to
 * would be withholding the wrong half of the feature.
 */
export function channelLabel(channel: string): string {
  return LIMITS[channel as DestinationKind]?.label ?? channel;
}

/** The destination a variant on this channel would go to, when the venture has
 *  exactly one. Two is ambiguous and produces a draft with no destination
 *  rather than a guess. */
export function destinationForChannel(ventureId: string, channel: string): string | null {
  const matches = destinationRows(ventureId).filter(
    (d) => d.enabled === 1 && d.kind === channel,
  );
  return matches.length === 1 ? matches[0]!.id : null;
}

/* ------------------------------------------------------------ the planner */

const PLANNER_SYSTEM = `You plan a small social campaign for a one-person software business.

A campaign is ONE argument made in several rooms. Each CONCEPT is a different
argument; the posts inside a concept are the same argument in different
registers. Concepts must not overlap.

Rules:
- Use ONLY the facts you are given. Anything not in them, you do not know.
- Never invent a feature, a price, a customer, a statistic or a launch date.
- A theme is 2 to 5 words naming the argument, not a slogan.
- No marketing language, no exclamation marks, no hype.
- The image note says what is IN the picture, in one sentence.

Answer with JSON only, no prose around it:
{"concepts":[{"theme":"<2-5 words>","description":"<one or two sentences: the argument, and who it is for>","imageNote":"<the picture: subject, then setting>"}]}`;

/** Concepts, validated one at a time. One missing a theme is DROPPED rather
 *  than half-built, and a duplicate theme is dropped too — two concepts with
 *  one argument is the failure the whole structure exists to avoid. */
export function shapeConcepts(raw: unknown, want: number): { theme: string; description: string; imageNote: string }[] {
  const doc = raw as { concepts?: unknown[] } | null;
  const seen = new Set<string>();
  const out: { theme: string; description: string; imageNote: string }[] = [];
  for (const item of doc?.concepts ?? []) {
    if (out.length >= want) break;
    const c = item as { theme?: unknown; description?: unknown; imageNote?: unknown };
    const theme = String(c?.theme ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!theme) continue;
    const key = theme.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      theme,
      description: String(c?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      imageNote: String(c?.imageNote ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    });
  }
  return out;
}

/** The first JSON object in a model's answer. Models fence it, preface it and
 *  apologise for it; the object is what was asked for. */
export function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- the brief */

/**
 * Everything this box knows about the venture, as lines.
 *
 * Each line is labelled with WHOSE fact it is — the owner's words, or a
 * measurement — for the reason the Studio's own brief is: a model told "your
 * brand colour is #44AA44" writes about the brand colour, and what is true is
 * that the site's strongest colour reads as that. Every part is optional and
 * silent when missing: a collector that has not run costs the brief a line,
 * never the campaign.
 */
export function campaignBrief(v: VentureRow): string[] {
  const out: string[] = [
    `Name (the owner's): ${v.name}`,
    `What it is (the owner's own words): ${v.description || "he has not written one"}`,
    `Stage (the owner's declaration): ${v.stage}`,
  ];
  if (v.website) out.push(`Website: ${v.website}`);

  const posts = db
    .prepare("SELECT brief FROM studio_posts WHERE venture_id = ? ORDER BY ts DESC LIMIT 6")
    .all(v.id) as unknown as { brief: string }[];
  if (posts.length)
    out.push(
      `Recently posted about (do not repeat these angles): ${posts.map((p) => p.brief).join("; ").slice(0, 500)}`,
    );

  const runs = db
    .prepare(
      "SELECT title FROM agent_runs WHERE venture_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 5",
    )
    .all(v.id) as unknown as { title: string }[];
  if (runs.length) out.push(`Work this box has done on it: ${runs.map((r) => r.title).join("; ").slice(0, 400)}`);

  return out;
}

/* ------------------------------------------------------------- the create */

export function createCampaign(input: {
  ventureId: string;
  goal: string;
  audience?: string | null;
  channels: string[];
  startsOn?: string | null;
  endsOn?: string | null;
  runId?: string | null;
  brief?: string[];
}): CampaignRow {
  const id = `cmp-${randomUUID().slice(0, 8)}`;
  const ts = now();
  db.prepare(
    `INSERT INTO campaigns
       (id, venture_id, run_id, goal, brief, audience, channels, starts_on, ends_on,
        status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'planning',?,?)`,
  ).run(
    id,
    input.ventureId,
    input.runId ?? null,
    input.goal.slice(0, 2_000),
    JSON.stringify(input.brief ?? []),
    (input.audience ?? "").slice(0, 300) || null,
    JSON.stringify(input.channels),
    input.startsOn ?? null,
    input.endsOn ?? null,
    ts,
    ts,
  );
  return campaignRow(id)!;
}

function patch(id: string, sets: Record<string, string | number | null>) {
  const keys = Object.keys(sets);
  if (!keys.length) return;
  db.prepare(
    `UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...keys.map((k) => sets[k]!), now(), id);
}

/* ---------------------------------------------------------------- the run */

/** What the executor lends a campaign run. The same interface shape
 *  `integrations/growth/runs.ts` uses, and for the reason its header gives:
 *  an import back into the executor would be a cycle. */
export type CampaignTools = {
  say(text: string): void;
  startStep(tool: string, label: string | null): { toolCallId: string };
  endStep(step: { toolCallId: string }, label?: string | null): void;
  turn(
    turns: { role: "system" | "user" | "assistant"; content: string }[],
    opts: { toOutput: boolean; forceProvider?: boolean },
  ): Promise<{ text: string }>;
};

const MAX_CONCEPTS = 5;
const MAX_CHANNELS = 4;

/**
 * Plan a campaign and fan it out.
 *
 * `signal` IS CHECKED BETWEEN VARIANTS AND NOT INSIDE ONE. A cancel that
 * abandoned a Studio call half way would leave a post row with a caption and
 * no picture and no error, which is the one state the Studio's own contract
 * does not have. Between variants, the campaign is left exactly where it got
 * to, its counters true, and its status `cancelled`.
 */
export async function campaignRun(args: {
  runId: string;
  venture: VentureRow;
  input: Record<string, string>;
  tools: CampaignTools;
  signal?: AbortSignal;
}): Promise<void> {
  const { runId, venture, input, tools, signal } = args;
  const goal = (input.goal ?? "").trim();
  if (!goal) throw new Error("A campaign needs a goal — one line saying what it is for.");

  const channels = (input.channels ?? "")
    .split(/[,\s]+/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_CHANNELS);
  if (!channels.length)
    throw new Error(
      "A campaign needs at least one channel. Use a destination kind — page, ig, linkedin, tiktok — " +
        "or a bare platform name for somewhere this box cannot publish to.",
    );

  const wanted = Math.max(1, Math.min(MAX_CONCEPTS, Number(input.concepts) || 3));
  const brief = campaignBrief(venture);
  const campaign = createCampaign({
    ventureId: venture.id,
    goal,
    audience: input.audience ?? null,
    channels,
    startsOn: input.startsOn ?? null,
    endsOn: input.endsOn ?? null,
    runId,
    brief,
  });

  tools.say(
    `## The brief\n\n${brief.map((b) => `- ${b}`).join("\n")}\n\n` +
      `**Goal.** ${goal}\n\n` +
      `**Channels.** ${channels.map(channelLabel).join(", ")}\n\n` +
      (input.audience ? `**Audience.** ${input.audience}\n\n` : "") +
      `Planning ${wanted} concept${wanted === 1 ? "" : "s"}.\n\n`,
  );

  /* ---------------------------------------------------------- the plan --- */
  const planStep = tools.startStep("campaign-plan", `${wanted} concepts`);
  const ask = [
    `BUSINESS: ${venture.name}`,
    `THE GOAL, in the owner's words: "${goal}"`,
    input.audience ? `AUDIENCE, in the owner's words: "${input.audience}"` : null,
    `CHANNELS: ${channels.map(channelLabel).join(", ")}`,
    "",
    brief.length
      ? `THE FACTS — everything this dashboard knows. These are the only facts you may use:\n${brief.map((l) => `- ${l}`).join("\n")}`
      : "THERE ARE NO FACTS on file for this business. Say only what the goal itself supports.",
    "",
    `Return exactly ${wanted} concepts.`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  let concepts: { theme: string; description: string; imageNote: string }[] = [];
  try {
    const reply = await tools.turn(
      [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: ask },
      ],
      /* FORCED ONTO THE RAW PROVIDER. This turn wants JSON and nothing else;
         an agent with tools answers a JSON request with a paragraph about what
         it is about to do roughly half the time. */
      { toOutput: false, forceProvider: true },
    );
    concepts = shapeConcepts(parseJson(reply.text), wanted);
  } catch (err) {
    patch(campaign.id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  tools.endStep(planStep, `${concepts.length} concept(s)`);

  if (!concepts.length) {
    patch(campaign.id, { status: "failed", error: "The planner returned no usable concept." });
    tools.say("\nThe planner returned no usable concept, so nothing was produced.\n");
    throw new Error("The planner returned no usable concept — nothing was rendered.");
  }

  const ts = now();
  concepts.forEach((c, i) => {
    db.prepare(
      "INSERT INTO campaign_concepts (id, campaign_id, idx, theme, description, image_note, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(`cc-${randomUUID().slice(0, 8)}`, campaign.id, i, c.theme, c.description, c.imageNote, ts);
  });
  const stored = conceptRows(campaign.id);
  const planned = stored.length * channels.length;
  patch(campaign.id, { status: "producing", planned });

  tools.say(
    `## Concepts\n\n` +
      stored.map((c) => `**${c.idx + 1}. ${c.theme}** — ${c.description ?? ""}`).join("\n\n") +
      `\n\nProducing ${planned} variant${planned === 1 ? "" : "s"}.\n\n`,
  );

  /* -------------------------------------------------------- the fan-out --- */
  let produced = 0;
  let failedCount = 0;
  const lines: string[] = [];

  outer: for (const concept of stored) {
    for (const channel of channels) {
      if (signal?.aborted) {
        patch(campaign.id, { status: "cancelled", produced, failed: failedCount });
        tools.say(`\nCancelled after ${produced} of ${planned}.\n`);
        break outer;
      }
      const step = tools.startStep("campaign-variant", `${concept.theme} · ${channelLabel(channel)}`);
      const made = await makeVariant(venture, campaign.id, concept, channel);
      if (made.error) {
        failedCount += 1;
        lines.push(`- ${concept.theme} · ${channelLabel(channel)} — **failed**: ${made.error}`);
      } else {
        produced += 1;
        lines.push(
          `- ${concept.theme} · ${channelLabel(channel)} — ${made.itemId ? `queued as \`${made.itemId}\` (draft)` : "a Studio draft, with no destination for that channel"}`,
        );
      }
      tools.endStep(step, made.error ? "failed" : "made");
      patch(campaign.id, { produced, failed: failedCount });
    }
  }

  if (!signal?.aborted)
    patch(campaign.id, { status: failedCount && !produced ? "failed" : "done", produced, failed: failedCount });

  tools.say(
    `## What was made\n\n${lines.join("\n")}\n\n` +
      `## What happens next\n\n` +
      `${produced} draft${produced === 1 ? " is" : "s are"} waiting in the publishing queue. ` +
      "NOTHING has been approved and nothing is scheduled — every one of them has to be " +
      "read and approved before it can go anywhere. Open Social media → Publishing.\n",
  );
}

/**
 * One variant: a Studio post, and a publish item where there is somewhere for
 * it to go.
 *
 * THE STUDIO'S OWN ROUTE HANDLER IS CALLED DIRECTLY, not over the network.
 * Hono apps are callable objects, so this runs the same handler the browser
 * reaches at `POST /api/studio/posts`, in this process. It is done this way
 * rather than by importing the generation functions because what a post IS
 * lives inside that handler — the caption turn, the image call, the row — and
 * a copy of it here would be a second definition of a post in a directory
 * another area owns. video/autopilot.ts makes the same call for the same
 * reason.
 */
async function makeVariant(
  venture: VentureRow,
  campaignId: string,
  concept: ConceptRow,
  channel: string,
): Promise<{ postId: string | null; itemId: string | null; error: string | null }> {
  const brief =
    `${concept.theme}. ${concept.description ?? ""}` +
    (concept.image_note ? ` The picture: ${concept.image_note}` : "");
  const format = channel === "tiktok" || channel === "ig" ? "story" : "square";

  let postId: string | null = null;
  let error: string | null = null;
  try {
    const res = await studioRoutes.request("/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ventureId: venture.id,
        brief: brief.slice(0, 2_000),
        format,
        platform: channelLabel(channel),
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { post?: { id?: unknown }; error?: unknown }
      | null;
    if (!res.ok || !body?.post)
      error = typeof body?.error === "string" ? body.error : `The Studio refused it (HTTP ${res.status}).`;
    else postId = String((body.post as { id: unknown }).id);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  let itemId: string | null = null;
  if (postId) {
    const destinationId = destinationForChannel(venture.id, channel);
    const created = createItem({
      ventureId: venture.id,
      source: { kind: "studio_post", id: postId },
      destinationId,
      campaignId,
    });
    if (created.ok) itemId = created.item.id;
  }

  db.prepare(
    "INSERT INTO campaign_variants (id, campaign_id, concept_id, channel, post_id, item_id, error, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    `cv-${randomUUID().slice(0, 8)}`,
    campaignId,
    concept.id,
    channel,
    postId,
    itemId,
    error,
    now(),
  );
  return { postId, itemId, error };
}

/**
 * Forget a campaign — the plan, its concepts and its variant records.
 *
 * WHAT IT DOES NOT TOUCH is the point: the Studio posts it produced and the
 * publish items it filed stay exactly where they are. Those are drafts
 * somebody may still want, and deleting a plan is not deleting the work. The
 * items lose their `campaign_id` so they stop pointing at a row that is gone,
 * and are otherwise unchanged.
 *
 * A campaign whose run is still going is refused: cancel the run first, so the
 * fan-out is not writing variants into a campaign that no longer exists.
 */
export function removeCampaign(id: string): { ok: boolean; error?: string; items: number } {
  const row = campaignRow(id);
  if (!row) return { ok: false, error: "No campaign by that id.", items: 0 };
  if (row.run_id) {
    const run = db.prepare("SELECT status FROM agent_runs WHERE id = ?").get(row.run_id) as
      | { status: string }
      | undefined;
    if (run?.status === "queued" || run?.status === "running")
      return {
        ok: false,
        error: "That campaign's run is still going. Cancel the run first.",
        items: 0,
      };
  }
  const items = db
    .prepare("UPDATE publish_items SET campaign_id = NULL WHERE campaign_id = ?")
    .run(id).changes;
  db.prepare("DELETE FROM campaign_variants WHERE campaign_id = ?").run(id);
  db.prepare("DELETE FROM campaign_concepts WHERE campaign_id = ?").run(id);
  db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
  return { ok: true, items: Number(items) };
}

/* ------------------------------------------------------------ suggestions */

/**
 * What a campaign could be about, without spending anything.
 *
 * DERIVED FROM ROWS, NOT FROM A MODEL. This is the view a page shows before
 * anybody has typed a goal, and it is built out of what the box already
 * measured: the venture's stage decides what a campaign is allowed to claim,
 * the destinations decide which channels are even available, and the recent
 * briefs decide what NOT to suggest. A model call here would be spending money
 * to draw a placeholder.
 */
export function suggestionsFor(v: VentureRow): {
  channels: { channel: string; label: string; destinationId: string | null; note: string }[];
  angles: { title: string; why: string }[];
  note: string;
} {
  const dests = destinationRows(v.id).filter((d) => d.enabled === 1);
  const channels = [...new Set(dests.map((d) => d.kind))].map((kind) => ({
    channel: kind,
    label: channelLabel(kind),
    destinationId: destinationForChannel(v.id, kind),
    note:
      dests.filter((d) => d.kind === kind).length > 1
        ? "More than one account of this kind — a variant is made as a draft with no destination chosen."
        : "A variant on this channel becomes a draft publish item.",
  }));

  const recent = db
    .prepare("SELECT brief FROM studio_posts WHERE venture_id = ? ORDER BY ts DESC LIMIT 6")
    .all(v.id) as unknown as { brief: string }[];

  const byStage: Record<string, { title: string; why: string }[]> = {
    idea: [
      { title: "The problem, named", why: "An idea has nothing to sell, and the problem is the only thing it can honestly talk about." },
      { title: "Who this is for", why: "Stating the audience out loud is how you find out whether it exists." },
    ],
    "pre-launch": [
      { title: "What is being built, and why that way", why: "Pre-launch can show progress and reasoning without claiming the product is on sale." },
      { title: "The waiting list", why: "The one call to action a pre-launch business honestly has." },
    ],
    launched: [
      { title: "One job it does, end to end", why: "A launched product can point at itself; a single job beats a feature list." },
      { title: "What it replaces", why: "Positioning against the status quo is the argument most portfolios never make." },
    ],
  };

  return {
    channels,
    angles: byStage[v.stage] ?? byStage.launched!,
    note:
      channels.length === 0
        ? "This venture has no enabled destination, so a campaign would produce Studio drafts and nothing queued. Probe the destinations first."
        : recent.length
          ? `The last ${recent.length} briefs are given to the planner as angles NOT to repeat.`
          : "Nothing has been posted for this venture yet, so the planner has no angles to avoid.",
  };
}
