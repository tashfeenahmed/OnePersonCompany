import type { ChatTurn } from "../../chat/backend.ts";
import type { ModelProvider } from "../../models/provider.ts";
import { db, now, type VentureRow } from "../../db.ts";
import { fencedJson } from "./kinds.ts";
import type { Step } from "./store.ts";

/**
 * THE AI-VISIBILITY RUN — what a model says about the business when it is not
 * allowed to look. Moved here from executor.ts unchanged in behaviour; the
 * executor hands it the same capabilities the competitor and research runs
 * borrow, so this file owns the whole of the measurement and the executor
 * owns only the queue.
 *
 * Every question goes through the raw provider — `forceProvider: true` on
 * every turn — even when an agent is live, because the thing being measured
 * is the model's own knowledge. An agent with a web search would answer every
 * question correctly and the run would have measured the search engine.
 *
 * MENTION IS MEASURED, ACCURACY AND RECOMMENDATION ARE JUDGED. The first is
 * string presence of the name or the host, which is mechanical and checkable.
 * The other two need a reader, so there is one more completion — the judge —
 * and where it does not answer usably both stay NULL. Null is "asked and not
 * told"; it is not "no".
 */
export type GeoTools = {
  say(text: string): void;
  startStep(tool: string, label: string | null): Step;
  endStep(step: Step, label?: string | null): void;
  turn(turns: ChatTurn[], opts: { toOutput: boolean; forceProvider?: boolean; document?: boolean }): Promise<{ text: string }>;
  /** The active raw provider, or null when none is chosen. */
  provider: ModelProvider | null;
  /** The model the session last recorded — what the ledger row carries. */
  model(): string | null;
};

export async function geoRun(opts: { runId: string; venture: VentureRow; input: Record<string, string>; tools: GeoTools }) {
  const { runId, venture: v, input, tools } = opts;
  const provider = tools.provider;
  if (!provider)
    throw new Error(
      "AI visibility asks the model provider directly, and no provider is chosen. Pick one under Models — an agent cannot stand in for it, because the measurement is what a model says with no tools.",
    );

  const category =
    (input.category ?? "").trim() ||
    (v.description ? v.description.split(/[.!?\n]/)[0]!.trim().slice(0, 120) : v.name);
  const questions = [
    `What is ${v.name}?`,
    v.host ? `What does the website ${v.host} do?` : `What is the website of ${v.name}?`,
    `Recommend a tool for ${category}. Name specific products.`,
    ...(input.questions ?? "")
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 7),
  ];

  const ASK_SYSTEM =
    "Answer from your own knowledge only. You have no tools, no web access and no documents. " +
    "If you have not heard of something, say so plainly — a guess presented as knowledge is the " +
    "one answer that is useless here. Two or three sentences.";

  type Answer = { question: string; answer: string; mentioned: boolean; accurate: boolean | null; recommended: boolean | null };
  const answers: Answer[] = [];

  tools.say(`# AI visibility — ${v.name}\n\nAsked of ${provider.label}, with no tools and no web access.\n\n`);

  for (const question of questions) {
    const step = tools.startStep("ask", question);
    const res = await tools.turn(
      [
        { role: "system", content: ASK_SYSTEM },
        { role: "user", content: question },
      ],
      { toOutput: false, forceProvider: true },
    );
    const hay = res.text.toLowerCase();
    const mentioned = hay.includes(v.name.toLowerCase()) || (v.host ? hay.includes(v.host.toLowerCase()) : false);
    answers.push({ question, answer: res.text, mentioned, accurate: null, recommended: null });
    tools.endStep(step, mentioned ? "mentioned" : "not mentioned");
  }

  /* THE JUDGE — one completion, which is what makes accuracy and
     recommendation answerable at all. It is given the venture record as the
     ground truth and the answers to mark against it. */
  const judgeStep = tools.startStep("judge", "scoring accuracy and recommendation");
  try {
    const truth = [
      `Name: ${v.name}`,
      `Website: ${v.website ?? "unknown"}`,
      `Host: ${v.host ?? "unknown"}`,
      `What it is: ${v.description || "not written down"}`,
    ].join("\n");
    const judgeUser = answers
      .map((a, i) => `[${i + 1}] QUESTION: ${a.question}\nANSWER: ${a.answer}`)
      .join("\n\n");
    const res = await tools.turn(
      [
        {
          role: "system",
          content:
            `You are marking another model's answers against a record of the truth. Here is the truth:\n\n${truth}\n\n` +
            `For each numbered answer, decide two things.\n` +
            `accurate: true if what the answer says ABOUT THIS PRODUCT is correct, false if it says something wrong about it (confusing it with something else counts as wrong), null if the answer does not describe this product at all.\n` +
            `recommended: true if the answer recommends or suggests this product by name, false if it recommends other things instead, null if it is not a question where anything is recommended.\n` +
            `Reply with ONLY a fenced block, info string \`json scores\`, holding [{"n": 1, "accurate": true, "recommended": null}, …]. No prose.`,
        },
        { role: "user", content: judgeUser },
      ],
      { toOutput: false, forceProvider: true },
    );
    const scores = fencedJson(res.text, "scores");
    if (Array.isArray(scores))
      for (const item of scores) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const n = typeof o.n === "number" ? o.n : Number(o.n);
        const a = answers[n - 1];
        if (!a) continue;
        a.accurate = typeof o.accurate === "boolean" ? o.accurate : null;
        a.recommended = typeof o.recommended === "boolean" ? o.recommended : null;
      }
    tools.endStep(judgeStep, Array.isArray(scores) ? `${scores.length} scored` : "the judge did not answer usably — accuracy and recommendation stay null");
  } catch (err) {
    /* A judge that fails costs two columns, not the run. The answers are the
       measurement and they are already in hand. */
    tools.endStep(judgeStep, `failed — ${err instanceof Error ? err.message : String(err)}; accuracy and recommendation stay null`);
  }

  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO geo_answers (run_id, venture_id, provider, model, question, answer, mentioned, accurate, recommended, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of answers)
    stmt.run(
      runId,
      v.id,
      provider.id,
      tools.model(),
      a.question,
      a.answer,
      a.mentioned ? 1 : 0,
      a.accurate === null ? null : a.accurate ? 1 : 0,
      a.recommended === null ? null : a.recommended ? 1 : 0,
      ts,
    );

  const bool = (b: boolean | null) => (b === null ? "not told" : b ? "yes" : "no");
  const mentions = answers.filter((a) => a.mentioned).length;
  tools.say(
    [
      `## Findings`,
      ``,
      `${mentions} of ${answers.length} answers mentioned ${v.name}${v.host ? ` or ${v.host}` : ""}.`,
      ``,
      `READ THAT NUMBER WITH ITS DEFINITION. "Mentioned" is string presence of the name or the host in the answer, which is mechanical and checkable and is therefore the only part of this that is MEASURED — and it counts an answer that repeats the name back while saying it has never heard of it. A high mention count over answers that all say "I do not know this" is a model echoing the question, not a model that knows the product. The answers are printed in full below precisely so that this cannot be read off the table alone.`,
      ``,
      `Accuracy and recommendation were judged by a second completion. "not told" means the judge did not answer for that row — never that the answer was wrong.`,
      ``,
      `| Question | Mentioned | Accurate | Recommended |`,
      `| --- | --- | --- | --- |`,
      ...answers.map((a) => `| ${a.question.replace(/\|/g, "\\|")} | ${a.mentioned ? "yes" : "no"} | ${bool(a.accurate)} | ${bool(a.recommended)} |`),
      ``,
      `## Evidence`,
      ``,
      `The answers as they were given, in full. There are no URLs here and there cannot be: nothing fetched anything, and every word below is ${provider.label} answering out of its own weights.`,
      ``,
      ...answers.flatMap((a) => [`**${a.question}**`, ``, a.answer, ``]),
    ].join("\n"),
  );

  const recStep = tools.startStep("write", "recommendations");
  const rec = await tools.turn(
    [
      {
        role: "system",
        content:
          `You are advising the owner of ${v.name} (${v.website ?? "no site recorded"}) on how models talk about it.\n\n` +
          `THE RECORD:\n${v.description || "nothing written down"}\n\n` +
          `WHAT WAS MEASURED: a model with no tools was asked ${answers.length} questions. ${mentions} answers mentioned the product. ` +
          `Here is what it said:\n\n${answers.map((a) => `Q: ${a.question}\nA: ${a.answer}\nmentioned: ${a.mentioned}, accurate: ${bool(a.accurate)}, recommended: ${bool(a.recommended)}`).join("\n\n")}\n\n` +
          `Write ONLY the following, starting with the heading, and nothing else:\n\n` +
          `## Recommendations\n` +
          `Ranked, each a thing that could be started this week, aimed at what a model would have to READ somewhere for the answer to improve — the places it learns from, not the site's own copy alone. Say what each would cost and what it would change.\n\n` +
          `Then a final fenced block, info string exactly \`json cards\`, with 3 to 8 board-card suggestions as [{"title": "…", "body": "…", "urgency": 0-3}].\n\n` +
          `Never invent a figure. The only measurements you have are the ones above.`,
      },
      { role: "user", content: `What should be done about how models describe ${v.name}?` },
    ],
    { toOutput: true, forceProvider: true },
  );
  tools.endStep(recStep, `${rec.text.length} characters`);
}
