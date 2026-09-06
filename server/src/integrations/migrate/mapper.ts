/**
 * WORKDASH RECORDS → THIS BOX'S ROWS. Pure functions, no database.
 *
 * WHY THE MAPPING IS ITS OWN MODULE WITH NO IMPORTS FROM db.ts. Every decision
 * in here is arguable — which column a card lands in, what a chat message's
 * timestamp is when the source never recorded one, whether a rolling 28-day
 * total may be written into a column of daily clicks — and an arguable decision
 * that can only be exercised by running a real import against a real directory
 * is a decision nobody checks. These take plain objects and return plain
 * objects, so migrate.test.ts can put a fixture in and read the row out.
 *
 * THE TWO CLOCKS. WorkDash stores milliseconds in some files and SECONDS in
 * others — `kanban.json` and `agent-memory.json` are ms, `goals.json`,
 * `actions.json`, `outcomes.json` and `studio.json` are seconds — and there is
 * no flag in the data saying which. `iso()` decides by magnitude, which is
 * unambiguous for every date this century, and every caller passes the unit it
 * knows from the source file rather than relying on the guess.
 *
 * WHAT IS DELIBERATELY NOT MAPPED. Credentials, in any form — see
 * workdash.ts's deny list. Individual message timestamps, because WorkDash
 * does not have them and interpolating a plausible one is inventing evidence.
 * And every metric history series, because not one of them shares a window and
 * a key with the table it would land in; the SERIES table below is the table of
 * that reasoning, one row per series, so the refusal is a decision on the page
 * rather than an omission in the code.
 */

/* ------------------------------------------------------------------ time */

/** WorkDash's two clocks, as ISO. Anything under 1e11 is seconds — that
 *  threshold is the year 5138 in seconds and 1973 in milliseconds, so nothing
 *  either application will ever hold is ambiguous. */
export function iso(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const at = Date.parse(value.trim());
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value < 1e11 ? value * 1000 : value;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** One string field, cleaned and bounded. Control characters go first, the
 *  way WorkDash's own `neutralize_label` does it at the collector boundary:
 *  a label carrying an escape sequence is a label that can rewrite a terminal. */
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/* -------------------------------------------------------------- ventures */

/** `projects-info.json`'s slugs are DOMAINS — "example-app-1.example.test", "example-app-7.example.test".
 *  That is a gift: this box's ventures carry a `host` and a `website`, and a
 *  domain is both, so a project arrives with the one field every other
 *  integration joins on by eye. A slug that is not a domain is a name, and
 *  produces a venture with no site — the normal state of an idea, not a gap. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export type VentureDraft = {
  sourceId: string;
  slug: string;
  name: string;
  description: string;
  website: string | null;
  host: string | null;
  problems: string[];
};

export function ventureFrom(sourceSlug: string, entry: Record<string, unknown>): VentureDraft {
  const problems: string[] = [];
  const isDomain = DOMAIN.test(sourceSlug);
  const name = str(entry.name, 80) ?? sourceSlug;
  /* oneLiner first, then summary. Two fields in the source and one column
     here, and the one-liner is the sentence a person wrote — the summary is
     usually a model's expansion of it. */
  const description = str(entry.oneLiner, 600) ?? str(entry.summary, 600) ?? "";
  if (!description)
    problems.push(`${sourceSlug} has neither a one-liner nor a summary in WorkDash, so its description is blank.`);

  /* THE SLUG IS NOT THE DOMAIN. A venture's slug is a URL segment on this box,
     and the dots would make /ventures/example-app-1.example.test a path with an extension.
     The domain goes to `host` and `website`, which is where the joins happen. */
  const slug =
    (isDomain ? sourceSlug.split(".")[0]! : sourceSlug)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "venture";

  return {
    sourceId: sourceSlug,
    slug,
    name,
    description,
    website: isDomain ? `https://${sourceSlug.toLowerCase()}` : null,
    host: isDomain ? sourceSlug.toLowerCase().replace(/^www\./, "") : null,
    problems,
  };
}

/* ----------------------------------------------------------------- board */

/**
 * WorkDash's column ids onto this box's.
 *
 * WorkDash guarantees exactly two ids — `backlog` and `done` — and its default
 * set adds `todo` and `inprogress`. This box's five are backlog, next, doing,
 * blocked, done. The three obvious pairs are obvious; ANYTHING ELSE FALLS TO
 * BACKLOG AND IS REPORTED BY NAME, rather than creating a column: a board that
 * silently grew two columns during an import is a board the owner has to
 * reorganise before they can read it, and "these four cards came from a column
 * called Waiting" is a sentence they can act on in ten seconds.
 */
export const COLUMN_MAP: Record<string, string> = {
  backlog: "backlog",
  todo: "next",
  next: "next",
  inprogress: "doing",
  doing: "doing",
  "in-progress": "doing",
  blocked: "blocked",
  done: "done",
};

/** low | normal | high | urgent → 0 | 1 | 2 | 3, this box's ordering. An
 *  unknown word is `normal`, because urgency is a comparison and inventing a
 *  high one out of a typo moves somebody's week. */
export function urgencyOf(word: unknown): number {
  const w = typeof word === "string" ? word.trim().toLowerCase() : "";
  return w === "low" ? 0 : w === "high" ? 2 : w === "urgent" ? 3 : 1;
}

export type CardDraft = {
  sourceId: string;
  columnKey: string;
  position: number;
  title: string;
  body: string | null;
  ventureSource: string | null;
  urgency: number;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  origin: string;
  problems: string[];
};

export function cardFrom(raw: Record<string, unknown>): CardDraft | null {
  const id = str(raw.id, 80);
  const title = str(raw.title, 300);
  if (!id || !title) return null;
  const problems: string[] = [];
  const column = typeof raw.column === "string" ? raw.column.trim().toLowerCase() : "backlog";
  const columnKey = COLUMN_MAP[column];
  if (!columnKey)
    problems.push(`card ${id} was in a WorkDash column called “${raw.column}”, which has no counterpart here; it landed in Backlog.`);
  const created = iso(raw.createdAt) ?? new Date().toISOString();
  return {
    sourceId: id,
    columnKey: columnKey ?? "backlog",
    position: typeof raw.order === "number" && Number.isFinite(raw.order) ? Math.round(raw.order) : 0,
    title,
    body: str(raw.notes, 5000),
    ventureSource: str(raw.project, 80),
    urgency: urgencyOf(raw.urgency),
    doneAt: iso(raw.doneAt),
    createdAt: created,
    updatedAt: iso(raw.updatedAt) ?? created,
    /* The provenance AND the idempotency. board_cards has a UNIQUE index on
       `origin`, so a second import of the same card is refused by the database
       rather than by this code remembering to check. */
    origin: `workdash:card:${id}`,
    problems,
  };
}

/* ----------------------------------------------------------------- chats */

export type MessageDraft = {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
  model: string | null;
};

export type ChatDraft = {
  sourceId: string;
  sessionId: string;
  title: string | null;
  messages: MessageDraft[];
  problems: string[];
};

/**
 * One WorkDash chat as a session of this box's messages.
 *
 * EVERY MESSAGE CARRIES ITS CHAT'S CREATION TIME AND THAT IS SAID OUT LOUD.
 * WorkDash's `chats.json` timestamps the CHAT and not the messages inside it,
 * so there is no honest per-message time to import. Spreading them evenly
 * between `createdAt` and `updatedAt` would produce a transcript where every
 * message appears to have been sent at a regular interval — a picture of a
 * conversation that never happened, indistinguishable on the page from one
 * that did. So they all get the chat's own start, and the ORDER — which is
 * real, and is what a transcript is for — is preserved by the insertion order
 * that chat_messages' autoincrement id gives.
 *
 * THE PARTS ARE FLATTENED AND THE TOOL LINES ARE KEPT. A WorkDash assistant
 * message may carry `parts`: thinking, text, and tool lines. This box's
 * chat_messages has `content` and a `tools` column. Thinking is dropped —
 * it was never shown to the owner and is not what they said or were told —
 * and the tool names go to `tools` as JSON, which is where this box keeps them.
 */
export function chatFrom(raw: Record<string, unknown>): ChatDraft | null {
  const id = str(raw.id, 80);
  if (!id) return null;
  const created = iso(raw.createdAt) ?? new Date().toISOString();
  const model = str(raw.model, 80);
  const problems: string[] = [];
  const messages: MessageDraft[] = [];

  const list = Array.isArray(raw.messages) ? raw.messages : [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
    if (!role) continue;

    let content = typeof row.content === "string" ? row.content : "";
    if (!content && Array.isArray(row.parts)) {
      content = (row.parts as unknown[])
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        .filter((p) => p.kind === "text" || p.kind === "say")
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();
    }
    if (typeof row.error === "string" && row.error.trim())
      content = `${content}\n\n_(WorkDash recorded an error on this turn: ${row.error.trim().slice(0, 300)})_`.trim();
    if (!content) continue;

    messages.push({ role, content, ts: created, model: role === "assistant" ? model : null });
  }

  if (!messages.length) return null;
  if (list.length !== messages.length)
    problems.push(
      `chat ${id}: ${list.length - messages.length} of ${list.length} message(s) carried neither text nor a text part and were not imported.`,
    );

  return {
    sourceId: id,
    /* Prefixed rather than reused. A WorkDash chat id is `c<base36>` and this
       box's own session ids are UUIDs and words like "briefing"; a prefix makes
       an imported session identifiable forever without a second table. */
    sessionId: `wd-${id}`,
    title: str(raw.title, 120),
    messages,
    problems,
  };
}

/* -------------------------------------------------------------- memories */

export type MemoryDraft = {
  sourceId: string;
  id: string;
  text: string;
  scope: "global" | "venture";
  ventureSource: string | null;
  createdAt: string;
  lastConfirmedAt: string;
};

/** WorkDash caps a note at 500 characters and this box at 600, so nothing is
 *  ever truncated here — a note longer than 600 is refused and named rather
 *  than cut, because half a belief is a belief that says something else. */
export const MAX_NOTE = 600;

export function memoryFrom(raw: Record<string, unknown>): MemoryDraft | { skip: string } | null {
  const id = str(raw.id, 80);
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!id || !text) return null;
  if (text.length > MAX_NOTE)
    return { skip: `note ${id} is ${text.length} characters and a note here is at most ${MAX_NOTE}; it was not truncated.` };
  const project = str(raw.project, 80);
  const created = iso(raw.createdAt) ?? new Date().toISOString();
  return {
    sourceId: id,
    id: `wd-${id}`,
    text,
    scope: project ? "venture" : "global",
    ventureSource: project,
    createdAt: created,
    lastConfirmedAt: iso(raw.updatedAt) ?? created,
  };
}

/* ----------------------------------------------------------------- goals */

/** How long this box's global goal document may be. */
export const MAX_GOAL = 4_000;

/**
 * WorkDash's structured goals as this box's markdown.
 *
 * The two models genuinely differ: WorkDash holds up to twelve records with a
 * horizon, keywords and an optional numeric target; this box holds ONE piece of
 * markdown per scope, which the agent reads as prose. Rendering the records
 * into a list is lossless in the direction that matters — every field appears
 * — and it does not pretend the structure survived, which a set of invented
 * per-goal rows would.
 */
export function goalsMarkdown(goals: unknown[]): string {
  const lines: string[] = [];
  for (const g of goals) {
    if (!g || typeof g !== "object") continue;
    const row = g as Record<string, unknown>;
    const title = str(row.title, 120);
    if (!title) continue;
    const horizon = row.horizon === "year" ? "this year" : "this quarter";
    lines.push(`- **${title}** (${horizon})`);
    const why = str(row.why, 400);
    if (why) lines.push(`  - Why: ${why}`);
    const target = row.target as Record<string, unknown> | undefined;
    if (target && typeof target.metric === "string" && typeof target.value === "number")
      lines.push(`  - Target: ${target.metric} = ${target.value}`);
    const keywords = Array.isArray(row.keywords)
      ? row.keywords.filter((k): k is string => typeof k === "string").slice(0, 12)
      : [];
    if (keywords.length) lines.push(`  - Keywords: ${keywords.join(", ")}`);
  }
  if (!lines.length) return "";
  const doc = `Imported from WorkDash.\n\n${lines.join("\n")}\n`;
  return doc.length > MAX_GOAL ? `${doc.slice(0, MAX_GOAL - 40)}\n\n… truncated at ${MAX_GOAL} characters.` : doc;
}

/* -------------------------------------------------------------- outcomes */

export type OutcomeDraft = {
  sourceId: string;
  id: string;
  title: string;
  ventureSource: string | null;
  actionRef: string;
  actionText: string;
  actionAt: string;
  unit: string | null;
  readings: { kind: "baseline" | "reading"; value: number | null; ts: string }[];
  note: string;
};

/**
 * A WorkDash outcome as a CLOSED claim with its two readings.
 *
 * WHY CLOSED. This box's outcomes are LIVE: each names a skill, a view and a
 * path, and a scheduled pass re-reads that address at 7, 14 and 30 days. An
 * imported one names no address on this box — the figure came out of another
 * application's history database — so there is nothing to re-read, and leaving
 * it open would put a row on the schedule that fails forever. It is closed at
 * import, which is what "this was measured and the measuring is finished"
 * means here.
 *
 * THE BEFORE AND AFTER BECOME READINGS, because they are exactly that: a
 * baseline and a later value. WorkDash's `windowDays` are SAMPLE COUNTS rather
 * than calendar days, which is why the note says so rather than the offsets
 * being written into `day_offset` — a 14 there would claim a schedule slot the
 * reading did not come from.
 */
export function outcomeFrom(
  raw: Record<string, unknown>,
  actionText: string | null,
): OutcomeDraft | null {
  const actionId = str(raw.actionId, 120);
  if (!actionId) return null;
  const metric = str(raw.metric, 40);
  const at = iso(raw.at);
  if (!at) return null;
  const text = actionText ?? `WorkDash action ${actionId}`;
  const before = typeof raw.before === "number" && Number.isFinite(raw.before) ? raw.before : null;
  const after = typeof raw.after === "number" && Number.isFinite(raw.after) ? raw.after : null;
  const windows = (raw.windowDays ?? {}) as Record<string, unknown>;
  const verdict = str(raw.verdict, 20) ?? "unmeasurable";

  return {
    sourceId: `${actionId}|${metric ?? ""}`,
    id: `wd-${actionId}${metric ? `-${metric}` : ""}`,
    title: `${text.slice(0, 90)}${metric ? ` — ${metric}` : ""}`,
    ventureSource: str(raw.project, 80),
    actionRef: actionId,
    actionText: text,
    actionAt: at,
    unit: metric,
    readings: [
      { kind: "baseline", value: before, ts: at },
      { kind: "reading", value: after, ts: at },
    ],
    note:
      `Imported from WorkDash: verdict “${verdict}”, ` +
      `${before === null ? "no before figure" : `before ${before}`}, ` +
      `${after === null ? "no after figure" : `after ${after}`}. ` +
      `The windows were ${Number(windows.before) || 0} and ${Number(windows.after) || 0} SAMPLES, not calendar days, ` +
      `and the day of the action belonged to neither. Nothing re-reads this: the address it was measured at is not on this box.`,
  };
}

/* --------------------------------------------------------------- studio */

export type StudioDraft = {
  sourceId: string;
  id: string;
  ventureSource: string;
  ts: string;
  brief: string;
  platform: string | null;
  format: string;
  caption: string | null;
  imagePrompt: string | null;
  imageFile: string | null;
  error: string | null;
};

export function studioFrom(raw: Record<string, unknown>): StudioDraft | null {
  const id = str(raw.id, 120);
  const slug = str(raw.slug, 80);
  const ts = iso(raw.at);
  if (!id || !slug || !ts) return null;
  return {
    sourceId: id,
    id: `wd-${id}`,
    ventureSource: slug,
    ts,
    /* brief, then topic, then the format label. studio_posts.brief is NOT NULL
       and it is the sentence the page shows as the thing that was asked for;
       an empty one would make an imported post unreadable beside a generated
       one. */
    brief: str(raw.brief, 600) ?? str(raw.topic, 600) ?? str(raw.formatLabel, 600) ?? "Imported from WorkDash",
    platform: str(raw.platform, 40),
    format: str(raw.format, 40) ?? "post",
    caption: str(raw.caption, 4000),
    imagePrompt: str(raw.prompt, 4000),
    imageFile: str(raw.image, 200),
    error: str(raw.error, 500),
  };
}

export type VideoDraft = {
  sourceId: string;
  runId: string;
  ventureSource: string | null;
  ts: string;
  format: string;
  videoFile: string | null;
  imageFile: string | null;
  narration: string | null;
  error: string | null;
};

/** A WorkDash UGC item as a video job. It has a rendered clip, a prompt and a
 *  status; this box's video_jobs has a path, a script and an error, which is
 *  the same three facts under different names. */
export function videoFrom(raw: Record<string, unknown>): VideoDraft | null {
  const id = str(raw.id, 120);
  const ts = iso(raw.at);
  if (!id || !ts) return null;
  return {
    sourceId: id,
    runId: `wd-${id}`,
    ventureSource: str(raw.slug, 80),
    ts,
    format: "ugc",
    videoFile: str(raw.video, 200),
    imageFile: str(raw.image, 200),
    narration: str(raw.imagePrompt, 4000),
    error: str(raw.error, 500),
  };
}

/* --------------------------------------------------------------- outbox */

export type OutboxDraft = {
  sourceId: string;
  to: string;
  subject: string;
  body: string;
  status: string;
  createdAt: string;
  problems: string[];
};

/**
 * WorkDash's statuses onto this box's.
 *
 * `approved` BECOMES `draft`, AND THAT IS NOT A DOWNGRADE — it is the only
 * value that produces a usable row. An approval here is not a flag, it is a
 * RECORD: `approved_at` and `approved_content`, the exact bytes that were
 * agreed to. `sendApproved` re-checks the body against `approved_content`
 * before it sends, and refuses when they differ; `approveDraft` refuses
 * anything that is not `draft` or `failed`. So a row inserted as `approved`
 * with neither column filled is stuck in the ready-to-send queue forever:
 * it cannot be sent and it cannot be re-approved. Two existing migrations
 * (122_outbox_delivery, and nurture's) reset approved rows to draft for exactly
 * this reason.
 *
 * Importing it as a draft loses one click and keeps the mail sendable, and the
 * click is one somebody should probably make again anyway — an approval given
 * in another application, to a body this box has not shown them, is not consent
 * to send from here.
 *
 * `stopped` has no counterpart — a sequence somebody halted is not a draft, not
 * sent and not dismissed — and is `dismissed`, the closest true statement: it
 * will not be sent.
 */
const OUTBOX_STATUS: Record<string, string> = {
  draft: "draft",
  approved: "draft",
  sent: "sent",
  dismissed: "dismissed",
  stopped: "dismissed",
};

export function outboxFrom(raw: Record<string, unknown>): OutboxDraft | null {
  const id = str(raw.id, 120);
  const to = str(raw.to, 200);
  const body = typeof raw.body === "string" ? raw.body : "";
  if (!id || !to || !to.includes("@") || !body.trim()) return null;
  const problems: string[] = [];
  const source = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "draft";
  const status = OUTBOX_STATUS[source];
  if (!status) problems.push(`draft ${id} had a WorkDash status of “${raw.status}”, which has no counterpart here; it was imported as a draft.`);
  if (source === "approved")
    problems.push(
      `draft ${id} was approved in WorkDash and arrives here as a DRAFT. An approval here carries the exact bytes that were agreed to, and a row marked approved without them can neither be sent nor re-approved — it would sit in the queue forever. Approve it again to send it.`,
    );
  if (source === "stopped") problems.push(`draft ${id} was “stopped” in WorkDash — a halted sequence — and is “dismissed” here, which is the closest true statement.`);
  return {
    sourceId: id,
    to,
    subject: str(raw.subject, 300) ?? "(no subject)",
    body: body.slice(0, 50_000),
    status: status ?? "draft",
    createdAt: iso(raw.createdAt) ?? new Date().toISOString(),
    problems,
  };
}

/* -------------------------------------------------------------- history */

/**
 * EVERY METRIC SERIES, AND WHERE IT MAY GO. This table IS the answer to
 * "history → the matching tables where a source maps 1:1".
 *
 * The rule the brief sets is that a series moves into its real table ONLY where
 * the units AND the windows match. Applied honestly to WorkDash's eighteen
 * exported series and this box's daily tables, the answer today is that NONE
 * of them qualify, and there are two independent reasons — either of which
 * alone would be disqualifying:
 *
 *   1. THE KEY. stripe_charge_days, umami_days, play_sales, play_stats and
 *      appstore_sales are all keyed by `account_id REFERENCES plugin_accounts`,
 *      because a figure means something only beside the credential that
 *      fetched it. Imported history has no such account. Attaching eighteen
 *      months of somebody else's arithmetic to a live Stripe key, so that an
 *      INSERT would succeed, is not a migration — it is a forgery with a
 *      foreign key.
 *
 *   2. THE WINDOW. gsc_days is the one daily table NOT keyed by an account —
 *      it is keyed by `property` — and it still does not qualify, because
 *      WorkDash's `search` rows are Google's ROLLING 28-DAY TOTALS sampled
 *      hourly, and gsc_days.clicks is one day's clicks. Writing the first into
 *      the second inflates every chart on the page by about twenty-eight times,
 *      and nothing downstream could ever tell.
 *
 * So the plan below sends everything to `migrate_history`, tagged, dated,
 * carrying its own reason, and joined into no live chart. `readings` was
 * considered as an alternative home and rejected: it is a real table with real
 * readers, and a metric name nothing reads is a row that looks live and is not.
 *
 * THE TABLE STAYS EVEN THOUGH EVERY ANSWER IS THE SAME, because the shape of
 * the reasoning is the deliverable. A series that later gains a matching target
 * — a WorkDash export with true daily Umami rows, say — becomes one edited line
 * here rather than an argument had again from scratch.
 */
export type SeriesRule = {
  /** The key in WorkDash's exported history.json. */
  series: string;
  /** Positional columns of each row, in order. */
  columns: string[];
  /** Which columns are the subject (site, package, product…) rather than a
   *  figure. Everything else that is numeric becomes one metric. */
  subject: string[];
  /** 'day' where a row IS one day, 'rolling' where it is a window ending that
   *  day, 'level' where it is a snapshot, 'cumulative' where it only rises. */
  window: "day" | "rolling" | "level" | "cumulative";
  /** Where it would go if it qualified, for the sentence. */
  target: string;
  /** Why it does not. One sentence, stored on every row it produces. */
  reason: string;
};

export const SERIES: SeriesRule[] = [
  {
    series: "revenue",
    columns: ["day", "mrr", "arr", "active", "customers", "gross30", "failed30", "succeeded30"],
    subject: [],
    window: "level",
    target: "stripe_charge_days",
    reason:
      "stripe_charge_days is keyed by the Stripe account that fetched it and holds one DAY's gross; these are levels (MRR, ARR, live subscriptions) beside rolling 30-day totals, from an account this box does not have.",
  },
  {
    series: "revenueProducts",
    columns: ["day", "product", "mrr", "subs"],
    subject: ["product"],
    window: "level",
    target: "stripe_subscriptions",
    reason:
      "A product's MRR here is a LEVEL Stripe held that day, not money that moved. This box computes MRR from live subscriptions on every read and has no column for a historical one.",
  },
  {
    series: "traffic",
    columns: ["day", "site", "views24", "bots24"],
    subject: ["site"],
    window: "rolling",
    target: "umami_days",
    reason:
      "views24 is a ROLLING 24-hour count sampled through the day, not that calendar day's pageviews, and umami_days is keyed by the Umami account. Two rows a day apart overlap.",
  },
  {
    series: "search",
    columns: ["day", "site", "clicks", "impressions", "position"],
    subject: ["site"],
    window: "rolling",
    target: "gsc_days",
    reason:
      "These are Google's ROLLING 28-DAY totals, and gsc_days.clicks is one day's clicks. Writing them in would multiply every figure on the search page by about twenty-eight, and nothing downstream could tell.",
  },
  {
    series: "playstore",
    columns: ["day", "package", "installs", "active", "rating"],
    subject: ["package"],
    window: "day",
    target: "play_stats",
    reason:
      "installs IS a genuine daily count and would map cleanly — but play_stats is keyed by the Play account that fetched it, and there is no honest account to attach another application's history to.",
  },
  {
    series: "appstore",
    columns: ["day", "bundle", "downloads", "rating"],
    subject: ["bundle"],
    window: "day",
    target: "appstore_sales",
    reason:
      "downloads IS a genuine daily count — but appstore_sales is keyed by the App Store Connect account that fetched it, and rating is a level stamped only on the day it was sampled.",
  },
  {
    series: "users",
    columns: ["day", "app", "total", "new7d"],
    subject: ["app"],
    window: "cumulative",
    target: "activity_user_days",
    reason:
      "total is CUMULATIVE and new7d is a rolling week; activity_user_days holds a day's signups. Differencing a cumulative series across a gap invents the day it was missing.",
  },
  {
    series: "userTotals",
    columns: ["day", "total", "new1d", "new7d", "new30d", "new90d", "partial"],
    subject: [],
    window: "cumulative",
    target: "activity_user_days",
    reason:
      "A portfolio roll-up across products this box measures one at a time, with a `partial` flag meaning the counts are FLOORS. There is no table here whose row means that.",
  },
  {
    series: "uptime",
    columns: ["day", "host", "availability", "avgMs", "certDays"],
    subject: ["host"],
    window: "day",
    target: "uptime_checks",
    reason:
      "uptime_checks holds one CHECK, not a day's summary; these rows are counters accumulated in place, and the average milliseconds covers only the successful checks.",
  },
  {
    series: "github",
    columns: ["day", "repo", "stars", "views", "uniques"],
    subject: ["repo"],
    window: "rolling",
    target: "github_traffic",
    reason:
      "views and uniques are GitHub's ROLLING 14-day counts, so two consecutive rows are two overlapping windows; stars is a level.",
  },
  {
    series: "ads",
    columns: ["day", "ad_id", "campaign", "spend", "impressions", "clicks", "ctr", "frequency", "leads", "cpl"],
    subject: ["ad_id", "campaign"],
    window: "day",
    target: "meta_ad_days",
    reason:
      "Genuinely per-day Meta figures — but spend and cpl carry NO CURRENCY in the export, and meta_ad_days is keyed by the Meta account. A money column whose unit was guessed is worse than no column.",
  },
  {
    series: "backlinks",
    columns: ["day", "site", "score", "sourced", "referringDomains", "inboundLinks"],
    subject: ["site"],
    window: "level",
    target: "backlink_rows",
    reason:
      "Weekly Monday levels, and score is NULL when fewer than four of seven factors had a source — a gap that must stay a gap.",
  },
];

export type HistoryRow = {
  source: string;
  metric: string;
  subject: string;
  period: string;
  window: string;
  value: number;
  unit: string | null;
  reason: string;
};

/**
 * One exported series as rows for `migrate_history`.
 *
 * Each numeric column becomes one metric; `examined` and `dropped` come back
 * beside them so the count on the page can say how many figures were NULL in
 * the source rather than pretending the series was shorter than it is.
 */
export function historyRows(rule: SeriesRule, rows: unknown[]): { rows: HistoryRow[]; examined: number; dropped: number } {
  const out: HistoryRow[] = [];
  let examined = 0;
  let dropped = 0;
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const named: Record<string, unknown> = {};
    rule.columns.forEach((c, i) => { named[c] = raw[i]; });
    const period = typeof named.day === "string" ? named.day : null;
    if (!period) continue;
    const subject = rule.subject.map((s) => String(named[s] ?? "")).filter(Boolean).join(" · ");
    for (const column of rule.columns) {
      if (column === "day" || rule.subject.includes(column)) continue;
      examined += 1;
      const v = named[column];
      /* NULL IS DROPPED AND NEVER STORED AS 0. Half of these columns carry a
         documented "not measured" null — bot views on a site with no
         fingerprint, GitHub traffic on an un-tokened repo, a backlink score
         with too few sources — and a row of 0 for any of them is a
         measurement that never happened. */
      if (typeof v !== "number" || !Number.isFinite(v)) { dropped += 1; continue; }
      out.push({
        source: rule.series,
        metric: column,
        subject,
        period,
        window: rule.window,
        value: v,
        unit: null,
        reason: rule.reason,
      });
    }
  }
  return { rows: out, examined, dropped };
}
