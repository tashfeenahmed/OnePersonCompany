/**
 * CREATIVE FATIGUE AND DELIVERY STATUS, COMPUTED ON THE READ.
 *
 * FATIGUE IS ONE SHAPE AND ONLY ONE: frequency RISING while click-through
 * FALLS, over two matched weeks, on an advertisement that delivered enough in
 * both of them to have a rate at all. That is the shape because it is the one
 * that separates "the creative is spent" from every other bad week — a rising
 * frequency alone is a small audience, a falling click-through alone is an
 * auction or a season, and only the two together say the same people are
 * seeing the same picture and have stopped responding to it.
 *
 * EVERY FIGURE COMES FROM META'S OWN WINDOW ROW, NEVER FROM A SUM. Reach and
 * frequency are de-duplicated over the window Meta was asked about, so a
 * week's frequency cannot be recovered from seven daily rows at any grain.
 * `ad_windows` holds two explicit `time_range` requests for exactly this, and
 * this file reads nothing else for the comparison.
 *
 * THE KILL TABLE IS `growth/ads.ts`'S AND IS DELIBERATELY THE SAME NUMBERS.
 * Under a thousand impressions in either week there is no verdict — not a
 * cautious one, none. Meta's percentages on four hundred impressions are a
 * rounding error wearing a percentage sign, and an ad-level view sees far more
 * rows that small than an account-level one does.
 *
 * A VERDICT IS NEVER A RECOMMENDATION TO TURN SOMETHING OFF. The evidence
 * lines carry both weeks' figures so a reader can disagree with the rubric,
 * which is the only defensible way to publish a judgement made of two ratios.
 */
import type { AdCreativeRow, AdSetRow, AdWindowRow } from "./store.ts";

/* ------------------------------------------------------------------ bands */

/** Impressions an advertisement needs in BOTH weeks before it gets a verdict.
 *  growth/ads.ts's MIN_IMPRESSIONS_TO_KILL, for its reason. */
export const MIN_IMPRESSIONS = 1000;
/** A click-through fall this large, week on week, is the falling half. */
export const CTR_DROP_WARN = 0.1;
export const CTR_DROP_FAIL = 0.2;
/** And frequency must have gone UP by at least this much, so a fall in
 *  click-through at flat frequency is not called fatigue. */
export const FREQ_RISE = 0.05;
/** Past this frequency in the current week the advertisement is repeating
 *  itself whatever the trend says — three exposures is workdash's and
 *  growth/ads.ts's bar, and it is a separate finding rather than fatigue. */
export const FREQ_HIGH = 3.0;

export type Verdict = "fatigued" | "tiring" | "steady" | "no-verdict";

export type FatigueRow = {
  adId: string;
  adAccountId: string;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  name: string | null;
  status: string | null;
  imageUrl: string | null;
  verdict: Verdict;
  /** Why there is no verdict, where there is none. Never a quiet "steady". */
  why: string | null;
  week: WindowFigures | null;
  before: WindowFigures | null;
  /** Proportional changes, null where either side could not be measured. */
  ctrChange: number | null;
  frequencyChange: number | null;
  evidence: string[];
};

export type WindowFigures = {
  startDay: string;
  endDay: string;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  spend: number | null;
  ctr: number | null;
  cpm: number | null;
};

const figures = (r: AdWindowRow): WindowFigures => ({
  startDay: r.start_day,
  endDay: r.end_day,
  impressions: r.impressions,
  reach: r.reach,
  frequency: r.frequency,
  clicks: r.clicks,
  spend: r.spend,
  ctr: r.ctr,
  cpm: r.cpm,
});

const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

/** A proportional change, or null when there is nothing to divide by. A rise
 *  from nothing is a start, not an infinite percentage. */
function change(now: number | null, was: number | null): number | null {
  if (now === null || was === null || was === 0) return null;
  return round((now - was) / was);
}

/**
 * One advertisement's fatigue reading.
 *
 * Exported and pure so the rubric can be tested against fixtures without a
 * database or a network — the arithmetic is the product here, and an
 * arithmetic nobody can run against a made-up row is an arithmetic nobody can
 * check.
 */
export function fatigueOf(
  ad: AdCreativeRow,
  week: AdWindowRow | undefined,
  before: AdWindowRow | undefined,
  adsetName: string | null,
): FatigueRow {
  const base: Omit<FatigueRow, "verdict" | "why" | "evidence" | "ctrChange" | "frequencyChange"> = {
    adId: ad.ad_id,
    adAccountId: ad.ad_account_id,
    adsetId: ad.adset_id,
    adsetName,
    campaignId: ad.campaign_id,
    name: ad.name,
    status: ad.status,
    imageUrl: ad.image_url ?? ad.thumbnail_url,
    week: week ? figures(week) : null,
    before: before ? figures(before) : null,
  };

  if (!week || !before)
    return {
      ...base,
      verdict: "no-verdict",
      why: !week
        ? "Meta reported no delivery for this advertisement in the last 7 complete days."
        : "There is no matched previous week to compare against — Meta reported no delivery in the 7 days before.",
      ctrChange: null,
      frequencyChange: null,
      evidence: [],
    };

  const ctrChange = change(week.ctr, before.ctr);
  const frequencyChange = change(week.frequency, before.frequency);
  const impressions = [week.impressions, before.impressions];

  if (impressions.some((n) => n === null || n < MIN_IMPRESSIONS))
    return {
      ...base,
      verdict: "no-verdict",
      why:
        `Under ${MIN_IMPRESSIONS} impressions in one of the two weeks ` +
        `(${week.impressions ?? "not reported"} and ${before.impressions ?? "not reported"}). ` +
        "A click-through rate on that few impressions moves by a fifth every time one more person clicks.",
      ctrChange,
      frequencyChange,
      evidence: [],
    };

  const evidence = [
    `Click-through ${week.ctr === null ? "not reported" : `${round(week.ctr, 4)}%`} in ` +
      `${week.start_day}–${week.end_day}, against ` +
      `${before.ctr === null ? "not reported" : `${round(before.ctr, 4)}%`} in ` +
      `${before.start_day}–${before.end_day}` +
      (ctrChange === null ? "." : ` — ${round(ctrChange * 100, 1)}%.`),
    `Frequency ${week.frequency === null ? "not reported" : round(week.frequency, 2)} against ` +
      `${before.frequency === null ? "not reported" : round(before.frequency, 2)}` +
      (frequencyChange === null ? "." : ` — ${round(frequencyChange * 100, 1)}%.`),
    `Both figures are META'S OWN for those exact windows. Reach and frequency are de-duplicated ` +
      `per window and neither was derived from daily rows.`,
    `${week.impressions} impressions this week, ${before.impressions} the week before.`,
  ];

  if (ctrChange === null || frequencyChange === null)
    return {
      ...base,
      verdict: "no-verdict",
      why: "One of the two rates was not reported in one of the weeks, so there is no trend to read.",
      ctrChange,
      frequencyChange,
      evidence,
    };

  const falling = -ctrChange;
  const rising = frequencyChange >= FREQ_RISE;

  if (rising && falling >= CTR_DROP_FAIL)
    return {
      ...base,
      verdict: "fatigued",
      why: null,
      ctrChange,
      frequencyChange,
      evidence: [
        ...evidence,
        `Frequency rose past the ${FREQ_RISE * 100}% bar while click-through fell past the ` +
          `${CTR_DROP_FAIL * 100}% bar. That is the fatigue shape: the same people, the same ` +
          `picture, fewer clicks.`,
      ],
    };

  if (rising && falling >= CTR_DROP_WARN)
    return {
      ...base,
      verdict: "tiring",
      why: null,
      ctrChange,
      frequencyChange,
      evidence: [
        ...evidence,
        `Frequency rose and click-through fell past the ${CTR_DROP_WARN * 100}% bar but not the ` +
          `${CTR_DROP_FAIL * 100}% one. One more week decides it.`,
      ],
    };

  return {
    ...base,
    verdict: "steady",
    why: null,
    ctrChange,
    frequencyChange,
    evidence: [
      ...evidence,
      week.frequency !== null && week.frequency >= FREQ_HIGH
        ? `Not the fatigue shape — but frequency is ${round(week.frequency, 2)} this week, past ` +
          `${FREQ_HIGH}: the same people are seeing it three times over. That is a separate ` +
          `finding and NOT a claim about audience overlap, which this box cannot measure.`
        : "Not the fatigue shape: click-through and frequency did not both move the wrong way.",
    ],
  };
}

/** Every advertisement in a list, read against its two windows. */
export function fatigueRows(
  ads: AdCreativeRow[],
  windows: AdWindowRow[],
  sets: AdSetRow[],
  compareDays: number,
): FatigueRow[] {
  const byAd = new Map<string, { week?: AdWindowRow; before?: AdWindowRow }>();
  for (const w of windows) {
    if (w.window_days !== compareDays) continue;
    const at = byAd.get(w.ad_id) ?? {};
    if (w.offset_days === 0) at.week = w;
    else if (w.offset_days === compareDays) at.before = w;
    byAd.set(w.ad_id, at);
  }
  const setNames = new Map(sets.map((s) => [s.adset_id, s.name]));
  return ads.map((ad) =>
    fatigueOf(ad, byAd.get(ad.ad_id)?.week, byAd.get(ad.ad_id)?.before, ad.adset_id ? setNames.get(ad.adset_id) ?? null : null),
  );
}

/* --------------------------------------------------------------- statuses */

export type StatusRow = {
  adId: string;
  adAccountId: string;
  name: string | null;
  status: string | null;
  configuredStatus: string | null;
  adsetId: string | null;
  campaignId: string | null;
  /** Meta's own issues_info, parsed but not paraphrased. */
  issues: unknown[];
  /** Configured ACTIVE, effectively not running — which is the state worth a
   *  page, because it looks live in the interface it was set up in. */
  mismatched: boolean;
};

/**
 * The delivery and disapproval view.
 *
 * THE ISSUE TEXT IS META'S, VERBATIM. A disapproval is a statement about
 * Meta's own policy and paraphrasing it would be inventing a reason; if the
 * field is absent the advertisement has no issue Meta chose to report, which
 * is not the same as an advertisement in good standing and the document says
 * so.
 *
 * `mismatched` IS THE ONE DERIVED FLAG and it is a comparison, not a judgement:
 * `configured_status` is what somebody set and `effective_status` is what is
 * happening after the parents and Meta's vetoes fold in. ACTIVE against
 * anything else means the advertisement reads as live where it was set up and
 * is not delivering.
 */
export function statusRows(ads: AdCreativeRow[]): StatusRow[] {
  return ads.map((ad) => {
    let issues: unknown[] = [];
    if (ad.issues) {
      try {
        const parsed = JSON.parse(ad.issues) as unknown;
        if (Array.isArray(parsed)) issues = parsed;
      } catch {
        /* Stored as Meta sent it; unparseable means it is reported as absent
           rather than as a fabricated issue. */
      }
    }
    return {
      adId: ad.ad_id,
      adAccountId: ad.ad_account_id,
      name: ad.name,
      status: ad.status,
      configuredStatus: ad.configured_status,
      adsetId: ad.adset_id,
      campaignId: ad.campaign_id,
      issues,
      mismatched: ad.configured_status === "ACTIVE" && ad.status !== "ACTIVE",
    };
  });
}
