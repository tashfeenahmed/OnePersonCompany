/**
 * THE ASSET LIBRARY — a venture's own pictures, kept so a post can look like
 * it came from that business.
 *
 * WHY A LIBRARY AND NOT A LONGER PROMPT. The Studio names a venture's MEASURED
 * hexes in its image prompt, and that is where brand consistency stops: a
 * diffusion model given "#44AA44" makes a green picture, not this business's
 * mark. The only thing that carries a logo is the logo, and the only thing
 * that carries a house style is a picture of it. So the owner uploads a file
 * once and reuses it, which is exactly the relationship a post does not have
 * with its own image.
 *
 * THREE KINDS AND THEY ARE NOT INTERCHANGEABLE. A `logo` is the mark and is
 * usually the wrong thing to hand a generative model, which will happily
 * redraw it slightly wrong; a `reference` is a look to imitate; a `screenshot`
 * is the product itself. The kind is stored so a caller can pick the right one
 * rather than the newest one.
 *
 * ------------------------------------------------------------------------
 * WHETHER A REFERENCE CAN BE USED AT ALL DEPENDS ON THE MODEL, AND THAT IS
 * ASKED RATHER THAN ASSUMED.
 *
 * The Studio's default image model, flux-schnell, takes a prompt and nothing
 * else: handing it a reference image is not a thing the API supports, and a
 * feature that silently dropped the reference would be worse than one that
 * refuses it. Other models on Replicate do take an image — under half a dozen
 * different field names.
 *
 * So `modelImageInput()` reads the MODEL'S OWN OPENAPI SCHEMA from Replicate
 * and looks for an input property that takes a file. That is a measurement,
 * not a table of model names this file would have to keep up to date, and its
 * three-valued answer is the point: supported with a field name, not
 * supported, or NOT CHECKED because Replicate is not connected or did not
 * answer. A caller that cannot pass an image is told so and falls back to a
 * textual description of the reference, which is honest and much weaker, and
 * says which of the two happened.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, now, ventureRowById } from "../../db.ts";
import { REPLICATE_API, tokenAccounts } from "../../providers/replicate.ts";
import { imageDimensions } from "../../tools/chrome.ts";
import { STUDIO_DIR } from "../ventures/studio.ts";
import { sniff } from "./items.ts";

/** Under the Studio's own directory, because these are Studio inputs and a
 *  backup that took one and not the other would restore a library of prompts
 *  pointing at nothing. */
export const ASSETS_DIR = resolve(STUDIO_DIR, "assets");

/** 12 MB, the same ceiling the Studio puts on a rendered image. A reference
 *  bigger than that is a photograph nobody meant to upload. */
export const UPLOAD_CAP = 12 * 1024 * 1024;

const KINDS = ["logo", "reference", "screenshot", "other"] as const;
export type AssetKind = (typeof KINDS)[number];

export const ASSET_KINDS: readonly AssetKind[] = KINDS;

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export type AssetRow = {
  id: string;
  venture_id: string;
  kind: string;
  name: string | null;
  path: string;
  mime: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  source: string;
  source_url: string | null;
  prompt: string | null;
  notes: string | null;
  sha256: string | null;
  used_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export function assetRow(id: string): AssetRow | undefined {
  return db.prepare("SELECT * FROM venture_assets WHERE id = ?").get(id) as AssetRow | undefined;
}

export function assetRows(ventureId?: string | null, kind?: string | null): AssetRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (ventureId) {
    where.push("venture_id = ?");
    args.push(ventureId);
  }
  if (kind) {
    where.push("kind = ?");
    args.push(kind);
  }
  return db
    .prepare(
      `SELECT * FROM venture_assets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 300`,
    )
    .all(...args) as unknown as AssetRow[];
}

export function shapeAsset(r: AssetRow) {
  return {
    id: r.id,
    ventureId: r.venture_id,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    source: r.source,
    sourceUrl: r.source_url,
    prompt: r.prompt,
    notes: r.notes,
    /** Whether the bytes are still there. A row whose file has gone is drawn
     *  as such rather than as a broken image. */
    onDisk: existsSync(r.path),
    url: `/api/publishing/assets/${r.id}/file`,
    usedCount: r.used_count,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}

export type AddResult = { ok: true; asset: AssetRow } | { ok: false; error: string };

/**
 * Store one file against one venture.
 *
 * THE TYPE COMES FROM THE BYTES, NOT THE UPLOAD'S CLAIM. A browser's
 * `Content-Type` on a multipart part is whatever the operating system guessed
 * from the extension; the magic numbers are the fact, and Instagram's
 * JPEG-only rule downstream is decided on it.
 */
export function addAsset(input: {
  ventureId: string;
  kind: string;
  bytes: Uint8Array;
  name?: string | null;
  source: "upload" | "url" | "extracted";
  sourceUrl?: string | null;
  prompt?: string | null;
  notes?: string | null;
}): AddResult {
  if (!ventureRowById(input.ventureId)) return { ok: false, error: `There is no venture ${input.ventureId}.` };
  const kind = (KINDS as readonly string[]).includes(input.kind) ? input.kind : "other";
  if (!input.bytes.byteLength) return { ok: false, error: "The file was empty." };
  if (input.bytes.byteLength > UPLOAD_CAP)
    return {
      ok: false,
      error: `That is ${Math.round(input.bytes.byteLength / 1024 / 1024)} MB; the cap is ${UPLOAD_CAP / 1024 / 1024} MB.`,
    };
  const mime = sniff(input.bytes);
  if (!mime || !ACCEPTED.includes(mime))
    return { ok: false, error: `That is not a PNG, JPEG, WebP or GIF image (its bytes read as ${mime ?? "something else"}).` };

  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime]!;
  const id = `a-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve(ASSETS_DIR, input.ventureId.replace(/[^A-Za-z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${id}.${ext}`);
  writeFileSync(path, input.bytes);

  /* PNG and JPEG only, which is what `imageDimensions` reads. A WebP or GIF is
     stored with null dimensions rather than with a guess: null means "not
     measured" everywhere this is shown. */
  const size = imageDimensions(input.bytes);
  const ts = now();
  db.prepare(
    `INSERT INTO venture_assets
       (id, venture_id, kind, name, path, mime, bytes, width, height, source,
        source_url, prompt, notes, sha256, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.ventureId,
    kind,
    (input.name ?? "").slice(0, 120) || null,
    path,
    mime,
    input.bytes.byteLength,
    size?.width ?? null,
    size?.height ?? null,
    input.source,
    input.sourceUrl ?? null,
    (input.prompt ?? "").slice(0, 600).trim() || null,
    (input.notes ?? "").slice(0, 600).trim() || null,
    createHash("sha256").update(input.bytes).digest("hex"),
    ts,
    ts,
  );
  return { ok: true, asset: assetRow(id)! };
}

/**
 * A reference from a URL: this box downloads it once and keeps the bytes.
 *
 * A URL is a promise somebody else can break — the picture that inspired a
 * look should survive that site's next redeploy — and it is also somebody
 * else's copyright, which is why `source` records that this came off the web
 * rather than out of the owner's own folder.
 */
/**
 * IS THIS ADDRESS ON THE PUBLIC INTERNET?
 *
 * WHY THIS EXISTS. `import_asset` is a NON-DESTRUCTIVE skill action, so an
 * agent may call it as often as it likes, and it makes this server fetch a URL
 * somebody else chose. Without a check that is a request forger and a working
 * internal port scanner: the HTTP status and the error name come back either
 * way, so `http://192.168.1.1/` answering at all is information, and anything
 * on this machine's own loopback — including this very API, whose /api surface
 * has no auth on a box with no password — is one line away.
 *
 * SO THE HOST IS RESOLVED AND EVERY ADDRESS IT RESOLVES TO IS CHECKED, rather
 * than the hostname being pattern-matched. `localhost` is a name, `127.0.0.1`
 * is a literal, `2130706433` is the same address as an integer and
 * `internal.example.com` may be an A record pointing at 10.0.0.5 — all four are
 * the same request, and only the resolved address tells them apart.
 *
 * WHAT IT CANNOT CLOSE, said plainly rather than implied: this resolves, then
 * fetches, and the name could in principle answer differently the second time
 * (a DNS rebind). Closing that needs a connection-level hook this runtime does
 * not expose to `fetch`. What is closed is every accidental and every casual
 * case, and redirects are followed MANUALLY so a public host cannot bounce the
 * fetch onto a private one — which is the version of this that actually gets
 * used.
 */
const PRIVATE_V4 = [
  { net: "0.", why: "this network" },
  { net: "10.", why: "a private range" },
  { net: "127.", why: "this machine" },
  { net: "169.254.", why: "link-local, where cloud metadata services live" },
  { net: "192.168.", why: "a private range" },
];

export function publicAddress(ip: string): { ok: boolean; why: string } {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    for (const p of PRIVATE_V4) if (v4.startsWith(p.net)) return { ok: false, why: p.why };
    const [a, b] = v4.split(".").map(Number) as [number, number];
    /* 172.16.0.0/12 and the carrier-grade NAT range 100.64.0.0/10 need the
       second octet, so they are not prefix strings. */
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, why: "a private range" };
    if (a === 100 && b >= 64 && b <= 127) return { ok: false, why: "a carrier-grade NAT range" };
    if (a >= 224) return { ok: false, why: "a multicast or reserved range" };
    return { ok: true, why: "" };
  }
  const v6 = ip.toLowerCase().split("%")[0]!;
  if (v6 === "::1" || v6 === "::") return { ok: false, why: "this machine" };
  if (/^f[cd]/.test(v6)) return { ok: false, why: "a unique-local address" };
  if (/^fe[89ab]/.test(v6)) return { ok: false, why: "link-local" };
  return { ok: true, why: "" };
}

/** Every address this host resolves to must be public. One private answer is
 *  a refusal, because a name that resolves to both is a name that can be made
 *  to answer with either. */
async function hostIsPublic(hostname: string): Promise<{ ok: boolean; error?: string }> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = publicAddress(bare);
  if (/^[\d.]+$/.test(bare) || bare.includes(":"))
    return literal.ok
      ? { ok: true }
      : { ok: false, error: `${bare} is ${literal.why}. This only fetches from the public internet.` };
  let addresses: { address: string }[];
  try {
    addresses = await lookup(bare, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: `“${bare}” did not resolve.` };
  }
  if (!addresses.length) return { ok: false, error: `“${bare}” resolved to nothing.` };
  for (const a of addresses) {
    const verdict = publicAddress(a.address);
    if (!verdict.ok)
      return {
        ok: false,
        error:
          `“${bare}” resolves to ${a.address}, which is ${verdict.why}. This only fetches ` +
          "from the public internet — upload the file instead.",
      };
  }
  return { ok: true };
}

/** How many redirects are followed by hand. Three is more than any image host
 *  needs and few enough that a redirect loop is a refusal rather than a hang. */
const MAX_HOPS = 3;

export async function addAssetFromUrl(input: {
  ventureId: string;
  kind: string;
  url: string;
  name?: string | null;
  prompt?: string | null;
  notes?: string | null;
}): Promise<AddResult> {
  let url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Paste an http(s) image URL." };

  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "That is not a URL this can read." };
    }
    /* CHECKED ON EVERY HOP, not only the first: a public host that 302s to
       http://127.0.0.1/ is the whole trick, and `redirect: "follow"` would
       have taken it silently. */
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return { ok: false, error: `${parsed.protocol} is not a scheme this fetches.` };
    const allowed = await hostIsPublic(parsed.hostname);
    if (!allowed.ok) return { ok: false, error: allowed.error! };

    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "manual" });
    } catch (err) {
      return { ok: false, error: `Could not fetch it (${err instanceof Error ? err.name : "Error"}).` };
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { ok: false, error: `That URL answered HTTP ${res.status} with no location.` };
      url = new URL(next, url).toString();
      res = null;
      continue;
    }
    break;
  }
  if (!res) return { ok: false, error: `That URL redirected more than ${MAX_HOPS} times.` };
  if (!res.ok) return { ok: false, error: `That URL answered HTTP ${res.status}.` };

  /* THE DECLARED LENGTH IS CHECKED BEFORE THE BODY IS READ, so a hostile URL
     cannot make this allocate a gigabyte to be told afterwards that it was too
     big. A server that declares nothing is still bounded by the cap below,
     which is checked against what actually arrived. */
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > UPLOAD_CAP)
    return {
      ok: false,
      error: `That URL declares ${Math.round(declared / 1024 / 1024)} MB; the cap is ${UPLOAD_CAP / 1024 / 1024} MB.`,
    };

  const bytes = new Uint8Array(await res.arrayBuffer());
  return addAsset({
    ...input,
    bytes,
    source: "url",
    sourceUrl: url,
    name: input.name ?? (url.split("/").pop() ?? "").split("?")[0]?.slice(0, 120) ?? null,
  });
}

export function removeAsset(id: string): { ok: boolean; error?: string } {
  const row = assetRow(id);
  if (!row) return { ok: false, error: "No asset by that id." };
  try {
    if (existsSync(row.path)) unlinkSync(row.path);
  } catch {
    /* a file that will not delete is not a reason to keep the row */
  }
  db.prepare("DELETE FROM venture_assets WHERE id = ?").run(id);
  return { ok: true };
}

export function updateAsset(
  id: string,
  patch: { kind?: string; name?: string | null; prompt?: string | null; notes?: string | null },
): AddResult {
  const row = assetRow(id);
  if (!row) return { ok: false, error: "No asset by that id." };
  if (patch.kind !== undefined && !(KINDS as readonly string[]).includes(patch.kind))
    return { ok: false, error: `A kind is one of ${KINDS.join(", ")}.` };
  db.prepare(
    `UPDATE venture_assets
        SET kind = COALESCE(?, kind), name = COALESCE(?, name),
            prompt = COALESCE(?, prompt), notes = COALESCE(?, notes), updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.kind ?? null,
    patch.name === undefined ? null : (patch.name ?? "").slice(0, 120) || null,
    patch.prompt === undefined ? null : (patch.prompt ?? "").slice(0, 600) || null,
    patch.notes === undefined ? null : (patch.notes ?? "").slice(0, 600) || null,
    now(),
    id,
  );
  return { ok: true, asset: assetRow(id)! };
}

export function markUsed(ids: string[]) {
  const ts = now();
  for (const id of ids)
    db.prepare(
      "UPDATE venture_assets SET used_count = used_count + 1, last_used_at = ? WHERE id = ?",
    ).run(ts, id);
}

/** The bytes and the type, for the route that serves them. Only ids already in
 *  the table are served, so a path cannot be traversed into. */
export function assetFile(id: string): { bytes: Uint8Array; mime: string } | null {
  const row = assetRow(id);
  if (!row) return null;
  try {
    const buf = readFileSync(row.path);
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mime: row.mime };
  } catch {
    return null;
  }
}

/**
 * What a selected asset travels to the image model as.
 *
 * A DATA URL, NOT A PATH AND NOT A LINK. Replicate fetches file inputs itself
 * and cannot reach this machine; a `data:` URI is accepted by its API and is
 * the only form that works from a box on a domestic connection. It is also why
 * the upload cap matters: the whole file goes into a request body.
 */
export function assetAsDataUrl(id: string): string | null {
  const row = assetRow(id);
  if (!row) return null;
  try {
    const bytes = readFileSync(row.path);
    if (bytes.length > UPLOAD_CAP) return null;
    return `data:${row.mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** A sentence describing an asset, for the models that cannot be handed one. */
export function assetAsText(row: AssetRow): string {
  const parts = [
    row.kind === "logo"
      ? "the business's own logo"
      : row.kind === "screenshot"
        ? "a screenshot of the product"
        : "a reference picture",
  ];
  if (row.name) parts.push(`called “${row.name}”`);
  if (row.width && row.height) parts.push(`${row.width}×${row.height}`);
  if (row.prompt) parts.push(`— the owner's instruction about it: ${row.prompt}`);
  return parts.join(" ");
}

/* -------------------------------------------- can this model take an image */

export type ImageInputSupport = {
  /** Whether the question was asked at all. False means Replicate is not
   *  connected or did not answer — which is NOT "the model cannot". */
  checked: boolean;
  supported: boolean;
  /** The input property a picture goes in, when there is one. */
  field: string | null;
  /** True when the field takes a list of images rather than one. */
  many: boolean;
  note: string;
};

/** Field names Replicate models actually use for an image input, in the order
 *  a caller should prefer them. Matched against the schema's OWN properties —
 *  a name in this list that the model does not have is not used. */
const IMAGE_FIELDS = [
  "image_input",
  "image_prompt",
  "input_image",
  "image",
  "reference_image",
  "images",
  "control_image",
  "subject_image",
];

const cache = new Map<string, { at: number; value: ImageInputSupport }>();
const CACHE_MS = 30 * 60_000;
/** How long a failure is remembered. Much shorter than a success: a schema
 *  does not change often, and Replicate being unreachable does. */
const FAILURE_MS = 60_000;
/** The schema read is on a read route's critical path, so it gets a short
 *  ceiling of its own rather than the twenty seconds a background call could
 *  afford. */
const SCHEMA_TIMEOUT_MS = 8_000;

/**
 * Read the model's own schema and say whether a reference can be passed.
 *
 * MEASURED, NOT LISTED. A table of model names in this file would be wrong the
 * week somebody changed the setting, and the setting is the whole point of the
 * Studio's model being a setting. Replicate publishes each model's OpenAPI
 * input schema on the model endpoint; a property whose format is `uri` and
 * whose name is one of the known image fields is an image input.
 *
 * Cached for half an hour, because this is asked on every generation and the
 * answer changes when a model publishes a new version.
 */
export async function modelImageInput(model: string): Promise<ImageInputSupport> {
  const hit = cache.get(model);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  /* A FAILURE IS CACHED TOO, for a shorter time.
     `GET /api/publishing/assets` — a read route, and the `assets` skill's only
     view — awaits this. Caching only the successes meant that while Replicate
     was down every single read paid a twenty-second timeout, so a page that
     merely lists pictures hung. A failed answer is still an answer ("could not
     ask"), and asking again a minute later is soon enough. */
  const unchecked = (note: string): ImageInputSupport => {
    const value: ImageInputSupport = { checked: false, supported: false, field: null, many: false, note };
    cache.set(model, { at: Date.now() - (CACHE_MS - FAILURE_MS), value });
    return value;
  };

  const tokens = tokenAccounts("publishing_model_schema");
  if (!tokens.length)
    return unchecked("Replicate is not connected, so this could not be asked and no reference is passed.");

  try {
    const res = await fetch(`${REPLICATE_API}/models/${model}`, {
      headers: { Authorization: `Bearer ${tokens[0]!.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(SCHEMA_TIMEOUT_MS),
    });
    if (!res.ok) return unchecked(`Replicate answered HTTP ${res.status} for that model's schema.`);
    const doc = (await res.json()) as {
      latest_version?: { openapi_schema?: { components?: { schemas?: Record<string, unknown> } } };
    };
    const input = doc.latest_version?.openapi_schema?.components?.schemas?.Input as
      | { properties?: Record<string, { type?: string; format?: string; items?: { format?: string } }> }
      | undefined;
    const props = input?.properties ?? {};
    for (const name of IMAGE_FIELDS) {
      const prop = props[name];
      if (!prop) continue;
      const many = prop.type === "array";
      const format = many ? prop.items?.format : prop.format;
      if (format !== "uri") continue;
      const value: ImageInputSupport = {
        checked: true,
        supported: true,
        field: name,
        many,
        note: `${model} takes a reference image in its \`${name}\` input.`,
      };
      cache.set(model, { at: Date.now(), value });
      return value;
    }
    const value: ImageInputSupport = {
      checked: true,
      supported: false,
      field: null,
      many: false,
      note:
        `${model} has no image input in its schema, so a selected reference cannot be passed to ` +
        "it. It is described in words in the prompt instead, which is much weaker.",
    };
    cache.set(model, { at: Date.now(), value });
    return value;
  } catch (err) {
    return unchecked(
      `The model's schema could not be read (${err instanceof Error ? err.name : "Error"}), so no reference is passed.`,
    );
  }
}

/** File sizes for the assets of one venture, so a page can say what the
 *  library costs on disk without stat-ing in the browser. */
export function libraryBytes(ventureId?: string | null): number {
  let total = 0;
  for (const row of assetRows(ventureId)) {
    try {
      total += statSync(row.path).size;
    } catch {
      /* a missing file contributes nothing, which is true */
    }
  }
  return total;
}
