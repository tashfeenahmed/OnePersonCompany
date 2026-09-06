/**
 * Meta — Facebook Pages and the ads account, through the Graph API.
 *
 * WHAT THE OWNER PASTES: one access token, and optionally the app it was
 * minted under. Both entries already exist in workdash's vault under the names
 * this file uses — `meta-token` and `meta-app` — which makes moving them a
 * copy rather than a translation.
 *
 * BOTH ARE COMMENT-ANNOTATED FILES, AND THAT IS THE FIRST TRAP.
 * `collect_social.py` reads the token file one line at a time, skipping blanks
 * and anything starting with `#`, because the owner keeps a note above each
 * secret explaining what it is for. Sealed whole and sent as a bearer token,
 * that file produces
 *
 *     OAuthException 190 "Bad signature"
 *
 * which is indistinguishable from a revoked credential and sends you to mint a
 * replacement for a token that was never wrong. `parseLines` below is the same
 * three lines Hetzner's `parseTokens` is, written out again for the reason that
 * one is: they are two statements about two credential formats that happen to
 * agree today.
 *
 * WHAT `meta-app` TURNED OUT TO BE. Not an app id, despite the catalog field
 * once calling it one — it is `app_id:app_secret`, a sixteen-digit id and a
 * thirty-two-character hex secret joined by a colon, which is the shape
 * `collect_social.py` partitions on when it exchanges an expiring token. So it
 * is a SECRET and is stored as one, and what it buys here is
 * `appsecret_proof`: an HMAC-SHA256 of the access token under the app secret,
 * sent with every call, which Meta verifies (a wrong one is refused with
 * "Invalid appsecret_proof provided in the API argument"). A token intercepted
 * without the secret cannot be replayed against an app that requires the proof.
 *
 * It is OPTIONAL and the integration is not crippled without it. The token
 * alone reads everything below; the proof only hardens the calls. An account
 * with a token and no app is connected, works, and says on the wire that its
 * calls are unproofed — which is a true and small thing, not a failure.
 *
 * THE TOKEN IS NOT AN EXPIRING USER TOKEN. `debug_token` reports it as a
 * SYSTEM_USER token with `expires_at: 0` — Meta for "never" — so the
 * sixty-day exchange dance `collect_social.py` performs is not something this
 * file ever needs to do, and it therefore never writes to the vault. That is
 * worth stating rather than leaving implicit: a collector that can rewrite a
 * credential is a collector that can lose one.
 *
 * PINNED TO v21.0, deliberately and with an escape hatch. Meta retires Graph
 * versions on a schedule and an unsupported version is a hard error on every
 * call rather than a warning; workdash pins the same version through the same
 * env var, so the two halves cannot drift apart by accident.
 *
 * WHAT IT READS, and nothing else — every one of them a GET:
 *
 *     GET /me                                who the token is
 *     GET /me/accounts                       the Pages, and whether each has an
 *                                            Instagram Business account
 *     GET /me/adaccounts                     the ad accounts
 *     GET /act_<id>/insights                 the window, the campaign cut,
 *                                            the daily cut, and lifetime spend
 *     GET /act_<id>/campaigns                names, objectives, real statuses
 *
 * The token carries `pages_manage_posts`, which can write. Nothing in this
 * file sends anything but GET, so "this cannot post to a Page" is a property
 * of the code rather than a promise in a comment — the same confinement
 * providers/stripe.ts makes for the same reason.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";
import { createHmac } from "node:crypto";

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const TIMEOUT_MS = 25_000;

/** Pages and ad accounts per listing. Three and one here; the cap exists so a
 *  portfolio that grows does not silently become an unbounded walk. */
const MAX_PAGES = 25;
const MAX_AD_ACCOUNTS = 10;
const MAX_CAMPAIGNS = 30;

/** The window every figure on this integration's cards is drawn over.
 *  Meta's own `last_30d` preset rather than a hand-rolled date range, so the
 *  account total and the daily rows are cut from the same window by Meta and
 *  cannot disagree about where it starts. */
export const WINDOW_DAYS = 30;

/**
 * THE ATTRIBUTION WINDOW, NAMED RATHER THAN INHERITED.
 *
 * A conversion count is meaningless without the window it was attributed over:
 * the same twelve leads are a different number at 1-day-click than at
 * 7-day-click, and Meta will happily answer either without saying which it
 * used. The account's default is whatever somebody last chose in Ads Manager,
 * so it is asked for EXPLICITLY here and the string travels with the figure to
 * the wire and onto the card.
 *
 * `value` under an explicit request is the total across the windows asked for,
 * which is why only one pair is ever requested.
 */
export const ATTRIBUTION_WINDOWS = "7d_click,1d_view";
export const ATTRIBUTION_LABEL = "7-day click, 1-day view";

/**
 * The lead action, under every name Meta has given it — first found wins.
 *
 * Lifted from `collect_ads.py`, which is the version that has run against this
 * account. `actions` carries several spellings of the SAME lead — this account
 * returns `onsite_conversion.lead_grouped`, `lead` and
 * `offsite_complete_registration_add_meta_leads` all reading 12 — so adding
 * them would treble the only outcome this account buys.
 */
const LEAD_ACTIONS = [
  "onsite_conversion.lead_grouped",
  "lead",
  "onsite_conversion.lead",
  "offsite_conversion.fb_pixel_lead",
] as const;

/**
 * WHAT THIS TOKEN CANNOT READ, probed live on 2026-09-04 and written down so
 * nobody has to find it twice.
 *
 * It sits here rather than being re-probed every collection, for the reason
 * Replicate's does: deliberately calling five endpoints to watch them refuse is
 * noise in Meta's logs to re-learn a fact that changes when somebody grants a
 * permission, not when the collector runs. It is dated, and the date is shown,
 * so it reads as something that was checked rather than something assumed.
 *
 * THE TWO ENTRIES THAT MATTER MOST:
 *
 *   A PAGE ACCESS TOKEN CANNOT BE MINTED. Asking `/me/accounts` for the
 *   `access_token` field — which is how every Page-scoped call gets its
 *   credential — answers 403 "(#200) Your access token does not have
 *   pages_read_engagement permissions or your page role is not permitted to
 *   create ads for the page", even though `debug_token` lists
 *   `pages_read_engagement` among the token's scopes. The scope is granted and
 *   the system user's ROLE on the Pages is not, and only the second decides.
 *   Everything Page-scoped falls with it: insights, posts, the feed.
 *
 *   PAGE REACH NO LONGER EXISTS UNDER THIS NAME. `page_impressions_unique` —
 *   the metric a "Page reach" card would be built on — answers 400 "(#100) The
 *   value must be a valid insights metric" in v21.0, as do `page_impressions`
 *   and `page_fans`. That is metric DEATH rather than a permission problem:
 *   Meta retired the `impressions` family on 15 November 2025, which
 *   `collect_social.py` documents finding the corpses of. The metrics that ARE
 *   still valid names (`page_views_total`, `page_post_engagements`,
 *   `page_follows`, `page_daily_follows_unique`) answer 400 "(#190) This
 *   method must be called with a Page Access Token" — so they fail on the
 *   first count instead. Two independent reasons, and a card that said "reach
 *   unavailable" without distinguishing them would send somebody to fix the
 *   wrong one.
 */
export const CANNOT = {
  checkedOn: "2026-09-04",
  asked: [
    {
      asked: "GET /me/accounts?fields=access_token",
      answer: "403 (#200) — the system user's page role cannot mint a Page token",
    },
    {
      asked: "Page reach (page_impressions_unique)",
      answer: "400 (#100) not a valid metric in " + GRAPH_VERSION + " — retired 15 Nov 2025",
    },
    {
      asked: "Page views, follows, post engagements",
      answer: "400 (#190) requires a Page Access Token",
    },
    { asked: "GET /{page}/posts, /published_posts", answer: "403 (#210) requires a Page Access Token" },
    { asked: "GET /me/businesses", answer: "400 (#100) Missing Permission" },
    {
      asked: "purchase_roas, action_values on ad insights",
      answer: "absent from every row — this account buys leads, not purchases",
    },
  ],
} as const;

/* ----------------------------------------------------------------- parsing */

/**
 * The usable lines of a credential file.
 *
 * Blank lines and `#` comments out, everything else kept in order. Written out
 * again rather than imported from providers/hetzner.ts for the reason
 * accounts.ts writes its own copy of the same three lines: these are two
 * separate statements about two separate credential formats, and one growing a
 * rule must not silently change the other.
 */
export function parseLines(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export type App = { id: string; secret: string };

/**
 * `app_id:app_secret`, or null.
 *
 * Null covers three different mistakes and none of them is fatal here: an
 * empty entry, a bare app id with no secret, and something that is not an app
 * pair at all. The caller treats all three as "no proof available" rather than
 * as an error, because the token reads everything without one.
 */
export function parseApp(raw: string | null | undefined): App | null {
  const line = parseLines(raw)[0];
  if (!line || !line.includes(":")) return null;
  const [id, ...rest] = line.split(":");
  const secret = rest.join(":").trim();
  if (!id?.trim() || !secret) return null;
  return { id: id.trim(), secret };
}

/**
 * `appsecret_proof` — HMAC-SHA256 of the access token, keyed by the app secret.
 *
 * Meta validates it when it is sent (a wrong one comes back as "Invalid
 * appsecret_proof provided in the API argument"), so this is not decoration:
 * with the app required to use it, a token lifted on its own cannot be
 * replayed.
 */
export function appSecretProof(token: string, app: App): string {
  return createHmac("sha256", app.secret).update(token).digest("hex");
}

/* -------------------------------------------------------------------- http */

export class MetaError extends Error {
  status: number;
  /** Meta's own numeric code — 190 is a bad token, 200 a missing permission,
   *  100 a bad field or metric name. The three want different sentences. */
  code: number | null;
  constructor(status: number, message: string, code: number | null = null) {
    super(message);
    this.name = "MetaError";
    this.status = status;
    this.code = code;
  }
}

/**
 * One GET against the Graph API.
 *
 * THE TOKEN GOES IN A HEADER, NOT THE QUERY STRING. Meta documents
 * `?access_token=` and every example uses it, which is how a credential ends
 * up in an error message, a redirect, a proxy log and eventually a `runs` row
 * this interface displays. `Authorization: Bearer` is accepted by every
 * endpoint this file calls (verified live) and keeps the secret out of the URL
 * entirely. The only thing left in the query string is the proof, which is a
 * derivative and useless without the token it was computed over.
 *
 * A refusal arrives as a 400 carrying a JSON `error` object whose `message` is
 * the actual reason — "(#100) The value must be a valid insights metric" — so
 * the body is read rather than discarded in favour of the status code. Half
 * the failures this integration will ever see are a scope or a retired metric,
 * and the message is the only thing that says which.
 */
async function get<T>(path: string, token: string, proof: string | null): Promise<T> {
  const url = `${GRAPH}/${path}` + (proof ? `${path.includes("?") ? "&" : "?"}appsecret_proof=${proof}` : "");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: number | null = null;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: number } };
      if (body?.error?.message) message = body.error.message;
      if (typeof body?.error?.code === "number") code = body.error.code;
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new MetaError(res.status, message.slice(0, 240), code);
  }
  return (await res.json()) as T;
}

/* ----------------------------------------------------------------- readers */

/** A number Meta sent as a string. The Marketing API quotes every figure
 *  ("61.9", "140110"), and an absent field stays null — a row with no spend
 *  figure is not a row that spent nothing. */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

type ActionRow = { action_type?: string; value?: string };

/**
 * One value out of Meta's list-of-dicts action fields, or null.
 *
 * `actions` and `cost_per_action_type` arrive as
 * `[{action_type, value}, …]` rather than as columns. First name in `names`
 * that appears wins and the rest are ignored — see LEAD_ACTIONS for why adding
 * them would treble the same lead. Null means the row carried no such action
 * at all, which is NOT zero: an account with no lead form connected reports
 * nothing here too, and the two must never render alike.
 */
function actionValue(rows: unknown, names: readonly string[]): number | null {
  if (!Array.isArray(rows)) return null;
  const index = new Map<string, number | null>();
  for (const item of rows as ActionRow[]) {
    const name = item?.action_type;
    if (typeof name === "string" && !index.has(name)) index.set(name, num(item?.value));
  }
  for (const name of names) if (index.has(name)) return index.get(name) ?? null;
  return null;
}

/**
 * Leads from one insights row, or null when the question could not be asked.
 *
 * The zero is deliberate and narrow, and it is `collect_ads.py`'s rule: a row
 * that DELIVERED and whose `actions` list came back with no lead in it produced
 * no leads, which is the single most actionable fact this integration has —
 * money spent with nothing to show for it. A row that did not deliver, or whose
 * `actions` field never arrived at all, is null, because nobody asked it
 * anything.
 */
function leads(row: InsightRow): number | null {
  const value = actionValue(row.actions, LEAD_ACTIONS);
  if (value !== null) return Math.round(value);
  if (!Array.isArray(row.actions)) return null;
  return (int(row.impressions) ?? 0) > 0 ? 0 : null;
}

type InsightRow = {
  spend?: string;
  impressions?: string;
  clicks?: string;
  cpc?: string;
  ctr?: string;
  reach?: string;
  frequency?: string;
  actions?: unknown;
  cost_per_action_type?: unknown;
  account_currency?: string;
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  date_stop?: string;
  /** Asked for on every insights call and, on this account, never sent back.
   *  See `Window.roas` for what that absence means and what it does not. */
  purchase_roas?: unknown;
  action_values?: unknown;
};

/**
 * One insights row, in Meta's own units.
 *
 * REACH AND FREQUENCY ARE DE-DUPLICATED PER ROW, which is the one rule that has
 * to survive to the wire. Two campaigns that both reached the same person each
 * count them once, so adding two campaign reaches counts that person twice;
 * averaging two frequencies does the same thing in reverse. Both are kept
 * because a campaign's reach is the denominator its frequency means anything
 * over — and nothing downstream sums either, which the route says in words
 * rather than enforcing by deleting the number.
 */
export type Window = {
  /** Meta's own window, as it dated it. A figure whose span is not stated is a
   *  figure a reader will assume ends today. */
  from: string | null;
  to: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  cpc: number | null;
  ctr: number | null;
  reach: number | null;
  frequency: number | null;
  leads: number | null;
  /** Meta's own cost per lead where it sent one; spend ÷ leads only when it did
   *  not and there is a division to do. The two agree, and Meta's is the figure
   *  Ads Manager shows — which is what an owner would check this against. */
  costPerLead: number | null;
  /**
   * RETURN ON AD SPEND, AND WHY IT IS ALWAYS NULL HERE.
   *
   * `purchase_roas` is asked for on every call and this account has never
   * returned it, because ROAS is a ratio of revenue to spend and this account
   * buys LEAD FORM SUBMISSIONS — there is no purchase event, no
   * `action_values`, and therefore no revenue figure for Meta to divide by.
   * Null is "asked and not told"; it is not 0×, and it is not "the campaign
   * performed badly". If a purchase campaign ever runs, this field fills itself
   * and the card stops saying there is nothing to report.
   */
  roas: number | null;
};

function window(row: InsightRow | undefined): Window | null {
  if (!row || typeof row !== "object") return null;
  const spend = num(row.spend);
  const n = leads(row);
  let costPerLead = actionValue(row.cost_per_action_type, LEAD_ACTIONS);
  if (costPerLead === null && n && spend !== null) costPerLead = spend / n;
  const roasRows = row.purchase_roas;
  return {
    from: str(row.date_start),
    to: str(row.date_stop),
    spend,
    impressions: int(row.impressions),
    clicks: int(row.clicks),
    cpc: num(row.cpc),
    ctr: num(row.ctr),
    reach: int(row.reach),
    frequency: num(row.frequency),
    leads: n,
    costPerLead: costPerLead === null ? null : Math.round(costPerLead * 10_000) / 10_000,
    roas: Array.isArray(roasRows) ? num((roasRows[0] as ActionRow | undefined)?.value) : null,
  };
}

/* -------------------------------------------------------------------- rows */

/**
 * One Facebook Page.
 *
 * `followers` and `fans` are two fields and they are not the same thing:
 * `followers_count` is people following the Page, `fan_count` is people who
 * liked it. Followers is the figure that means reach today and likes is the
 * legacy one; both are kept, `followersSource` says which was used, and a Page
 * that reports neither is null rather than nought.
 *
 * `instagram` is the field the whole Instagram integration turns on, and it is
 * THREE-STATE by construction. `checked` records that the question was asked at
 * all; `id` null with `checked` true is Meta answering "this Page has no
 * Instagram Business account linked", which is a measurement. A Page with no
 * Instagram account and a Page with no followers must never look alike, and
 * that is what keeps them apart.
 */
export type PageRow = {
  accountId: number;
  accountLabel: string;
  id: string;
  name: string | null;
  followers: number | null;
  fans: number | null;
  followersSource: "followers_count" | "fan_count" | null;
  link: string | null;
  category: string | null;
  about: string | null;
  picture: string | null;
  instagram: {
    checked: boolean;
    id: string | null;
    username: string | null;
    followers: number | null;
  };
};

export type AdAccountRow = {
  accountId: number;
  accountLabel: string;
  /** `act_740050057705514` — the id every insights call is made against. */
  id: string;
  name: string | null;
  /** The account's OWN currency. Every money figure below is in it, and
   *  nothing anywhere adds two accounts' figures without one. */
  currency: string | null;
  /** Meta's `account_status`: 1 is active, 101 closed, 2 disabled. Anything but
   *  1 is listed and NOT queried for insights — four dead accounts answering
   *  with zeros every night is noise wearing a number's clothes. */
  status: number | null;
  active: boolean;
  timezone: string | null;
  createdAt: string | null;
  /** `date_preset=maximum`, for scale. Its own field rather than a longer
   *  window of the same series, because it is a different question. */
  lifetimeSpend: number | null;
  /** Meta's own answer for the 30-day window, dated. The daily rows below sum
   *  to the same spend; reach and frequency cannot be recovered from them at
   *  all, which is why this row is stored rather than derived. */
  window: Window | null;
  note: string | null;
};

export type CampaignRow = {
  adAccountId: string;
  id: string;
  name: string | null;
  /**
   * `effective_status`, never the configured `status`. An ad left ACTIVE inside
   * a paused campaign is not running, and the configured field would say it is.
   * effective_status folds the parents in (CAMPAIGN_PAUSED, ADSET_PAUSED) and
   * Meta's own vetoes (DISAPPROVED, WITH_ISSUES), so "ACTIVE" here means
   * "actually eligible to deliver" — the only reading of active a page should
   * make.
   */
  status: string | null;
  objective: string | null;
  window: Window | null;
};

/** One ad account's spend on one day. Keyed and replaced, because Meta revises
 *  recent days and a re-read must correct a row rather than double it. */
export type AdDayRow = {
  adAccountId: string;
  day: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
};

export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  /** Who the token is, from `/me`. The only thing that names one Meta account
   *  apart from another on the page. */
  user?: string | null;
  userId?: string | null;
  /** Whether this account's calls carried `appsecret_proof`. False is not a
   *  failure; it is "no app pair was stored", and the route says so. */
  proofed?: boolean;
  pages?: number;
  adAccounts?: number;
  /** Pages asked about, and Pages that turned out to have an Instagram
   *  Business account. `0 of 3` is the finding this whole integration turns
   *  on and it has to be a pair of counts, not a boolean. */
  pagesChecked?: number;
  instagramLinked?: number;
  notes?: string[];
};

export type CollectResult = {
  pages: PageRow[];
  adAccounts: AdAccountRow[];
  campaigns: CampaignRow[];
  days: AdDayRow[];
  accounts: AccountOutcome[];
  accountsTried: number;
  warnings: string[];
};

/* ------------------------------------------------------------------ verify */

/**
 * Is this token real, and what does it see?
 *
 * THREE CALLS RATHER THAN ONE, because "the token exists" and "the token can
 * read anything worth reading" are different facts and only the second matters.
 * `/me` answers 200 for a token scoped to nothing at all, so a credential that
 * passed only that check would connect happily and then show an empty board for
 * a reason nothing on the page could state — the same trap Cloudflare's
 * `/user/tokens/verify` sets, refused the same way.
 *
 * Neither listing being empty is a failure. A token that administers no Pages
 * and holds no ad accounts is a real, useless credential and it is refused with
 * that sentence; a token with one of the two is stored, because half this
 * integration is a whole answer.
 */
export async function verify(
  token: string,
  appRaw?: string | null,
): Promise<
  | { ok: true; user: string | null; pages: number; adAccounts: number; proofed: boolean }
  | { ok: false; error: string }
> {
  const app = parseApp(appRaw);
  const proof = app ? appSecretProof(token, app) : null;
  try {
    const me = await get<{ id?: string; name?: string }>("me?fields=id,name", token, proof);
    const pages = await get<{ data?: unknown[] }>(
      `me/accounts?fields=id&limit=${MAX_PAGES}`,
      token,
      proof,
    );
    const ads = await get<{ data?: unknown[] }>(
      `me/adaccounts?fields=id&limit=${MAX_AD_ACCOUNTS}`,
      token,
      proof,
    );
    const nPages = (pages.data ?? []).length;
    const nAds = (ads.data ?? []).length;
    if (!nPages && !nAds)
      return {
        ok: false,
        error:
          "That token works but administers no Pages and holds no ad accounts. " +
          "It needs pages_show_list for the Pages and ads_read for the ads — " +
          "check the system user's assets in Business settings.",
      };
    return { ok: true, user: me.name ?? null, pages: nPages, adAccounts: nAds, proofed: !!proof };
  } catch (err) {
    if (err instanceof MetaError) {
      /*
        190 IS THE ONE WORTH A SENTENCE OF ITS OWN. "Bad signature" on a token
        that is perfectly good is what a comment-annotated file produces when it
        is sealed and sent whole, and it reads exactly like a revoked
        credential — so the refusal names that possibility rather than sending
        the owner to mint a replacement for a token that was never wrong.
      */
      if (err.code === 190)
        return {
          ok: false,
          error:
            `Meta refused that token (190: ${err.message}). If the value was ` +
            `pasted from a notes file, the comment lines have to come out — ` +
            `only the token itself is the token.`,
        };
      if (err.code === 100 && /appsecret_proof/i.test(err.message))
        return {
          ok: false,
          error:
            "The app secret does not match this token's app. `meta-app` is " +
            "`app_id:app_secret` from developers.facebook.com → the app → " +
            "Settings → Basic, and both halves have to be that app's.",
        };
      return { ok: false, error: err.message };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Meta did not answer within 25 seconds."
          : `Could not reach the Graph API (${name}).`,
    };
  }
}

/* ----------------------------------------------------------------- collect */

type RawPage = {
  id?: string;
  name?: string;
  followers_count?: number;
  fan_count?: number;
  link?: string;
  category?: string;
  about?: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id?: string; username?: string; followers_count?: number };
};

type RawAdAccount = {
  id?: string;
  name?: string;
  currency?: string;
  account_status?: number;
  timezone_name?: string;
  created_time?: string;
};

type RawCampaign = {
  id?: string;
  name?: string;
  effective_status?: string;
  objective?: string;
};

const PAGE_FIELDS =
  "id,name,followers_count,fan_count,link,category,about,picture{url}," +
  "instagram_business_account{id,username,followers_count}";

const INSIGHT_FIELDS =
  "spend,impressions,clicks,cpc,ctr,reach,frequency,actions," +
  "cost_per_action_type,account_currency,purchase_roas,action_values";

/**
 * Every connected Meta account, walked.
 *
 * FAILURE IS PER ACCOUNT AT THE TOP AND PER EDGE BELOW IT. An account fails
 * only when `/me` itself threw — the token is dead or unreachable. A Page
 * listing that refuses while the ad accounts answer is a gap in an answer that
 * arrived, recorded as a note on that account; an ad account whose insights
 * refuse keeps its row, its currency and its name, with the refusal attached.
 * An account demoted to "failing" over any of those is an account whose
 * perfectly good token gets re-pasted.
 */
export async function collect(reader = "collect_meta"): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed("meta", ["token"], reader);

  const pages: PageRow[] = [];
  const adAccounts: AdAccountRow[] = [];
  const campaigns: CampaignRow[] = [];
  const days: AdDayRow[] = [];
  const outcomes: AccountOutcome[] = [];
  const warnings: string[] = [];

  for (const { account } of broken) {
    outcomes.push({ id: account.id, label: account.label, ok: false, error: "No token stored." });
    warnings.push(`${account.label}: no token stored`);
  }

  for (const { account, values } of ready) {
    /*
      STRIPPED ON THE WAY OUT OF THE VAULT, not merely on the way in.

      A `.trim()` here would be enough for a value this app stored, because the
      registry refuses a multi-line paste. It is not enough for a value COPIED
      ACROSS from workdash's vault, which is the ordinary way these two entries
      arrive — over there `meta-token` is a file with a `#` note above the
      secret, and reading it whole is exactly the mistake that produces
      OAuthException 190 on a perfectly good token. Doing it at read time makes
      the provider right whatever is in the entry.
    */
    const token = parseLines(values.token)[0] ?? "";
    if (!token) {
      const error = "The stored token has no usable line — only comments or blanks.";
      warnings.push(`${account.label}: ${error}`);
      outcomes.push({ id: account.id, label: account.label, ok: false, error });
      continue;
    }
    /* The app pair is read out of the same credential set and is allowed to be
       absent. A missing proof costs hardening, not access. */
    const app = parseApp(values.app);
    const proof = app ? appSecretProof(token, app) : null;
    const notes: string[] = [];
    const g = <T>(path: string) => get<T>(path, token, proof);

    let user: string | null = null;
    let userId: string | null = null;
    try {
      const me = await g<{ id?: string; name?: string }>("me?fields=id,name");
      user = me.name ?? null;
      userId = me.id ?? null;
    } catch (err) {
      const error = describe(err);
      warnings.push(`${account.label}: ${error}`);
      outcomes.push({ id: account.id, label: account.label, ok: false, error, proofed: !!proof });
      continue;
    }

    /* ------------------------------------------------------------- pages */

    let pagesChecked = 0;
    let instagramLinked = 0;
    try {
      const doc = await g<{ data?: RawPage[] }>(
        `me/accounts?fields=${encodeURIComponent(PAGE_FIELDS)}&limit=${MAX_PAGES}`,
      );
      for (const raw of (doc.data ?? []).slice(0, MAX_PAGES)) {
        if (!raw?.id) continue;
        pagesChecked += 1;
        const followers = int(raw.followers_count);
        const fans = int(raw.fan_count);
        const ig = raw.instagram_business_account;
        if (ig?.id) instagramLinked += 1;
        pages.push({
          accountId: account.id,
          accountLabel: account.label,
          id: raw.id,
          name: str(raw.name),
          followers: followers ?? fans,
          fans,
          followersSource:
            followers !== null ? "followers_count" : fans !== null ? "fan_count" : null,
          link: str(raw.link) ?? `https://www.facebook.com/${raw.id}`,
          category: str(raw.category),
          about: str(raw.about),
          /* A signed, EXPIRING scontent URL — Meta stamps an `oe=` deadline a
             few days out. It is only as good as the row is fresh, which is why
             nothing downstream may cache it and whatever renders it has to
             survive one 403ing without drawing a broken frame. */
          picture: str(raw.picture?.data?.url),
          instagram: {
            /* The question WAS asked. That is the difference between "this Page
               has no Instagram account" and "nobody looked", and it is the only
               thing that lets the Instagram card say which. */
            checked: true,
            id: str(ig?.id),
            username: str(ig?.username),
            followers: int(ig?.followers_count),
          },
        });
      }
    } catch (err) {
      const note = `Pages unreadable (${describe(err)})`;
      notes.push(note);
      warnings.push(`${account.label}: ${note}`);
    }

    /* -------------------------------------------------------- ad accounts */

    try {
      const doc = await g<{ data?: RawAdAccount[] }>(
        "me/adaccounts?fields=id,account_id,name,currency,account_status," +
          `timezone_name,created_time&limit=${MAX_AD_ACCOUNTS}`,
      );
      for (const raw of (doc.data ?? []).slice(0, MAX_AD_ACCOUNTS)) {
        if (!raw?.id) continue;
        const status = int(raw.account_status);
        const active = status === 1;
        const row: AdAccountRow = {
          accountId: account.id,
          accountLabel: account.label,
          id: raw.id,
          name: str(raw.name),
          currency: str(raw.currency),
          status,
          active,
          timezone: str(raw.timezone_name),
          createdAt: str(raw.created_time),
          lifetimeSpend: null,
          window: null,
          note: null,
        };
        if (!active) {
          row.note =
            `account_status ${status ?? "unknown"}: not active, so no insights were ` +
            "requested — the history exists at Meta and is not collected";
          adAccounts.push(row);
          continue;
        }
        const adNotes: string[] = [];
        await collectAdAccount(row, g, campaigns, days, adNotes);
        row.note = adNotes.join(" · ") || null;
        adAccounts.push(row);
      }
    } catch (err) {
      const note = `Ad accounts unreadable (${describe(err)})`;
      notes.push(note);
      warnings.push(`${account.label}: ${note}`);
    }

    outcomes.push({
      id: account.id,
      label: account.label,
      ok: true,
      user,
      userId,
      proofed: !!proof,
      pages: pages.filter((p) => p.accountId === account.id).length,
      adAccounts: adAccounts.filter((a) => a.accountId === account.id).length,
      pagesChecked,
      instagramLinked,
      notes,
    });
  }

  return {
    pages,
    adAccounts,
    campaigns,
    days,
    accounts: outcomes,
    accountsTried: ready.length + broken.length,
    warnings,
  };
}

/**
 * One active ad account's four insights cuts.
 *
 * FOUR CALLS, AND EACH ONE FAILS ALONE. The window, lifetime spend, the
 * campaign cut and the daily cut answer four different questions, and losing
 * one is not losing the others: an account whose campaign edge refuses still
 * has a spend figure, and one whose daily rows refuse still has a total. Each
 * refusal becomes a note against the account rather than an exception that
 * costs the other three.
 *
 * The campaign list and the campaign insights DISAGREE ON MEMBERSHIP by design.
 * A paused campaign with no delivery in the window is in the edge and not in
 * the insights, and it is still listed — "paused, nothing spent" is a fact the
 * owner acts on, and on this account it is thirteen of the fourteen.
 */
async function collectAdAccount(
  row: AdAccountRow,
  g: <T>(path: string) => Promise<T>,
  campaigns: CampaignRow[],
  days: AdDayRow[],
  notes: string[],
) {
  const enc = encodeURIComponent;
  const attribution = `&action_attribution_windows=${enc(ATTRIBUTION_WINDOWS)}`;

  try {
    const doc = await g<{ data?: InsightRow[] }>(
      `${row.id}/insights?date_preset=last_${WINDOW_DAYS}d&fields=${enc(INSIGHT_FIELDS)}${attribution}`,
    );
    /* NO ROWS IS A REAL ANSWER: an account with no delivery in the window
       returns an empty list, not a row of zeros. Keeping window null rather
       than fabricating one is what lets a card say "nothing ran" instead of
       drawing €0.00 beside a spend that was never measured. */
    row.window = window((doc.data ?? [])[0]);
  } catch (err) {
    notes.push(`the ${WINDOW_DAYS}-day window is unreadable (${describe(err)})`);
  }

  try {
    const doc = await g<{ data?: InsightRow[] }>(
      `${row.id}/insights?date_preset=maximum&fields=spend`,
    );
    row.lifetimeSpend = num((doc.data ?? [])[0]?.spend);
  } catch (err) {
    notes.push(`lifetime spend is unreadable (${describe(err)})`);
  }

  const listed = new Map<string, CampaignRow>();
  try {
    const doc = await g<{ data?: RawCampaign[] }>(
      `${row.id}/campaigns?fields=id,name,effective_status,objective&limit=${MAX_CAMPAIGNS}`,
    );
    for (const c of doc.data ?? []) {
      if (!c?.id) continue;
      listed.set(c.id, {
        adAccountId: row.id,
        id: c.id,
        name: str(c.name),
        status: str(c.effective_status),
        objective: str(c.objective),
        window: null,
      });
    }
  } catch (err) {
    notes.push(`the campaign list is unreadable (${describe(err)})`);
  }

  try {
    const doc = await g<{ data?: InsightRow[] }>(
      `${row.id}/insights?date_preset=last_${WINDOW_DAYS}d&level=campaign&fields=` +
        `${enc("campaign_id,campaign_name," + INSIGHT_FIELDS)}&limit=${MAX_CAMPAIGNS}${attribution}`,
    );
    for (const r of doc.data ?? []) {
      const id = str(r.campaign_id);
      if (!id) continue;
      const existing = listed.get(id);
      if (existing) existing.window = window(r);
      else
        /* Delivered inside the window but past the campaigns-edge page cut. A
           spender outranks a listed sleeper, so it is kept with the fields the
           insights row does carry and nulls for the ones it does not. */
        listed.set(id, {
          adAccountId: row.id,
          id,
          name: str(r.campaign_name),
          status: null,
          objective: null,
          window: window(r),
        });
    }
  } catch (err) {
    notes.push(`campaign insights are unreadable (${describe(err)})`);
  }
  campaigns.push(...listed.values());

  try {
    const doc = await g<{ data?: InsightRow[] }>(
      `${row.id}/insights?date_preset=last_${WINDOW_DAYS}d&time_increment=1&fields=` +
        `${enc("spend,impressions,clicks,actions")}&limit=${WINDOW_DAYS * 2}${attribution}`,
    );
    for (const r of doc.data ?? []) {
      const day = str(r.date_start);
      if (!day) continue;
      /* A DAY META DID NOT REPORT IS A DAY NOTHING WAS SPENT, NOT A DAY
         MEASURED AT ZERO — and it is not written. Inventing a zero row for
         every silent day would turn "the account stopped delivering on the
         16th" into a flat line that looks measured, and the route would have
         no way to tell the two apart afterwards. */
      days.push({
        adAccountId: row.id,
        day,
        spend: num(r.spend),
        impressions: int(r.impressions),
        clicks: int(r.clicks),
        leads: leads(r),
      });
    }
  } catch (err) {
    notes.push(`the daily breakdown is unreadable (${describe(err)})`);
  }
}

function describe(err: unknown): string {
  if (err instanceof MetaError) return err.message;
  if (err instanceof Error && err.name === "TimeoutError")
    return "Meta did not answer within 25 seconds";
  return err instanceof Error ? err.name : "Error";
}

export type { Account };

/* ==========================================================================
 * PUBLISHING — added by the publishing area, 2026-09-06.
 *
 * EVERYTHING ABOVE THIS LINE IS A GET AND STAYS ONE. The header of this file
 * says, as a property of the code rather than a promise, that nothing here
 * sends anything but GET. That sentence was true and is now qualified: it is
 * true of the COLLECTOR, which is what it was about, and everything below is
 * a separate, named surface that only the publishing pipeline reaches. The
 * collector does not import any of it, and nothing below is called except
 * from `integrations/publishing/`.
 *
 * WHY IT LIVES HERE RATHER THAN IN THE PUBLISHING AREA. The Graph API's traps
 * are documented at the top of this file — the comment-annotated credential
 * file, the appsecret proof, the pinned version, and the one that decides this
 * whole feature: A SYSTEM USER TOKEN CAN LIST PAGES AND CANNOT NECESSARILY
 * MINT A PAGE TOKEN. Publishing needs the Page token; a second module that
 * re-derived the graph call would eventually re-learn all of that the
 * expensive way.
 *
 * THE TRANSPORT IS INJECTED so the whole path can be rehearsed. See
 * providers/social.ts.
 * ======================================================================= */

import { describeBody, failed, redact, type PublishOutcome, type Transport } from "./social.ts";

/** One Page a token administers, with the credential that can actually post
 *  as it. `token` null is the finding CANNOT documents above: the scope is
 *  granted and the system user's ROLE on the Page is not. */
export type PublishablePage = {
  id: string;
  name: string | null;
  /** The PAGE access token. Null means one could not be minted, and
   *  `tokenError` says what Meta answered. */
  token: string | null;
  tokenError: string | null;
  instagram: { id: string | null; username: string | null };
};

/**
 * The Pages of one Meta account, asked WITH `access_token` in the field list.
 *
 * This is the single most informative call in the whole publishing area, and
 * it is the one the collector above deliberately does not make. Asking for
 * `access_token` either returns a per-Page credential — in which case this
 * box can post — or refuses the whole edge with 403 (#200), which is Meta
 * saying the system user's role on the Pages does not permit it. Both answers
 * are recorded verbatim on the destination's probe.
 */
export async function publishablePages(
  token: string,
  proof: string | null,
  t: Transport,
): Promise<{ ok: boolean; pages: PublishablePage[]; error: string | null }> {
  const fields =
    "id,name,access_token,instagram_business_account{id,username}";
  const url =
    `${GRAPH}/me/accounts?fields=${encodeURIComponent(fields)}&limit=${MAX_PAGES}` +
    (proof ? `&appsecret_proof=${proof}` : "");
  let res: Response;
  try {
    res = await t.fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, pages: [], error: describe(err) };
  }
  const body = (await res.json().catch(() => null)) as
    | { data?: RawPage[]; error?: { message?: string; code?: number } }
    | null;
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    /* (#200) IS THE ONE WORTH ITS OWN SENTENCE, because it is the answer this
       account actually gives and it sends people to the wrong place: the
       scope IS granted, and it is the system user's ROLE on the Pages that is
       not. Re-granting pages_read_engagement fixes nothing. */
    return {
      ok: false,
      pages: [],
      error:
        body?.error?.code === 200
          ? `${message} — this is a PAGE ROLE, not a scope: give the system ` +
            "user a role on the Page in Business settings → Accounts → Pages, " +
            "with Create content and Manage Page permissions."
          : message.slice(0, 240),
    };
  }
  const pages: PublishablePage[] = [];
  for (const raw of (body?.data ?? []).slice(0, MAX_PAGES)) {
    if (!raw?.id) continue;
    const withToken = raw as RawPage & { access_token?: string };
    pages.push({
      id: raw.id,
      name: str(raw.name),
      token: str(withToken.access_token),
      tokenError: withToken.access_token
        ? null
        : "Meta listed this Page and sent no access token for it, so nothing here can post as it.",
      instagram: {
        id: str(raw.instagram_business_account?.id),
        username: str(raw.instagram_business_account?.username),
      },
    });
  }
  return { ok: true, pages, error: null };
}

/** What this token is granted, as Meta reports it. Best effort: a system user
 *  token answers 400 here on some setups, and that is a note rather than a
 *  failure — the page listing above is the authoritative probe. */
export async function tokenPermissions(
  token: string,
  proof: string | null,
  t: Transport,
): Promise<{ granted: string[]; declined: string[]; error: string | null }> {
  try {
    const res = await t.fetch(
      `${GRAPH}/me/permissions${proof ? `?appsecret_proof=${proof}` : ""}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const body = (await res.json().catch(() => null)) as {
      data?: { permission?: string; status?: string }[];
      error?: { message?: string };
    } | null;
    if (!res.ok)
      return { granted: [], declined: [], error: (body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200) };
    const granted: string[] = [];
    const declined: string[] = [];
    for (const row of body?.data ?? []) {
      if (!row?.permission) continue;
      (row.status === "granted" ? granted : declined).push(row.permission);
    }
    return { granted, declined, error: null };
  } catch (err) {
    return { granted: [], declined: [], error: describe(err) };
  }
}

/** A Graph write. The token goes in the body the way Meta's own upload
 *  examples do, because a multipart POST cannot carry a bearer through every
 *  proxy the file passes; `redact` keeps it out of the record either way. */
async function graphWrite(
  t: Transport,
  path: string,
  body: FormData | URLSearchParams,
  timeoutMs: number,
): Promise<{ ok: boolean; doc: Record<string, unknown>; error: string | null }> {
  let res: Response;
  try {
    res = await t.fetch(`${GRAPH}/${path}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, doc: {}, error: describe(err) };
  }
  const doc = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const err = doc.error as { message?: string; code?: number } | undefined;
  if (!res.ok || err)
    return {
      ok: false,
      doc,
      error: (err?.message ?? `HTTP ${res.status}`).slice(0, 240),
    };
  return { ok: true, doc, error: null };
}

/** A caption on a Page's timeline, with no picture. */
export async function postPageFeed(
  page: { id: string; token: string },
  caption: string,
  t: Transport,
): Promise<PublishOutcome> {
  const form = new URLSearchParams({ message: caption, access_token: page.token });
  const out = await graphWrite(t, `${page.id}/feed`, form, 45_000);
  if (!out.ok) return failed(`Facebook refused the post — ${out.error}`);
  const id = typeof out.doc.id === "string" ? out.doc.id : null;
  return {
    ok: true,
    id,
    url: id ? `https://www.facebook.com/${id.replace("_", "/posts/")}` : null,
    configured: true,
    error: null,
    note: null,
  };
}

/**
 * A photo post. `/photos` rather than `/feed`, because the picture IS the post
 * — a feed post with a link would show the caption and drop the image the
 * Studio just paid to render.
 *
 * `post_id` is the story on the timeline and `id` is the photo object; the
 * permalink wants the first, and Meta only returns it for a published upload.
 */
export async function postPagePhoto(
  page: { id: string; token: string },
  caption: string,
  media: { bytes: Uint8Array; mime: string; name: string },
  t: Transport,
): Promise<PublishOutcome> {
  const form = new FormData();
  form.set("caption", caption);
  form.set("published", "true");
  form.set("access_token", page.token);
  form.set("source", new Blob([media.bytes], { type: media.mime }), media.name);
  const out = await graphWrite(t, `${page.id}/photos`, form, 180_000);
  if (!out.ok) return failed(`Facebook refused the photo — ${out.error}`);
  const postId =
    (typeof out.doc.post_id === "string" && out.doc.post_id) ||
    (typeof out.doc.id === "string" && out.doc.id) ||
    null;
  return {
    ok: true,
    id: postId,
    url: postId ? `https://www.facebook.com/${postId.replace("_", "/posts/")}` : null,
    configured: true,
    error: null,
    note: null,
  };
}

/** A video on the Page. The `videos` edge answers with the video's own id and
 *  no `post_id`, so the permalink is built from that rather than split. */
export async function postPageVideo(
  page: { id: string; token: string },
  caption: string,
  media: { bytes: Uint8Array; mime: string; name: string },
  t: Transport,
): Promise<PublishOutcome> {
  const form = new FormData();
  form.set("description", caption);
  form.set("published", "true");
  form.set("access_token", page.token);
  form.set("source", new Blob([media.bytes], { type: media.mime }), media.name);
  const out = await graphWrite(t, `${page.id}/videos`, form, 600_000);
  if (!out.ok) return failed(`Facebook refused the video — ${out.error}`);
  const id = typeof out.doc.id === "string" ? out.doc.id : null;
  return {
    ok: true,
    id,
    url: id ? `https://www.facebook.com/${page.id}/videos/${id}` : null,
    configured: true,
    error: null,
    note: null,
  };
}

/**
 * Instagram, in two steps against a URL this box does not own the fetch of.
 *
 * `/media` takes an `image_url` and FETCHES IT ITSELF, asynchronously, from
 * Meta's network — which is why the publishing area refuses to attempt this
 * without a public base URL, and why the picture has to still be there
 * afterwards. The caption goes on the CONTAINER; putting it on `/media_publish`
 * is a documented way to publish a post with no caption at all.
 *
 * The permalink is read back on a third call and its failure is not the
 * post's: a link we could not look up is a missing link, not a failed publish.
 */
export async function postInstagramImage(
  ig: { id: string; token: string },
  caption: string,
  imageUrl: string,
  t: Transport,
): Promise<PublishOutcome> {
  const container = await graphWrite(
    t,
    `${ig.id}/media`,
    new URLSearchParams({ image_url: imageUrl, caption, access_token: ig.token }),
    60_000,
  );
  if (!container.ok) return failed(`Instagram refused the container — ${container.error}`);
  const creationId = typeof container.doc.id === "string" ? container.doc.id : null;
  if (!creationId) return failed("Instagram made no media container and gave no reason.");

  const published = await graphWrite(
    t,
    `${ig.id}/media_publish`,
    new URLSearchParams({ creation_id: creationId, access_token: ig.token }),
    60_000,
  );
  if (!published.ok) return failed(`Instagram refused to publish the container — ${published.error}`);
  const mediaId = typeof published.doc.id === "string" ? published.doc.id : null;

  let url: string | null = null;
  if (mediaId) {
    try {
      const res = await t.fetch(
        `${GRAPH}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(ig.token)}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const doc = (await res.json().catch(() => null)) as { permalink?: string } | null;
      url = str(doc?.permalink);
    } catch {
      /* The post is live either way. */
    }
  }
  return {
    ok: true,
    id: mediaId,
    url,
    configured: true,
    error: null,
    note: url ? null : "Posted; the permalink could not be read back.",
  };
}

/* `redact` and `describeBody` are imported for the transport contract's sake
   and re-exported so a caller holding only this module can compose the same
   record — see providers/social.ts. */
export { redact, describeBody };

/* ==========================================================================
 * ORGANIC READS — the posts that already exist, added by the socialfeed area,
 * 2026-09-06.
 *
 * A SEPARATE SECTION FROM THE COLLECTOR ABOVE AND FROM THE PUBLISHING SECTION
 * BELOW IT, and the separation is deliberate rather than tidy. The collector
 * reads Page identity and ad spend with the SYSTEM USER token. The publishing
 * section writes with a PAGE token. This reads a Page's own timeline, which
 * needs the Page token and sends nothing but GETs — so it belongs to neither
 * and shares only the Graph version, the proof and the error vocabulary.
 *
 * IT IS ALL GET. Every function here is a read; there is no write in this
 * section and nothing here is reachable from the publishing pipeline.
 *
 * ─────────────────────── WHAT WAS MEASURED, 2026-09-06 ────────────────────
 *
 * Probed live against three connected Pages on this account, on v21.0, with
 * Page tokens minted through `publishablePages`. The findings changed what
 * this code asks for, so they are written down rather than summarised:
 *
 *   GET /{page}/posts?fields=…                200. The edge works with a Page
 *                                             token. `CANNOT` above records a
 *                                             403 (#210) from 2026-09-04, when
 *                                             no Page token could be minted;
 *                                             the system user has a Page role
 *                                             now and both facts are true of
 *                                             their own dates.
 *   insights.metric(post_impressions)         400 (#100) — NOT A VALID METRIC
 *   insights.metric(post_engaged_users)       400 (#100) — NOT A VALID METRIC
 *   insights.metric(post_impressions_unique)  400 (#100) — NOT A VALID METRIC
 *   insights.metric(post_impressions_organic) 400 (#100) — NOT A VALID METRIC
 *   insights.metric(post_activity)            400 (#100) — NOT A VALID METRIC
 *   insights.metric(post_negative_feedback)   400 (#100) — NOT A VALID METRIC
 *   insights.metric(post_media_view)          200, period `lifetime`
 *   insights.metric(post_clicks)              200, period `lifetime`
 *   insights.metric(post_video_views)         200, `lifetime` and `day`
 *   reactions/comments .summary(total_count)  200, and they need no insights
 *                                             permission at all
 *   shares                                    absent from the payload when the
 *                                             count is zero — normal, not a gap
 *
 * THE WHOLE `impressions` FAMILY IS DEAD. Meta retired it on 15 November 2025.
 * A request that asks for one of those names does not get a null back: it gets
 * a 400 that takes the WHOLE PAGE OF POSTS with it. So the metric list is a
 * measured constant here rather than a hopeful one, and anything added to it
 * has to be probed first.
 *
 * ONE REQUEST PER PAGE, NOT ONE PER POST. Insights ride on the posts edge as
 * a field expansion. Asking per post would be twenty-five requests to learn
 * what one returns, against somebody's rate limit.
 * ======================================================================= */

/** The Facebook post insights that are still valid metric names in
 *  GRAPH_VERSION, measured — see the section header. Every name here answered
 *  200; every name that did not is listed above with its error. */
export const POST_INSIGHT_METRICS = ["post_media_view", "post_clicks", "post_video_views"] as const;

/** The metric names Meta RETIRED, kept so a document can say what is missing
 *  and why rather than showing a gap. */
export const RETIRED_POST_METRICS = [
  "post_impressions",
  "post_impressions_unique",
  "post_impressions_organic",
  "post_engaged_users",
  "post_activity",
  "post_negative_feedback",
] as const;

/** One post or one piece of Instagram media, in the platform's own vocabulary.
 *  `metrics` keys are Meta's field paths and metric names, never a word chosen
 *  here — see migration 340 for why that rule exists. */
export type OrganicPost = {
  id: string;
  createdTime: string | null;
  permalink: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  text: string | null;
  metrics: Record<string, number>;
  /** What was absent, in words. Null when everything asked for arrived. */
  note: string | null;
};

export type OrganicRead = {
  ok: boolean;
  posts: OrganicPost[];
  /** Meta's own sentence when the edge refused. Null on success. */
  error: string | null;
  /** Set when the POSTS arrived and their INSIGHTS did not — a permission
   *  problem that must not read as "this Page has no posts". */
  insightsError: string | null;
};

/** One insights metric out of an edge-expanded block, found BY NAME.
 *  The order of `data` is not promised, so asking for element 0 works right up
 *  until Meta adds a metric and every figure becomes a different one. */
function insightValue(raw: Record<string, unknown>, metric: string): number | null {
  const block = raw.insights as { data?: unknown[] } | undefined;
  for (const entry of block?.data ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { name?: unknown; period?: unknown; values?: unknown[] };
    if (row.name !== metric) continue;
    /* `lifetime` where there is one: `post_video_views` answers with both a
       lifetime total and a per-day series, and summing the days would be a
       second, smaller answer to the same question. */
    if (row.period && row.period !== "lifetime") continue;
    const first = row.values?.[0] as { value?: unknown } | undefined;
    if (typeof first?.value === "number") return first.value;
  }
  return null;
}

const deep = (obj: unknown, ...path: (string | number)[]): unknown => {
  let cur: unknown = obj;
  for (const step of path) {
    if (cur === null || cur === undefined) return null;
    if (typeof step === "number") {
      if (!Array.isArray(cur)) return null;
      cur = cur[step];
    } else {
      if (typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[step];
    }
  }
  return cur ?? null;
};

const count = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * A Page's own timeline, newest first.
 *
 * `/posts` RATHER THAN `/feed`. Both answer 200 with a Page token and they are
 * not the same edge: `feed` includes what other people posted to the Page and
 * `posts` is what the Page itself published. This document is about what the
 * business published, so anything a visitor wrote does not belong in it.
 *
 * `message` IS WHAT THE OWNER TYPED AND `story` IS WHAT FACEBOOK TYPED for
 * them ("X updated their cover photo"). The story is a fallback and never a
 * first choice: a Page whose posts all read as stories has published nothing,
 * which is a different fact from having posted silently.
 */
export async function pagePosts(
  pageId: string,
  pageToken: string,
  limit = 25,
): Promise<OrganicRead> {
  const base =
    "id,message,story,created_time,permalink_url,full_picture," +
    "attachments{media_type,type,description,media,url}," +
    "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares";
  const insights = `insights.metric(${POST_INSIGHT_METRICS.join(",")})`;

  const ask = (fields: string) =>
    fetchPage(
      `${GRAPH}/${pageId}/posts?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}` +
        `&fields=${encodeURIComponent(fields)}`,
      pageToken,
    );

  let attempt = await ask(`${base},${insights}`);
  let metricsError: string | null = null;

  /*
    THE RETRY THAT KEEPS THE TIMELINE ALIVE WHEN A METRIC DIES.

    Insights ride on the posts edge as ONE field expansion, so a single retired
    metric name does not answer null — it answers 400 (#100) and takes the
    WHOLE PAGE OF POSTS with it. That is exactly what happened to the
    `post_impressions` family on 15 November 2025, and the only thing standing
    between this file and that failure a second time is that the constant above
    was probed on the day it was written. Meta will retire something else.

    So a 400 whose message is about a metric is retried ONCE with the insights
    clause removed. The posts survive, and `insightsError` carries Meta's own
    sentence — which is the honest report: the timeline is current, and the
    engagement figures on it are missing for a named reason. The alternative,
    which this had before, was a Page that silently stopped updating.

    ONLY A METRIC ERROR IS RETRIED. A 403 about a Page token or a 190 about the
    wrong kind of token would fail identically without insights, and a second
    request to learn that is a second request against somebody's rate limit.
  */
  if (!attempt.ok && isMetricError(attempt.error, attempt.code)) {
    metricsError =
      `${attempt.error} — the posts below are current; their engagement figures are not, because ` +
      `at least one of ${POST_INSIGHT_METRICS.join(", ")} is no longer a valid metric name in ` +
      `${GRAPH_VERSION}. Re-probe the list in providers/meta.ts.`;
    attempt = await ask(base);
  }

  if (!attempt.ok)
    return { ok: false, posts: [], error: attempt.error, insightsError: null };
  const body = attempt.body;

  const posts: OrganicPost[] = [];
  let withoutInsights = 0;
  for (const raw of body?.data ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;

    const metrics: Record<string, number> = {};
    for (const m of POST_INSIGHT_METRICS) {
      const v = insightValue(row, m);
      if (v !== null) metrics[m] = v;
    }
    /* THE EDGE SUMMARIES ARE KEPT UNDER THEIR GRAPH PATHS. They are not
       insights, they need no insights permission, and calling either of them
       "engagement" here would be this file inventing a metric Meta does not
       publish. Adding them up is the reader's decision and it is made where
       the window and the units are known. */
    const reactions = count(deep(row, "reactions", "summary", "total_count"));
    const comments = count(deep(row, "comments", "summary", "total_count"));
    const shares = count(deep(row, "shares", "count"));
    if (reactions !== null) metrics["reactions.summary.total_count"] = reactions;
    if (comments !== null) metrics["comments.summary.total_count"] = comments;
    /* `shares` VANISHES WHEN THE COUNT IS ZERO, measured. Its absence is
       normal and is not recorded as a gap. */
    if (shares !== null) metrics["shares.count"] = shares;

    const notes: string[] = [];
    const hadInsights = row.insights !== undefined;
    if (!hadInsights) {
      withoutInsights += 1;
      notes.push("no insights block came back for this post");
    }
    if (reactions === null && comments === null)
      notes.push("neither the reactions nor the comments summary was in the response");

    const attachment = deep(row, "attachments", "data", 0) as Record<string, unknown> | null;
    const text =
      str(row.message) ??
      str(attachment?.description) ??
      str(row.story);

    posts.push({
      id,
      createdTime: str(row.created_time),
      permalink: str(row.permalink_url),
      mediaType: (str(attachment?.media_type) ?? str(attachment?.type))?.toLowerCase() ?? null,
      /* `full_picture` is the render Meta serves in feed; the attachment's own
         src is the fallback for link shares and some video posts. */
      imageUrl: str(row.full_picture) ?? (str(deep(attachment, "media", "image", "src")) ?? null),
      /* Truncated here rather than in the browser: this is polled by every
         open tab and a page holding ten essays would pay for them each time. */
      text: text ? text.slice(0, 600) : null,
      metrics,
      note: notes.join("; ") || null,
    });
  }

  return {
    ok: true,
    posts,
    error: null,
    insightsError:
      /* The metric death first, because it is the one with a fix in this
         repository rather than in Meta's settings. */
      metricsError ??
      (posts.length && withoutInsights === posts.length
        ? "The posts came back and none of them carried an insights block. That is a Page " +
          "permission (read_insights on this Page's role), not an absence of activity."
        : null),
  };
}

/**
 * One Graph GET with the token in the HEADER.
 *
 * THE TOKEN NEVER GOES IN THE QUERY STRING, which is this file's own rule
 * stated at `get<T>()` above and is the reason that function exists: a
 * credential in a URL is a credential in an access log, in a `Referer`, and in
 * every error message that echoes the request. These two organic reads were
 * written with `access_token=` in the URL and are not any more.
 */
async function fetchPage(
  url: string,
  pageToken: string,
): Promise<
  | { ok: true; body: { data?: unknown[] } | null }
  | { ok: false; error: string; code: number | null }
> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${pageToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: describe(err), code: null };
  }
  const body = (await res.json().catch(() => null)) as
    | { data?: unknown[]; error?: { message?: string; code?: number } }
    | null;
  if (!res.ok)
    return {
      ok: false,
      error: (body?.error?.message ?? `HTTP ${res.status}`).slice(0, 300),
      code: body?.error?.code ?? null,
    };
  return { ok: true, body };
}

/**
 * Is this 400 about a metric NAME rather than about permission?
 *
 * Meta's (#100) is a general "bad parameter" and its message is the only thing
 * that distinguishes "you asked for a metric that no longer exists" from "you
 * asked for a field that never existed". Matched on the sentence Meta actually
 * sends — "(#100) The value must be a valid insights metric", measured
 * 2026-09-06 — with `insights` as the fallback signal, because a message this
 * has not seen must not send a permission problem round the retry loop.
 */
function isMetricError(message: string, code: number | null): boolean {
  const text = message.toLowerCase();
  return (
    (code === 100 || code === null) &&
    (text.includes("valid insights metric") || text.includes("insights metric") || text.includes("must be a valid metric"))
  );
}

/**
 * An Instagram business account's media, newest first.
 *
 * NOT EXERCISED ON THIS INSTALL, and the honest thing is to say so: every one
 * of the three Pages this token administers answered
 * `instagram_business_account: null` on 2026-09-06, so there was no IG account
 * to read and this function has never been run against a live one. Its field
 * list is the one `collect_social.py` has run for months and the code path is
 * here so that connecting an account is all that is needed — but a document
 * built on it must say "not measured here" rather than "zero".
 *
 * `reach` IS INSTAGRAM'S OWN METRIC NAME and it means unique accounts, which
 * is NOT what Facebook's surviving `post_media_view` counts. The two are kept
 * under their own names for exactly that reason.
 */
export async function instagramMedia(
  igUserId: string,
  pageToken: string,
  limit = 25,
): Promise<OrganicRead> {
  const fields =
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp," +
    "like_count,comments_count,insights.metric(reach)";
  const url =
    `${GRAPH}/${igUserId}/media?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}` +
    `&fields=${encodeURIComponent(fields)}`;

  /* Token in the header, same rule as the Page read above. */
  const attempt = await fetchPage(url, pageToken);
  if (!attempt.ok) return { ok: false, posts: [], error: attempt.error, insightsError: null };
  const body = attempt.body;

  const posts: OrganicPost[] = [];
  let withoutInsights = 0;
  for (const raw of body?.data ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    const metrics: Record<string, number> = {};
    const reach = insightValue(row, "reach");
    if (reach !== null) metrics["reach"] = reach;
    const likes = count(row.like_count);
    const comments = count(row.comments_count);
    if (likes !== null) metrics["like_count"] = likes;
    if (comments !== null) metrics["comments_count"] = comments;
    if (row.insights === undefined) withoutInsights += 1;

    const mediaType = str(row.media_type);
    posts.push({
      id,
      createdTime: str(row.timestamp),
      permalink: str(row.permalink),
      mediaType: mediaType ? mediaType.toLowerCase() : null,
      /* A video's `media_url` is the video file; only its thumbnail is
         something an <img> can show. Photos have no thumbnail_url at all, so
         the order matters in both directions. */
      imageUrl: mediaType === "VIDEO" ? (str(row.thumbnail_url) ?? str(row.media_url)) : str(row.media_url),
      text: str(row.caption)?.slice(0, 600) ?? null,
      metrics,
      note: row.insights === undefined ? "no insights block came back for this media" : null,
    });
  }

  return {
    ok: true,
    posts,
    error: null,
    insightsError:
      posts.length && withoutInsights === posts.length
        ? "The media came back with no insights block on any of it — that is the " +
          "instagram_manage_insights permission on this account, not an absence of activity."
        : null,
  };
}

/* ==========================================================================
 * ADS READS — added by the webanalytics area, 2026-09-06, for gap row 35.
 *
 * A SEPARATE SECTION, AND SEPARATE FROM THE PUBLISHING ONE ABOVE IT. Every
 * function below is a GET, in the sense the file header means: the collector's
 * confinement is intact and this section adds nothing that can write. It is
 * apart from the collector only because it is on a different clock and reads a
 * different depth — the ad, the ad set, the creative and the per-ad day —
 * which the account-level collector deliberately does not fetch.
 *
 * WHAT IT READS, verified live against act_740050057705514 on 2026-09-06,
 * every one of them answering 200 with the fields asked for:
 *
 *   GET /act_<id>/ads?fields=id,name,adset_id,campaign_id,effective_status,
 *       configured_status,created_time,updated_time,issues_info,creative{…}
 *   GET /act_<id>/adsets?fields=id,name,campaign_id,effective_status,
 *       daily_budget,lifetime_budget,optimization_goal,billing_event,
 *       bid_strategy,start_time,end_time
 *   GET /act_<id>/insights?level=ad&time_increment=1&date_preset=last_30d
 *   GET /act_<id>/insights?level=ad&time_range={since,until}   ×2
 *
 * THE TWO WINDOW CALLS ARE THE WHOLE REASON THIS EXISTS RATHER THAN A SUM.
 * Fatigue is frequency rising while click-through falls, and NEITHER REACH NOR
 * FREQUENCY CAN BE DERIVED FROM DAILY ROWS: Meta de-duplicates reach over the
 * row's own window, so seven daily reaches do not add to a week's reach and
 * seven daily frequencies do not average into a week's frequency. So the week
 * and the week before are two explicit `time_range` requests, and what Meta
 * says is what is stored, with the dates it covered.
 *
 * WHAT IS DELIBERATELY NOT ASKED FOR, because asking would invite a claim:
 * there is no targeting specification here and no delivery-insights call, so
 * NOTHING in this section or downstream of it may say an ad set is in the
 * learning phase or that two ad sets overlap. Those are the two sentences the
 * ad-health module's limitations block already refuses to say, and having ad
 * set ids does not license either of them.
 * ======================================================================== */

/**
 * Rows per listing, and per insights page.
 *
 * An ad account with more advertisements than this has a problem this page
 * cannot help with anyway; the cap is what stops one account's history from
 * being a thousand requests. NOTHING HERE FOLLOWS `paging.next`, which is the
 * rest of this file's convention — but at AD level it truncates far sooner
 * than it does at account level, so every reader below REPORTS reaching its
 * own cap rather than returning a short list silently. A caller that does not
 * know a list was cut will delete the rows it could not see.
 */
export const MAX_ADS = 200;
export const MAX_ADSETS = 200;
/** Insight rows per request. A 30-day ad-level daily series is (ads × days)
 *  rows, so 200 advertisements would be 6,000 — well past this, and the cap is
 *  reported for exactly that reason. */
export const MAX_INSIGHT_ROWS = 1000;

/** The window the per-ad daily series covers, and the length of each of the
 *  two matched windows the fatigue view compares. */
export const AD_DAYS_WINDOW = 30;
export const AD_COMPARE_DAYS = 7;

/** The insight fields asked for at ad level. `actions` is included because a
 *  conversion attributed to one advertisement is the only outcome figure this
 *  depth has; `cost_per_action_type` is NOT, because a per-ad cost per action
 *  divides one small number by another and the account-level figure is the one
 *  Ads Manager shows. */
const AD_INSIGHT_FIELDS =
  "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name," +
  "impressions,reach,frequency,clicks,spend,ctr,cpm,actions";

const AD_FIELDS =
  "id,name,adset_id,campaign_id,effective_status,configured_status," +
  "created_time,updated_time,issues_info," +
  "creative{id,name,title,body,image_url,thumbnail_url,object_story_spec,call_to_action_type}";

const ADSET_FIELDS =
  "id,name,campaign_id,effective_status,daily_budget,lifetime_budget," +
  "optimization_goal,billing_event,bid_strategy,start_time,end_time";

/** One advertisement, as this box stores it. */
export type AdRow = {
  id: string;
  adAccountId: string;
  adsetId: string | null;
  campaignId: string | null;
  name: string | null;
  /** effective_status: the parents and Meta's own vetoes folded in. */
  status: string | null;
  configuredStatus: string | null;
  creativeId: string | null;
  creativeName: string | null;
  title: string | null;
  body: string | null;
  callToAction: string | null;
  /** The destination this advertisement sends people to, wherever Meta put it
   *  — the creative's own link spec, the story spec's link data, or the child
   *  attachment. It is what the campaign-to-venture matcher reads. */
  linkUrl: string | null;
  /** SIGNED AND EXPIRING. Meta stamps an `oe=` deadline a few days out; this
   *  is only as good as the row is fresh and nothing may cache it. */
  imageUrl: string | null;
  thumbnailUrl: string | null;
  /** Meta's own issues_info, unedited, as JSON. A disapproval is the
   *  platform's sentence about the platform's own policy. */
  issues: string | null;
  createdTime: string | null;
  updatedTime: string | null;
};

export type AdSetRow = {
  id: string;
  adAccountId: string;
  campaignId: string | null;
  name: string | null;
  status: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  /** MINOR UNITS of the account's currency, as Meta sent them. Nothing
   *  divides by a hundred without saying so. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  endTime: string | null;
};

/** One ad's figures for one span — a day or an explicit window. */
export type AdInsight = {
  adId: string;
  adsetId: string | null;
  campaignId: string | null;
  day: string | null;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  spend: number | null;
  ctr: number | null;
  cpm: number | null;
  /** `{action_type: value}` as Meta sent it, or null when it sent none. */
  actions: Record<string, number> | null;
};

type RawAd = {
  id?: string;
  name?: string;
  adset_id?: string;
  campaign_id?: string;
  effective_status?: string;
  configured_status?: string;
  created_time?: string;
  updated_time?: string;
  issues_info?: unknown;
  creative?: {
    id?: string;
    name?: string;
    title?: string;
    body?: string;
    image_url?: string;
    thumbnail_url?: string;
    call_to_action_type?: string;
    object_story_spec?: unknown;
  };
};

type RawAdSet = {
  id?: string;
  name?: string;
  campaign_id?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  start_time?: string;
  end_time?: string;
};

/**
 * The destination URL out of a creative, wherever Meta put it.
 *
 * There are four places and Meta uses whichever matches how the ad was built:
 * `link_data.link` on a link ad, `video_data.call_to_action.value.link` on a
 * video, the first child attachment's link on a carousel, and
 * `template_data.link` on a dynamic one. Exported and pure so the matcher's
 * test can feed it the four shapes without a network.
 */
export function creativeLink(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, Record<string, unknown> | undefined>;
  const candidates: unknown[] = [];
  for (const block of ["link_data", "video_data", "template_data"] as const) {
    const data = s[block];
    if (!data) continue;
    candidates.push(data.link);
    const cta = data.call_to_action as { value?: { link?: unknown } } | undefined;
    candidates.push(cta?.value?.link);
    const children = data.child_attachments;
    if (Array.isArray(children))
      for (const child of children) candidates.push((child as { link?: unknown })?.link);
  }
  for (const c of candidates) if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
  return null;
}

/** Every advertisement in one ad account. */
export async function ads(
  adAccountId: string,
  g: <T>(path: string) => Promise<T>,
): Promise<{ rows: AdRow[]; capped: boolean }> {
  const doc = await g<{ data?: RawAd[] }>(
    `${adAccountId}/ads?fields=${encodeURIComponent(AD_FIELDS)}&limit=${MAX_ADS}`,
  );
  const out: AdRow[] = [];
  for (const raw of doc.data ?? []) {
    if (!raw?.id) continue;
    const creative = raw.creative ?? {};
    out.push({
      id: raw.id,
      adAccountId,
      adsetId: str(raw.adset_id),
      campaignId: str(raw.campaign_id),
      name: str(raw.name),
      status: str(raw.effective_status),
      configuredStatus: str(raw.configured_status),
      creativeId: str(creative.id),
      creativeName: str(creative.name),
      title: str(creative.title),
      body: str(creative.body),
      callToAction: str(creative.call_to_action_type),
      linkUrl: creativeLink(creative.object_story_spec),
      imageUrl: str(creative.image_url),
      thumbnailUrl: str(creative.thumbnail_url),
      issues:
        Array.isArray(raw.issues_info) && raw.issues_info.length
          ? JSON.stringify(raw.issues_info).slice(0, 4000)
          : null,
      createdTime: str(raw.created_time),
      updatedTime: str(raw.updated_time),
    });
  }
  return { rows: out, capped: (doc.data ?? []).length >= MAX_ADS };
}

/** Every ad set in one ad account. */
export async function adSets(
  adAccountId: string,
  g: <T>(path: string) => Promise<T>,
): Promise<{ rows: AdSetRow[]; capped: boolean }> {
  const doc = await g<{ data?: RawAdSet[] }>(
    `${adAccountId}/adsets?fields=${encodeURIComponent(ADSET_FIELDS)}&limit=${MAX_ADSETS}`,
  );
  const out: AdSetRow[] = [];
  for (const raw of doc.data ?? []) {
    if (!raw?.id) continue;
    out.push({
      id: raw.id,
      adAccountId,
      campaignId: str(raw.campaign_id),
      name: str(raw.name),
      status: str(raw.effective_status),
      optimizationGoal: str(raw.optimization_goal),
      billingEvent: str(raw.billing_event),
      bidStrategy: str(raw.bid_strategy),
      dailyBudget: num(raw.daily_budget),
      lifetimeBudget: num(raw.lifetime_budget),
      startTime: str(raw.start_time),
      endTime: str(raw.end_time),
    });
  }
  return { rows: out, capped: (doc.data ?? []).length >= MAX_ADSETS };
}

/** Turn Meta's `actions` array into a plain map, or null when it sent none. */
function actionMap(rows: unknown): Record<string, number> | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  const out: Record<string, number> = {};
  for (const raw of rows) {
    const r = raw as ActionRow;
    const value = num(r.value);
    if (!r.action_type || value === null) continue;
    out[r.action_type] = value;
  }
  return Object.keys(out).length ? out : null;
}

function insight(r: InsightRow & { ad_id?: string; adset_id?: string }): AdInsight | null {
  const adId = str(r.ad_id);
  if (!adId) return null;
  return {
    adId,
    adsetId: str(r.adset_id),
    campaignId: str(r.campaign_id),
    day: str(r.date_start),
    impressions: int(r.impressions),
    reach: int(r.reach),
    frequency: num(r.frequency),
    clicks: int(r.clicks),
    spend: num(r.spend),
    ctr: num(r.ctr),
    cpm: num((r as { cpm?: unknown }).cpm),
    actions: actionMap(r.actions),
  };
}

/**
 * The per-ad DAILY series.
 *
 * `day` is Meta's own `date_start` on a `time_increment=1` row, which is the
 * ad account's day in the ad account's timezone — never this box's. A day Meta
 * did not report is a day that is absent, not a day measured at zero.
 */
export async function adDays(
  adAccountId: string,
  g: <T>(path: string) => Promise<T>,
  days = AD_DAYS_WINDOW,
): Promise<{ rows: AdInsight[]; capped: boolean }> {
  const doc = await g<{ data?: (InsightRow & { ad_id?: string })[] }>(
    `${adAccountId}/insights?date_preset=last_${days}d&level=ad&time_increment=1` +
      `&fields=${encodeURIComponent(AD_INSIGHT_FIELDS)}` +
      `&action_attribution_windows=${encodeURIComponent(ATTRIBUTION_WINDOWS)}&limit=${MAX_INSIGHT_ROWS}`,
  );
  const out: AdInsight[] = [];
  for (const r of doc.data ?? []) {
    const row = insight(r);
    if (row?.day) out.push(row);
  }
  return { rows: out, capped: (doc.data ?? []).length >= MAX_INSIGHT_ROWS };
}

/**
 * The per-ad figures for ONE EXPLICIT WINDOW.
 *
 * `since` and `until` are inclusive dates in the ad account's own timezone,
 * and both are complete days: today is never in one, for `windows()`'s reason.
 * Meta's `reach` and `frequency` on this row are de-duplicated over exactly
 * this span and are meaningful for no other.
 */
export async function adWindow(
  adAccountId: string,
  g: <T>(path: string) => Promise<T>,
  since: string,
  until: string,
): Promise<{ rows: AdInsight[]; capped: boolean }> {
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  const doc = await g<{ data?: (InsightRow & { ad_id?: string })[] }>(
    `${adAccountId}/insights?time_range=${range}&level=ad` +
      `&fields=${encodeURIComponent(AD_INSIGHT_FIELDS)}` +
      `&action_attribution_windows=${encodeURIComponent(ATTRIBUTION_WINDOWS)}&limit=${MAX_INSIGHT_ROWS}`,
  );
  const out: AdInsight[] = [];
  for (const r of doc.data ?? []) {
    const row = insight(r);
    if (row) out.push({ ...row, day: null });
  }
  return { rows: out, capped: (doc.data ?? []).length >= MAX_INSIGHT_ROWS };
}

/**
 * A reader bound to one connected Meta account.
 *
 * The transport is built here rather than exported piecemeal so the token
 * still never leaves this file: the caller gets a function that takes a path
 * and gets JSON, exactly as `collect()` builds for itself, and cannot see the
 * bearer or the proof.
 */
export function readerFor(values: Record<string, string>): {
  g: <T>(path: string) => Promise<T>;
  proofed: boolean;
} | null {
  const token = parseLines(values.token)[0] ?? "";
  if (!token) return null;
  const app = parseApp(values.app);
  const proof = app ? appSecretProof(token, app) : null;
  return { g: <T>(path: string) => get<T>(path, token, proof), proofed: Boolean(proof) };
}
