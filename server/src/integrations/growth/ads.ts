/**
 * THE AD ACCOUNT'S HEALTH, AS A SCORE WITH THE ARITHMETIC WRITTEN DOWN.
 *
 * WHY A SCORE AT ALL. `/api/meta` reports what Meta said — spend, impressions,
 * clicks, reach, frequency, leads, cost per lead, per account and per campaign
 * — and stops there, which is correct for a route that publishes a
 * measurement. Nothing on this box then said whether any of it was GOING WRONG,
 * and paid media is the one place where a bad fortnight costs cash rather than
 * a rank. So this reads those same rows and applies a rubric.
 *
 * NO MODEL RUNS HERE, AND EVERY FIGURE IS DIVISION. Checks with ids, pass/warn/
 * fail bands, severity weights, category weights, and a coverage floor under
 * which a subscore is refused rather than guessed. A model asked to grade an ad
 * account would give a different grade every day from the same rows.
 *
 * FOUR RULES THIS WAS BUILT AROUND
 * --------------------------------
 * 1. N/A IS EXCLUDED FROM THE DENOMINATOR. A check that could not be evaluated
 *    is not a check that failed. That is what stops an account with no lead
 *    tracking from scoring 40 for the absence of a measurement.
 *
 * 2. THE KILL TABLE GATES EVERY VERDICT. Under seven days of delivery and
 *    twenty clicks a campaign gets no verdict at all — not a cautious one,
 *    none. Under a thousand impressions nothing may be called dead. Meta's
 *    percentages on a four-click campaign are a rounding error wearing a
 *    percentage sign.
 *
 * 3. THE TARGET COST PER LEAD IS THIS ACCOUNT'S OWN. Never a benchmark and
 *    never a figure from an article: it is the account's own cost per lead over
 *    its own window, and where the account has none, every check that needs one
 *    is null rather than measured against a number somebody made up.
 *
 * 4. NOTHING IS COMPARED ACROSS ACCOUNTS. Each account's money is in its own
 *    currency, its rubric is scored on its own figures, and two scores from two
 *    accounts are two different rubrics' outputs that happen to share a scale.
 *
 * WHAT IT CANNOT SEE, AND SAYS SO. `limitations` is part of the reading rather
 * than a footnote, and three of the things this feature was asked for are in
 * it: there is no AD SET anywhere in what the collector stores, so a
 * learning-limited set cannot be detected; there is no AD row, so a disapproved
 * ad cannot be seen; and there is no audience specification, so overlap can
 * only be inferred from frequency and is named as an inference. Each of those
 * is a null check that names itself rather than a check quietly skipped.
 */
import { db } from "../../db.ts";

/* -------------------------------------------------------------- constants */

/** Severity multipliers. A critical check is ten times a low one, not twice
 *  it, so one broken lead form outweighs four long-running campaigns. */
const WEIGHT: Record<string, number> = { critical: 5, high: 3, medium: 1.5, low: 0.5 };

/** Category weights. Creative and tracking carry 30 each because they are the
 *  two things that can be wrong in a way that wastes every euro — nobody sees
 *  the ad, or nobody can tell whether they responded. Structure and audience
 *  carry 20: a badly-shaped account with working creative and working tracking
 *  still buys leads, just fewer of them. */
const CATEGORIES: Record<string, number> = { creative: 30, tracking: 30, structure: 20, audience: 20 };

const VALUE: Record<string, number> = { pass: 1, warn: 0.5, fail: 0 };

/** Below this share of a category's weight, the subscore is refused. The one
 *  failure this may not have is a confident 100 drawn from two checks. */
const COVERAGE_MIN = 0.4;
/** Fewer live categories than this and the whole score is refused. */
const MIN_LIVE_CATEGORIES = 2;

/* ------------------------------------------------------------- kill table */

/** Seven days because a week contains every day of the week, and delivery on a
 *  Sunday is not delivery on a Tuesday. */
const MIN_DAYS = 7;
/** Twenty clicks, because below that a click-through rate moves by a fifth
 *  every time one more person clicks. */
const MIN_CLICKS = 20;
/** A thousand impressions before anything may be called dead: turning a
 *  creative off is irreversible in practice, and a run of bad luck over nine
 *  hundred impressions is a run of bad luck. */
const MIN_IMPRESSIONS_TO_KILL = 1000;

/* ----------------------------------------------------------------- bands */

/** Frequency. About two exposures is a campaign reaching new people; three is
 *  a campaign repeating itself; past three is paying to annoy. */
const FREQ_WARN = 2.0;
const FREQ_FAIL = 3.0;
/** The overlap shape: more than one delivering campaign above this. */
const FREQ_OVERLAP = 2.5;
/** A week-on-week click-through fall this large is fatigue. */
const CTR_DROP_WARN = 0.1;
const CTR_DROP_FAIL = 0.2;
/** A week-on-week cost-per-thousand rise this large is the auction moving
 *  against the account. */
const CPM_RISE_WARN = 0.2;
const CPM_RISE_FAIL = 0.4;
/** Spend past this multiple of the target with no lead at all. */
const ZERO_LEAD_MULTIPLE = 3;
/** Daily spend a lead-buying campaign needs before delivery can learn. */
const BUDGET_ADEQUACY_MULTIPLE = 5;
/** A campaign under half the account's own median click-through, over the kill
 *  table's impressions, is not being clicked. */
const DEAD_CTR_SHARE = 0.5;

/* ------------------------------------------------------------- the checks */

type Sev = "critical" | "high" | "medium" | "low";
type CheckDef = { cat: string; sev: Sev; title: string; what: string; fix: string };

const CHECKS: Record<string, CheckDef> = {
  "ctr-trend": {
    cat: "creative",
    sev: "critical",
    title: "Click-through is falling week on week",
    what: `Click-through over the last 7 days against the 7 before it. A fall past ${CTR_DROP_FAIL * 100}% is creative wearing out.`,
    fix: "Replace the image and the headline. Keep the offer; it is the creative that is spent, not the audience.",
  },
  "cpm-trend": {
    cat: "creative",
    sev: "medium",
    title: "It costs more to be seen than it did last week",
    what: `Cost per thousand impressions over the last 7 days against the 7 before it. A rise past ${CPM_RISE_FAIL * 100}% is the auction moving against this account.`,
    fix: "Check what changed in targeting or budget. A rising CPM with a flat CTR is competition; a rising CPM with a falling CTR is the creative.",
  },
  "campaign-not-clicked": {
    cat: "creative",
    sev: "high",
    title: "A campaign is not being clicked",
    what: `Click-through under ${DEAD_CTR_SHARE * 100}% of this account's own median campaign CTR, over at least ${MIN_IMPRESSIONS_TO_KILL} impressions.`,
    fix: "Turn it off. That many impressions is enough to know, and the budget is being spent proving it again.",
  },
  "lead-action-reported": {
    cat: "tracking",
    sev: "critical",
    title: "No lead is being reported",
    what: "Not one delivering campaign in the window reported a lead action, so nothing in this account can be judged on outcome.",
    fix: "Check the instant form or the pixel's lead event. Until this reports, every other figure here is a cost with no result beside it.",
  },
  "cpl-reported": {
    cat: "tracking",
    sev: "high",
    title: "Meta is not costing the leads",
    what: "The cost-per-action field came back empty, so any cost per lead is this app's own division rather than the platform's figure.",
    fix: "Nothing to fix if the lead count is right — but check the two agree in Ads Manager before acting on a cost per lead from here.",
  },
  "zero-lead-spend": {
    cat: "tracking",
    sev: "critical",
    title: "Spending with nothing to show",
    what: `A campaign has spent more than ${ZERO_LEAD_MULTIPLE}× this account's own cost per lead and produced none.`,
    fix: "Pause it. Three times the target with no result is past the point where the next lead makes it worth it.",
  },
  "budget-adequacy": {
    cat: "structure",
    sev: "high",
    title: "A campaign is too small to learn",
    what: `Daily spend under ${BUDGET_ADEQUACY_MULTIPLE}× this account's own cost per lead, which is below what delivery needs to leave the learning phase.`,
    fix: "Consolidate campaigns or raise this one. Several starved campaigns buy fewer leads than one fed one.",
  },
  "objective-matches-leads": {
    cat: "structure",
    sev: "medium",
    title: "A campaign is not optimising for leads",
    what: "This account reports lead actions, and a campaign's objective asks Meta for something else — link clicks or messages.",
    fix: "Rebuild it under a leads objective, or accept that its cost per lead is an accident rather than a target.",
  },
  "something-delivering": {
    cat: "structure",
    sev: "medium",
    title: "Nothing is running",
    what: "Every campaign in the window is paused or inactive.",
    fix: "Nothing to fix if this is deliberate. If it is not, the account is spending nothing and learning nothing.",
  },
  "account-frequency": {
    cat: "audience",
    sev: "high",
    title: "The same people are seeing this too often",
    what: `The account's frequency over the window. Past ${FREQ_FAIL} the spend is going to people who have already decided.`,
    fix: "Broaden the targeting or cap the frequency. At this level the extra budget is buying repeats, not reach.",
  },
  "campaign-overlap-signal": {
    cat: "audience",
    sev: "medium",
    title: "Two campaigns may be bidding against each other",
    what: `More than one delivering campaign above a frequency of ${FREQ_OVERLAP} — the shape overlap makes, though nothing here can prove it.`,
    fix: "Check the audience definitions for overlap in Audience Manager, or merge them.",
  },
  "audience-spec-visible": {
    cat: "audience",
    sev: "low",
    title: "Targeting cannot be read from here",
    what: "Nothing this box collects carries an audience specification, so overlap, exclusions and lookalike ratios cannot be measured at all.",
    fix: "Nothing to do. This check exists so the audience subscore says what it is missing rather than scoring around it.",
  },
  "adset-learning-state": {
    cat: "structure",
    sev: "medium",
    title: "Learning-limited ad sets cannot be seen",
    what: "The Meta collector stores accounts, campaigns and daily totals. There is no AD SET row anywhere, and 'learning limited' is an ad-set state, so it cannot be detected from here.",
    fix: "Read it in Ads Manager. This check is null on purpose so the structure subscore is not a claim about something nobody looked at.",
  },
  "ads-review-status": {
    cat: "creative",
    sev: "medium",
    title: "Disapproved ads cannot be seen",
    what: "There is no AD row in what the collector stores, so an ad rejected in review is invisible to this box.",
    fix: "Read it in Ads Manager. Null here rather than a pass by silence.",
  },
};

type Result = "pass" | "warn" | "fail" | null;
type CheckRow = { id: string; cat: string; sev: Sev; result: Result; detail: string; scope: string };

/* ---------------------------------------------------------------- inputs */

type AccountRow = {
  ad_account_id: string;
  name: string | null;
  currency: string | null;
  active: number;
  status: number | null;
  window_from: string | null;
  window_to: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  cpc: number | null;
  ctr: number | null;
  reach: number | null;
  frequency: number | null;
  leads: number | null;
  cost_per_lead: number | null;
  seen_at: string;
};

type CampaignRow = {
  campaign_id: string;
  name: string | null;
  status: string | null;
  objective: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  frequency: number | null;
  leads: number | null;
  cost_per_lead: number | null;
};

type DayRow = { day: string; spend: number | null; impressions: number | null; clicks: number | null; leads: number | null };

const round = (v: number, dp = 2) => Number(v.toFixed(dp));

/** The two seven-day halves of the most recent fortnight of days this account
 *  has, and the CTR and CPM of each. Null where a half is too thin to speak. */
function fortnight(days: DayRow[]): {
  recent: { ctr: number | null; cpm: number | null; clicks: number; impressions: number; days: number };
  prior: { ctr: number | null; cpm: number | null; clicks: number; impressions: number; days: number };
} {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const last14 = sorted.slice(-14);
  const half = (rows: DayRow[]) => {
    const impressions = rows.reduce((n, r) => n + (r.impressions ?? 0), 0);
    const clicks = rows.reduce((n, r) => n + (r.clicks ?? 0), 0);
    const spend = rows.reduce((n, r) => n + (r.spend ?? 0), 0);
    return {
      ctr: impressions > 0 ? round((100 * clicks) / impressions, 4) : null,
      cpm: impressions > 0 ? round((1000 * spend) / impressions, 4) : null,
      clicks,
      impressions,
      days: rows.length,
    };
  };
  return { recent: half(last14.slice(-7)), prior: half(last14.slice(0, Math.max(0, last14.length - 7))) };
}

function medianOf(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/* --------------------------------------------------------------- the checks */

function evaluate(account: AccountRow, campaigns: CampaignRow[], days: DayRow[]) {
  const rows: CheckRow[] = [];
  const add = (id: string, result: Result, detail: string, scope = "account") =>
    rows.push({ id, cat: CHECKS[id]!.cat, sev: CHECKS[id]!.sev, result, detail, scope });

  const windowDays = days.length;
  const enough = windowDays >= MIN_DAYS && (account.clicks ?? 0) >= MIN_CLICKS;
  const killNote = `the kill table: ${MIN_DAYS} days of delivery and ${MIN_CLICKS} clicks. This account has ${windowDays} days and ${account.clicks ?? 0} clicks.`;

  /* ---- creative ---- */
  const f = fortnight(days);
  if (!enough) add("ctr-trend", null, `Not enough delivery to compare two weeks — ${killNote}`);
  else if (f.recent.ctr === null || f.prior.ctr === null || f.prior.days < MIN_DAYS)
    add(
      "ctr-trend",
      null,
      f.prior.days < MIN_DAYS
        ? `There are only ${f.recent.days + f.prior.days} days of daily rows for this account, so the earlier week is ${f.prior.days} day${f.prior.days === 1 ? "" : "s"} long — under the ${MIN_DAYS}-day floor, and a week compared against ${f.prior.days} days is not a week-on-week comparison.`
        : `One of the two weeks has no impressions to divide by (recent ${f.recent.impressions}, prior ${f.prior.impressions}).`,
    );
  else {
    const change = (f.recent.ctr - f.prior.ctr) / f.prior.ctr;
    add(
      "ctr-trend",
      change <= -CTR_DROP_FAIL ? "fail" : change <= -CTR_DROP_WARN ? "warn" : "pass",
      `CTR ${f.recent.ctr}% over the last ${f.recent.days} days against ${f.prior.ctr}% over the ${f.prior.days} before: ${round(change * 100, 1)}%. Bands: −${CTR_DROP_WARN * 100}% warns, −${CTR_DROP_FAIL * 100}% fails.`,
    );
  }

  if (!enough) add("cpm-trend", null, `Not enough delivery to compare two weeks — ${killNote}`);
  else if (f.recent.cpm === null || f.prior.cpm === null || f.prior.days < MIN_DAYS)
    add(
      "cpm-trend",
      null,
      f.prior.days < MIN_DAYS
        ? `The earlier week is only ${f.prior.days} day${f.prior.days === 1 ? "" : "s"} long — under the ${MIN_DAYS}-day floor.`
        : "One of the two weeks has no impressions to divide by.",
    );
  else {
    const change = (f.recent.cpm - f.prior.cpm) / f.prior.cpm;
    add(
      "cpm-trend",
      change >= CPM_RISE_FAIL ? "fail" : change >= CPM_RISE_WARN ? "warn" : "pass",
      `CPM ${f.recent.cpm} ${account.currency ?? ""} over the last ${f.recent.days} days against ${f.prior.cpm} over the ${f.prior.days} before: ${round(change * 100, 1)}%. Bands: +${CPM_RISE_WARN * 100}% warns, +${CPM_RISE_FAIL * 100}% fails.`,
    );
  }

  const deliverable = campaigns.filter((c) => (c.impressions ?? 0) >= MIN_IMPRESSIONS_TO_KILL && c.ctr !== null);
  const medianCtr = medianOf(deliverable.map((c) => c.ctr!));
  if (medianCtr === null || deliverable.length < 2)
    add(
      "campaign-not-clicked",
      null,
      `Needs at least two campaigns with ${MIN_IMPRESSIONS_TO_KILL}+ impressions to have a median to compare against; there ${deliverable.length === 1 ? "is 1" : `are ${deliverable.length}`}.`,
      "campaign",
    );
  else {
    const dead = deliverable.filter((c) => c.ctr! < medianCtr * DEAD_CTR_SHARE);
    add(
      "campaign-not-clicked",
      dead.length ? "fail" : "pass",
      dead.length
        ? `${dead.length} of ${deliverable.length} campaigns are under ${DEAD_CTR_SHARE * 100}% of this account's own median CTR (${round(medianCtr, 3)}%): ${dead.map((c) => `${c.name ?? c.campaign_id} at ${round(c.ctr!, 3)}%`).join("; ")}.`
        : `All ${deliverable.length} campaigns with ${MIN_IMPRESSIONS_TO_KILL}+ impressions are above ${DEAD_CTR_SHARE * 100}% of the account's own median CTR (${round(medianCtr, 3)}%).`,
      "campaign",
    );
  }

  add("ads-review-status", null, CHECKS["ads-review-status"]!.what);

  /* ---- tracking ---- */
  const leads = account.leads ?? 0;
  add(
    "lead-action-reported",
    leads > 0 ? "pass" : "fail",
    leads > 0
      ? `${leads} lead actions over ${account.window_from} to ${account.window_to}.`
      : `No lead action was reported over ${account.window_from} to ${account.window_to}. Every other figure here is a cost with no result beside it.`,
  );

  add(
    "cpl-reported",
    account.cost_per_lead !== null ? "pass" : leads > 0 ? "fail" : null,
    account.cost_per_lead !== null
      ? `Meta reported ${account.cost_per_lead} ${account.currency ?? ""} per lead.`
      : leads > 0
        ? "Leads were reported but Meta gave no cost per action, so any figure would be this app's own division."
        : "There are no leads, so there is no cost per lead to report and nothing to check.",
  );

  /* THE TARGET IS THE ACCOUNT'S OWN and there is no fallback. Without it every
     check that needs a target is null — never measured against a benchmark. */
  const target = account.cost_per_lead;
  const spending = campaigns.filter((c) => (c.spend ?? 0) > 0);
  if (target === null)
    add("zero-lead-spend", null, "This account has no cost per lead of its own, and no benchmark is ever substituted, so there is no target to measure spend against.", "campaign");
  else {
    const burning = spending.filter((c) => (c.leads ?? 0) === 0 && (c.spend ?? 0) > target * ZERO_LEAD_MULTIPLE);
    add(
      "zero-lead-spend",
      burning.length ? "fail" : "pass",
      burning.length
        ? `${burning.length} campaign${burning.length === 1 ? "" : "s"} spent past ${ZERO_LEAD_MULTIPLE}× the account's own ${target} ${account.currency ?? ""} cost per lead with no lead: ${burning.map((c) => `${c.name ?? c.campaign_id} at ${c.spend}`).join("; ")}.`
        : `No spending campaign is past ${ZERO_LEAD_MULTIPLE}× the account's own ${target} ${account.currency ?? ""} cost per lead with nothing to show.`,
      "campaign",
    );
  }

  /* ---- structure ---- */
  if (target === null || !windowDays)
    add("budget-adequacy", null, "No cost per lead of this account's own, so there is no floor to compare a daily budget against.", "campaign");
  else {
    const floor = target * BUDGET_ADEQUACY_MULTIPLE;
    const starved = spending.filter((c) => (c.spend ?? 0) / windowDays < floor);
    add(
      "budget-adequacy",
      starved.length === 0 ? "pass" : starved.length === spending.length ? "fail" : "warn",
      `Daily spend needs ${round(floor, 2)} ${account.currency ?? ""} (${BUDGET_ADEQUACY_MULTIPLE}× the account's own cost per lead). ${starved.length} of ${spending.length} spending campaigns are under it: ${starved.map((c) => `${c.name ?? c.campaign_id} at ${round((c.spend ?? 0) / windowDays, 2)}/day`).join("; ") || "none"}.`,
      "campaign",
    );
  }

  if (leads === 0) add("objective-matches-leads", null, "This account reports no leads, so there is no evidence about what it is buying and no objective to check against.", "campaign");
  else {
    const wrong = spending.filter((c) => (c.objective ?? "").toUpperCase() !== "LEAD_GENERATION");
    add(
      "objective-matches-leads",
      wrong.length === 0 ? "pass" : wrong.length === spending.length ? "fail" : "warn",
      `This account reported ${leads} leads. ${wrong.length} of ${spending.length} spending campaigns ask Meta for something else: ${wrong.map((c) => `${c.name ?? c.campaign_id} (${c.objective ?? "no objective"})`).join("; ") || "none"}.`,
      "campaign",
    );
  }

  const live = campaigns.filter((c) => (c.status ?? "").toUpperCase() === "ACTIVE");
  add(
    "something-delivering",
    live.length ? "pass" : "fail",
    live.length
      ? `${live.length} of ${campaigns.length} campaigns are ACTIVE.`
      : `All ${campaigns.length} campaigns are paused or inactive as of the last collection (${account.seen_at}).`,
    "campaign",
  );

  add("adset-learning-state", null, CHECKS["adset-learning-state"]!.what);

  /* ---- audience ---- */
  if (account.frequency === null) add("account-frequency", null, "Meta reported no frequency for this window.");
  else
    add(
      "account-frequency",
      account.frequency >= FREQ_FAIL ? "fail" : account.frequency >= FREQ_WARN ? "warn" : "pass",
      `Frequency ${round(account.frequency, 2)} over ${account.window_from} to ${account.window_to} — impressions ÷ reach, and reach is de-duplicated over THAT window and cannot be summed with any other. Bands: ${FREQ_WARN} warns, ${FREQ_FAIL} fails.`,
    );

  const busy = campaigns.filter((c) => (c.frequency ?? 0) > FREQ_OVERLAP && (c.impressions ?? 0) > 0);
  add(
    "campaign-overlap-signal",
    busy.length > 1 ? "warn" : "pass",
    busy.length > 1
      ? `${busy.length} campaigns are above a frequency of ${FREQ_OVERLAP}: ${busy.map((c) => `${c.name ?? c.campaign_id} at ${round(c.frequency!, 2)}`).join("; ")}. That is the SHAPE overlap makes and is not proof of it — nothing here can read an audience definition.`
      : `At most one campaign is above ${FREQ_OVERLAP}, so there is no overlap shape to report.`,
    "campaign",
  );

  add("audience-spec-visible", null, CHECKS["audience-spec-visible"]!.what);

  return rows;
}

/* --------------------------------------------------------------- scoring */

function grade(score: number | null): string | null {
  if (score === null) return null;
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function score(rows: CheckRow[]) {
  const cats: Record<string, { weight: number; coverage: number; score: number | null; reason: string | null }> = {};
  const arithmetic: string[] = [];

  for (const [cat, weight] of Object.entries(CATEGORIES)) {
    const all = Object.entries(CHECKS).filter(([, d]) => d.cat === cat);
    const possible = all.reduce((n, [, d]) => n + WEIGHT[d.sev]!, 0);
    let evaluated = 0;
    let earned = 0;
    for (const r of rows) {
      if (r.cat !== cat || r.result === null) continue;
      evaluated += WEIGHT[r.sev]!;
      earned += WEIGHT[r.sev]! * VALUE[r.result]!;
    }
    const coverage = possible ? evaluated / possible : 0;
    const live = evaluated > 0 && coverage >= COVERAGE_MIN;
    cats[cat] = {
      weight,
      coverage: round(coverage, 2),
      score: live ? Math.round((100 * earned) / evaluated) : null,
      reason: live
        ? null
        : evaluated === 0
          ? "nothing in this category could be evaluated"
          : `only ${Math.round(coverage * 100)}% of this category's severity weight could be evaluated; the floor is ${COVERAGE_MIN * 100}%`,
    };
    arithmetic.push(
      live
        ? `${cat}: ${round(earned, 2)} severity-weighted points earned over ${round(evaluated, 2)} evaluated = ${cats[cat]!.score}, category weight ${weight}`
        : `${cat}: refused — ${cats[cat]!.reason}`,
    );
  }

  const names = Object.keys(CATEGORIES);
  const coverage = round(names.reduce((n, c) => n + CATEGORIES[c]! * cats[c]!.coverage, 0) / 100, 2);
  const liveNames = names.filter((c) => cats[c]!.score !== null);
  if (liveNames.length < MIN_LIVE_CATEGORIES)
    return {
      score: null,
      grade: null,
      coverage,
      categories: cats,
      refusal: `only ${liveNames.length} of ${names.length} categories could be scored, which is not enough of an account to grade`,
      arithmetic,
    };
  const weight = liveNames.reduce((n, c) => n + CATEGORIES[c]!, 0);
  const total = Math.round(liveNames.reduce((n, c) => n + CATEGORIES[c]! * cats[c]!.score!, 0) / weight);
  arithmetic.push(
    `score = (${liveNames.map((c) => `${CATEGORIES[c]}×${cats[c]!.score}`).join(" + ")}) ÷ ${weight} = ${total}. Refused categories are out of both sides of that division.`,
  );
  return { score: total, grade: grade(total), coverage, categories: cats, refusal: null, arithmetic };
}

/* ---------------------------------------------------------------- the read */

export function adsHealthFor(accountId: string) {
  const account = db.prepare("SELECT * FROM meta_ad_accounts WHERE ad_account_id = ?").get(accountId) as AccountRow | undefined;
  if (!account) return null;
  const campaigns = db
    .prepare(
      "SELECT campaign_id, name, status, objective, spend, impressions, clicks, ctr, frequency, leads, cost_per_lead FROM meta_campaigns WHERE ad_account_id = ? ORDER BY spend DESC",
    )
    .all(accountId) as unknown as CampaignRow[];
  const days = db
    .prepare("SELECT day, spend, impressions, clicks, leads FROM meta_ad_days WHERE ad_account_id = ? ORDER BY day")
    .all(accountId) as unknown as DayRow[];

  const rows = evaluate(account, campaigns, days);
  const scored = score(rows);
  const failing = rows
    .filter((r) => r.result === "fail" || r.result === "warn")
    .sort((a, b) => WEIGHT[b.sev]! - WEIGHT[a.sev]!)
    .map((r) => ({
      id: r.id,
      category: r.cat,
      severity: r.sev,
      result: r.result,
      title: CHECKS[r.id]!.title,
      what: CHECKS[r.id]!.what,
      fix: CHECKS[r.id]!.fix,
      detail: r.detail,
    }));

  return {
    account: {
      id: account.ad_account_id,
      name: account.name,
      /** Every money figure below is in THIS currency. Two accounts' scores
       *  share a scale and nothing else. */
      currency: account.currency,
      active: account.active === 1,
      window: { from: account.window_from, to: account.window_to, days: days.length },
      spend: account.spend,
      impressions: account.impressions,
      clicks: account.clicks,
      ctr: account.ctr,
      reach: account.reach,
      frequency: account.frequency,
      leads: account.leads,
      costPerLead: account.cost_per_lead,
      seenAt: account.seen_at,
    },
    score: scored.score,
    grade: scored.grade,
    coverage: scored.coverage,
    refusal: scored.refusal,
    categories: scored.categories,
    /** The working, printed so a reader can check the score by hand. */
    arithmetic: scored.arithmetic,
    weights: { categories: CATEGORIES, severity: WEIGHT, value: VALUE, coverageFloor: COVERAGE_MIN },
    killTable: { minDays: MIN_DAYS, minClicks: MIN_CLICKS, minImpressionsToKill: MIN_IMPRESSIONS_TO_KILL },
    target: {
      costPerLead: account.cost_per_lead,
      basis:
        "This account's OWN cost per lead over its own window. No benchmark is ever substituted — where the account has none, every check that needs a target is null.",
    },
    checks: rows.map((r) => ({
      id: r.id,
      category: r.cat,
      severity: r.sev,
      scope: r.scope,
      result: r.result,
      title: CHECKS[r.id]!.title,
      detail: r.detail,
      fix: CHECKS[r.id]!.fix,
    })),
    failing,
    campaigns: campaigns.map((c) => ({
      id: c.campaign_id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      spend: c.spend,
      impressions: c.impressions,
      clicks: c.clicks,
      ctr: c.ctr,
      frequency: c.frequency,
      leads: c.leads,
      costPerLead: c.cost_per_lead,
    })),
    limitations: [
      "There is no AD SET anywhere in what the Meta collector stores, so a learning-limited ad set cannot be detected here. That check is null, not passing.",
      "There is no AD row either, so an ad rejected in review is invisible to this box.",
      "There is no audience specification, so overlap is inferred from frequency and is named as an inference rather than measured.",
      "There is no budget field. What would be a budget check is a check on DAILY SPEND, which is what actually happened rather than what was asked for.",
      "Reach and frequency are de-duplicated by Meta over the window on the row and can never be summed or averaged with another window's.",
    ],
    means:
      "This score is this app's own rubric, computed from Meta's own figures by arithmetic that is printed beside it. It is not a Meta figure, it is not an industry grade, and it may not be compared with another account's — every band is measured against THIS account's own history.",
  };
}

export function adsHealthAll() {
  const rows = db.prepare("SELECT ad_account_id FROM meta_ad_accounts ORDER BY ad_account_id").all() as unknown as {
    ad_account_id: string;
  }[];
  return {
    accounts: rows.map((r) => adsHealthFor(r.ad_account_id)).filter((a): a is NonNullable<ReturnType<typeof adsHealthFor>> => a !== null),
    note:
      "Listed, never ranked and never totalled. Each account's money is in its own currency and each score is that account's rubric measured against its own history.",
  };
}
