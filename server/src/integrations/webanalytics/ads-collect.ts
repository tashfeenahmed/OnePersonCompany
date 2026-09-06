/**
 * THE AD-LEVEL READ — advertisements, ad sets, creatives, and two matched
 * weeks per advertisement.
 *
 * WHAT THIS ADDS TO WHAT WAS ALREADY THERE, and it is exactly the three things
 * `growth/ads.ts` names in its own limitations block as the reasons it cannot
 * diagnose more: there was no AD SET row, so nothing could be said about
 * grouping; no AD row, so a disapproved advertisement was invisible; and no
 * creative, so "the image is spent" had nothing to point at. All three are
 * rows now.
 *
 * WHAT IT STILL DOES NOT LICENSE, written here because having the ids is
 * exactly when somebody would claim it: an ad set id and an optimisation goal
 * DO NOT establish learning status, and two ad sets delivering on the same day
 * DO NOT establish audience overlap. Meta publishes learning state only through
 * a delivery-insights call this token has not been asked for, and the targeting
 * specification is not read at all.
 *
 * FIVE REQUESTS PER AD ACCOUNT, EACH FAILING ALONE. The advertisements, the ad
 * sets, the daily series, this week and last week. An account whose ads edge
 * refuses still gets its daily series; an account whose second window refuses
 * gets a fatigue view that says so rather than one computed against nothing.
 */
import * as accounts from "../../accounts.ts";
import { db, metaAdAccounts } from "../../db.ts";
import * as meta from "../../providers/meta.ts";
import { isoDay, dayStart } from "../analytics/umami.ts";
import {
  replaceAdCreatives,
  replaceAdSets,
  writeAdDays,
  writeAdWindows,
  type AdCreativeRow,
  type AdDayRow,
  type AdSetRow,
  type AdWindowRow,
} from "./store.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type AdsOutcome = {
  adAccounts: number;
  ads: number;
  adSets: number;
  days: number;
  windows: number;
  warnings: string[];
};

/**
 * A complete-day span, `offset` days back, as the two inclusive dates Meta's
 * `time_range` wants.
 *
 * TODAY IS NEVER IN ONE. `until` is yesterday for `offset: 0`, which is the
 * same boundary every other window on this box uses and for the same reason: a
 * partial day compared with a complete one falls every morning.
 */
export function span(days: number, offset = 0, from = new Date()) {
  const since = isoDay(dayStart(days + offset, from));
  const until = isoDay(dayStart(1 + offset, from));
  return { since, until };
}

export async function collectAdLevel(): Promise<AdsOutcome> {
  const out: AdsOutcome = {
    adAccounts: 0,
    ads: 0,
    adSets: 0,
    days: 0,
    windows: 0,
    warnings: [],
  };
  const { ready, broken } = accounts.credentialed("meta", ["token"], "collect_ad_level");
  /* SILENCE IS THE ONE THING THIS MAY NOT DO. A connected Meta plugin whose
     accounts carry no readable token, or a set of ad accounts none of which is
     active, both produce zero rows — and a run that reported "nothing" without
     saying which of those it was is a run nobody can act on. */
  for (const b of broken) out.warnings.push(`${b.account.label}: no readable ${b.missing.join(", ")}.`);
  if (!ready.length) {
    if (!broken.length) out.warnings.push("No Meta account is connected, so there are no ad accounts to read.");
    return out;
  }

  /* WHICH AD ACCOUNTS EXIST IS THE META COLLECTOR'S ANSWER, NOT A SECOND
     LISTING. `/me/adaccounts` was already walked half an hour ago and asking
     again would be a second source of truth about the same set — and the one
     that says which accounts are ACTIVE, which is the set worth spending five
     requests each on. An account this box has never collected has no row here
     and is read on the pass after the Meta collector's next one. */
  const stored = metaAdAccounts();
  if (!stored.length) {
    out.warnings.push(
      "No ad account rows yet — this reads the accounts the Meta collector already found, so collect Meta first.",
    );
    return out;
  }

  const week = span(meta.AD_COMPARE_DAYS, 0);
  const before = span(meta.AD_COMPARE_DAYS, meta.AD_COMPARE_DAYS);

  let matched = 0;
  for (const { account, values } of ready) {
    const reader = meta.readerFor(values);
    if (!reader) {
      out.warnings.push(`${account.label}: the stored token has no usable line.`);
      continue;
    }
    for (const row of stored) {
      if (row.account_id !== account.id) continue;
      matched++;
      /* Meta's account_status: 1 is active. Anything else is listed by the
         Meta collector and not queried here, and it is SAID rather than
         skipped in silence — a disabled ad account with no rows and no
         sentence reads exactly like a permission failure. */
      if (row.active !== 1) {
        out.warnings.push(
          `${row.name ?? row.ad_account_id}: account_status ${row.status ?? "unknown"}, not active — no ad-level rows were read for it.`,
        );
        continue;
      }
      out.adAccounts++;
      const id = row.ad_account_id;
      const label = row.name ?? id;

      const seen = "";
      let creatives: AdCreativeRow[] = [];
      /* Set when ANY of this account's four reads came back at its own cap.
         A capped list is a list with rows this box could not see, and the
         `ad_windows` tidy-up at the bottom must not treat those as deleted. */
      let truncated = false;
      try {
        const { rows, capped } = await meta.ads(id, reader.g);
        if (capped) {
          truncated = true;
          out.warnings.push(
            `${label}: the ads edge came back at its ${meta.MAX_ADS}-row limit — there are advertisements this box did not see, and nothing here follows Meta's paging.`,
          );
        }
        creatives = rows.map((a) => ({
          ad_id: a.id,
          ad_account_id: id,
          adset_id: a.adsetId,
          campaign_id: a.campaignId,
          name: a.name,
          status: a.status,
          configured_status: a.configuredStatus,
          creative_id: a.creativeId,
          creative_name: a.creativeName,
          title: a.title,
          body: a.body,
          call_to_action: a.callToAction,
          link_url: a.linkUrl,
          image_url: a.imageUrl,
          thumbnail_url: a.thumbnailUrl,
          issues: a.issues,
          created_time: a.createdTime,
          updated_time: a.updatedTime,
          seen_at: seen,
        }));
        replaceAdCreatives(id, creatives);
        out.ads += creatives.length;
      } catch (err) {
        out.warnings.push(`${label}: the ads edge is unreadable (${message(err)})`);
      }

      try {
        const { rows, capped } = await meta.adSets(id, reader.g);
        if (capped) {
          truncated = true;
          out.warnings.push(
            `${label}: the ad sets edge came back at its ${meta.MAX_ADSETS}-row limit — there are ad sets this box did not see.`,
          );
        }
        const sets: AdSetRow[] = rows.map((s) => ({
          adset_id: s.id,
          ad_account_id: id,
          campaign_id: s.campaignId,
          name: s.name,
          status: s.status,
          optimization_goal: s.optimizationGoal,
          billing_event: s.billingEvent,
          bid_strategy: s.bidStrategy,
          daily_budget: s.dailyBudget,
          lifetime_budget: s.lifetimeBudget,
          currency: row.currency,
          start_time: s.startTime,
          end_time: s.endTime,
          seen_at: seen,
        }));
        replaceAdSets(id, sets);
        out.adSets += sets.length;
      } catch (err) {
        out.warnings.push(`${label}: the ad sets edge is unreadable (${message(err)})`);
      }

      try {
        const { rows, capped } = await meta.adDays(id, reader.g);
        if (capped) {
          truncated = true;
          out.warnings.push(
            `${label}: the per-ad daily series came back at its ${meta.MAX_INSIGHT_ROWS}-row limit — the spend, impressions and clicks joined per venture UNDERSTATE by an amount this box cannot measure.`,
          );
        }
        const days: AdDayRow[] = rows.map((r) => ({
          ad_id: r.adId,
          ad_account_id: id,
          adset_id: r.adsetId,
          campaign_id: r.campaignId,
          day: r.day!,
          impressions: r.impressions,
          reach: r.reach,
          frequency: r.frequency,
          clicks: r.clicks,
          spend: r.spend,
          ctr: r.ctr,
          cpm: r.cpm,
          actions: r.actions ? JSON.stringify(r.actions) : null,
          seen_at: seen,
        }));
        writeAdDays(days);
        out.days += days.length;
      } catch (err) {
        out.warnings.push(`${label}: the per-ad daily series is unreadable (${message(err)})`);
      }

      for (const [offset, range] of [
        [0, week],
        [meta.AD_COMPARE_DAYS, before],
      ] as const) {
        try {
          const { rows, capped } = await meta.adWindow(id, reader.g, range.since, range.until);
          if (capped) {
            truncated = true;
            out.warnings.push(
              `${label}: the ${range.since}–${range.until} window came back at its ${meta.MAX_INSIGHT_ROWS}-row limit — some advertisements have no fatigue comparison for it.`,
            );
          }
          const windows: AdWindowRow[] = rows.map((r) => ({
            ad_id: r.adId,
            ad_account_id: id,
            window_days: meta.AD_COMPARE_DAYS,
            offset_days: offset,
            start_day: range.since,
            end_day: range.until,
            impressions: r.impressions,
            reach: r.reach,
            frequency: r.frequency,
            clicks: r.clicks,
            spend: r.spend,
            ctr: r.ctr,
            cpm: r.cpm,
            seen_at: seen,
          }));
          writeAdWindows(windows);
          out.windows += windows.length;
        } catch (err) {
          out.warnings.push(
            `${label}: the ${range.since}–${range.until} window is unreadable (${message(err)})`,
          );
        }
      }

      /* AN AD THAT NO LONGER EXISTS LOSES ITS WINDOWS BUT KEEPS ITS DAYS.
         The windows are a current comparison and a stale one would be
         compared against a live one; the days are history and history that
         was true stays true after somebody deletes an advertisement.

         AND NOT ONE ROW IS DELETED IF ANY READ WAS TRUNCATED. "Not in the list
         I just fetched" only means "removed at Meta" when the list was the
         whole list. With a capped `ads` edge it means "past the 200th row",
         and deleting on that basis would quietly discard the fatigue
         comparison for every advertisement after the cut — which is the same
         class of error as a silent zero, arriving as a silent deletion. */
      if (creatives.length && !truncated) {
        const live = creatives.map((c) => c.ad_id);
        const q = live.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM ad_windows WHERE ad_account_id = ? AND ad_id NOT IN (${q})`,
        ).run(id, ...live);
      } else if (truncated) {
        out.warnings.push(
          `${label}: stale ad_windows rows were NOT tidied up, because a read was truncated and "absent from a capped list" is not "removed at Meta".`,
        );
      }
    }
  }
  if (!matched)
    out.warnings.push(
      `${stored.length} ad account row(s) exist and none belongs to a Meta account with a readable token on this pass.`,
    );
  return out;
}
