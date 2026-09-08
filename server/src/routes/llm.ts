import { Hono } from "hono";
import { db, now, ventureRowById } from "../db.ts";
import { kindDef } from "../integrations/runs/kinds.ts";
import { budgets } from "../runtime/budgets.ts";

/**
 * THIS BOX'S OWN LLM USE — the half no provider bills for by name.
 *
 * The costs report says what OpenAI and OpenRouter CHARGED, by day, by model
 * and by key. It cannot say what the money was FOR: a key is not a venture
 * and a model is not a kind of work. This report reads the two ledgers this
 * box writes itself — every chat turn's reported tokens in `chat_messages`,
 * every run's in `agent_runs` — and cuts them the way the owner asks about
 * them: by day, by model, by the kind of work, and by venture.
 *
 * TOKENS, NOT DOLLARS, AND THE ONE EXCEPTION SAYS ITS PRICE. No provider
 * reports a per-call price this box can read back, and a per-model rate card
 * typed by hand is a number that is wrong the week after it is typed. So the
 * figures here are tokens the backend REPORTED. The only dollars are the
 * budget ledger's, and those are `tokens × usdPerMillion` — the owner's own
 * conservative price, set under Usage limits — and the report says so.
 *
 * A TURN THAT REPORTED NOTHING IS COUNTED AS A TURN AND NOT AS ZERO TOKENS.
 * A Hermes turn with no usage is a turn that happened and cost something;
 * calling it free would make the cheapest-looking backend the one that says
 * least. `unreported` carries how many such turns there were, beside the
 * total they are absent from.
 */
export const llm = new Hono();

const WINDOW_DAYS = 30;

type ChatRow = {
  day: string;
  backend: string | null;
  channel: string;
  model: string | null;
  prompt: number | null;
  completion: number | null;
};
type RunRow = {
  day: string;
  kind: string;
  venture_id: string | null;
  backend: string | null;
  model: string | null;
  prompt: number | null;
  completion: number | null;
};

const dayOf = (iso: string) => iso.slice(0, 10);

llm.get("/", (c) => {
  /* Clamped the way every other windowed route clamps: a dashboard asks all
     of them for one span, and this ledger is the one that answered thirty
     whatever it was asked. */
  const windowDays = Math.min(Math.max(Number(c.req.query("days") ?? WINDOW_DAYS) || WINDOW_DAYS, 1), 400);
  const to = now();
  const fromMs = Date.parse(to) - windowDays * 86_400_000;
  const from = new Date(fromMs).toISOString();
  const today = dayOf(to);

  const chats = db
    .prepare(
      `SELECT substr(ts, 1, 10) AS day, backend, channel, model,
              prompt_tokens AS prompt, completion_tokens AS completion
         FROM chat_messages
        WHERE role = 'assistant' AND ts >= ?`,
    )
    .all(from) as unknown as ChatRow[];
  const runs = db
    .prepare(
      `SELECT substr(coalesce(started_at, queued_at), 1, 10) AS day, kind, venture_id,
              backend, model, usage_prompt AS prompt, usage_completion AS completion
         FROM agent_runs
        WHERE coalesce(started_at, queued_at) >= ? AND status IN ('done', 'failed', 'cancelled', 'running')`,
    )
    .all(from) as unknown as RunRow[];

  const tokensOf = (r: { prompt: number | null; completion: number | null }) =>
    r.prompt === null && r.completion === null ? null : (r.prompt ?? 0) + (r.completion ?? 0);

  /* ------------------------------------------------------------- folds */
  const days = new Map<string, { chat: number; runs: number; calls: number }>();
  const models = new Map<string, { tokens: number; calls: number; backend: string | null }>();
  const work = new Map<string, { label: string; tokens: number; calls: number }>();
  const ventures = new Map<string, { name: string; tokens: number; calls: number }>();
  let prompt = 0;
  let completion = 0;
  let calls = 0;
  let unreportedChat = 0;
  let unreportedRuns = 0;
  const todayTally = { chatTokens: 0, runTokens: 0, calls: 0 };

  const bump = <K,>(m: Map<K, { tokens: number; calls: number } & Record<string, unknown>>, k: K, tokens: number, make: () => { tokens: number; calls: number } & Record<string, unknown>) => {
    const cur = m.get(k) ?? make();
    cur.tokens += tokens;
    cur.calls += 1;
    m.set(k, cur);
  };

  for (const r of chats) {
    calls += 1;
    const t = tokensOf(r);
    if (t === null) unreportedChat += 1;
    const tokens = t ?? 0;
    prompt += r.prompt ?? 0;
    completion += r.completion ?? 0;
    const d = days.get(r.day) ?? { chat: 0, runs: 0, calls: 0 };
    d.chat += tokens; d.calls += 1; days.set(r.day, d);
    if (r.day === today) { todayTally.chatTokens += tokens; todayTally.calls += 1; }
    bump(models, r.model ?? "model not reported", tokens, () => ({ tokens: 0, calls: 0, backend: r.backend }));
    const key = `chat:${r.channel}`;
    bump(work, key, tokens, () => ({ label: r.channel === "telegram" ? "Chat · Telegram" : "Chat · web", tokens: 0, calls: 0 }));
  }
  for (const r of runs) {
    calls += 1;
    const t = tokensOf(r);
    if (t === null) unreportedRuns += 1;
    const tokens = t ?? 0;
    prompt += r.prompt ?? 0;
    completion += r.completion ?? 0;
    const d = days.get(r.day) ?? { chat: 0, runs: 0, calls: 0 };
    d.runs += tokens; d.calls += 1; days.set(r.day, d);
    if (r.day === today) { todayTally.runTokens += tokens; todayTally.calls += 1; }
    bump(models, r.model ?? "model not reported", tokens, () => ({ tokens: 0, calls: 0, backend: r.backend }));
    bump(work, `run:${r.kind}`, tokens, () => ({ label: kindDef(r.kind)?.name ?? r.kind, tokens: 0, calls: 0 }));
    if (r.venture_id) {
      bump(ventures, r.venture_id, tokens, () => ({
        name: ventureRowById(r.venture_id!)?.name ?? r.venture_id!,
        tokens: 0,
        calls: 0,
      }));
    }
  }

  /* Every calendar day in the window, zeros included, so a chart draws the
     quiet days as quiet rather than closing the gap. */
  const series: { day: string; chatTokens: number; runTokens: number; calls: number }[] = [];
  for (let ms = Date.parse(`${dayOf(from)}T00:00:00Z`); ms <= Date.parse(`${today}T00:00:00Z`); ms += 86_400_000) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const d = days.get(day);
    series.push({ day, chatTokens: d?.chat ?? 0, runTokens: d?.runs ?? 0, calls: d?.calls ?? 0 });
  }

  /* --------------------------------------------------------- the budget */
  const limits = budgets();
  const start = `${today}T00:00:00.000Z`;
  const ledger = db
    .prepare(
      `SELECT status, count(*) AS calls, coalesce(sum(tokens), 0) AS tokens, coalesce(sum(usd), 0) AS usd,
              coalesce(sum(automation), 0) AS automation
         FROM budget_usage WHERE at >= ? GROUP BY status`,
    )
    .all(start) as unknown as { status: string; calls: number; tokens: number; usd: number; automation: number }[];
  const budgetToday = ledger.reduce(
    (acc, r) => ({ calls: acc.calls + r.calls, tokens: acc.tokens + r.tokens, usd: acc.usd + r.usd, automation: acc.automation + r.automation }),
    { calls: 0, tokens: 0, usd: 0, automation: 0 },
  );

  return c.json({
    generatedAt: to,
    window: { days: windowDays, from: dayOf(from), to: today },
    total: { calls, promptTokens: prompt, completionTokens: completion, tokens: prompt + completion },
    unreported: { chatTurns: unreportedChat, runs: unreportedRuns },
    today: { ...todayTally, tokens: todayTally.chatTokens + todayTally.runTokens },
    days: series,
    models: [...models.entries()]
      .map(([model, m]) => ({ model, backend: m.backend, tokens: m.tokens, calls: m.calls }))
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls),
    work: [...work.entries()]
      .map(([key, w]) => ({ key, label: w.label, tokens: w.tokens, calls: w.calls }))
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls),
    ventures: [...ventures.entries()]
      .map(([id, v]) => ({ ventureId: id, name: v.name, tokens: v.tokens, calls: v.calls }))
      .sort((a, b) => b.tokens - a.tokens),
    budget: {
      /* The owner's limits, zero meaning "none set" for every one but the
         call caps, which have defaults. */
      limits,
      /* Priced only when the owner typed a price: every usd in the ledger is
         tokens × that price, so with no price they are all zero and zero is
         not a measurement. */
      priced: limits.usdPerMillion > 0,
      today: {
        ...budgetToday,
        byStatus: ledger.map((r) => ({ status: r.status, calls: r.calls, tokens: r.tokens, usd: r.usd })),
      },
    },
  });
});
