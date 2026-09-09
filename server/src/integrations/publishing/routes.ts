/**
 * `/api/publishing` — the queue, the calendar, the destinations, the campaigns
 * and the asset library.
 *
 * ONE ROUTE FAMILY RATHER THAN FIVE, and that is the same argument /api/mail
 * makes over two providers: this is one workflow read at five depths. A draft
 * becomes an approved item becomes a scheduled item becomes a post with a
 * permalink, and every view here is a cut of that one list. Splitting them
 * would mean a page fetching four documents and joining them, which is a page
 * that eventually joins them wrongly.
 *
 * WHAT WRITES, AND WHAT THE WRITE MEANS. `approve` is the owner's consent and
 * is the only door from a draft to something the scheduler will touch;
 * `schedule` puts an approved item on a date; `publish` submits one now.
 * Everything else reads. There is no route here that creates an item in any
 * state but `draft`, in this file or anywhere else in this server.
 *
 * THE MEDIA ROUTE IS THE ONE THAT LEAVES THIS BOX. `/items/:id/media` serves
 * the picture or the clip, and it exists because Instagram and TikTok fetch
 * their own media from a URL. It is only useful when `publicBaseUrl` is set
 * and something actually routes the public internet to this API — this server
 * binds to loopback, so on a plain install it is reachable by the browser and
 * by nothing else. If the owner has put a password on this dashboard, the gate
 * in integrations/security applies to this path like every other, and Meta's
 * fetcher will be refused: that is stated on the readiness view rather than
 * discovered as a container that never becomes a post.
 */
import { Hono } from "hono";
import { ventureRow, ventureRowById, ventureRows } from "../../db.ts";
import { passwordSet } from "../security/owner.ts";
import { requireBrowser } from "../security/gate.ts";
import { insertRun, mintRunId, runRow, shapeRun } from "../runs/store.ts";
import { pump } from "../runs/executor.ts";
import {
  ASSET_KINDS,
  addAsset,
  addAssetFromUrl,
  assetFile,
  assetRow,
  assetRows,
  libraryBytes,
  modelImageInput,
  removeAsset,
  shapeAsset,
  updateAsset,
  UPLOAD_CAP,
} from "./assets.ts";
import {
  campaignRow,
  campaignRows,
  removeCampaign,
  shapeCampaign,
  suggestionsFor,
} from "./campaigns.ts";
import {
  destinationRow,
  destinationRows,
  probeDestinations,
  removeDestination,
  setEnabled,
  setVenture,
  shapeDestination,
} from "./destinations.ts";
import { DESTINATION_KINDS, LIMITS } from "./limits.ts";
import {
  approve,
  cancel,
  createItem,
  itemRow,
  itemRows,
  patchItem,
  publicMediaUrl,
  schedule,
  shapeItem,
  statusCounts,
  unschedule,
  type Source,
} from "./items.ts";
import { attemptRows, publishItem, shapeAttempt } from "./publish.ts";
import { calendar, dueItems, scheduledRows, tick } from "./scheduler.ts";
import { PLUGIN, settings, TICK_MS } from "./settings.ts";
import { imageModel } from "../ventures/studio.ts";
import { readFileSync, statSync } from "node:fs";
import { mimeFromPath } from "./items.ts";

export const publishingRoutes = new Hono();

const bad = (message: string) => ({ error: message });

/** Boundaries, part headers and the other form fields around the file. A
 *  generous allowance: the point is to refuse a gigabyte, not to be exact. */
const MULTIPART_SLACK = 256 * 1024;

/**
 * THE TWO ROUTES THAT REACH A STRANGER'S FEED ARE BROWSER-ONLY.
 *
 * `requireBrowser` (integrations/security/gate.ts) refuses any request that
 * carries a service key of either scope or the skills proxy's own
 * `x-opc-via: skills`, and any request whose Origin is not this workspace —
 * while still letting the dashboard work on a box with no password, which is
 * the shipped state. That is the right shape for exactly two routes here:
 * publish and retry. `deploy-routes.ts` uses it for install and uninstall and
 * `mailflow` uses its stricter sibling for send, for the same reason.
 *
 * WHY NOT `/api/publishing` IN THE GATE'S `OWNER_SURFACE`. That list is a
 * PREFIX list and it refuses the skills proxy outright, so putting this area
 * on it would kill every publishing skill action — queueing, approving,
 * scheduling, probing, importing an asset — all of which the registry
 * deliberately publishes and none of which sends anything. The surface that
 * has to be closed is two routes, not a prefix, and the id sits in the middle
 * of both paths where a prefix cannot reach it.
 *
 * SO THE WALLS ARE THREE, AND THEY ARE DIFFERENT KINDS:
 *   the registry names no action pointing at either route, so the proxy has
 *   no URL to compose — the structural one. It was briefly false: a
 *   `retry_item` action pointed here and could only ever have been answered
 *   with a 403. It was deleted rather than the guard, and skills.ts's header
 *   says why;
 *   `requireBrowser` refuses the proxy's header and both keys, so adding such
 *   an action by accident is a 403 rather than a post;
 *   and `publishItem` refuses anything the owner has not approved, which is
 *   the one that does not depend on where the request came from.
 *
 * The middle wall is a HEURISTIC and the gate's own comment says so at length:
 * anything that can open a socket can set these headers. It raises the bar to
 * "you must deliberately impersonate a browser". It is not a cryptographic
 * boundary and is not described as one.
 */

function ventureFrom(key: string | undefined | null) {
  if (!key) return null;
  return ventureRow(key) ?? null;
}

/* ------------------------------------------------------------- readiness */

/**
 * Can anything be published at all, and what stops it.
 *
 * The first view, because it is the question. Everything else on this route
 * is a list; this is the answer a page draws before it draws one.
 */
publishingRoutes.get("/", (c) => {
  const s = settings();
  const dests = destinationRows().map(shapeDestination);
  const counts = statusCounts();
  const due = dueItems(scheduledRows(), new Date().toISOString());
  const locked = passwordSet();
  return c.json({
    settings: {
      timezone: s.timezone,
      maxAttempts: s.maxAttempts,
      blackout: s.blackout.map((w) => w.raw),
      autoSchedule: s.autoSchedule.map((a) => `${a.slug} = ${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`),
      publicBaseUrl: s.publicBaseUrl,
    },
    publicMedia: {
      configured: s.publicBaseUrl !== null,
      /* THE HONEST QUALIFICATION. A base URL being typed is not the same as
         Meta being able to reach it, and this box cannot test the second from
         inside itself. What it CAN say is when it is certainly wrong. */
      note: !s.publicBaseUrl
        ? "No public base URL is set, so Instagram and TikTok cannot be published to — both fetch " +
          "their own media and this server binds to loopback."
        : locked
          ? "A base URL is set AND this dashboard has a password on it. The media route is behind " +
            "that lock like every other, so Meta's and TikTok's fetchers will be refused. Serve " +
            "the media from a public path of your own instead. DO NOT take the password off: " +
            "that would expose the whole of /api — plugin configuration, the agent routes, every " +
            "credential surface — to the internet so that Meta could fetch one picture."
          : "A base URL is set. Whether the internet actually routes to it is not something this " +
            "box can test from inside itself — a failed fetch shows up as a container that never " +
            "becomes a post, minutes later.",
    },
    scheduler: {
      everyMs: TICK_MS,
      due: due.length,
      next: due[0] ? { id: due[0].id, at: due[0].scheduled_for } : null,
    },
    destinations: {
      total: dests.length,
      enabled: dests.filter((d) => d.enabled).length,
      canPublish: dests.filter(
        (d) => d.enabled && (d.capabilities.text || d.capabilities.photo || d.capabilities.video),
      ).length,
      neverProbed: dests.filter((d) => d.probe.at === null).length,
    },
    counts,
    kinds: DESTINATION_KINDS.map((k) => LIMITS[k]),
    note:
      dests.length === 0
        ? "No destinations exist yet. Probe a venture's destinations to discover the Pages, " +
          "Instagram accounts, LinkedIn pages and TikTok accounts the connected credentials reach."
        : "Nothing is published that was not approved by the owner first, and nothing is scheduled " +
          "that was not approved.",
  });
});

/* ---------------------------------------------------------- destinations */

publishingRoutes.get("/destinations", (c) => {
  const venture = ventureFrom(c.req.query("venture"));
  if (c.req.query("venture") && !venture) return c.json(bad("No venture by that id or slug."), 404);
  return c.json({
    venture: venture ? { id: venture.id, slug: venture.slug, name: venture.name } : null,
    destinations: destinationRows(venture?.id ?? null).map(shapeDestination),
    kinds: DESTINATION_KINDS.map((k) => LIMITS[k]),
    note:
      "A probe is dated. `probe.at: null` means nobody has ever asked, which is not the same as a " +
      "probe that failed. Nothing here is re-probed on a read.",
  });
});

publishingRoutes.post("/destinations/probe", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ventureId?: unknown } | null;
  const key = typeof body?.ventureId === "string" ? body.ventureId : c.req.query("venture");
  const venture = ventureFrom(key);
  if (!venture)
    return c.json(bad("Expected { ventureId } — a venture's id or slug. A destination belongs to a business."), 400);
  const report = await probeDestinations(venture);
  return c.json(report);
});

/**
 * Switch a destination off, or move it to the venture it belongs to.
 *
 * The second is the half the probe cannot do: it attaches every Page a token
 * administers to the venture it was run for, and only the owner knows which
 * business each Page is actually for.
 */
publishingRoutes.patch("/destinations/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { enabled?: unknown; ventureId?: unknown }
    | null;
  if (!body) return c.json(bad("Expected a JSON body."), 400);
  const id = c.req.param("id");
  if (!destinationRow(id)) return c.json(bad("No destination by that id."), 404);
  if (typeof body.ventureId === "string") {
    const venture = ventureFrom(body.ventureId);
    if (!venture) return c.json(bad("No venture by that id or slug."), 400);
    const moved = setVenture(id, venture.id);
    if (!moved.ok) return c.json(bad(moved.error!), 400);
  }
  if (typeof body.enabled === "boolean") setEnabled(id, body.enabled);
  if (body.enabled === undefined && body.ventureId === undefined)
    return c.json(bad("Expected { enabled } or { ventureId }."), 400);
  return c.json({ destination: shapeDestination(destinationRow(id)!) });
});

publishingRoutes.delete("/destinations/:id", (c) => {
  const res = removeDestination(c.req.param("id"));
  if (!res.ok) return c.json(bad(res.error!), 400);
  return c.json({ ok: true, deleted: c.req.param("id") });
});

/* ----------------------------------------------------------------- items */

publishingRoutes.get("/items", (c) => {
  const venture = ventureFrom(c.req.query("venture"));
  if (c.req.query("venture") && !venture) return c.json(bad("No venture by that id or slug."), 404);
  const status = c.req.query("status") ?? null;
  const limitRaw = Number(c.req.query("limit") ?? 100);
  const rows = itemRows({
    ventureId: venture?.id ?? null,
    status,
    campaignId: c.req.query("campaign") ?? null,
    limit: Number.isFinite(limitRaw) ? limitRaw : 100,
  });
  return c.json({
    venture: venture ? { id: venture.id, slug: venture.slug, name: venture.name } : null,
    counts: statusCounts(venture?.id ?? null),
    items: rows.map(shapeItem),
    note:
      "`problems` is computed on every read, never stored — a caption edited to fit is a different " +
      "answer. An item with problems cannot be approved.",
  });
});

publishingRoutes.post("/items", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    ventureId?: unknown;
    source?: unknown;
    sourceKind?: unknown;
    sourceId?: unknown;
    destinationId?: unknown;
    caption?: unknown;
  } | null;
  if (!body) return c.json(bad("Expected a JSON body."), 400);

  const sourceObj = (body.source ?? {}) as { kind?: unknown; id?: unknown };
  const kind = String(sourceObj.kind ?? body.sourceKind ?? "manual");
  const id = typeof sourceObj.id === "string" ? sourceObj.id : typeof body.sourceId === "string" ? body.sourceId : null;
  if (kind !== "studio_post" && kind !== "video_job" && kind !== "manual")
    return c.json(bad('A source kind is "studio_post", "video_job" or "manual".'), 400);
  if (kind !== "manual" && !id) return c.json(bad("A studio_post or video_job source needs an id."), 400);

  const source = (kind === "manual" ? { kind: "manual", id: null } : { kind, id: id! }) as Source;
  const created = createItem({
    ventureId: typeof body.ventureId === "string" ? body.ventureId : null,
    source,
    destinationId: typeof body.destinationId === "string" ? body.destinationId : null,
    caption: typeof body.caption === "string" ? body.caption : null,
  });
  if (!created.ok) return c.json(bad(created.error), 400);
  return c.json(
    {
      item: shapeItem(created.item),
      /* `created: false` is a SUCCESS and the note says so — asking twice is
         the same request, not an error. */
      created: created.created,
      note: created.created
        ? "Queued as a DRAFT. Nothing goes anywhere until you approve it."
        : "That source was already queued to that destination; this is the row that already existed.",
    },
    created.created ? 201 : 200,
  );
});

publishingRoutes.get("/items/:id", (c) => {
  const row = itemRow(c.req.param("id"));
  if (!row) return c.json(bad("No item by that id."), 404);
  return c.json({
    item: shapeItem(row),
    attempts: attemptRows(row.id).map(shapeAttempt),
    publicMediaUrl: publicMediaUrl(row.id),
  });
});

publishingRoutes.patch("/items/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { caption?: unknown; destinationId?: unknown }
    | null;
  if (!body) return c.json(bad("Expected a JSON body."), 400);
  const res = patchItem(c.req.param("id"), {
    caption: typeof body.caption === "string" ? body.caption : undefined,
    destinationId:
      body.destinationId === undefined
        ? undefined
        : body.destinationId === null
          ? null
          : String(body.destinationId),
  });
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({
    item: shapeItem(res.item),
    /* SAID OUT LOUD, because it is a status moving backwards and a page that
       did not mention it would look like it had lost the approval. */
    unapproved: res.unapproved,
    note: res.unapproved
      ? "Edited, so the approval was withdrawn — it is a draft again. Approve it when you have read it."
      : null,
  });
});

publishingRoutes.post("/items/:id/approve", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { by?: unknown } | null;
  const res = approve(c.req.param("id"), typeof body?.by === "string" ? body.by : "owner");
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({
    item: shapeItem(res.item),
    note: "Approved. It still has to be scheduled or published — approving does not send anything.",
  });
});

publishingRoutes.post("/items/:id/schedule", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { at?: unknown } | null;
  if (typeof body?.at !== "string")
    return c.json(bad("Expected { at } — an ISO instant, e.g. 2026-09-08T09:30:00Z."), 400);
  const res = schedule(c.req.param("id"), body.at);
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({ item: shapeItem(res.item), timezone: settings().timezone });
});

publishingRoutes.post("/items/:id/unschedule", (c) => {
  const res = unschedule(c.req.param("id"));
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({ item: shapeItem(res.item) });
});

publishingRoutes.post("/items/:id/cancel", (c) => {
  const res = cancel(c.req.param("id"));
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({ item: shapeItem(res.item) });
});

/**
 * REHEARSE. Its own route, and that is a correction rather than a convenience.
 *
 * This started life as `POST /items/:id/publish` with a `dry` FLAG, and the
 * flag published a real post to a real Facebook Page during testing. The
 * caller — the skills proxy — sends every parameter as a STRING, so `"true"`
 * arrived where `true` was compared, the flag read false, and a rehearsal
 * became a publish. Nobody typed anything wrong.
 *
 * The lesson is not "coerce the string". It is that a rehearsal and a
 * submission must not be the same endpoint distinguished by a value, because
 * a value can be wrong and the two outcomes are not comparably bad. So there
 * are two routes: this one CANNOT publish — it passes `dry: true` as a
 * literal, with nothing read off the request — and the other one always does.
 * The skill registry points its `rehearse_item` action here, so no agent can
 * reach the live one at all.
 */
publishingRoutes.post("/items/:id/rehearse", async (c) => {
  const res = await publishItem(c.req.param("id"), { dry: true, by: "owner" });
  const row = itemRow(c.req.param("id"));
  return c.json({ result: res, item: row ? shapeItem(row) : null });
});

/**
 * Submit now. This one really posts.
 *
 * `dry` IS STILL ACCEPTED for the page's Rehearse button, and it is read
 * STRICTLY: `true`, `"true"` and `"1"` are a rehearsal, `false`, `"false"`,
 * `"0"` and absence are a publish, and ANYTHING ELSE is a 400. A parameter
 * that could not be read must never fall through to the side that posts —
 * that is the exact mistake this route made once.
 */
publishingRoutes.post("/items/:id/publish", requireBrowser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { dry?: unknown } | null;
  const raw = body?.dry ?? c.req.query("dry");
  let dry: boolean;
  if (raw === undefined || raw === null || raw === false || raw === "false" || raw === "0")
    dry = false;
  else if (raw === true || raw === "true" || raw === "1") dry = true;
  else
    return c.json(
      bad(
        `\`dry\` was “${String(raw)}”, which this cannot read as yes or no. It is refusing rather ` +
          "than guessing, because the wrong guess here is a post in somebody's feed. Use " +
          "POST /api/publishing/items/:id/rehearse for a rehearsal.",
      ),
      400,
    );
  const id = String(c.req.param("id"));
  const res = await publishItem(id, { dry, by: "owner" });
  const row = itemRow(id);
  return c.json(
    { result: res, item: row ? shapeItem(row) : null },
    res.ok || dry ? 200 : 422,
  );
});

/** A failed item, tried again by hand. The attempt counter is NOT reset: three
 *  failures and a manual retry is a fourth attempt, and a page that said
 *  "attempt 1" would hide the history. */
publishingRoutes.post("/items/:id/retry", requireBrowser, async (c) => {
  const row = itemRow(String(c.req.param("id")));
  if (!row) return c.json(bad("No item by that id."), 404);
  if (row.status !== "failed")
    return c.json(bad(`That item is ${row.status}. Retry is for a failed one.`), 400);
  if (row.external_id) return c.json(bad("That item was already submitted."), 400);
  const res = await publishItem(row.id, { by: "owner" });
  return c.json({ result: res, item: shapeItem(itemRow(row.id)!) }, res.ok ? 200 : 422);
});

/**
 * The bytes. This is the URL Instagram and TikTok are handed.
 *
 * Only files an item already points at are served, so a path cannot be
 * traversed into — the same rule the Studio's image route keeps.
 */
publishingRoutes.get("/items/:id/media", (c) => {
  const row = itemRow(c.req.param("id"));
  if (!row) return c.json(bad("No item by that id."), 404);
  if (!row.media_path) return c.json(bad("That item has no media."), 404);
  let bytes: Buffer;
  let size: number;
  try {
    size = statSync(row.media_path).size;
    bytes = readFileSync(row.media_path);
  } catch {
    return c.json(bad("That item's file is no longer on disk."), 404);
  }
  return c.body(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    200,
    {
      "Content-Type": mimeFromPath(row.media_path),
      "Content-Length": String(size),
      /* Public, because the whole point is that somebody else's fetcher can
         read it — and short, because an item's media can be replaced. */
      "Cache-Control": "public, max-age=600",
    },
  );
});

/* -------------------------------------------------------------- calendar */

publishingRoutes.get("/calendar", (c) => {
  const venture = ventureFrom(c.req.query("venture"));
  if (c.req.query("venture") && !venture) return c.json(bad("No venture by that id or slug."), 404);
  const daysRaw = Number(c.req.query("days") ?? 7);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(62, Math.round(daysRaw))) : 7;
  const fromRaw = c.req.query("from");
  const from = fromRaw ? new Date(fromRaw) : new Date();
  if (Number.isNaN(from.getTime())) return c.json(bad("`from` is not a date this can read."), 400);

  const cal = calendar({ from, days, ventureId: venture?.id ?? null });
  return c.json({
    timezone: cal.timezone,
    from: from.toISOString(),
    days,
    /** One entry per local day in the window, in order, including empty ones —
     *  an empty day is a fact and a missing key is a bug. */
    calendar: [...cal.buckets.entries()].map(([day, rows]) => ({
      day,
      items: rows.map(shapeItem),
    })),
    outside: cal.outside,
    blackout: settings().blackout.map((w) => w.raw),
    note:
      "Days are LOCAL to the configured timezone; `scheduledFor` is a UTC instant. An item due " +
      "inside a blackout window is not skipped — it goes out when the window closes.",
  });
});

/** Run one scheduler tick by hand. Publishes at most one due item, exactly as
 *  the timer does — this is not a "publish everything" button. */
publishingRoutes.post("/tick", async (c) => c.json(await tick("manual")));

/* ------------------------------------------------------------- campaigns */

publishingRoutes.get("/campaigns", (c) => {
  const venture = ventureFrom(c.req.query("venture"));
  if (c.req.query("venture") && !venture) return c.json(bad("No venture by that id or slug."), 404);
  return c.json({
    venture: venture ? { id: venture.id, slug: venture.slug, name: venture.name } : null,
    campaigns: campaignRows(venture?.id ?? null).map(shapeCampaign),
    note:
      "A campaign's variants are Studio drafts and DRAFT publish items. Nothing a campaign makes " +
      "is approved or scheduled by making it.",
  });
});

publishingRoutes.get("/campaigns/suggestions", (c) => {
  const venture = ventureFrom(c.req.query("venture"));
  if (!venture) return c.json(bad("Expected ?venture= — a venture's id or slug."), 400);
  return c.json({
    venture: { id: venture.id, slug: venture.slug, name: venture.name },
    ...suggestionsFor(venture),
  });
});

publishingRoutes.get("/campaigns/:id", (c) => {
  const row = campaignRow(c.req.param("id"));
  if (!row) return c.json(bad("No campaign by that id."), 404);
  const run = row.run_id ? runRow(row.run_id) : undefined;
  return c.json({
    campaign: shapeCampaign(row),
    run: run ? shapeRun(run) : null,
    items: itemRows({ campaignId: row.id, limit: 200 }).map(shapeItem),
  });
});

/**
 * Start a campaign — which QUEUES A RUN and answers immediately.
 *
 * The work is minutes long and this route is not the place to hold it: the run
 * queue owns the slot, the cancellation, the report and the page it is read
 * at. What comes back here is the run, and the campaign row appears the moment
 * the run starts planning.
 */
publishingRoutes.post("/campaigns", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    ventureId?: unknown;
    goal?: unknown;
    audience?: unknown;
    channels?: unknown;
    concepts?: unknown;
    startsOn?: unknown;
    endsOn?: unknown;
  } | null;
  if (!body) return c.json(bad("Expected a JSON body."), 400);
  const venture = ventureFrom(typeof body.ventureId === "string" ? body.ventureId : null);
  if (!venture) return c.json(bad("Expected { ventureId } — a venture's id or slug."), 400);
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) return c.json(bad("Expected { goal } — one line saying what the campaign is for."), 400);
  const channels = (Array.isArray(body.channels) ? body.channels : String(body.channels ?? "").split(","))
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
  if (!channels.length)
    return c.json(
      bad(`Expected { channels } — one or more of ${DESTINATION_KINDS.join(", ")}, or a bare platform name.`),
      400,
    );

  const id = mintRunId();
  const input: Record<string, string> = {
    goal,
    channels: channels.join(","),
    concepts: String(Math.max(1, Math.min(5, Number(body.concepts) || 3))),
  };
  if (typeof body.audience === "string" && body.audience.trim()) input.audience = body.audience.trim();
  if (typeof body.startsOn === "string") input.startsOn = body.startsOn;
  if (typeof body.endsOn === "string") input.endsOn = body.endsOn;

  insertRun({
    id,
    kind: "campaign",
    ventureId: venture.id,
    title: `Campaign — ${goal.slice(0, 80)}`,
    input,
  });
  pump();
  return c.json(
    {
      run: shapeRun(runRow(id)!),
      note:
        "Queued. The campaign row appears when the run starts planning; the variants arrive as " +
        "DRAFT publish items, none of them approved.",
    },
    201,
  );
});

/** Forget a plan. The drafts it produced are kept and simply stop pointing at
 *  it — deleting a plan is not deleting the work. */
publishingRoutes.delete("/campaigns/:id", (c) => {
  const res = removeCampaign(c.req.param("id"));
  if (!res.ok) return c.json(bad(res.error!), 400);
  return c.json({
    ok: true,
    deleted: c.req.param("id"),
    note: `${res.items} publish item(s) kept, no longer linked to a campaign.`,
  });
});

/* ---------------------------------------------------------------- assets */

publishingRoutes.get("/assets", async (c) => {
  const venture = ventureFrom(c.req.query("venture"));
  if (c.req.query("venture") && !venture) return c.json(bad("No venture by that id or slug."), 404);
  const kind = c.req.query("kind") ?? null;
  const model = imageModel();
  const support = await modelImageInput(model);
  return c.json({
    venture: venture ? { id: venture.id, slug: venture.slug, name: venture.name } : null,
    assets: assetRows(venture?.id ?? null, kind).map(shapeAsset),
    kinds: ASSET_KINDS,
    bytes: libraryBytes(venture?.id ?? null),
    uploadCap: UPLOAD_CAP,
    /** Whether a selected asset can be handed to the image model at all, read
     *  off that model's OWN schema. `checked: false` is "could not ask". */
    imageModel: { model, ...support },
    note:
      "An asset is stored once and reused. Selecting one in the Studio passes it to the image " +
      "model where the model has an image input, and describes it in words where it has not — " +
      "the post records which of the two happened.",
  });
});

/**
 * Add one, from an upload or from a URL.
 *
 * Two content types on one route rather than two routes, because they are one
 * action with two sources and the answer is identical. A multipart body is a
 * file the owner chose; a JSON body with a `url` is this box fetching one,
 * which is recorded as such because it can be somebody else's copyright.
 */
publishingRoutes.post("/assets", async (c) => {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    /*
      THE DECLARED LENGTH IS REFUSED BEFORE THE BODY IS TOUCHED.
      `c.req.formData()` materialises the whole upload in memory, and
      `addAsset`'s 12 MB cap is checked afterwards — so without this a
      multi-gigabyte POST is accepted, buffered, and then politely told it was
      too big by a process that has already died. The multipart envelope adds
      boundaries and headers around the file, so the wire limit is the file cap
      plus a small allowance rather than the file cap exactly.
    */
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > UPLOAD_CAP + MULTIPART_SLACK)
      return c.json(
        bad(
          `That upload declares ${Math.round(declared / 1024 / 1024)} MB; the cap is ` +
            `${UPLOAD_CAP / 1024 / 1024} MB.`,
        ),
        413,
      );
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(bad("That body could not be read as a multipart form."), 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json(bad("Send the image as a `file` part."), 400);
    const ventureKey = String(form.get("ventureId") ?? "");
    const venture = ventureFrom(ventureKey);
    if (!venture) return c.json(bad("Send a `ventureId` part — a venture's id or slug."), 400);
    const res = addAsset({
      ventureId: venture.id,
      kind: String(form.get("kind") ?? "reference"),
      bytes: new Uint8Array(await file.arrayBuffer()),
      name: String(form.get("name") ?? file.name ?? ""),
      source: "upload",
      prompt: String(form.get("prompt") ?? ""),
      notes: String(form.get("notes") ?? ""),
    });
    if (!res.ok) return c.json(bad(res.error), 400);
    return c.json({ asset: shapeAsset(res.asset) }, 201);
  }

  const body = (await c.req.json().catch(() => null)) as {
    ventureId?: unknown;
    kind?: unknown;
    url?: unknown;
    name?: unknown;
    prompt?: unknown;
    notes?: unknown;
  } | null;
  if (!body) return c.json(bad("Expected a multipart form with a `file`, or JSON with a `url`."), 400);
  const venture = ventureFrom(typeof body.ventureId === "string" ? body.ventureId : null);
  if (!venture) return c.json(bad("Expected { ventureId } — a venture's id or slug."), 400);
  if (typeof body.url !== "string") return c.json(bad("Expected { url } — an http(s) image URL."), 400);
  const res = await addAssetFromUrl({
    ventureId: venture.id,
    kind: String(body.kind ?? "reference"),
    url: body.url,
    name: typeof body.name === "string" ? body.name : null,
    prompt: typeof body.prompt === "string" ? body.prompt : null,
    notes: typeof body.notes === "string" ? body.notes : null,
  });
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({ asset: shapeAsset(res.asset) }, 201);
});

publishingRoutes.patch("/assets/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    kind?: unknown;
    name?: unknown;
    prompt?: unknown;
    notes?: unknown;
    ventureId?: unknown;
  } | null;
  if (!body) return c.json(bad("Expected a JSON body."), 400);
  const moveTo = typeof body.ventureId === "string" ? ventureFrom(body.ventureId) : null;
  if (typeof body.ventureId === "string" && !moveTo) return c.json(bad("No venture by that id or slug to move it to."), 400);
  const res = updateAsset(c.req.param("id"), {
    kind: typeof body.kind === "string" ? body.kind : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    ventureId: moveTo?.id,
  });
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({ asset: shapeAsset(res.asset) });
});

publishingRoutes.delete("/assets/:id", (c) => {
  const res = removeAsset(c.req.param("id"));
  if (!res.ok) return c.json(bad(res.error ?? "No asset by that id."), 404);
  return c.json({ ok: true, deleted: c.req.param("id") });
});

publishingRoutes.get("/assets/:id/file", (c) => {
  const row = assetRow(c.req.param("id"));
  if (!row) return c.json(bad("No asset by that id."), 404);
  const file = assetFile(row.id);
  if (!file) return c.json(bad("That asset's file is no longer on disk."), 404);
  return c.body(
    file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength,
    ) as ArrayBuffer,
    200,
    {
      "Content-Type": file.mime,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
    },
  );
});

/* ------------------------------------------------------------- utilities */

/** Every venture with a count of what is waiting, for a picker that wants to
 *  show where the work is rather than an alphabetical list. */
publishingRoutes.get("/ventures", (c) =>
  c.json({
    ventures: ventureRows().map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      stage: v.stage,
      destinations: destinationRows(v.id).length,
      counts: statusCounts(v.id),
    })),
  }),
);

/** The plugin id this area's settings live under, so a client can build the
 *  Integrations link without hard-coding it. */
publishingRoutes.get("/plugin", (c) => c.json({ plugin: PLUGIN }));

export { ventureRowById };
