/**
 * What the operation costs — from the three providers that report money and
 * compute, and from the one that reports neither.
 *
 * ONE ROUTE FOR THE WHOLE BOARD, for the reason /api/domains is one route: a
 * costs dashboard asks the same question of the same rows from a dozen cards,
 * and a dozen requests to answer it once is a burst the box does not need to
 * serve.
 *
 * EVERY TOTAL HERE IS COMPUTED ON THE READ. Nothing in the database says
 * "$212 this month"; it says "$1.47 on the 9th, in this project", and the
 * window is added up when someone asks. A stored monthly total is wrong the
 * next morning and badly wrong after a week of failed collections — which is
 * the week someone actually goes looking at it.
 *
 * THE CURRENCY RULE, WHICH IS THE WHOLE REASON THIS FILE IS CAREFUL.
 * OpenAI, OpenRouter and Replicate report US dollars. Hetzner reports euro,
 * net of VAT. This route offers NO figure that mixes them, and it is explicit
 * about that rather than silent: `currency.combined` is null and carries the
 * sentence explaining why. Converting would need a real, dated exchange rate
 * this box does not fetch, and one confident number spanning two currencies is
 * worth less than two numbers that are each right.
 *
 * THE THREE PROVIDERS ANSWER THREE DIFFERENT QUESTIONS, and the shape of each
 * section is that provider's own:
 *
 *   openai      money per day per project. Both cuts sum over the same rows,
 *               so they agree to the cent. It has no per-model answer, so
 *               there is no per-model field here to fill with a guess.
 *   openrouter  money per day per model, AND money per key — two cuts that do
 *               not join, kept in two objects that share no key. Its three
 *               headline totals measure three different things and each one
 *               is labelled with what it is a total of.
 *   replicate   no money at all. `cost` is null — asked and not told — and
 *               `cannot` says exactly what was asked and what came back.
 */
import { Hono } from "hono";
import {
  db,
  getPlugin,
  openAiCosts,
  openRouterActivity,
  openRouterCredits,
  openRouterKeys,
  replicatePredictions,
  ventureRows,
  type OpenRouterKeyRecord,
  type VentureRow,
} from "../db.ts";
import { CANNOT } from "../providers/replicate.ts";
import { PSEUDO_VENTURES, isPseudoVenture } from "../runtime/budgets.ts";
/* Four places, and a NUMBER rather than a string so nothing downstream parses
   one back into arithmetic. The rule and the reason live in shared/money.ts. */
import { money } from "../shared/money.ts";

export const costs = new Hono();

/**
 * The window every section is cut to.
 *
 * ONE window for the page rather than one per provider, because the question
 * is "what is this costing me" and three cards over three different spans
 * cannot be read together. Thirty days is what OpenAI's Costs API hands over
 * comfortably and roughly what OpenRouter's activity endpoint keeps, so it is
 * the largest window all three can actually answer.
 */
export const WINDOW_DAYS = 30;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Has this plugin ever completed a collection?
 *
 * The difference between "$0" and "we do not know" is exactly this question. A
 * provider with no rows that has never run successfully knows nothing and says
 * null; a provider with no rows that ran fine an hour ago is reporting a real,
 * free month. Folding them together would put a confident zero on a card
 * whose credential was refused.
 */
function everCollected(pluginId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM runs WHERE plugin_id = ? AND ok = 1 LIMIT 1")
      .get(pluginId),
  );
}

const connected = (id: string) => getPlugin(id)?.connected === 1;


/** Newest `seen_at` across a set of rows: when this section was last true. */
function newestSeen(rows: { seen_at: string }[]): string | null {
  let newest: string | null = null;
  for (const r of rows) if (!newest || r.seen_at > newest) newest = r.seen_at;
  return newest;
}

/* -------------------------------------------------------------- openai */

function openaiSection(from: string) {
  const rows = openAiCosts(from);
  const isConnected = connected("openai");
  const collected = everCollected("openai");

  const byDay = new Map<string, number>();
  const byProject = new Map<string, { name: string; usd: number }>();
  for (const r of rows) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.usd);
    const p = byProject.get(r.project_id) ?? {
      name: r.project_name ?? r.project_id,
      usd: 0,
    };
    p.usd += r.usd;
    byProject.set(r.project_id, p);
  }

  /*
    THE LAST COMPLETE DAY. OpenAI's buckets lag by about a day and today's is
    partial by definition, so a card drawing the series has to know where the
    measured part stops. Told rather than trimmed: dropping the partial bucket
    would hide spend that really happened, and drawing it unlabelled would show
    a cliff every morning.
  */
  const completeThrough = utcDay(Date.now() - 86_400_000);

  return {
    connected: isConnected,
    /* null is "asked and not told": no rows AND no successful collection. A
       successful collection with no rows is a genuinely free month, and that
       is a zero. */
    usd: rows.length || collected ? money([...byDay.values()].reduce((a, b) => a + b, 0)) : null,
    currency: "usd" as const,
    days: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, usd]) => ({ day, usd: money(usd) })),
    projects: [...byProject.entries()]
      .map(([id, p]) => ({ id, name: p.name, usd: money(p.usd) }))
      .sort((a, b) => b.usd - a.usd),
    /** How many organizations these figures are the sum of. */
    accounts: new Set(rows.map((r) => r.account_id)).size,
    completeThrough,
    lag: "Costs aggregate into UTC day buckets and the recent ones lag by about a day, so the newest bucket is partial by definition.",
    /** What this API cannot be asked, said once so no card promises it. */
    noModelSplit:
      "The Costs API groups by project or by line item, never both, so there is no per-model spend here.",
    seenAt: newestSeen(rows),
  };
}

/* ---------------------------------------------------------- openrouter */

function openrouterSection(from: string) {
  const activity = openRouterActivity(from);
  const keys = openRouterKeys();
  const credits = openRouterCredits();
  const collected = everCollected("openrouter");

  const byDay = new Map<string, { usd: number; requests: number; prompt: number; completion: number }>();
  const byModel = new Map<
    string,
    { usd: number; byokUsd: number; requests: number; prompt: number; completion: number }
  >();
  let usd = 0;
  let byokUsd = 0;
  let requests = 0;
  let prompt = 0;
  let completion = 0;

  for (const r of activity) {
    usd += r.usd;
    byokUsd += r.byok_usd;
    requests += r.requests;
    prompt += r.prompt_tokens;
    completion += r.completion_tokens;

    const d = byDay.get(r.day) ?? { usd: 0, requests: 0, prompt: 0, completion: 0 };
    d.usd += r.usd;
    d.requests += r.requests;
    d.prompt += r.prompt_tokens;
    d.completion += r.completion_tokens;
    byDay.set(r.day, d);

    const m = byModel.get(r.model) ?? {
      usd: 0,
      byokUsd: 0,
      requests: 0,
      prompt: 0,
      completion: 0,
    };
    m.usd += r.usd;
    m.byokUsd += r.byok_usd;
    m.requests += r.requests;
    m.prompt += r.prompt_tokens;
    m.completion += r.completion_tokens;
    byModel.set(r.model, m);
  }

  const purchased = credits.reduce((n, c) => n + (c.purchased ?? 0), 0);
  const spentLifetime = credits.reduce((n, c) => n + (c.spent ?? 0), 0);
  const keysTotal = keys.reduce((n, k) => n + k.usd, 0);

  return {
    connected: connected("openrouter"),
    currency: "usd" as const,
    /*
      THE LEDGER. `spent` is the account's WHOLE LIFE — every key that ever
      existed, including the deleted ones — which is why it is larger than the
      sum of the keys below and larger than the window above. Named
      `spentLifetime` so no card can quietly caption it "spent this month".
    */
    credits: credits.length
      ? {
          purchased: money(purchased),
          spentLifetime: money(spentLifetime),
          balance: money(purchased - spentLifetime),
          accounts: credits.length,
          seenAt: newestSeen(credits),
        }
      : null,
    /*
      CUT ONE: per day per model. There is no key in this object and there
      never will be — OpenRouter reports no per-day-per-key figure anywhere, so
      "which key spent this on which model" is unanswerable and must not be
      implied by putting the two cuts in one shape.
    */
    activity: {
      usd: activity.length || collected ? money(usd) : null,
      /* Routed to the owner's OWN provider keys and billed elsewhere. Its own
         field, never added to usd. */
      byokUsd: money(byokUsd),
      requests,
      promptTokens: prompt,
      completionTokens: completion,
      dayCount: byDay.size,
      days: [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, d]) => ({
          day,
          usd: money(d.usd),
          requests: d.requests,
          /* Tokens per day, so a card can draw the volume beside the bill and
             quote a blended rate for the day rather than for the month. */
          promptTokens: d.prompt,
          completionTokens: d.completion,
        })),
      models: [...byModel.entries()]
        .map(([model, m]) => ({
          model,
          usd: money(m.usd),
          byokUsd: money(m.byokUsd),
          requests: m.requests,
          promptTokens: m.prompt,
          completionTokens: m.completion,
        }))
        .sort((a, b) => b.usd - a.usd || b.promptTokens - a.promptTokens),
      seenAt: newestSeen(activity),
    },
    /*
      CUT TWO: per key. Four running totals each, and no day column, because
      that is all the API has. Only keys that STILL EXIST are here — a deleted
      key's spend stays inside the lifetime figure above and is absent from
      this sum, which is the whole reason the two disagree.
    */
    keys: {
      total: money(keysTotal),
      count: keys.length,
      list: keys.map((k) => ({
        name: k.name,
        account: k.account_label,
        usd: money(k.usd),
        usdMonth: money(k.usd_month),
        usdWeek: money(k.usd_week),
        usdDay: money(k.usd_day),
        disabled: k.disabled === 1,
        createdAt: k.created_at,
        /* null is "no cap at all", which is a different fact from a cap with
           nothing left on it. They must not both read as zero. */
        spendLimit: k.spend_limit,
        limitRemaining: k.limit_remaining,
      })),
      seenAt: newestSeen(keys),
    },
    /**
     * The three headline totals, and what each is a total OF. Any card showing
     * more than one of them has to say this, so it is said here once rather
     * than three times in three builders.
     */
    totalsDiffer:
      "Lifetime spend covers every key that ever existed; the key totals cover only the keys that still exist; the activity figure covers about a month. Three true numbers about three different things — they do not add up to each other.",
    noJoin:
      "OpenRouter reports per-day-per-model and per-key, and nothing per-day-per-key, so which key paid for which model is not answerable.",
    accounts: new Set([
      ...activity.map((r) => r.account_id),
      ...keys.map((k) => k.account_id),
      ...credits.map((c) => c.account_id),
    ]).size,
  };
}

/* ------------------------------------------------------------ replicate */

function replicateSection(fromIso: string) {
  const rows = replicatePredictions(fromIso);

  const byDay = new Map<string, { runs: number; seconds: number }>();
  const byModel = new Map<
    string,
    {
      runs: number;
      failed: number;
      seconds: number;
      images: number;
      videoSeconds: number;
      tokens: number;
    }
  >();
  let seconds = 0;
  let unreported = 0;
  let failed = 0;
  let images = 0;
  let videoSeconds = 0;
  let tokens = 0;

  for (const p of rows) {
    const day = p.created_at.slice(0, 10);
    const d = byDay.get(day) ?? { runs: 0, seconds: 0 };
    d.runs += 1;
    d.seconds += p.predict_seconds ?? 0;
    byDay.set(day, d);

    const key = p.model ?? "(unnamed model)";
    const m = byModel.get(key) ?? {
      runs: 0,
      failed: 0,
      seconds: 0,
      images: 0,
      videoSeconds: 0,
      tokens: 0,
    };
    m.runs += 1;
    if (p.status === "failed") m.failed += 1;
    m.seconds += p.predict_seconds ?? 0;
    m.images += p.image_outputs ?? 0;
    m.videoSeconds += p.video_seconds ?? 0;
    m.tokens += p.output_tokens ?? 0;
    byModel.set(key, m);

    // A prediction with no predict_time reported is counted apart rather than
    // added as nought seconds: it never ran, or it had not finished when it
    // was read, and neither of those is "free".
    if (p.predict_seconds === null) unreported += 1;
    else seconds += p.predict_seconds;
    if (p.status === "failed") failed += 1;
    images += p.image_outputs ?? 0;
    videoSeconds += p.video_seconds ?? 0;
    tokens += p.output_tokens ?? 0;
  }

  return {
    connected: connected("replicate"),
    /*
      NULL, AND NEVER A NUMBER. Replicate's API publishes no billing surface —
      /v1/billing, /v1/account/billing and /v1/usage all answer 404 — a
      prediction carries no hardware SKU or price, /v1/hardware lists SKUs with
      no rates, and the models this account runs are billed per output rather
      than per second anyway. Anything in this field would be this codebase's
      invention rather than Replicate's measurement.
    */
    cost: null,
    cannot: CANNOT,
    runs: rows.length,
    failed,
    succeeded: rows.filter((p) => p.status === "succeeded").length,
    /** Seconds of prediction time, which is what Replicate measures. It is the
     *  billing UNIT for hardware-priced models and not for output-priced ones,
     *  and in neither case is the RATE knowable from this API. */
    predictSeconds: Number(seconds.toFixed(1)),
    unreported,
    outputs: {
      images,
      videoSeconds: Number(videoSeconds.toFixed(1)),
      tokens,
    },
    days: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, d]) => ({
        day,
        runs: d.runs,
        seconds: Number(d.seconds.toFixed(1)),
      })),
    models: [...byModel.entries()]
      .map(([model, m]) => ({
        model,
        runs: m.runs,
        failed: m.failed,
        seconds: Number(m.seconds.toFixed(1)),
        images: m.images,
        videoSeconds: Number(m.videoSeconds.toFixed(1)),
        tokens: m.tokens,
      }))
      .sort((a, b) => b.seconds - a.seconds),
    accounts: new Set(rows.map((p) => p.account_id)).size,
    seenAt: newestSeen(rows),
  };
}

/* ------------------------------------------------------------- ventures */

/**
 * WHAT EACH VENTURE'S MODEL WORK COST, as far as this box can say — and a
 * plain statement of how far that is.
 *
 * TWO LEDGERS, AND THEY DO NOT JOIN. This box's own meter (`budget_usage`) is
 * one row per model call OPC made, filed under the venture the call was for —
 * a synthesis pass for Betaware, a caption for Viral Video Maker — or under a
 * pseudo-venture (`portfolio`, `chief`) when the work spanned the roster. The
 * providers' invoices (OpenAI, OpenRouter) are what the products THEMSELVES
 * spent calling the shared keys from their own servers: Betaware's app, My
 * Voice Agents' app, Viral Video Maker's generation. OpenAI reports one
 * project for all of them and Replicate reports no money at all, so that half
 * cannot be split by venture from here — and it says so rather than
 * apportioning a bill by a token count that never touched it. The one honest
 * bridge is an OpenRouter key NAMED for a product: its per-key totals are that
 * product's own spend and are shown against the venture whose name it carries.
 */
type MeteredRow = {
  venture_id: string | null;
  calls: number;
  tokens: number;
  reported: number;
  agent: number;
};

/** `viral-video-maker`, `Viral Video Maker`, `ViralVideoMaker` and
 *  `viralvideomaker.co` are one name; `FLA` and `GetPreg` are nobody's. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function keyNamesVenture(keyName: string, v: Pick<VentureRow, "name" | "slug" | "host" | "website">): boolean {
  const k = norm(keyName);
  if (!k) return false;
  let host = v.host ?? "";
  if (!host && v.website) {
    try { host = new URL(v.website).hostname; } catch { host = ""; }
  }
  const bare = host.replace(/^www\./, "");
  const candidates = [v.name, v.slug, bare, bare.split(".")[0] ?? ""].map(norm).filter(Boolean);
  return candidates.includes(k);
}

/** Which of this box's OWN calls in the window went to a provider that also
 *  sends an invoice — the fact that decides whether the invoice is OPC's
 *  spend or the products'. Read off the two ledgers that name a backend. */
function ownBackends(fromIso: string): string[] {
  const seen = new Set<string>();
  const runs = db
    .prepare("SELECT DISTINCT backend FROM agent_runs WHERE coalesce(started_at, queued_at) >= ? AND backend IS NOT NULL")
    .all(fromIso) as { backend: string }[];
  const chats = db
    .prepare("SELECT DISTINCT backend FROM chat_messages WHERE role = 'assistant' AND ts >= ? AND backend IS NOT NULL")
    .all(fromIso) as { backend: string }[];
  for (const r of [...runs, ...chats]) seen.add(r.backend);
  return [...seen].sort();
}

export function venturesSection(fromIso: string, keys: OpenRouterKeyRecord[], openaiProjects: { id: string; name: string; usd: number }[]) {
  const metered = db
    .prepare(
      `SELECT venture_id, count(*) AS calls, coalesce(sum(tokens), 0) AS tokens,
              coalesce(sum(status = 'reported'), 0) AS reported,
              coalesce(sum(status = 'unmetered-agent'), 0) AS agent
         FROM budget_usage WHERE at >= ? GROUP BY venture_id`,
    )
    .all(fromIso) as unknown as MeteredRow[];
  const byVenture = new Map(metered.map((r) => [r.venture_id, r]));
  const allTokens = metered.reduce((n, r) => n + r.tokens, 0);
  const allCalls = metered.reduce((n, r) => n + r.calls, 0);

  const ventures = ventureRows();
  const claimed = new Set<string>();
  const keysFor = (v: VentureRow) => {
    const mine = keys.filter((k) => keyNamesVenture(k.name, v));
    for (const k of mine) claimed.add(`${k.account_id}:${k.name}`);
    if (!mine.length) return null;
    return {
      names: mine.map((k) => k.name),
      usd: money(mine.reduce((n, k) => n + k.usd, 0)),
      usdMonth: money(mine.reduce((n, k) => n + k.usd_month, 0)),
      usdWeek: money(mine.reduce((n, k) => n + k.usd_week, 0)),
      usdDay: money(mine.reduce((n, k) => n + k.usd_day, 0)),
    };
  };
  const meteredOf = (id: string | null) => {
    const r = byVenture.get(id);
    return {
      calls: r?.calls ?? 0,
      tokens: r?.tokens ?? 0,
      reportedCalls: r?.reported ?? 0,
      agentCalls: r?.agent ?? 0,
      /** This venture's share of every token this box metered in the window. */
      share: allTokens > 0 ? Number(((r?.tokens ?? 0) / allTokens).toFixed(4)) : 0,
    };
  };

  const list: {
    id: string | null; slug: string | null; name: string; kind: "venture" | "pseudo" | "unattributed";
    why?: string; metered: ReturnType<typeof meteredOf>; openrouterKeys: ReturnType<typeof keysFor>;
  }[] = ventures.map((v) => ({
    id: v.id, slug: v.slug, name: v.name, kind: "venture" as const,
    metered: meteredOf(v.id), openrouterKeys: keysFor(v),
  }));
  for (const [id, p] of Object.entries(PSEUDO_VENTURES))
    list.push({ id, slug: id, name: p.name, kind: "pseudo", why: p.why, metered: meteredOf(id), openrouterKeys: null });
  /* Rows filed before every call carried a venture, and rows for a venture
     since deleted: both are money that reached no venture, and both are listed
     rather than dropped so the column still adds up to the total. */
  for (const r of metered) {
    if (r.venture_id === null) list.push({
      id: null, slug: null, name: "Unattributed", kind: "unattributed",
      why: "Calls metered before 22 Sep 2026, when a call outside a run was filed with no venture. No new row is written this way.",
      metered: meteredOf(null), openrouterKeys: null,
    });
    else if (!ventures.some((v) => v.id === r.venture_id) && !isPseudoVenture(r.venture_id)) list.push({
      id: r.venture_id, slug: null, name: r.venture_id, kind: "unattributed",
      why: "Filed under a venture id that is no longer on the roster.",
      metered: meteredOf(r.venture_id), openrouterKeys: null,
    });
  }
  list.sort((a, b) => b.metered.tokens - a.metered.tokens || a.name.localeCompare(b.name));

  const unclaimedKeys = keys.filter((k) => !claimed.has(`${k.account_id}:${k.name}`));
  const backends = ownBackends(fromIso);
  const invoicedUsedHere = backends.filter((b) => b === "provider:openai" || b === "provider:openrouter");

  return {
    list,
    metered: {
      calls: allCalls,
      tokens: allTokens,
      /** Every backend this box's own calls went to in the window, as the run
       *  and chat ledgers name it. */
      backends,
      note:
        "One row per model call this box made, filed under the venture the call was for. " +
        "Tokens are what the backend reported, or the reservation where it reported nothing; " +
        "no dollars, because the meter prices nothing unless a budget price per million is set.",
    },
    unattributed: {
      openai: {
        usd: money(openaiProjects.reduce((n, p) => n + p.usd, 0)),
        projects: openaiProjects.map((p) => p.name),
        why:
          invoicedUsedHere.includes("provider:openai")
            ? "OpenAI bills one project for every product and this box's own calls also went to it in the window, so the bill mixes product-side spend with OPC's and neither half can be split by venture from here."
            : "OpenAI bills one project for every product, and none of this box's own calls in the window went to OpenAI, so this is the products' own spend — Betaware, My Voice Agents, Viral Video Maker and the rest calling the shared key from their own servers. It cannot be split by venture until each product has its own project.",
      },
      openrouter: {
        usd: money(unclaimedKeys.reduce((n, k) => n + k.usd, 0)),
        usdMonth: money(unclaimedKeys.reduce((n, k) => n + k.usd_month, 0)),
        keys: unclaimedKeys.map((k) => k.name),
        why:
          "OpenRouter keys whose name is not a venture's name, slug or host. Their spend is real and belongs to whatever uses them; nothing here guesses which venture that is.",
      },
      replicate: {
        why: "Replicate publishes no cost at all (see `replicate.cannot`), so Viral Video Maker's generation spend there has no dollar figure to attribute.",
      },
    },
    note:
      "Two ledgers that do not join. `metered` is OPC's own model work by venture; the provider invoices above are what the products themselves spent on the shared keys. " +
      "The only bridge is an OpenRouter key named for a product, shown under that venture as `openrouterKeys`. " +
      (invoicedUsedHere.length
        ? `This box's own calls went to ${invoicedUsedHere.join(" and ")} in the window, so part of that invoice is OPC's.`
        : "None of this box's own calls in the window went to OpenAI or OpenRouter, so no share of those invoices is apportioned by metered tokens: it would be a number about nothing."),
  };
}

/* ------------------------------------------------------------------ route */

costs.get("/", (c) => {
  const days = Math.min(
    Math.max(Number(c.req.query("days") ?? WINDOW_DAYS) || WINDOW_DAYS, 1),
    400,
  );
  const fromMs = Date.now() - days * 86_400_000;
  const from = utcDay(fromMs);
  const openai = openaiSection(from);

  return c.json({
    window: { days, from, to: utcDay(Date.now()) },
    generatedAt: new Date().toISOString(),
    /*
      THE CURRENCIES, NAMED, AND NO TOTAL ACROSS THEM.

      Hetzner's figure lives on /api/hetzner/summary and is euro net of VAT;
      everything in this document is US dollars. There is no field here adding
      them, and there is not going to be one without a dated rate fetched from
      somewhere that publishes rates — at which point the rate and its date
      belong on the card beside the number. A single "total spend" quietly
      spanning two currencies is a confident lie, and it is the exact failure
      this dashboard exists to not commit.
    */
    currency: {
      usd: ["openai", "openrouter", "replicate"],
      eur: ["hetzner"],
      combined: null,
      note:
        "OpenAI, OpenRouter and Replicate report US dollars; Hetzner reports euro, " +
        "net of VAT. Nothing here converts between them — a combined figure would " +
        "need a real, dated exchange rate, which this box does not fetch.",
    },
    openai,
    openrouter: openrouterSection(from),
    replicate: replicateSection(new Date(fromMs).toISOString()),
    /* Per venture: OPC's own metered calls, the OpenRouter keys named for a
       product, and a plain statement of what stays portfolio-wide and why. */
    ventures: venturesSection(new Date(fromMs).toISOString(), openRouterKeys(), openai.projects),
  });
});
