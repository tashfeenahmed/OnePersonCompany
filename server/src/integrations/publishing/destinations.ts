/**
 * WHERE A VENTURE'S POSTS CAN GO, and what was actually true when this box
 * last asked.
 *
 * A DESTINATION IS DISCOVERED, NOT TYPED. The owner does not paste a Page id:
 * the probe walks every connected social plugin, asks each one what it can
 * reach, and writes a row per (venture, network, account). What the owner does
 * decide is WHICH VENTURE a Page belongs to — a token that administers five
 * Pages says nothing about which business each one is for — and whether a
 * destination is enabled at all.
 *
 * THE PROBE IS THE PRODUCT AND THE CAPABILITIES ARE ITS ANSWER. "Meta is
 * connected" is not the question; "can this box put a photo on that Page" is,
 * and on the account this was written against the answer is NO for a reason no
 * scope list would reveal — the system user holds `pages_manage_posts` and has
 * no ROLE on the Pages, so `/me/accounts?fields=access_token` refuses the whole
 * edge with (#200). That refusal is recorded verbatim, dated, and rendered as
 * itself. A readiness page that said "Meta ✓" because a token verified would be
 * lying in the one place it matters.
 *
 * NOTHING IS RE-PROBED ON A READ. A permission changes when somebody grants
 * one, not when a page is drawn, and a probe is three network calls per
 * account. `GET /api/publishing/destinations` serves the stored answer with its
 * date; the owner presses Probe.
 */
import { randomUUID } from "node:crypto";
import * as accounts from "../../accounts.ts";
import { db, now, ventureRowById, type VentureRow } from "../../db.ts";
import { appSecretProof, parseApp, parseLines, publishablePages, tokenPermissions } from "../../providers/meta.ts";
import * as linkedin from "../../providers/linkedin.ts";
import * as tiktok from "../../providers/tiktok.ts";
import { liveTransport, type Transport } from "../../providers/social.ts";
import { LIMITS, type DestinationKind } from "./limits.ts";

export const META_PLUGIN = "meta";
export const LINKEDIN_PLUGIN = "linkedin";
export const TIKTOK_PLUGIN = "tiktok";

export type DestinationRow = {
  id: string;
  venture_id: string;
  plugin_id: string;
  account_id: number | null;
  account_label: string | null;
  kind: string;
  external_id: string;
  handle: string | null;
  enabled: number;
  capabilities: string;
  probe_ts: string | null;
  probe_ok: number | null;
  probe_error: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * What a probe established. Three booleans and the reasons.
 *
 * `text`, `photo` and `video` are what this app believes it could send TODAY,
 * which is the AND of two things: what the network's API supports through the
 * code in providers/, and what this credential was actually allowed to do when
 * asked. `missing` names the permission or the portal step behind a false, in
 * the words that identify what to go and change.
 */
export type Capabilities = {
  text: boolean;
  photo: boolean;
  video: boolean;
  missing: string[];
  /** Anything true and specific that is not a capability — TikTok's privacy
   *  levels, LinkedIn's author kind, an Instagram account's username. */
  facts: Record<string, string | number | boolean | null>;
  note: string;
};

const EMPTY: Capabilities = {
  text: false,
  photo: false,
  video: false,
  missing: [],
  facts: {},
  note: "Never probed.",
};

export function readCapabilities(raw: string): Capabilities {
  try {
    const parsed = JSON.parse(raw) as Partial<Capabilities>;
    return {
      text: !!parsed.text,
      photo: !!parsed.photo,
      video: !!parsed.video,
      missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
      facts: (parsed.facts ?? {}) as Capabilities["facts"],
      note: typeof parsed.note === "string" ? parsed.note : "",
    };
  } catch {
    return EMPTY;
  }
}

export function destinationRow(id: string): DestinationRow | undefined {
  return db.prepare("SELECT * FROM publish_destinations WHERE id = ?").get(id) as
    | DestinationRow
    | undefined;
}

export function destinationRows(ventureId?: string | null): DestinationRow[] {
  return (
    ventureId
      ? db
          .prepare(
            "SELECT * FROM publish_destinations WHERE venture_id = ? ORDER BY kind, handle",
          )
          .all(ventureId)
      : db.prepare("SELECT * FROM publish_destinations ORDER BY venture_id, kind, handle").all()
  ) as unknown as DestinationRow[];
}

export function shapeDestination(r: DestinationRow) {
  const caps = readCapabilities(r.capabilities);
  const kind = r.kind as DestinationKind;
  return {
    id: r.id,
    ventureId: r.venture_id,
    plugin: r.plugin_id,
    account: r.account_label,
    accountId: r.account_id,
    kind: r.kind,
    label: LIMITS[kind]?.label ?? r.kind,
    externalId: r.external_id,
    handle: r.handle,
    enabled: r.enabled === 1,
    capabilities: caps,
    limits: LIMITS[kind] ?? null,
    probe: {
      /** Null means nobody has ever asked — never "it failed". */
      at: r.probe_ts,
      ok: r.probe_ok === null ? null : r.probe_ok === 1,
      error: r.probe_error,
    },
  };
}

/** Insert or update by the natural key, keeping the owner's `enabled` switch
 *  and never moving a destination between ventures behind their back. */
function upsert(entry: {
  ventureId: string;
  plugin: string;
  accountId: number | null;
  accountLabel: string | null;
  kind: DestinationKind;
  externalId: string;
  handle: string | null;
  capabilities: Capabilities;
  ok: boolean;
  error: string | null;
}): string {
  const existing = db
    .prepare(
      "SELECT id FROM publish_destinations WHERE venture_id = ? AND plugin_id = ? AND kind = ? AND external_id = ?",
    )
    .get(entry.ventureId, entry.plugin, entry.kind, entry.externalId) as
    | { id: string }
    | undefined;
  const ts = now();
  const caps = JSON.stringify(entry.capabilities);
  if (existing) {
    db.prepare(
      `UPDATE publish_destinations
          SET account_id = ?, account_label = ?, handle = ?, capabilities = ?,
              probe_ts = ?, probe_ok = ?, probe_error = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      entry.accountId,
      entry.accountLabel,
      entry.handle,
      caps,
      ts,
      entry.ok ? 1 : 0,
      entry.error,
      ts,
      existing.id,
    );
    return existing.id;
  }
  const id = `d-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO publish_destinations
       (id, venture_id, plugin_id, account_id, account_label, kind, external_id,
        handle, enabled, capabilities, probe_ts, probe_ok, probe_error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
  ).run(
    id,
    entry.ventureId,
    entry.plugin,
    entry.accountId,
    entry.accountLabel,
    entry.kind,
    entry.externalId,
    entry.handle,
    caps,
    ts,
    entry.ok ? 1 : 0,
    entry.error,
    ts,
    ts,
  );
  return id;
}

/* -------------------------------------------------------------- the probe */

export type ProbeReport = {
  at: string;
  venture: { id: string; name: string } | null;
  /** One entry per plugin asked, whether or not it produced a destination. */
  plugins: {
    plugin: string;
    connected: boolean;
    accountsTried: number;
    found: number;
    /** What could not be reached at all, per account. */
    problems: string[];
    note: string;
  }[];
  destinations: ReturnType<typeof shapeDestination>[];
  note: string;
};

/**
 * Ask every connected social plugin what it can reach, and write it down.
 *
 * WHY A VENTURE IS REQUIRED. A destination row is meaningless without one: the
 * whole feature is "this business's posts go to these accounts". Probing
 * without a venture would have to invent an ownership mapping, and the only
 * honest source for it is the owner. So the probe is per venture and the same
 * Page may legitimately be a destination for two of them.
 */
export async function probeDestinations(
  venture: VentureRow,
  makeTransport: () => Transport = liveTransport,
): Promise<ProbeReport> {
  const report: ProbeReport = {
    at: now(),
    venture: { id: venture.id, name: venture.name },
    plugins: [],
    destinations: [],
    note: "",
  };

  await probeMeta(venture, makeTransport, report);
  await probeLinkedIn(venture, makeTransport, report);
  await probeTikTok(venture, makeTransport, report);

  report.destinations = destinationRows(venture.id).map(shapeDestination);
  const canPost = report.destinations.filter(
    (d) => d.enabled && (d.capabilities.text || d.capabilities.photo || d.capabilities.video),
  ).length;
  report.note =
    canPost === 0
      ? "No destination can publish anything yet. Each row's `missing` names the permission or the portal step behind that."
      : `${canPost} of ${report.destinations.length} destination(s) can publish something.`;
  return report;
}

async function probeMeta(
  venture: VentureRow,
  makeTransport: () => Transport,
  report: ProbeReport,
) {
  const { ready, broken } = accounts.credentialed(META_PLUGIN, ["token"], "publish_probe");
  const entry = {
    plugin: META_PLUGIN,
    connected: ready.length > 0,
    accountsTried: ready.length + broken.length,
    found: 0,
    problems: broken.map((b) => `${b.account.label}: no token stored`),
    note:
      "A Facebook Page is reached with a PAGE access token, which is minted from " +
      "the system user's token only if that user has a ROLE on the Page. An " +
      "Instagram business account is reached through the Page it is linked to.",
  };
  report.plugins.push(entry);

  for (const { account, values } of ready) {
    /* Stripped on the way out of the vault, not merely on the way in — see
       providers/meta.ts, which explains what a comment-annotated paste does. */
    const token = parseLines(values.token)[0] ?? "";
    if (!token) {
      entry.problems.push(`${account.label}: the stored token has no usable line`);
      continue;
    }
    const app = parseApp(values.app);
    const proof = app ? appSecretProof(token, app) : null;
    const t = makeTransport();

    const perms = await tokenPermissions(token, proof, t);
    const pages = await publishablePages(token, proof, t);
    if (!pages.ok) {
      entry.problems.push(`${account.label}: ${pages.error}`);
      continue;
    }
    for (const page of pages.pages) {
      entry.found += 1;
      const canPost = !!page.token;
      const missing: string[] = [];
      if (!canPost) {
        missing.push(
          "a Page role for this system user (Business settings → Accounts → Pages → " +
            "Create content), which is what mints the Page access token",
        );
      }
      if (perms.granted.length && !perms.granted.includes("pages_manage_posts"))
        missing.push("the pages_manage_posts permission");
      upsert({
        ventureId: venture.id,
        plugin: META_PLUGIN,
        accountId: account.id,
        accountLabel: account.label,
        kind: "page",
        externalId: page.id,
        handle: page.name,
        ok: canPost,
        error: canPost ? null : page.tokenError,
        capabilities: {
          text: canPost,
          photo: canPost,
          video: canPost,
          missing,
          facts: {
            pageId: page.id,
            grantedPermissions: perms.granted.join(", ") || "not readable",
            permissionsError: perms.error,
          },
          note: canPost
            ? "A Page access token was minted, so a caption, a photo and a video can all be sent. " +
              "Whether Meta accepts a given post is still Meta's decision."
            : "Meta listed this Page and would not mint a Page access token for it, so nothing " +
              "can be posted as it. The scope is not the problem — the system user's role on the Page is.",
        },
      });

      if (page.instagram.id) {
        entry.found += 1;
        const igMissing = [...missing];
        if (!canPost)
          igMissing.push("the linked Page's token, which is the credential an Instagram post is made with");
        upsert({
          ventureId: venture.id,
          plugin: META_PLUGIN,
          accountId: account.id,
          accountLabel: account.label,
          kind: "ig",
          externalId: page.instagram.id,
          handle: page.instagram.username ?? page.instagram.id,
          ok: canPost,
          error: canPost ? null : "The linked Page would not mint an access token.",
          capabilities: {
            text: false,
            photo: canPost,
            video: false,
            missing: igMissing,
            facts: {
              throughPage: page.id,
              username: page.instagram.username,
            },
            note:
              "Instagram fetches the picture from a URL it can reach and takes JPEG only. " +
              "Reels are not implemented here, and a caption with no picture is not a thing " +
              "the Instagram API accepts.",
          },
        });
      }
    }
  }
}

async function probeLinkedIn(
  venture: VentureRow,
  makeTransport: () => Transport,
  report: ProbeReport,
) {
  const { ready, broken } = accounts.credentialed(
    LINKEDIN_PLUGIN,
    ["token", "author"],
    "publish_probe",
  );
  const entry = {
    plugin: LINKEDIN_PLUGIN,
    connected: ready.length > 0,
    accountsTried: ready.length + broken.length,
    found: 0,
    problems: broken.map((b) => `${b.account.label}: missing ${b.missing.join(", ")}`),
    note:
      "LinkedIn posts as an explicit author URN. Text and image posts are implemented; " +
      "video is not.",
  };
  report.plugins.push(entry);

  for (const { account, values } of ready) {
    const t = makeTransport();
    const probed = await linkedin.probe(values, t);
    const urn = probed.author;
    if (!urn) {
      entry.problems.push(`${account.label}: ${probed.error ?? "no author URN stored"}`);
      continue;
    }
    entry.found += 1;
    const known = probed.administersKnown;
    const administers = probed.administers;
    const mismatch =
      known && administers.length > 0 && !administers.includes(urn) ? administers : null;
    const ok = probed.ok && !mismatch;
    const missing: string[] = [];
    if (mismatch)
      missing.push(
        `an author this token administers — it can post as ${mismatch.slice(0, 3).join(", ")}`,
      );
    if (!probed.ok && probed.error) missing.push(probed.error);
    upsert({
      ventureId: venture.id,
      plugin: LINKEDIN_PLUGIN,
      accountId: account.id,
      accountLabel: account.label,
      kind: "linkedin",
      externalId: urn,
      handle: urn.split(":").pop() ?? urn,
      ok,
      error: mismatch
        ? `This token does not administer ${urn}.`
        : probed.error,
      capabilities: {
        text: ok,
        photo: ok,
        video: false,
        missing,
        facts: {
          author: urn,
          authorKind: probed.kind,
          administers: known ? administers.join(", ") || "none readable" : "not readable with this token's scopes",
        },
        note:
          "Video is not implemented for LinkedIn here — its upload register is a different " +
          "multi-step call, and a half-attempt would upload a file the API then refuses. " +
          "These tokens expire; a 401 later means paste a new one, not that anything broke.",
      },
    });
  }
}

async function probeTikTok(
  venture: VentureRow,
  makeTransport: () => Transport,
  report: ProbeReport,
) {
  const { ready, broken } = accounts.credentialed(TIKTOK_PLUGIN, ["token"], "publish_probe");
  const entry = {
    plugin: TIKTOK_PLUGIN,
    connected: ready.length > 0,
    accountsTried: ready.length + broken.length,
    found: 0,
    problems: broken.map((b) => `${b.account.label}: missing ${b.missing.join(", ")}`),
    note:
      "TikTok takes a clip by fetching a public URL, so a public base URL whose domain is " +
      "verified in the developer portal is a precondition. Video only.",
  };
  report.plugins.push(entry);

  for (const { account, values } of ready) {
    const t = makeTransport();
    const probed = await tiktok.probe(values, t);
    const openId = (values.openId ?? "").trim() || `account-${account.id}`;
    entry.found += 1;
    const levels = probed.privacyLevels;
    const missing: string[] = [];
    if (!probed.ok && probed.error) missing.push(probed.error);
    if (probed.ok && levels.length === 1 && levels[0] === "SELF_ONLY")
      missing.push(
        "an audited TikTok client — this one may only post SELF_ONLY, so a post will be private",
      );
    upsert({
      ventureId: venture.id,
      plugin: TIKTOK_PLUGIN,
      accountId: account.id,
      accountLabel: account.label,
      kind: "tiktok",
      externalId: openId,
      handle: probed.nickname ?? probed.username ?? openId,
      ok: probed.ok,
      error: probed.error,
      capabilities: {
        text: false,
        photo: false,
        video: probed.ok,
        missing,
        facts: {
          nickname: probed.nickname,
          privacyLevels: levels.join(", ") || "not readable",
          maxVideoSeconds: probed.maxVideoSeconds,
        },
        note:
          "Photo posts are not implemented here. A post's privacy is chosen from what TikTok " +
          "says this account may use, and the answer records which level was actually used — " +
          "a post the owner thinks is public and TikTok made private is the failure this prevents.",
      },
    });
  }
}

/* ------------------------------------------------------------ owner edits */

export function setEnabled(id: string, enabled: boolean): boolean {
  const row = destinationRow(id);
  if (!row) return false;
  db.prepare("UPDATE publish_destinations SET enabled = ?, updated_at = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    now(),
    id,
  );
  return true;
}

/**
 * Move a destination to the venture it actually belongs to.
 *
 * THE PROBE CANNOT KNOW THIS AND DOES NOT GUESS. It attaches every Page a
 * token administers to the venture it was run for, because that is the only
 * thing it was told; a token that administers three businesses' Pages produces
 * three destinations under one venture and the owner sorts them out. That is
 * the correct division: Meta knows which Pages exist and only the owner knows
 * which business each one is for.
 *
 * ITEMS DO NOT MOVE WITH IT. An item already queued to this destination keeps
 * its own venture, which is deliberate — a post written for one business must
 * not silently become a post for another because a mapping was corrected. The
 * refusal in `items.patchItem` is the other half of the same rule.
 */
export function setVenture(id: string, ventureId: string): { ok: boolean; error?: string } {
  const row = destinationRow(id);
  if (!row) return { ok: false, error: "No destination by that id." };
  if (!ventureRowById(ventureId)) return { ok: false, error: `There is no venture ${ventureId}.` };
  const clash = db
    .prepare(
      "SELECT id FROM publish_destinations WHERE venture_id = ? AND plugin_id = ? AND kind = ? AND external_id = ? AND id != ?",
    )
    .get(ventureId, row.plugin_id, row.kind, row.external_id, id) as { id: string } | undefined;
  if (clash)
    return { ok: false, error: `That venture already has this account as ${clash.id}.` };
  db.prepare("UPDATE publish_destinations SET venture_id = ?, updated_at = ? WHERE id = ?").run(
    ventureId,
    now(),
    id,
  );
  return { ok: true };
}

/**
 * Forget a destination.
 *
 * REFUSED WHILE ANYTHING IS QUEUED TO IT, because an item pointing at a
 * destination that no longer exists is an item nobody can publish and nobody
 * can diagnose. Cancel or re-address those first — the error says how many.
 */
export function removeDestination(id: string): { ok: boolean; error?: string } {
  const row = destinationRow(id);
  if (!row) return { ok: false, error: "No destination by that id." };
  const used = db
    .prepare(
      "SELECT COUNT(*) AS n FROM publish_items WHERE destination_id = ? AND status NOT IN ('published','cancelled')",
    )
    .get(id) as { n: number } | undefined;
  if (used?.n)
    return {
      ok: false,
      error: `${used.n} item(s) are still queued to that destination. Cancel or re-address them first.`,
    };
  db.prepare("DELETE FROM publish_destinations WHERE id = ?").run(id);
  return { ok: true };
}

export function ventureOf(id: string): VentureRow | undefined {
  const row = destinationRow(id);
  return row ? ventureRowById(row.venture_id) : undefined;
}
