/**
 * ASKING A MODEL WHETHER A SCREENSHOT IS A PICTURE OF A BROKEN PAGE.
 *
 * `integrations/security/shotsqa.ts` decodes the PNG and computes a variance,
 * a dominant-colour share and a set of dimensions, and its own header states
 * the limit of that honestly: "a page that renders perfectly and says the
 * wrong thing passes everything here". A footer sitting on top of a paragraph,
 * a hero image that never loaded, a cookie wall covering the whole viewport —
 * all of those have a perfectly healthy standard deviation. A model looking at
 * the picture is the only thing that catches them, and this is that, with
 * every guard the old header said would have to exist first.
 *
 * THE CAPABILITY IS PROBED, NEVER ASSUMED. `models/provider.ts` still declares
 * nothing about whether the model behind the active provider can see — it
 * cannot, because FreeLLMAPI and a local router both route per request and
 * answer `defaultModel: null`. So this sends ONE tiny image (a 1×1 PNG, about
 * seventy bytes) and reads what comes back: an answer means images are
 * accepted, a 4xx naming the image means they are not, and anything else means
 * we could not tell. The result is cached in `model_vision_probe` per
 * provider+model so the probe costs one call ever rather than one per pass,
 * and `supports: null` — could not tell — is a third state that never reads as
 * either of the other two.
 *
 * OPT-IN PER VENTURE, AND OFF BY DEFAULT. A vision call is a bill, and a
 * dashboard that starts spending because it could is one somebody switches off
 * entirely. The setting is a list of ventures; an empty list is the default
 * and means no venture is looked at.
 *
 * THE ANSWER IS VALIDATED WHOLE OR THROWN AWAY WHOLE. `{ verdict, issues }`
 * with three legal verdicts, issues capped in number and length, every issue
 * needing a `kind` from a closed list, a `where` that names something visible
 * and a numeric confidence. A `broken` with no issue is refused outright:
 * "broken, for reasons we had to delete" is not a smaller verdict, it is a
 * different and worse thing, and the whole value of a red mark is that
 * somebody can be told what is red about it.
 *
 * A VERDICT IS REUSED FOR AN UNCHANGED PICTURE. The key is the SHA-256 of the
 * file's bytes: a weekly capture of a site nobody touched hashes the same,
 * finds its row, and costs nothing. That is a unique index rather than a
 * cache, so it survives a restart and cannot drift.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { db, now, type VentureRow } from "../../db.ts";
import { activeProvider, complete, type VisionTurn } from "../../models/provider.ts";
import { optedIn, settings } from "./settings.ts";

/* ------------------------------------------------------------- the probe */

/** A 1×1 opaque PNG. The smallest thing that is unambiguously an image. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type Capability = {
  /** True — an image was accepted. False — it was refused. Null — the probe
   *  itself did not complete, which is neither. */
  supports: boolean | null;
  provider: string | null;
  model: string | null;
  at: string | null;
  detail: string;
};

const probeKey = (provider: string, model: string | null) => `${provider}|${model ?? "(endpoint picks)"}`;

/** What a refusal of the IMAGE looks like on the wire, as opposed to a refusal
 *  of the request. Matched loosely on purpose — six servers, six wordings —
 *  and only ever used to turn "could not tell" into "no". */
const REFUSED_IMAGE =
  /(image|multimodal|vision|content parts?|image_url|not\s+support|unsupported|invalid[_ ]type)/i;

export function storedCapability(provider: string, model: string | null): Capability | null {
  const row = db
    .prepare("SELECT * FROM model_vision_probe WHERE key = ?")
    .get(probeKey(provider, model)) as { ts: string; supports: number | null; detail: string } | undefined;
  if (!row) return null;
  return {
    supports: row.supports === null ? null : row.supports === 1,
    provider,
    model,
    at: row.ts,
    detail: row.detail,
  };
}

function storeCapability(provider: string, model: string | null, supports: boolean | null, detail: string) {
  db.prepare(
    `INSERT INTO model_vision_probe (key, ts, supports, detail) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, supports = excluded.supports, detail = excluded.detail`,
  ).run(probeKey(provider, model), now(), supports === null ? null : supports ? 1 : 0, detail);
}

/**
 * CAN THE ACTIVE MODEL SEE?
 *
 * Cached forever once it has answered yes or no — the answer is a fact about a
 * model id, and a model id that changes gets its own row. A `null` (could not
 * tell) is NOT cached as an answer: it is stored so the page can say when it
 * was last tried, and `force` or the next explicit probe tries again.
 */
export async function capability(opts: { force?: boolean } = {}): Promise<Capability> {
  const p = activeProvider();
  if (!p)
    return {
      supports: null,
      provider: null,
      model: null,
      at: null,
      detail:
        "No model provider is the default, so there is nothing to ask. Connect one under Integrations and choose it.",
    };
  const model = p.defaultModel;
  const held = storedCapability(p.id, model);
  if (held && !opts.force && held.supports !== null) return held;

  const turns: VisionTurn[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Reply with the single word OK." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL_PNG}` } },
      ],
    },
  ];

  try {
    const reply = await complete(turns, {
      model: model ?? undefined,
      /* One 1x1 pixel: one tile. Declared for the same reason the real call
         declares its own — see `imageTokens`. */
      imageTokens: imageTokens(1, 1),
    });
    const detail =
      `${p.label} accepted a 1×1 PNG on ${reply.model ?? model ?? "the model the endpoint picked"} ` +
      `and answered in ${reply.ms} ms. That proves the request shape is accepted; it does not prove the ` +
      `model looks carefully, which is what the verdicts and their issues are for.`;
    storeCapability(p.id, model, true, detail);
    return { supports: true, provider: p.id, model: reply.model ?? model, at: now(), detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /* A refusal that NAMES the image is a no. Anything else — a timeout, a
       rate limit, a gateway — is "could not tell", and the two must never be
       collapsed: one means never ask again, the other means try later. */
    const refused = REFUSED_IMAGE.test(message);
    const detail = refused
      ? `${p.label} refused an image: ${message.slice(0, 260)}`
      : `The probe did not complete, so nothing is known either way: ${message.slice(0, 260)}`;
    storeCapability(p.id, model, refused ? false : null, detail);
    return { supports: refused ? false : null, provider: p.id, model, at: now(), detail };
  }
}

/* ------------------------------------------------------- the answer's shape */

export const VERDICTS = ["ok", "broken", "unsure"] as const;
export type VisionVerdict = (typeof VERDICTS)[number];

/**
 * The closed list of ISSUE KINDS.
 *
 * A closed list rather than free text for `actions.js`'s reason, applied
 * again: free text produces nine spellings of "the page looks wrong" inside a
 * month, and a column of nine spellings cannot be counted, filtered or
 * compared between two weeks.
 */
export const ISSUE_KINDS = [
  /** Nothing rendered: white, or one flat colour. */
  "blank",
  /** An error or 404 page rather than the site. */
  "error-page",
  /** A spinner, a skeleton, a half-painted app. */
  "loading",
  /** Text on text, a footer over a paragraph, boxes on top of each other. */
  "overlap",
  /** No layout at all: unstyled serif text in one column. */
  "unstyled",
  /** Content running off the edge, or cut through. */
  "overflow",
  /** A modal, cookie wall or banner covering the page. */
  "obscured",
  /** An image or icon that did not load. */
  "missing-media",
  /** Placeholder copy still on the page — lorem ipsum, "your text here". */
  "placeholder",
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export type Issue = { kind: IssueKind; where: string; confidence: number };

export const MAX_ISSUES = 5;
const MAX_WHERE = 160;
const MIN_WHERE = 8;

/** Words that mean a location or a visible thing. An issue's `where` must
 *  carry at least one, which is how a validator checks — cheaply and without a
 *  model — that the model pointed at something rather than hedging. */
const PLACE_WORDS = [
  "top", "bottom", "left", "right", "centre", "center", "header", "footer", "nav",
  "menu", "hero", "banner", "sidebar", "body", "background", "button", "form",
  "field", "image", "logo", "heading", "title", "text", "paragraph", "column",
  "row", "card", "table", "list", "modal", "dialog", "overlay", "page", "screen",
  "corner", "edge", "section", "above", "below", "fold", "middle", "whole",
];

const HEDGE = /\b(may|might|perhaps|possibly|seems? to|appears? to be (?:some|an? issue)|not sure|unclear|could be)\b/i;
const ADDRESSISH = /(https?:\/\/|www\.|@[\w-]+\.[a-z]{2,})/i;

export type Validated =
  | { verdict: VisionVerdict; issues: Issue[]; dropped: string[] }
  | { unreadable: string };

/**
 * THE ANSWER, ALL OR NOTHING ON THE VERDICT.
 *
 * There is no repair round and no partial acceptance. A verdict outside the
 * three is thrown away; a `broken` that survives validation with no issue left
 * is thrown away; an issue that names nothing visible, hedges, or writes an
 * address it cannot have read off a screenshot is dropped and counted.
 */
export function validateVisionAnswer(raw: unknown): Validated {
  let doc: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return { unreadable: "the answer carried no JSON object" };
    try {
      doc = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { unreadable: "the answer's JSON would not parse, so nothing it said could be checked" };
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return { unreadable: "the answer was not a JSON object" };

  const obj = doc as Record<string, unknown>;
  const verdict = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.includes(verdict as VisionVerdict))
    return {
      unreadable: `it answered "${String(obj.verdict ?? "nothing").slice(0, 40)}" where the only verdicts are ${VERDICTS.join(", ")}`,
    };

  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: Issue[] = [];
  const dropped: string[] = [];

  for (const item of rawIssues) {
    if (issues.length >= MAX_ISSUES) {
      dropped.push(`more than ${MAX_ISSUES} issues, which is more than one screenshot can support`);
      break;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      dropped.push("an issue that was not an object");
      continue;
    }
    const it = item as Record<string, unknown>;
    const kind = typeof it.kind === "string" ? it.kind.trim().toLowerCase() : "";
    if (!ISSUE_KINDS.includes(kind as IssueKind)) {
      dropped.push(`an issue of kind "${String(it.kind ?? "none").slice(0, 30)}", which is not one of the ${ISSUE_KINDS.length} kinds`);
      continue;
    }
    const where = typeof it.where === "string" ? it.where.replace(/\s+/g, " ").trim() : "";
    if (where.length < MIN_WHERE) {
      dropped.push(`a ${kind} issue that pointed at nothing`);
      continue;
    }
    if (ADDRESSISH.test(where)) {
      dropped.push(`a ${kind} issue that wrote an address it cannot have read off a screenshot`);
      continue;
    }
    if (HEDGE.test(where)) {
      dropped.push(`a ${kind} issue that hedged instead of observing`);
      continue;
    }
    const low = where.toLowerCase();
    if (!PLACE_WORDS.some((w) => low.includes(w))) {
      dropped.push(`a ${kind} issue that names no part of the page`);
      continue;
    }
    const confidence = typeof it.confidence === "number" && Number.isFinite(it.confidence) ? it.confidence : null;
    if (confidence === null || confidence < 0 || confidence > 1) {
      dropped.push(`a ${kind} issue whose confidence was not a number between 0 and 1`);
      continue;
    }
    if (issues.some((existing) => existing.kind === kind && existing.where === where.slice(0, MAX_WHERE))) continue;
    issues.push({ kind: kind as IssueKind, where: where.slice(0, MAX_WHERE), confidence: Number(confidence.toFixed(2)) });
  }

  /* The rule the whole contract exists for. */
  if (verdict === "broken" && !issues.length)
    return {
      unreadable:
        "it called the page broken and pointed at nothing" +
        (dropped.length ? ` — ${dropped[0]}` : ", giving no issue at all"),
    };

  return { verdict: verdict as VisionVerdict, issues, dropped };
}

/* ------------------------------------------------------------- the prompt */

export const SYSTEM =
  "You are looking at a screenshot of one website's front page, taken by a headless " +
  "browser at 1280x800. It is the top of the page as a visitor on a laptop sees it; " +
  "nothing below the fold is in the picture.\n\n" +
  "Say whether the page is BROKEN. Not whether it is well designed, not whether the " +
  "copy is good. A dated design, a sparse page, a dark theme and an unusual layout " +
  "are somebody's choices and none of them is a fault.\n\n" +
  "RULES\n" +
  "1. Judge only what is visible. You have no traffic, no source code and no idea " +
  "what this site is supposed to look like. Never write a URL, an email address or " +
  "a number you did not read off the picture.\n" +
  "2. An issue names a VISIBLE PART OF THE PAGE and what is wrong with it — " +
  '"the footer sits on top of the last paragraph", "the area below the header is ' +
  'blank white". Never "the page looks off", never a recommendation, never a hedge.\n' +
  "3. `broken` REQUIRES at least one issue. A validator throws away a broken verdict " +
  "with nothing to point at, and the site is then recorded as an unreadable answer " +
  "rather than as a fault.\n" +
  "4. `unsure` is the right answer when something looks wrong and a screenshot cannot " +
  "settle it.\n" +
  "5. Most front pages are fine. `ok` with an empty issues list is the common and " +
  "correct answer; reaching for something to say is the one way to make this useless.\n\n" +
  "Output JSON and nothing else. No prose around it, no markdown fences.";

export function task(name: string, website: string | null): string {
  return (
    `SITE: ${name}${website ? ` (${website})` : ""}\n\n` +
    "Return JSON in EXACTLY this shape:\n\n" +
    '{"verdict":"ok","issues":[]}\n\n' +
    "Field rules:\n" +
    `- verdict: exactly one of ${VERDICTS.join(", ")}. Anything else is thrown away whole.\n` +
    `- issues: at most ${MAX_ISSUES}. Each is {"kind":…,"where":…,"confidence":…}.\n` +
    `  - kind: exactly one of ${ISSUE_KINDS.join(", ")}.\n` +
    `  - where: one clause of at most ${MAX_WHERE} characters naming the part of the ` +
    "page it is about. It must contain a word like header, footer, hero, nav, button, " +
    "image, heading, background, top, bottom, left, right. An issue that names no part " +
    "of the page is dropped.\n" +
    "  - confidence: a number between 0 and 1.\n\n" +
    "Begin with { and end with }."
  );
}

/* ------------------------------------------------------------- the verdict */

export type ShotVisionRow = {
  id: number;
  venture_id: string;
  shot_path: string;
  shot_hash: string;
  shot_ts: string | null;
  ts: string;
  provider: string | null;
  model: string | null;
  verdict: string | null;
  issues: string;
  raw: string | null;
  error: string | null;
};

export const visionRow = (ventureId: string, hash: string): ShotVisionRow | undefined =>
  db
    .prepare("SELECT * FROM shot_vision WHERE venture_id = ? AND shot_hash = ?")
    .get(ventureId, hash) as ShotVisionRow | undefined;

export const latestVision = (ventureId: string): ShotVisionRow | undefined =>
  db
    .prepare("SELECT * FROM shot_vision WHERE venture_id = ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(ventureId) as ShotVisionRow | undefined;

export function readIssues(raw: string | null): Issue[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Issue[]) : [];
  } catch {
    return [];
  }
}

/** How big a PNG this will send. A 1280x800 capture is around 100–300 KB;
 *  two megabytes is a file that is not a screenshot of a front page, and
 *  sending one would be a bill for a mistake. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * WHAT AN IMAGE ACTUALLY COSTS, so the budget does not price it by the byte.
 *
 * `runtime/budgets.ts` reserves a call at the UTF-8 byte length of its turns,
 * which is a good estimate for text and a nonsense one here: a 300 KB
 * screenshot base64s to 400 KB and would reserve four hundred thousand tokens
 * and the dollars to match. With daily token or dollar budgets switched on,
 * every vision call would be refused — and the refusal would surface as "the
 * model did not answer", which sends the owner looking at their provider.
 *
 * So the caller declares what the image is worth instead. The formula is the
 * published tile rule every vision endpoint of this shape uses: a base cost
 * plus one tile-worth per 512x512 block. It is an ESTIMATE and it is
 * deliberately the conservative direction — a model that bills more will
 * report its real usage, which `budgeted` then writes over the reservation.
 */
const IMAGE_BASE_TOKENS = 85;
const IMAGE_TILE_TOKENS = 170;

export function imageTokens(width: number | null, height: number | null): number {
  /* An image whose dimensions could not be read is priced as the largest one
     this will send rather than as a small one. Guessing low is how a budget
     stops being a budget. */
  const w = width && width > 0 ? width : 2048;
  const h = height && height > 0 ? height : 2048;
  return IMAGE_BASE_TOKENS + IMAGE_TILE_TOKENS * Math.ceil(w / 512) * Math.ceil(h / 512);
}

/** Width and height out of a PNG's IHDR, without decoding it. The eight-byte
 *  signature, then a length and a type, then the two 32-bit dimensions. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export type VisionResult = {
  ventureId: string;
  venture: string;
  verdict: VisionVerdict | null;
  issues: Issue[];
  reused: boolean;
  hash: string | null;
  shotPath: string | null;
  shotTs: string | null;
  model: string | null;
  dropped: string[];
  error: string | null;
};

/** The newest picture row of a venture, which is what `brand_rendered IS NULL`
 *  means in `venture_shots` — see that table's migration. */
function newestCapture(ventureId: string): { ts: string; path: string | null; error: string | null } | undefined {
  try {
    /* THE NEWEST SUCCESSFUL ONE, not the newest ROW. capture.ts's own reader
       makes the same distinction: a single failed attempt writes a row with a
       null path, and taking that as "the newest capture" hid a perfectly good
       picture from last week behind "no capture to look at. Press Capture" —
       until a capture happened to succeed. A failure is a fact about the
       attempt, not about what is on disk. */
    return db
      .prepare(
        `SELECT ts, path, error FROM venture_shots
          WHERE venture_id = ? AND brand_rendered IS NULL AND path IS NOT NULL AND error IS NULL
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(ventureId) as { ts: string; path: string | null; error: string | null } | undefined;
  } catch {
    return undefined;
  }
}

/**
 * ONE VENTURE, LOOKED AT.
 *
 * Never throws. Every failure is a result with `verdict: null` and the
 * sentence, because a pass that died on the third of eleven ventures is worth
 * less than no pass at all — shotsqa.ts's rule, applied to the half of it that
 * costs money.
 */
export async function lookAt(v: VentureRow, opts: { force?: boolean } = {}): Promise<VisionResult> {
  const blank: VisionResult = {
    ventureId: v.id,
    venture: v.name,
    verdict: null,
    issues: [],
    reused: false,
    hash: null,
    shotPath: null,
    shotTs: null,
    model: null,
    dropped: [],
    error: null,
  };

  /*
    THE OPT-IN IS CHECKED HERE AS WELL AS AT EVERY CALLER, and the duplication
    is the point. Every caller today filters first, which means the guard is
    one careless caller away from being gone — and what is on the other side of
    it is the site's own screenshot leaving this machine for a third party, at
    the owner's expense. The route keeps its own friendlier refusal; this one
    is the floor under it.
  */
  if (!optedIn(settings().visionVentures, v))
    return {
      ...blank,
      error:
        `${v.name} is not opted in to visual QA, so nothing was sent and nothing was spent. ` +
        `Add its slug to "Vision ventures" under Integrations -> SEO Ops.`,
    };

  const cap = newestCapture(v.id);
  if (!cap?.path)
    return { ...blank, error: "This venture has no capture to look at. Press Capture on its page first." };

  let bytes: Buffer;
  try {
    const stat = statSync(cap.path);
    if (stat.size > MAX_BYTES)
      return {
        ...blank,
        shotPath: cap.path,
        shotTs: cap.ts,
        error: `That capture is ${Math.round(stat.size / 1024)} KB, over the ${MAX_BYTES / 1024} KB ceiling this will send.`,
      };
    bytes = readFileSync(cap.path);
  } catch (err) {
    return {
      ...blank,
      shotPath: cap.path,
      shotTs: cap.ts,
      error: `The capture file could not be read: ${err instanceof Error ? err.message.slice(0, 140) : "unknown error"}. It may have been pruned off disk.`,
    };
  }

  const hash = createHash("sha256").update(bytes).digest("hex");
  const held = visionRow(v.id, hash);
  if (held && held.verdict && !opts.force)
    return {
      ...blank,
      verdict: held.verdict as VisionVerdict,
      issues: readIssues(held.issues),
      reused: true,
      hash,
      shotPath: cap.path,
      shotTs: cap.ts,
      model: held.model,
    };

  const able = await capability();
  if (able.supports !== true)
    return {
      ...blank,
      hash,
      shotPath: cap.path,
      shotTs: cap.ts,
      error:
        able.supports === false
          ? `No visual verdict: the configured model refuses images. ${able.detail}`
          : `No visual verdict: whether the configured model accepts images is not known. ${able.detail}`,
    };

  const turns: VisionTurn[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: task(v.name, v.website) },
        { type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } },
      ],
    },
  ];

  let text: string;
  let model: string | null = null;
  let provider: string | null = null;
  try {
    const size = pngSize(bytes);
    const reply = await complete(turns, { imageTokens: imageTokens(size?.width ?? null, size?.height ?? null) });
    text = reply.text;
    model = reply.model;
    provider = reply.provider;
  } catch (err) {
    const error = `The model did not answer: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`;
    store(v.id, cap.path, hash, cap.ts, null, null, null, [], null, error);
    return { ...blank, hash, shotPath: cap.path, shotTs: cap.ts, error };
  }

  const checked = validateVisionAnswer(text);
  if ("unreadable" in checked) {
    const error = `The model's answer was thrown away whole: ${checked.unreadable}.`;
    store(v.id, cap.path, hash, cap.ts, provider, model, null, [], text.slice(0, 600), error);
    return { ...blank, hash, shotPath: cap.path, shotTs: cap.ts, model, error };
  }

  store(v.id, cap.path, hash, cap.ts, provider, model, checked.verdict, checked.issues, text.slice(0, 600), null);
  return {
    ...blank,
    verdict: checked.verdict,
    issues: checked.issues,
    hash,
    shotPath: cap.path,
    shotTs: cap.ts,
    model,
    dropped: checked.dropped,
  };
}

function store(
  ventureId: string,
  path: string,
  hash: string,
  shotTs: string | null,
  provider: string | null,
  model: string | null,
  verdict: VisionVerdict | null,
  issues: Issue[],
  raw: string | null,
  error: string | null,
) {
  /*
    A ROW WITH A VERDICT IS KEPT — migration 322's own rule, and it used to be
    a comment rather than a constraint. `DO UPDATE` overwrote a good `ok` with
    a NULL the moment a FORCED re-look failed on a provider outage, so a
    verdict somebody paid for was lost to a timeout. The two `COALESCE`s and
    the guard say it properly: a failed attempt records its error and its
    timestamp against the row and leaves the verdict and its issues alone; a
    successful one replaces everything.
  */
  db.prepare(
    `INSERT INTO shot_vision (venture_id, shot_path, shot_hash, shot_ts, ts, provider, model, verdict, issues, raw, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(venture_id, shot_hash) DO UPDATE SET
       ts = excluded.ts,
       provider = COALESCE(excluded.provider, shot_vision.provider),
       model = COALESCE(excluded.model, shot_vision.model),
       verdict = COALESCE(excluded.verdict, shot_vision.verdict),
       issues = CASE WHEN excluded.verdict IS NULL THEN shot_vision.issues ELSE excluded.issues END,
       raw = COALESCE(excluded.raw, shot_vision.raw),
       error = excluded.error,
       shot_path = excluded.shot_path,
       shot_ts = excluded.shot_ts`,
  ).run(ventureId, path, hash, shotTs, now(), provider, model, verdict, JSON.stringify(issues), raw, error);
}
