/**
 * THE IMPORT ITSELF: plan, then apply.
 *
 * TWO PHASES AND THE DRY RUN IS THE FIRST ONE, not a separate code path. That
 * is the whole reason this file is shaped the way it is. A `--dry-run` that
 * printed what a DIFFERENT function would later do is a rehearsal of a play
 * nobody is performing; the counts it prints are only trustworthy if they came
 * from the same reading, the same mapping and the same conflict checks that the
 * real run will use. So `plan()` does everything except write, and `apply()`
 * does nothing except write what `plan()` decided.
 *
 * WHAT A CONFLICT IS AND WHAT HAPPENS TO IT. A venture whose slug already
 * exists here is not an error and not a duplicate: it is the SAME BUSINESS,
 * and the import maps onto it, records `created: 0` in the id map, and says so.
 * A rollback then leaves it alone — see store.ts. A goal document that already
 * has text in it is a conflict of a different kind, because there is one row
 * per scope and the owner's words are in it; that one is SKIPPED and named,
 * because overwriting what somebody typed is not something an importer gets to
 * decide.
 *
 * EVERY ROW CARRIES ITS PROVENANCE. Where the table has a column for it, it is
 * written into the row — `board_cards.origin` is `workdash:card:<id>` (and its
 * UNIQUE index makes a second import a database-level refusal rather than a
 * remembered check), `chief_memory.source` is `workdash`, `chat_messages.
 * backend` is `workdash`. Where it has no such column, the id map is the
 * provenance, and it is complete: nothing is written by an import that does not
 * have a row there.
 *
 * ASSETS ARE COPIED AND NEVER MOVED. The source directory belongs to another
 * application that may still be running; an importer that took its files would
 * be a migration that broke the thing being migrated from.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { db, now } from "../../db.ts";
import { DATA_DIR } from "../../config.ts";
import {
  type CardDraft, type ChatDraft, type MemoryDraft, type OutboxDraft,
  type OutcomeDraft, type StudioDraft, type VentureDraft, type VideoDraft,
  SERIES, cardFrom, chatFrom, goalsMarkdown, historyRows, iso, memoryFrom,
  outboxFrom, outcomeFrom, studioFrom, ventureFrom, videoFrom,
} from "./mapper.ts";
import { type Source, list } from "./workdash.ts";
import { goalTarget, mapped, remember, rememberFile, writeHistory } from "./store.ts";

export const KINDS = ["projects", "history", "board", "chats", "memories", "assets", "workflow"] as const;
export type Kind = (typeof KINDS)[number];

/** What a venture created by an import claims about itself, when WorkDash does
 *  not say. It records no launch stage at all — there is no such field in
 *  `projects-info.json` — so this is a SETTING with a default and never a
 *  constant, and every venture it creates is named in the problems. */
export const DEFAULT_STAGE = "pre-launch";
const STAGES = ["idea", "pre-launch", "launched"];

export type Options = {
  kinds: Kind[];
  stage: string;
  /** WorkDash slug → this box's venture slug or id, or the word "skip". */
  ventureMap: Map<string, string>;
};

export type KindCount = { read: number; imported: number; skipped: number; conflicts: number };
export type Plan = {
  counts: Record<string, KindCount>;
  problems: string[];
  reconnect: string[];
  /* The drafts, carried from plan to apply so the two cannot disagree. */
  ventures: { draft: VentureDraft; existingId: string | null; skip: boolean }[];
  cards: CardDraft[];
  chats: ChatDraft[];
  memories: MemoryDraft[];
  goalText: string | null;
  outcomes: OutcomeDraft[];
  studio: StudioDraft[];
  videos: VideoDraft[];
  outbox: OutboxDraft[];
  history: { source: string; metric: string; subject: string; period: string; window: string; value: number; unit: string | null; reason: string }[];
};

const blank = (): KindCount => ({ read: 0, imported: 0, skipped: 0, conflicts: 0 });

/* --------------------------------------------------------- venture map */

/**
 * `--venture-map` — `workdash-slug = venture` per line, `= skip` to leave one
 * behind, `#` comments.
 *
 * It exists because the two applications' idea of a project does not have to
 * line up, and guessing is the wrong way to resolve that: a WorkDash project
 * called `example.ie` and a venture here called `example-content` are obviously the same
 * business to a person and not to a string compare, and one called `betindex.ai`
 * is the same business as `example-app-12.example.test` only because somebody knows the
 * rename happened. The automatic match — slug, then host — handles the easy
 * ones; this handles the rest, and it is a FILE rather than nineteen prompts
 * because an import is run more than once.
 */
export function parseVentureMap(text: string): { map: Map<string, string>; problems: string[] } {
  const map = new Map<string, string>();
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) {
      problems.push(`“${line.slice(0, 60)}” is not a mapping. Each line is “workdash-slug = venture-slug”, or “workdash-slug = skip”.`);
      continue;
    }
    const from = line.slice(0, eq).trim().toLowerCase();
    const to = line.slice(eq + 1).trim();
    if (!from || !to) {
      problems.push(`“${line.slice(0, 60)}” has an empty side.`);
      continue;
    }
    map.set(from, to);
  }
  return { map, problems };
}

/* ------------------------------------------------------------ existing */

type VentureRow = { id: string; slug: string; host: string | null; name: string };

function ventureRows(): VentureRow[] {
  return db.prepare("SELECT id, slug, host, name FROM ventures").all() as unknown as VentureRow[];
}

/** `v-` and six base36, the same shape routes/ventures.ts mints. */
function newVentureId(taken: Set<string>): string {
  for (;;) {
    const id = `v-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!taken.has(id) && !db.prepare("SELECT 1 FROM ventures WHERE id = ?").get(id)) return id;
  }
}

/**
 * A slug nothing else has, WITHIN THIS PLAN as well as in the database.
 *
 * `ventures.slug` is UNIQUE, and a WorkDash project slug is a DOMAIN whose
 * first label becomes the venture slug — so `foo.ie` and `foo.app`, which is
 * the ordinary shape of one brand on two TLDs, both want `foo`. Checking only
 * the database misses that entirely: both pass `plan()`, the dry run reports
 * two imported, and then the real run takes a backup and dies inside the
 * transaction on a constraint, with a raw SQLite sentence.
 *
 * So the plan carries its own set and suffixes the second one, the way
 * routes/ventures.ts's `uniqueSlug` does for a name typed twice — and the
 * rename is REPORTED, because a business quietly addressed as `foo-2` is a URL
 * somebody will wonder about.
 */
function uniqueSlug(base: string, taken: Set<string>): string {
  const held = (slug: string) =>
    taken.has(slug) || !!db.prepare("SELECT 1 FROM ventures WHERE slug = ?").get(slug);
  if (!held(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 44)}-${n}`;
    if (!held(candidate)) return candidate;
  }
}

/* ---------------------------------------------------------------- plan */

export function plan(source: Source, options: Options): Plan {
  const counts: Record<string, KindCount> = {};
  const problems: string[] = [...source.problems];
  const want = new Set<Kind>(options.kinds);
  const stage = STAGES.includes(options.stage) ? options.stage : DEFAULT_STAGE;
  if (!STAGES.includes(options.stage))
    problems.push(`“${options.stage}” is not a stage. It is one of ${STAGES.join(", ")}; ${DEFAULT_STAGE} was used.`);

  const out: Plan = {
    counts, problems, reconnect: source.reconnect,
    ventures: [], cards: [], chats: [], memories: [],
    goalText: null, outcomes: [], studio: [], videos: [], outbox: [], history: [],
  };

  /* ------------------------------------------------------- projects */

  /** WorkDash slug → this box's venture id, decided once and used by every
   *  other kind. `null` means "deliberately not imported". */
  const ventureFor = new Map<string, string | null>();
  const existing = ventureRows();
  const mintedIds = new Set<string>();
  /* See uniqueSlug: ventures.slug is UNIQUE and two projects can want one. */
  const mintedSlugs = new Set<string>();

  if (want.has("projects")) {
    const c = (counts.projects = blank());
    const projects = (source.docs["projects-info.json"]?.value?.projects ?? {}) as Record<string, unknown>;
    const aliases = (source.docs["projects-info.json"]?.value?.aliases ?? {}) as Record<string, unknown>;

    for (const [slug, raw] of Object.entries(projects)) {
      if (!raw || typeof raw !== "object") continue;
      c.read += 1;
      const draft = ventureFrom(slug, raw as Record<string, unknown>);
      problems.push(...draft.problems);

      const wanted = options.ventureMap.get(slug.toLowerCase());
      if (wanted === "skip") {
        c.skipped += 1;
        ventureFor.set(slug, null);
        problems.push(`${slug} was skipped because the venture map says skip.`);
        continue;
      }

      /* Already mapped by an earlier batch: reuse it and do not count it as
         new work. This is what makes running the importer twice safe. */
      const already = mapped("project", slug);
      if (already) {
        ventureFor.set(slug, already.target_id);
        c.skipped += 1;
        problems.push(`${slug} was already imported as venture ${already.target_id} by batch ${already.batch}.`);
        continue;
      }

      const match = wanted
        ? existing.find((v) => v.slug === wanted || v.id === wanted)
        : existing.find((v) => v.slug === draft.slug) ??
          (draft.host ? existing.find((v) => v.host === draft.host) : undefined);

      if (wanted && !match) {
        c.skipped += 1;
        ventureFor.set(slug, null);
        problems.push(`The venture map sends ${slug} to “${wanted}”, and there is no venture here with that slug or id.`);
        continue;
      }
      if (match) {
        c.conflicts += 1;
        ventureFor.set(slug, match.id);
        out.ventures.push({ draft, existingId: match.id, skip: false });
        problems.push(
          `${slug} matches the venture already here called “${match.name}” (${match.slug}); it was mapped onto it rather than duplicated, and nothing about that venture is changed.`,
        );
        continue;
      }

      const id = newVentureId(mintedIds);
      mintedIds.add(id);
      /* The slug is decided HERE, in the plan, and carried to apply(). Deciding
         it at insert time would mean the dry run's counts describing a run that
         cannot happen. */
      const unique = uniqueSlug(draft.slug, mintedSlugs);
      if (unique !== draft.slug)
        problems.push(
          `${slug} wants the address “${draft.slug}”, which is already taken — two projects on different domains share a first label, or a venture here has it. It is “${unique}” instead; rename it on its venture page if that reads badly.`,
        );
      draft.slug = unique;
      mintedSlugs.add(unique);
      ventureFor.set(slug, id);
      out.ventures.push({ draft, existingId: null, skip: false });
      (draft as VentureDraft & { mintedId?: string }).mintedId = id;
      c.imported += 1;
    }

    const aliasCount = Object.keys(aliases).length;
    if (aliasCount)
      problems.push(
        `WorkDash records ${aliasCount} domain alias(es) — old domains folded onto current slugs at read time. They are NOT imported: this box has one host per venture, and a second one would be a second business on the ventures page.`,
      );
    if (c.imported)
      problems.push(
        `WorkDash records no launch stage, so the ${c.imported} venture(s) this creates are “${stage}”. Set each one on its venture page — the agent's advice is stage-aware.`,
      );
  } else {
    /* Not importing projects does not mean not RESOLVING them: cards, memories
       and studio posts all name a project, and an earlier batch's mapping is
       exactly how they find their venture. */
    for (const slug of Object.keys(
      (source.docs["projects-info.json"]?.value?.projects ?? {}) as Record<string, unknown>,
    ))
      ventureFor.set(slug, mapped("project", slug)?.target_id ?? null);
  }

  const resolveVenture = (slug: string | null): string | null => {
    if (!slug) return null;
    if (ventureFor.has(slug)) return ventureFor.get(slug) ?? null;
    const already = mapped("project", slug);
    if (already) return already.target_id;
    const match = existing.find((v) => v.slug === slug || v.host === slug || v.id === slug);
    return match?.id ?? null;
  };

  /* ---------------------------------------------------------- board */

  if (want.has("board")) {
    const c = (counts.board = blank());
    const columns = list(source, "kanban.json", "columns");
    const names = new Map<string, string>();
    for (const col of columns)
      if (typeof col.id === "string" && typeof col.name === "string") names.set(col.id, col.name);

    const held = new Set(
      (db.prepare("SELECT origin FROM board_cards WHERE origin IS NOT NULL").all() as unknown as { origin: string }[])
        .map((r) => r.origin),
    );
    for (const raw of list(source, "kanban.json", "cards")) {
      c.read += 1;
      const draft = cardFrom(raw);
      if (!draft) { c.skipped += 1; continue; }
      if (held.has(draft.origin)) {
        c.skipped += 1;
        continue;
      }
      problems.push(...draft.problems);
      out.cards.push(draft);
      c.imported += 1;
    }
    if (c.read && c.read !== c.imported + c.skipped) c.skipped = c.read - c.imported;
    const prompt = source.docs["kanban.json"]?.value?.prompt;
    if (typeof prompt === "string" && prompt.trim())
      problems.push(
        `WorkDash's board carries ${prompt.trim().length} characters of board “prompt” — standing instructions for its agent. There is no column for it here; paste it into a memory note or the global goal if it still applies.`,
      );
  }

  /* ---------------------------------------------------------- chats */

  if (want.has("chats")) {
    const c = (counts.chats = blank());
    const held = new Set(
      (db.prepare("SELECT DISTINCT session_id FROM chat_messages").all() as unknown as { session_id: string }[])
        .map((r) => r.session_id),
    );
    for (const raw of list(source, "chats.json", "chats")) {
      c.read += 1;
      const draft = chatFrom(raw);
      if (!draft) { c.skipped += 1; continue; }
      if (held.has(draft.sessionId)) { c.skipped += 1; continue; }
      problems.push(...draft.problems);
      out.chats.push(draft);
      c.imported += 1;
    }
    if (out.chats.length)
      problems.push(
        `WorkDash timestamps a chat and not the messages in it, so every imported message carries its conversation's start time. The ORDER is real; the times within a conversation are not.`,
      );
    if (out.chats.some((ch) => ch.title))
      problems.push(
        `Chat TITLES are not imported. This box keeps session labels in the browser's own workspace preferences, not in the database this writes to — the transcripts are here and the names are not.`,
      );
  }

  /* ------------------------------------------------------- memories */

  if (want.has("memories")) {
    const c = (counts.memories = blank());
    const held = new Set(
      (db.prepare("SELECT id FROM chief_memory").all() as unknown as { id: string }[]).map((r) => r.id),
    );
    for (const raw of list(source, "agent-memory.json", "notes")) {
      c.read += 1;
      const got = memoryFrom(raw);
      if (!got) { c.skipped += 1; continue; }
      if ("skip" in got) { c.skipped += 1; problems.push(got.skip); continue; }
      if (held.has(got.id)) { c.skipped += 1; continue; }
      out.memories.push(got);
      c.imported += 1;
    }
    const brief = source.docs["agent-memory.json"]?.value?.brief;
    if (typeof brief === "string" && brief.trim())
      problems.push(
        `WorkDash's memory “brief” — ${brief.trim().length} characters of the owner's own standing context — is NOT imported. ` +
          `A note here is at most 600 characters and the global goal at most 4,000, and choosing which to cut it into is not an importer's decision. Paste it where it belongs.`,
      );
  }

  /* ------------------------------------------------------- workflow */

  if (want.has("workflow")) {
    const c = (counts.workflow = blank());

    /* Goals: WorkDash's twelve structured records become this box's one
       markdown document, and only if there is nothing there already. */
    const goals = list(source, "goals.json", "goals");
    c.read += goals.length;
    if (goals.length) {
      const text = goalsMarkdown(goals);
      const current = db
        .prepare("SELECT text FROM chief_goals WHERE scope = 'global' AND venture_id = ''")
        .get() as { text: string } | undefined;
      if (current && current.text.trim()) {
        c.conflicts += 1;
        problems.push(
          `There is already a global goal document here with ${current.text.trim().length} characters in it, so WorkDash's ${goals.length} goal(s) were NOT written. Overwriting what somebody typed is not an importer's decision — the rendered version is on this batch's page.`,
        );
      } else if (text) {
        out.goalText = text;
        c.imported += 1;
      }
    }

    /* Outcomes, with their action text looked up out of actions.json. */
    const actions = new Map<string, string>();
    for (const a of list(source, "actions.json", "actions"))
      if (typeof a.id === "string" && typeof a.text === "string") actions.set(a.id, a.text);

    const heldOutcomes = new Set(
      (db.prepare("SELECT id FROM chief_outcomes").all() as unknown as { id: string }[]).map((r) => r.id),
    );
    for (const raw of list(source, "outcomes.json", "outcomes")) {
      c.read += 1;
      const draft = outcomeFrom(raw, actions.get(String(raw.actionId ?? "")) ?? null);
      if (!draft) { c.skipped += 1; continue; }
      if (heldOutcomes.has(draft.id)) { c.skipped += 1; continue; }
      out.outcomes.push(draft);
      c.imported += 1;
    }

    /* Outbox drafts. They need a Gmail account to belong to, because that is
       what mailflow_outbox is keyed by — the address a mail would be sent FROM
       is a property of a mailbox and not of a draft. */
    const gmail = db
      .prepare("SELECT id, label FROM plugin_accounts WHERE plugin_id = 'gmail' ORDER BY id LIMIT 1")
      .get() as { id: number; label: string } | undefined;
    const items = list(source, "outbox.json", "items");
    c.read += items.length;
    if (items.length && !gmail) {
      c.skipped += items.length;
      problems.push(
        `${items.length} outbox draft(s) were NOT imported: this box's outbox is keyed by the Gmail account a mail would be sent FROM, and no Gmail account is connected. Connect one and run the import again with --only workflow.`,
      );
    } else if (items.length) {
      const heldOutbox = new Set(
        (db.prepare("SELECT to_address, subject FROM mailflow_outbox").all() as unknown as {
          to_address: string; subject: string;
        }[]).map((r) => `${r.to_address}|${r.subject}`),
      );
      for (const raw of items) {
        const draft = outboxFrom(raw);
        if (!draft) { c.skipped += 1; continue; }
        if (mapped("outbox", draft.sourceId)) { c.skipped += 1; continue; }
        if (heldOutbox.has(`${draft.to}|${draft.subject}`)) { c.skipped += 1; continue; }
        problems.push(...draft.problems);
        out.outbox.push(draft);
        c.imported += 1;
      }
      problems.push(
        `Outbox drafts were imported against the Gmail account “${gmail!.label}”, because a draft has to belong to the mailbox it would be sent from. ` +
          `Anything already SENT in WorkDash arrives marked sent and nothing re-sends it; anything APPROVED there arrives as a draft, because an approval here is the exact bytes that were agreed to and this box was never shown them.`,
      );
    }
  }

  /* --------------------------------------------------------- assets */

  if (want.has("assets")) {
    const c = (counts.assets = blank());
    const heldPosts = new Set(
      (db.prepare("SELECT id FROM studio_posts").all() as unknown as { id: string }[]).map((r) => r.id),
    );
    for (const raw of list(source, "studio.json", "drafts")) {
      c.read += 1;
      const draft = studioFrom(raw);
      if (!draft) { c.skipped += 1; continue; }
      if (heldPosts.has(draft.id)) { c.skipped += 1; continue; }
      const venture = resolveVenture(draft.ventureSource);
      if (!venture) {
        c.skipped += 1;
        problems.push(`studio draft ${draft.sourceId} is for “${draft.ventureSource}”, which is not a venture here; a studio post must belong to one, so it was skipped.`);
        continue;
      }
      out.studio.push(draft);
      c.imported += 1;
    }

    const heldVideos = new Set(
      (db.prepare("SELECT run_id FROM video_jobs").all() as unknown as { run_id: string }[]).map((r) => r.run_id),
    );
    for (const raw of list(source, "studio.json", "ugc")) {
      c.read += 1;
      const draft = videoFrom(raw);
      if (!draft) { c.skipped += 1; continue; }
      if (heldVideos.has(draft.runId)) { c.skipped += 1; continue; }
      out.videos.push(draft);
      c.imported += 1;
    }

    const refs = list(source, "studio.json", "refs").length;
    const logos = list(source, "studio.json", "logos").length;
    if (refs || logos)
      problems.push(
        `WorkDash holds ${refs} reference image(s) and ${logos} logo(s) under studio/refs and studio/logos. There is no table for either here — this box measures a venture's brand from its live site — so they are not imported. The files are still in the source directory.`,
      );
    if (!source.assets.studio)
      problems.push("There is no studio/ directory beside the state files, so no post images could be copied — the rows will carry no image.");
  }

  /* -------------------------------------------------------- history */

  if (want.has("history")) {
    const c = (counts.history = blank());
    if (!source.history) {
      problems.push(source.historyNote ?? "No exported history was found.");
    } else {
      for (const rule of SERIES) {
        const rows = source.history[rule.series];
        if (!Array.isArray(rows) || !rows.length) continue;
        const made = historyRows(rule, rows);
        /* `read` counts FIGURES and not rows, so the three columns are
           comparable: one exported row of `revenue` carries seven numbers, and
           a table where read was 5 and imported was 35 reads like a bug. */
        c.read += made.examined;
        c.imported += made.rows.length;
        c.skipped += made.dropped;
        out.history.push(...made.rows);
      }
      if (counts.history!.skipped)
        problems.push(
          `${counts.history!.skipped} figure(s) were NULL in the export and were dropped rather than stored as 0. ` +
            `Half of these columns carry a documented "not measured" null — bot views on a site with no fingerprint, GitHub traffic on an un-tokened repo, a backlink score with too few sources — and a zero for any of them is a measurement that never happened.`,
        );
      problems.push(
        `Every one of these ${out.history.length} figure(s) went into migrate_history and NOT into a live table. ` +
          `Two independent reasons, either fatal on its own: this box's daily tables (stripe, umami, play, app store) are keyed by the plugin ACCOUNT that fetched them, and imported history has no such account; ` +
          `and the one that is not — gsc_days — holds a day's clicks where WorkDash's search rows are Google's ROLLING 28-DAY totals, which would multiply every figure on the search page by about twenty-eight. ` +
          `Each row carries its own reason. Nothing joins them into a chart.`,
      );
    }
  }

  return out;
}

/* --------------------------------------------------------------- apply */

export type Applied = { counts: Record<string, KindCount>; problems: string[]; files: number };

/**
 * The writes, in one transaction, in dependency order.
 *
 * ONE TRANSACTION FOR EVERYTHING. An import that created nineteen ventures and
 * then failed on a card would leave a database that neither the batch record
 * nor the rollback describes.
 *
 * FILES ARE THE PART A TRANSACTION CANNOT COVER, so they are handled around it
 * rather than inside it. A `copyFileSync` is not rolled back by `ROLLBACK`, and
 * neither is the `migrate_files` row that would have named it — so a failure
 * after the copies would have rolled the RECORDS back and left the BYTES in
 * data/studio, invisible to any rollback and contradicting the CLI's own
 * "NOTHING was written". So: the copies are made first and remembered in a
 * local list; on COMMIT that list becomes the migrate_files rows; on any
 * failure the files are UNLINKED before the error is rethrown, and the
 * directory is left exactly as it was found.
 */
/**
 * A file name out of the source document, as a name and nothing else.
 *
 * `studio.json` is a JSON file in a directory somebody points this at, so its
 * `image` field is untrusted the way any file is: `"../../../etc/hosts"` joined
 * onto the studio directory and resolved reaches outside it, and the copy would
 * then be served by `GET /api/studio/posts/:id/image` to anybody who can reach
 * this box. The fix is that a name is a NAME — one path segment, no separators,
 * no `..` — and anything else is refused by name rather than sanitised, because
 * a traversal that got quietly rewritten into a valid filename is a traversal
 * nobody ever hears about.
 */
export function safeName(name: string): string | null {
  const clean = name.trim();
  if (!clean || clean === "." || clean === "..") return null;
  if (clean.includes("/") || clean.includes("\\") || clean.includes("\u0000")) return null;
  if (basename(clean) !== clean) return null;
  return clean;
}

export function apply(p: Plan, batchId: string, source: Source, stage: string): Applied {
  const problems: string[] = [];
  const ts = now();

  const ventureIdFor = new Map<string, string>();

  /* Copies made but not yet recorded. See this function's header: on COMMIT
     these become migrate_files rows; on failure they are unlinked. */
  const copied: { path: string; sourcePath: string; bytes: number; targetKind: string; targetId: string }[] = [];

  const copy = (dir: string | null, name: string | null, into: string, kind: string, id: string): string | null => {
    if (!dir || !name) return null;
    const safe = safeName(name);
    if (!safe) {
      problems.push(
        `${kind} ${id} names its file “${name}”, which is a path and not a file name. Nothing was copied — a name that walks out of the source directory is refused rather than trimmed.`,
      );
      return null;
    }
    const src = resolve(join(dir, safe));
    if (!existsSync(src)) {
      problems.push(`${safe} is named by ${kind} ${id} and is not in the source directory; the row was imported without it.`);
      return null;
    }
    mkdirSync(into, { recursive: true });
    /* Prefixed, so an imported file cannot land on top of one this box
       generated with the same timestamp-derived name. */
    const target = join(into, `wd-${safe}`);
    try {
      copyFileSync(src, target);
      copied.push({ path: target, sourcePath: src, bytes: statSync(target).size, targetKind: kind, targetId: id });
      return target;
    } catch (err) {
      problems.push(`${safe} could not be copied: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  /** Everything this run put on disk, taken back off it. Called on any failure
   *  before the error is rethrown, so "nothing was written" is true of the
   *  filesystem as well as of the database. */
  const undoCopies = () => {
    for (const f of copied) {
      try {
        rmSync(f.path, { force: true });
      } catch {
        /* Reported through the thrown error's context rather than swallowed
           into a problems list nobody will read: the caller is about to die. */
      }
    }
  };

  db.exec("BEGIN");
  try {
    /* -------------------------------------------------------- ventures */
    const position = (
      db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM ventures").get() as { p: number }
    ).p;
    let next = position + 1;
    const COLORS = ["#635bff", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];

    for (const entry of p.ventures) {
      const { draft, existingId } = entry;
      if (existingId) {
        ventureIdFor.set(draft.sourceId, existingId);
        remember({ sourceKind: "project", sourceId: draft.sourceId, targetKind: "venture", targetId: existingId, batch: batchId, created: false });
        continue;
      }
      const id = (draft as VentureDraft & { mintedId?: string }).mintedId!;
      db.prepare(
        `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,'default',?, '{}', ?, ?)`,
      ).run(id, draft.slug, draft.name, draft.description, draft.website, draft.host, stage, COLORS[next % COLORS.length]!, next, ts, ts);
      next += 1;
      ventureIdFor.set(draft.sourceId, id);
      remember({ sourceKind: "project", sourceId: draft.sourceId, targetKind: "venture", targetId: id, batch: batchId, created: true });
    }

    const venture = (slug: string | null): string | null => {
      if (!slug) return null;
      return ventureIdFor.get(slug) ?? mapped("project", slug)?.target_id ?? null;
    };

    /* ------------------------------------------------------------ board */
    const columns = new Map(
      (db.prepare("SELECT id, key FROM board_columns").all() as unknown as { id: number; key: string }[])
        .map((r) => [r.key, r.id] as const),
    );
    for (const card of p.cards) {
      const columnId = columns.get(card.columnKey) ?? columns.get("backlog");
      if (!columnId) {
        problems.push(`card ${card.sourceId} had nowhere to go: this board has no Backlog column.`);
        continue;
      }
      const result = db.prepare(
        `INSERT INTO board_cards (column_id, position, title, body, venture_id, urgency, due, done_at, created_at, updated_at, archived_at, origin)
         VALUES (?,?,?,?,?,?,NULL,?,?,?,NULL,?)`,
      ).run(columnId, card.position, card.title, card.body, venture(card.ventureSource), card.urgency, card.doneAt, card.createdAt, card.updatedAt, card.origin);
      remember({ sourceKind: "card", sourceId: card.sourceId, targetKind: "board_card", targetId: String(result.lastInsertRowid), batch: batchId, created: true });
    }

    /* ------------------------------------------------------------ chats */
    const message = db.prepare(
      `INSERT INTO chat_messages (session_id, ts, role, content, backend, channel, model, prompt_tokens, completion_tokens, ms, tools, partial)
       VALUES (?,?,?,?,'workdash','web',?,NULL,NULL,NULL,NULL,0)`,
    );
    for (const chat of p.chats) {
      for (const m of chat.messages) message.run(chat.sessionId, m.ts, m.role, m.content, m.model);
      remember({ sourceKind: "chat", sourceId: chat.sourceId, targetKind: "chat_session", targetId: chat.sessionId, batch: batchId, created: true });
    }

    /* --------------------------------------------------------- memories */
    for (const note of p.memories) {
      db.prepare(
        `INSERT INTO chief_memory (id, text, scope, venture_id, source, created_at, last_confirmed_at)
         VALUES (?,?,?,?,'workdash',?,?)`,
      ).run(note.id, note.text, venture(note.ventureSource) ? note.scope : "global", venture(note.ventureSource) ?? "", note.createdAt, note.lastConfirmedAt);
      remember({ sourceKind: "memory", sourceId: note.sourceId, targetKind: "memory", targetId: note.id, batch: batchId, created: true });
    }

    /* ---------------------------------------------------------- goals */
    if (p.goalText) {
      db.prepare(
        `INSERT INTO chief_goals (scope, venture_id, text, updated_at) VALUES ('global','',?,?)
         ON CONFLICT(scope, venture_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
      ).run(p.goalText, ts);
      remember({ sourceKind: "goals", sourceId: "global", targetKind: "goal", targetId: goalTarget("global", ""), batch: batchId, created: true });
    }

    /* -------------------------------------------------------- outcomes */
    for (const o of p.outcomes) {
      db.prepare(
        `INSERT INTO chief_outcomes (id, title, venture_id, action_kind, action_ref, action_text, action_at, skill, view, params, path, unit, created_at, closed_at)
         VALUES (?,?,?,'note',?,?,?,'migrate','imported','{}','',?,?,?)`,
      ).run(o.id, o.title, venture(o.ventureSource) ?? "", o.actionRef, o.actionText, o.actionAt, o.unit, ts, ts);
      for (const r of o.readings)
        db.prepare(
          "INSERT INTO chief_outcome_readings (outcome_id, ts, kind, day_offset, value, error, raw) VALUES (?,?,?,NULL,?,NULL,?)",
        ).run(o.id, r.ts, r.kind, r.value, o.note);
      remember({ sourceKind: "outcome", sourceId: o.sourceId, targetKind: "outcome", targetId: o.id, batch: batchId, created: true });
    }

    /* --------------------------------------------------------- outbox */
    const gmail = db
      .prepare("SELECT id FROM plugin_accounts WHERE plugin_id = 'gmail' ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    for (const item of p.outbox) {
      if (!gmail) break;
      const result = db.prepare(
        `INSERT INTO mailflow_outbox (account_id, to_address, subject, body, in_reply_to, venture, status, created_by, created_at)
         VALUES (?,?,?,?,NULL,NULL,?,'agent',?)`,
      ).run(gmail.id, item.to, item.subject, item.body, item.status, item.createdAt);
      remember({ sourceKind: "outbox", sourceId: item.sourceId, targetKind: "outbox", targetId: String(result.lastInsertRowid), batch: batchId, created: true });
    }

    /* --------------------------------------------------------- assets */
    for (const post of p.studio) {
      const target = venture(post.ventureSource);
      if (!target) continue;
      const image = copy(source.assets.studio, post.imageFile, join(DATA_DIR, "studio"), "studio_post", post.id);
      db.prepare(
        `INSERT INTO studio_posts (id, venture_id, ts, brief, platform, format, caption, hashtags, image_prompt, image_path, model, ms, error)
         VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL,NULL,?)`,
      ).run(post.id, target, post.ts, post.brief, post.platform, post.format, post.caption, post.imagePrompt, image, post.error);
      remember({ sourceKind: "studio", sourceId: post.sourceId, targetKind: "studio_post", targetId: post.id, batch: batchId, created: true });
    }

    for (const v of p.videos) {
      const file = copy(source.assets.ugc, v.videoFile, join(DATA_DIR, "video"), "video_job", v.runId);
      db.prepare(
        `INSERT INTO video_jobs (run_id, venture_id, format, ts, aspect, width, height, script, assets, duration_s, bytes, path, captions, narration, transcript, error)
         VALUES (?,?,?,?,'9:16',NULL,NULL,'{}','[]',NULL,?,?,NULL,?,NULL,?)`,
      ).run(
        v.runId, venture(v.ventureSource), v.format, v.ts,
        file ? statSync(file).size : null, file, v.narration, v.error,
      );
      remember({ sourceKind: "ugc", sourceId: v.sourceId, targetKind: "video_job", targetId: v.runId, batch: batchId, created: true });
    }

    /* -------------------------------------------------------- history */
    for (const h of p.history) writeHistory({ batch: batchId, ...h });

    /* THE FILE RECORDS ARE THE LAST WRITE IN THE TRANSACTION. The bytes are
       already on disk; this is what makes them findable by a rollback, and it
       is inside the COMMIT so that a database that knows about the import knows
       about its files too. */
    for (const f of copied) rememberFile({ batch: batchId, ...f });

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    undoCopies();
    throw err;
  }

  return { counts: p.counts, problems, files: copied.length };
}

/** The kinds a `--only` list names, or all of them. */
export function parseKinds(value: string | null): { kinds: Kind[]; problems: string[] } {
  if (!value) return { kinds: [...KINDS], problems: [] };
  const problems: string[] = [];
  const kinds: Kind[] = [];
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    if ((KINDS as readonly string[]).includes(part)) kinds.push(part as Kind);
    else problems.push(`“${part}” is not a kind. They are: ${KINDS.join(", ")}.`);
  }
  return { kinds, problems };
}

export { iso };
