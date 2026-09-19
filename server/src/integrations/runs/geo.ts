import type { ChatTurn } from "../../chat/backend.ts";
import type { ModelProvider } from "../../models/provider.ts";
import { db, now, type VentureRow } from "../../db.ts";
import { sanitizeReportHtml } from "./html.ts";
import { fencedJson } from "./kinds.ts";
import type { Step } from "./store.ts";

/**
 * THE AI-VISIBILITY RUN — what a model says about the business when it is not
 * allowed to look. The executor owns the queue; this file owns the whole of
 * the measurement and the document it produces.
 *
 * Every question goes through the raw provider — `forceProvider: true` on
 * every turn — even when an agent is live, because the thing being measured
 * is the model's own knowledge. An agent with a web search would answer every
 * question correctly and the run would have measured the search engine.
 *
 * THREE KINDS OF QUESTION, AND THE MIDDLE ONE IS THE POINT. A `direct`
 * question names the product — "What is X?" — and answers the question "does
 * this model know we exist". That was the whole of this run and it was the
 * less useful half: nobody types a product's name into an assistant unless
 * they already know the product. A `generic` question is the one a stranger
 * actually asks — "what's the best tool for X", "I need to do Y, what should I
 * use" — and it is where the business is either recommended or not. Those are
 * GENERATED, once per run, by one provider turn from the venture record, and
 * any that come back carrying the product's own name or host are thrown away:
 * a "generic" question that names the product measures nothing, because the
 * name in the question is the name in the answer. `extra` is what the owner
 * typed into the form, used as typed.
 *
 * MENTION IS MEASURED, EVERYTHING ELSE IS JUDGED. Mention is string presence
 * of the name or the host, which is mechanical and checkable. Accuracy,
 * recommendation, the rivals that were named instead of us, what the answer
 * actually said and what to do about it all need a reader, so there is one
 * more completion — the judge — and where it does not answer usably every one
 * of them stays NULL. Null is "asked and not told"; it is not "no", and the
 * document and the client both draw it as "not judged".
 *
 * THE REPORT IS COMPOSED HERE, NOT WRITTEN BY A MODEL. Every other reporting
 * kind on this box hands its findings to a writing turn and asks for an HTML
 * document back. This one does not, and the reason is that the report is
 * mostly VERBATIM MODEL OUTPUT — the answers themselves — laid out against
 * numbers this file already counted. A writing turn given that job would
 * paraphrase the answers it was told to quote and recount the numbers it was
 * told to print, and both are the failure this feature exists to prevent. So
 * the server builds the page, escapes every piece of model text into it, and
 * the only thing a model writes here is the recommendations, which arrive as
 * JSON and are rendered as a list. See htmlReportSpec.ts's `designRules` for
 * the house style the stylesheet below follows by hand.
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

/** What a question is FOR, which is the axis the whole report is read along.
 *  Stored on the row so the cross-run panel can group by it too. */
export type GeoQuestionKind = "direct" | "generic" | "extra";

type Question = { text: string; kind: GeoQuestionKind };

type Answer = {
  question: string;
  kind: GeoQuestionKind;
  answer: string;
  mentioned: boolean;
  accurate: boolean | null;
  recommended: boolean | null;
  /** The products the answer named instead of, or beside, us. `null` is "the
   *  judge did not answer for this row"; `[]` is "it answered and named
   *  none". They are different facts and they are stored differently. */
  rivals: string[] | null;
  explanation: string | null;
  action: string | null;
};

type Recommendation = { title: string; why: string; cost: string; change: string };
type Card = { title: string; body: string; urgency: number };

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

  const questions: Question[] = [
    { text: `What is ${v.name}?`, kind: "direct" },
    { text: v.host ? `What does the website ${v.host} do?` : `What is the website of ${v.name}?`, kind: "direct" },
    /* The stranger's words for the category, not the owner's: a description
       that opens with the product's own name would otherwise put the name
       into a question that is meant to be asked without it. */
    { text: `Recommend a tool for ${strangersWords(v, category)}. Name specific products.`, kind: "direct" },
    ...(await genericQuestions({ v, category, tools })).map((text): Question => ({ text, kind: "generic" })),
    ...(input.questions ?? "")
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 7)
      .map((text): Question => ({ text, kind: "extra" })),
  ];

  const ASK_SYSTEM =
    "Answer from your own knowledge only. You have no tools, no web access and no documents. " +
    "If you have not heard of something, say so plainly — a guess presented as knowledge is the " +
    "one answer that is useless here. Two or three sentences.";

  const answers: Answer[] = [];

  for (const q of questions) {
    const step = tools.startStep("ask", q.text);
    const res = await tools.turn(
      [
        { role: "system", content: ASK_SYSTEM },
        { role: "user", content: q.text },
      ],
      { toOutput: false, forceProvider: true },
    );
    const hay = res.text.toLowerCase();
    const mentioned = hay.includes(v.name.toLowerCase()) || (v.host ? hay.includes(v.host.toLowerCase()) : false);
    answers.push({
      question: q.text,
      kind: q.kind,
      answer: res.text,
      mentioned,
      accurate: null,
      recommended: null,
      rivals: null,
      explanation: null,
      action: null,
    });
    tools.endStep(step, mentioned ? "mentioned" : "not mentioned");
  }

  await judge({ v, answers, tools });

  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO geo_answers (run_id, venture_id, provider, model, question, answer, mentioned, accurate, recommended, ts, kind, rivals, explanation, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      a.kind,
      a.rivals === null ? null : JSON.stringify(a.rivals),
      a.explanation,
      a.action,
    );

  const advice = await recommend({ v, answers, tools });

  /* ONE `say`, AT THE END, AND IT IS THE WHOLE DOCUMENT. Every turn above ran
     with `toOutput: false`, so nothing has been written to the row yet and the
     steps list is what showed progress while it ran. The page reads the row,
     sees a document, and frames it. */
  tools.say(sanitizeReportHtml(composeDocument({ v, provider, model: tools.model(), answers, advice, ts })));

  /* THE CARDS, APPENDED AFTER THE DOCUMENT — the same shape the competitor
     sweep uses, for the same reason: `GET /runs/:id` parses the fence out of
     the tail and the client strips it before framing the page, so neither had
     to learn a new one. See runs/html.ts's `splitTrailingFence`. */
  if (advice.cards.length)
    tools.say(`\n\n\`\`\`json cards\n${JSON.stringify(advice.cards, null, 2)}\n\`\`\`\n`);
}

/* ------------------------------------------------- the questions a stranger asks */

/**
 * THE GENERIC ASKS, GENERATED ONCE PER RUN.
 *
 * WHY A MODEL WRITES THEM RATHER THAN A TEMPLATE. The words a stranger uses
 * are the words of the CATEGORY, not of the product, and they differ per
 * business in ways a template cannot reach: "planning permission search" wants
 * "how do I find out if I can build an extension", and no amount of string
 * formatting gets there from the category alone. So one turn is spent on it.
 *
 * WHY EVERY ANSWER IS FILTERED ANYWAY. A model asked for questions that do not
 * name the product names it about a third of the time — "What's the best tool
 * for support chat, like Scallopbot?" — and such a question measures nothing,
 * because the name in the question is the name in the answer. Anything
 * carrying the name, the host, or the host's stem is dropped without argument.
 *
 * WHY THERE IS A DETERMINISTIC FALLBACK. This turn can fail, be cut off, or
 * come back with prose, and a run that produced no generic asks would have
 * measured the old thing and called it the new one. Fewer than three usable
 * questions means the templates are used instead — worse questions, but the
 * run still answers the question it exists to answer.
 */
async function genericQuestions(opts: { v: VentureRow; category: string; tools: GeoTools }): Promise<string[]> {
  const { v, category, tools } = opts;
  const subject = strangersWords(v, category);
  const step = tools.startStep("write", "questions a stranger would ask");

  /* The product's own words, kept out of the generated questions. The host's
     stem matters on its own: a model handed `scallopbot.com` writes questions
     about "Scallopbot" without ever repeating the domain. */
  const banned = [v.name, v.host, v.host ? v.host.split(".")[0] : null]
    .map((s) => (s ?? "").trim().toLowerCase())
    .filter((s) => s.length >= 4);
  const clean = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const q = typeof raw === "string" ? raw.trim() : "";
      if (q.length < 8 || q.length > 200) continue;
      const low = q.toLowerCase();
      if (banned.some((b) => low.includes(b))) continue;
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(q);
      if (out.length === 6) break;
    }
    return out;
  };

  let generated: string[] = [];
  try {
    const res = await tools.turn(
      [
        {
          role: "system",
          content:
            `You write the questions a STRANGER would type into an AI assistant — somebody with the problem this business solves who has never heard of the business.\n\n` +
            `THE BUSINESS (for your understanding only, never to be repeated in a question):\n` +
            `Name: ${v.name}\nWebsite: ${v.website ?? "unknown"}\nWhat it is: ${v.description || "not written down"}\nCategory: ${subject}\n\n` +
            `Write 5 or 6 questions. Every one of them MUST obey all of this:\n` +
            `- It NEVER contains the product's name or its website. A question that names the product is worthless here, because it tells the model the answer.\n` +
            `- It is problem-framed or category-framed, in a real person's words: "What's the best tool for …", "I need to …, what should I use?", "Compare the top options for …", "Is there a free or cheap way to …?", "What do most people use for …?".\n` +
            `- It is one sentence somebody would actually type, not a survey question.\n` +
            `- Between them they cover both the plain category ask and the underlying problem asked without the category's jargon.\n\n` +
            `Reply with ONLY a fenced block, info string \`json questions\`, holding ["…", "…"]. No prose.`,
        },
        { role: "user", content: `Questions somebody with this problem would ask, about ${subject}.` },
      ],
      { toOutput: false, forceProvider: true },
    );
    generated = clean(fencedJson(res.text, "questions"));
  } catch (err) {
    /* A generator that fails costs the generated wording, not the run: the
       templates below ask the same shapes in duller words. */
    tools.endStep(step, `failed — ${err instanceof Error ? err.message : String(err)}; using the category templates`);
    return templateQuestions(subject);
  }

  if (generated.length < 3) {
    tools.endStep(step, `${generated.length} usable — using the category templates instead`);
    return templateQuestions(subject);
  }
  tools.endStep(step, `${generated.length} generic questions`);
  return generated;
}

/** The fallback asks, built from the category and nothing else. Dull on
 *  purpose: they are what a stranger's question looks like with the wording
 *  taken out, and they can be written without asking anything. */
function templateQuestions(subject: string): string[] {
  return [
    `What's the best tool for ${subject}?`,
    `I need help with ${subject} — what should I use?`,
    `Compare the top options for ${subject}.`,
    `Is there a free or cheap way to handle ${subject}?`,
    `What do most people use for ${subject}?`,
  ];
}

/**
 * THE CATEGORY WITH THE PRODUCT'S NAME TAKEN OUT OF IT.
 *
 * The category defaults to the first sentence of the venture's description,
 * and a description almost always opens with the product's own name —
 * "Scallopbot is a support chatbot widget for websites". Dropped into a
 * template unchanged that produces "What's the best tool for Scallopbot is a
 * support chatbot widget?", which names the product and reads as nonsense. So
 * the name and the host come out, and the copula that was holding them on
 * comes out with them.
 */
function strangersWords(v: VentureRow, category: string): string {
  let s = category;
  for (const word of [v.name, v.host, v.host ? v.host.split(".")[0] : null]) {
    const w = (word ?? "").trim();
    if (w.length < 3) continue;
    s = s.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  s = s
    .replace(/^[\s,;:—–-]+/, "")
    .replace(/^(?:is|are|was|were)\s+(?:an?|the)\s+/i, "")
    .replace(/^(?:an?|the)\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:.]+$/, "")
    .trim();
  /* Nothing left means the category WAS the name. There is no honest way to
     guess the words a stranger would use from that, so the questions say what
     is true — this kind of product — rather than inventing a market. */
  return s.length >= 3 ? s : "this kind of product";
}

/* ------------------------------------------------------------------- the judge */

/**
 * ONE COMPLETION, AND IT IS WHAT MAKES FOUR OF THE SIX COLUMNS ANSWERABLE AT
 * ALL. It is given the venture record as the ground truth and every answer to
 * mark against it.
 *
 * `explanation` AND `action` ARE WHY THIS RUN IS WORTH READING. A row saying
 * "recommended: no" is a fact nobody can act on; "it named Intercom, Drift and
 * Zendesk, and a buyer reading this never learns you exist" plus "get listed
 * on the two comparison pages that rank for this category" is the same fact
 * with a next step on it. Both are one or two sentences, both are the judge's
 * words rather than this file's, and both are NULL when it did not answer.
 */
async function judge(opts: { v: VentureRow; answers: Answer[]; tools: GeoTools }) {
  const { v, answers, tools } = opts;
  const step = tools.startStep("judge", "reading the answers");
  try {
    const truth = [
      `Name: ${v.name}`,
      `Website: ${v.website ?? "unknown"}`,
      `Host: ${v.host ?? "unknown"}`,
      `What it is: ${v.description || "not written down"}`,
    ].join("\n");
    const judgeUser = answers
      .map((a, i) => `[${i + 1}] (${a.kind}) QUESTION: ${a.question}\nANSWER: ${a.answer}`)
      .join("\n\n");
    const res = await tools.turn(
      [
        {
          role: "system",
          content:
            `You are marking another model's answers against a record of the truth. Here is the truth:\n\n${truth}\n\n` +
            `Each answer is tagged with what the question was for. \`direct\` names the product. \`generic\` is what a stranger who has never heard of it would ask. \`extra\` is the owner's own question.\n\n` +
            `For each numbered answer, decide five things.\n` +
            `accurate: true if what the answer says ABOUT THIS PRODUCT is correct, false if it says something wrong about it (confusing it with something else counts as wrong), null if the answer does not describe this product at all.\n` +
            `recommended: true if the answer recommends or suggests this product by name, false if it recommends other things instead, null if it is not a question where anything is recommended.\n` +
            `rivals: the specific products, brands or services the answer named INSTEAD OF or BESIDE this one, as an array of their names. [] when it named none. Names only — no descriptions.\n` +
            `explanation: one or two sentences saying what the answer actually said about this product, or what it said instead of it, and why that is or is not a problem for THIS question.\n` +
            `action: one sentence saying the specific thing to do so that THIS question's answer improves — aimed at what a model would have to READ somewhere, not at the product's own marketing copy.\n\n` +
            `Never invent. If you cannot tell, use null for that field rather than a guess — a null is read as "not judged" and is harmless; a guess is read as a measurement.\n\n` +
            `Reply with ONLY a fenced block, info string \`json scores\`, holding [{"n": 1, "accurate": true, "recommended": null, "rivals": [], "explanation": "…", "action": "…"}, …]. No prose.`,
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
        a.rivals = Array.isArray(o.rivals)
          ? o.rivals
              .map((r) => (typeof r === "string" ? r.trim().slice(0, 60) : ""))
              .filter((r) => r.length > 0)
              .slice(0, 8)
          : null;
        a.explanation = sentence(o.explanation);
        a.action = sentence(o.action);
      }
    tools.endStep(
      step,
      Array.isArray(scores)
        ? `${scores.length} read`
        : "the judge did not answer usably — every judged column stays null",
    );
  } catch (err) {
    /* A judge that fails costs four columns, not the run. The answers are the
       measurement and they are already in hand. */
    tools.endStep(step, `failed — ${err instanceof Error ? err.message : String(err)}; every judged column stays null`);
  }
}

/** A model's one-or-two sentences, or null. An empty string and the word
 *  "null" arriving as prose are both the absence of an answer. */
function sentence(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /^(null|n\/a|none|unknown)$/i.test(s)) return null;
  return s.slice(0, 600);
}

/* --------------------------------------------------------- the recommendations */

/**
 * THE ONE TURN WHOSE WORDS REACH THE PAGE AS PROSE, and it answers in JSON so
 * that the page can lay it out. Asking for markdown here and pasting it into
 * the document would put a second, differently-styled document inside the
 * first — which is what the long text answer the owner complained about was.
 */
async function recommend(opts: {
  v: VentureRow;
  answers: Answer[];
  tools: GeoTools;
}): Promise<{ recommendations: Recommendation[]; cards: Card[]; failed: boolean }> {
  const { v, answers, tools } = opts;
  const step = tools.startStep("write", "recommendations");
  const told = (b: boolean | null) => (b === null ? "not judged" : b ? "yes" : "no");
  const mentions = answers.filter((a) => a.mentioned).length;
  try {
    const res = await tools.turn(
      [
        {
          role: "system",
          content:
            `You are advising the owner of ${v.name} (${v.website ?? "no site recorded"}) on how models talk about it.\n\n` +
            `THE RECORD:\n${v.description || "nothing written down"}\n\n` +
            `WHAT WAS MEASURED: a model with no tools was asked ${answers.length} questions — some naming the product (\`direct\`), some the questions a stranger would ask without knowing it exists (\`generic\`). ` +
            `${mentions} answers mentioned the product. Here is all of it:\n\n` +
            answers
              .map(
                (a) =>
                  `(${a.kind}) Q: ${a.question}\nA: ${a.answer}\nmentioned: ${a.mentioned}, accurate: ${told(a.accurate)}, recommended: ${told(a.recommended)}` +
                  `${a.rivals && a.rivals.length ? `, named instead: ${a.rivals.join(", ")}` : ""}`,
              )
              .join("\n\n") +
            `\n\nThe \`generic\` questions are the ones that matter: they are what a buyer actually asks.\n\n` +
            `Reply with ONLY a fenced block, info string \`json recommendations\`, holding:\n` +
            `{"recommendations": [{"title": "…", "why": "…", "cost": "…", "change": "…"}], "cards": [{"title": "…", "body": "…", "urgency": 2}]}\n\n` +
            `Three to six \`recommendations\`, ranked, each a thing that could be started this week and aimed at what a model would have to READ SOMEWHERE for the answers above to improve — the places it learns from, not the site's own copy alone. \`why\` names the question or the answer above that it comes from. \`cost\` is what it would take. \`change\` is which of the answers above would move.\n` +
            `Three to eight \`cards\`. \`urgency\` is 0 (whenever) to 3 (this week). A card is one action somebody could tick off and its body says why.\n\n` +
            `Never invent a figure. The only measurements you have are the ones above. No prose outside the fence.`,
        },
        { role: "user", content: `What should be done about how models describe ${v.name}?` },
      ],
      { toOutput: false, forceProvider: true },
    );
    const recommendations = readRecommendations(fencedJson(res.text, "recommendations"));
    const cards = readCards(fencedJson(res.text, "cards"));
    if (!recommendations.length) {
      tools.endStep(step, "the model did not answer usably — no recommendations");
      return { recommendations: [], cards: [], failed: true };
    }
    tools.endStep(step, `${recommendations.length} recommendations, ${cards.length} cards`);
    return { recommendations, cards, failed: false };
  } catch (err) {
    /* Same rule as the judge: the measurement is already in hand and the
       document is worth having without the advice on the end of it. */
    tools.endStep(step, `failed — ${err instanceof Error ? err.message : String(err)}`);
    return { recommendations: [], cards: [], failed: true };
  }
}

function readRecommendations(v: unknown): Recommendation[] {
  if (!Array.isArray(v)) return [];
  const out: Recommendation[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    out.push({
      title: title.slice(0, 160),
      why: sentence(o.why) ?? "",
      cost: sentence(o.cost) ?? "",
      change: sentence(o.change) ?? "",
    });
    if (out.length === 8) break;
  }
  return out;
}

/**
 * THE CARDS, READ STRICTLY. `fencedJson` falls back to "the only block that
 * parsed" when it cannot find the key, and both blocks here are the same
 * block — so a reply carrying recommendations and no cards would hand the
 * recommendations back as cards. A card has a body and a recommendation does
 * not, so requiring both strings is what tells them apart.
 */
function readCards(v: unknown): Card[] {
  if (!Array.isArray(v)) return [];
  const out: Card[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!title || !body) continue;
    const urgency = typeof o.urgency === "number" ? Math.max(0, Math.min(3, Math.round(o.urgency))) : 1;
    out.push({ title: title.slice(0, 160), body: body.slice(0, 600), urgency });
    if (out.length === 8) break;
  }
  return out;
}

/* ---------------------------------------------------------------- the document */

/** Every piece of model text on the page goes through this on the way in.
 *  Nothing below builds markup out of a string that has not. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * THE ANSWER, VERBATIM BUT NOT RAW. A model answering "recommend a tool"
 * writes markdown — `**Intercom**` and a bulleted list — and a verbatim
 * dump shows the asterisks. The words are not touched: after escaping, bold
 * markers become <strong> and a leading list marker becomes a bullet, and
 * nothing else is interpreted. The box is pre-wrap, so the lines stay where
 * the model put them.
 */
function answerHtml(s: string): string {
  return esc(s)
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^([ \t]*)[*-][ \t]+/gm, "$1• ");
}

const STYLE = `
:root { --ink: #14161a; --muted: #6b7280; --rule: #e5e7eb; --accent: #4f63d2; --accent-soft: #eef0fb; }
* { box-sizing: border-box; }
body { margin: 0; padding: 40px 20px 72px; background: #fff; color: var(--ink);
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.page { max-width: 46rem; margin: 0 auto; }
h1 { margin: 0 0 6px; font-size: 26px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.25; }
.dateline { margin: 0; color: var(--muted); font-size: 12.5px; }
.rule { height: 3px; background: var(--accent); margin: 14px 0 28px; }
h2 { margin: 36px 0 12px; font-size: 15px; font-weight: 600; padding-left: 10px; border-left: 3px solid var(--accent); }
p { margin: 0 0 12px; }
.callouts { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 8px; }
.callout { flex: 1 1 180px; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; }
.callout .big { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; color: var(--accent); }
.callout .of { font-size: 16px; font-weight: 500; color: var(--muted); }
.callout .cap { margin-top: 4px; font-size: 12px; color: var(--muted); }
.callout .plain { font-size: 14px; font-weight: 600; line-height: 1.4; }
table { width: 100%; border-collapse: collapse; margin: 0 0 10px; font-size: 13px; }
th { text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); border-bottom: 1px solid var(--rule); padding: 0 10px 6px 0; }
td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.q { width: 40%; }
.yes { color: var(--accent); font-weight: 600; }
.no { color: var(--ink); }
.nul { color: var(--muted); font-style: italic; }
.note { color: var(--muted); font-size: 12.5px; line-height: 1.55; margin: 0 0 8px; }
.badge { display: inline-block; border-radius: 6px; padding: 1px 6px; font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; border: 1px solid var(--rule); color: var(--muted); }
.badge-generic { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.ask { border: 1px solid var(--rule); border-radius: 12px; padding: 16px 18px; margin: 0 0 14px; }
.askhead { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 12px; }
.pill { display: inline-block; border: 1px solid var(--rule); border-radius: 8px; padding: 1px 7px; font-size: 11px; color: var(--muted); }
.pill-yes { border-color: var(--accent); color: var(--accent); }
.pill-nul { border-style: dashed; }
.chip { display: inline-block; background: #f4f5f7; border-radius: 6px; padding: 1px 7px; font-size: 11.5px; color: var(--ink); margin-right: 4px; }
.part { margin: 0 0 12px; }
.part:last-child { margin-bottom: 0; }
.label { display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 4px; }
.prompt { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.response { white-space: pre-wrap; max-height: 16rem; overflow: auto; border: 1px solid var(--rule);
  border-radius: 8px; padding: 10px 12px; font-size: 13px; background: #fbfbfc; }
.part p { margin: 0; font-size: 13.5px; }
ol.recs { margin: 0; padding-left: 20px; }
ol.recs li { margin-bottom: 14px; }
ol.recs .rt { font-weight: 600; }
ol.recs .meta { color: var(--muted); font-size: 12.5px; }
footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12px; }
/* THE SCROLLING ANSWER BOX IS A SCREEN AFFORDANCE AND THERE IS NO SCROLLING
   ON PAPER. Printed — which is what the report's PDF export does — a capped
   box would silently cut the answer off at sixteen rems, and the answer is the
   evidence. See client/src/components/runs/ExportPdf.tsx. */
@media print { .response { max-height: none; overflow: visible; } .ask { break-inside: avoid; } }
`;

function composeDocument(opts: {
  v: VentureRow;
  provider: ModelProvider;
  model: string | null;
  answers: Answer[];
  advice: { recommendations: Recommendation[]; cards: Card[]; failed: boolean };
  ts: string;
}): string {
  const { v, provider, model, answers, advice, ts } = opts;
  const day = ts.slice(0, 10);
  const who = `${v.name}${v.host ? ` or ${v.host}` : ""}`;

  const generic = answers.filter((a) => a.kind === "generic");
  const direct = answers.filter((a) => a.kind === "direct");
  const genericJudged = generic.filter((a) => a.recommended !== null);
  const genericRec = generic.filter((a) => a.recommended === true).length;
  const directJudged = direct.filter((a) => a.accurate !== null);
  const directAcc = direct.filter((a) => a.accurate === true).length;
  const mentions = answers.filter((a) => a.mentioned).length;

  /* THE HEADLINE IS THE FINDING, AND IT REFUSES TO STATE ONE IT DOES NOT HAVE.
     "Recommended in 0 of 5" and "nobody judged whether it was recommended" are
     wildly different findings and the second is the one a failed judge
     produces, so the sentence changes rather than printing a zero. */
  const finding =
    generic.length === 0
      ? `${provider.label} answered ${answers.length} questions about ${v.name}`
      : genericJudged.length === 0
        ? `No judgement on whether models recommend ${v.name} in ${generic.length} generic asks`
        : `Models recommend ${v.name} in ${genericRec} of ${genericJudged.length} generic asks`;

  const out: string[] = [];
  out.push(`<!doctype html>`);
  out.push(`<html lang="en">`);
  out.push(`<head>`);
  out.push(`<meta charset="utf-8">`);
  out.push(`<title>${esc(finding)}</title>`);
  out.push(`<style>${STYLE}</style>`);
  out.push(`</head>`);
  out.push(`<body><div class="page">`);
  out.push(`<header>`);
  out.push(`<h1>${esc(finding)}</h1>`);
  out.push(
    `<p class="dateline">${esc(provider.label)}${model ? ` · ${esc(model)}` : ""} · no tools, no web access · ${esc(day)}</p>`,
  );
  out.push(`</header>`);
  out.push(`<div class="rule"></div>`);

  /* THE BIG NUMBERS. Two counts and a provenance line, because the provenance
     IS one of the three things worth knowing: the same questions put to a
     different model are a different finding, not a better one. */
  out.push(`<div class="callouts">`);
  out.push(
    callout(
      generic.length === 0 ? "—" : `${genericRec}`,
      generic.length === 0 ? "" : ` / ${genericJudged.length}`,
      generic.length === 0
        ? "no generic asks in this run"
        : `generic asks that recommended ${esc(v.name)}${generic.length !== genericJudged.length ? ` · ${generic.length - genericJudged.length} of ${generic.length} not judged` : ""}`,
    ),
  );
  out.push(
    callout(
      direct.length === 0 ? "—" : `${directAcc}`,
      direct.length === 0 ? "" : ` / ${directJudged.length}`,
      direct.length === 0
        ? "no direct asks in this run"
        : `direct asks answered accurately${direct.length !== directJudged.length ? ` · ${direct.length - directJudged.length} of ${direct.length} not judged` : ""}`,
    ),
  );
  out.push(
    `<div class="callout"><div class="plain">${esc(provider.label)}<br>${esc(model ?? "model not recorded")}</div><div class="cap">asked ${esc(day)} · ${answers.length} questions · ${mentions} mentioned ${esc(who)}</div></div>`,
  );
  out.push(`</div>`);

  /* -------------------------------------------------------- the summary table */
  out.push(`<h2>Every ask at a glance</h2>`);
  out.push(`<table>`);
  out.push(
    `<thead><tr><th>Question</th><th>Kind</th><th>Mentioned</th><th>Accurate</th><th>Recommended</th><th>Named instead</th></tr></thead><tbody>`,
  );
  for (const a of ordered(answers))
    out.push(
      `<tr><td class="q">${esc(a.question)}</td><td><span class="badge${a.kind === "generic" ? " badge-generic" : ""}">${a.kind}</span></td>` +
        `<td>${cell(a.mentioned)}</td><td>${cell(a.accurate)}</td><td>${cell(a.recommended)}</td>` +
        `<td>${a.rivals === null ? `<span class="nul">not judged</span>` : a.rivals.length === 0 ? `<span class="nul">none named</span>` : a.rivals.map((r) => `<span class="chip">${esc(r)}</span>`).join(" ")}</td></tr>`,
    );
  out.push(`</tbody></table>`);

  /* THE HONESTY NOTE, SHORTENED AND PUT WHERE THE NUMBER IS. It used to be
     three paragraphs above the table; it is the definition of the column and
     it belongs under the column. */
  out.push(
    `<p class="note"><strong>Read those columns with their definitions.</strong> “Mentioned” is string presence of ${esc(who)} in the answer — mechanical, checkable, and the only MEASURED column here. It counts an answer that repeats the name back while saying it has never heard of it, which is why every answer is printed in full below. Accuracy, recommendation, the rivals and the readings were judged by a second completion; “not judged” means it did not answer for that row, never that the answer was wrong.</p>`,
  );

  const chart = barChart(answers);
  if (chart) {
    out.push(`<h2>Mentioned and recommended, by kind</h2>`);
    out.push(chart);
  }

  /* ----------------------------------------------------------- one card per ask */
  out.push(`<h2>The asks, one by one</h2>`);
  out.push(
    `<p class="note">Generic asks first — those are the ones a buyer who has never heard of ${esc(v.name)} would type. Every response below is verbatim.</p>`,
  );
  for (const a of ordered(answers)) out.push(askCard(a));

  /* ------------------------------------------------------------ what to do next */
  out.push(`<h2>Recommendations</h2>`);
  if (advice.failed || advice.recommendations.length === 0) {
    out.push(
      `<p class="note">The model was asked what to do about the answers above and did not answer usably, so there are no recommendations on this page and no board cards were proposed. The measurement above is unaffected — it is what was asked and what came back.</p>`,
    );
  } else {
    out.push(`<ol class="recs">`);
    for (const r of advice.recommendations) {
      const bits: string[] = [`<div class="rt">${esc(r.title)}</div>`];
      if (r.why) bits.push(`<p>${esc(r.why)}</p>`);
      const meta = [r.cost ? `Cost: ${esc(r.cost)}` : "", r.change ? `Changes: ${esc(r.change)}` : ""].filter(Boolean);
      if (meta.length) bits.push(`<p class="meta">${meta.join(" · ")}</p>`);
      out.push(`<li>${bits.join("")}</li>`);
    }
    out.push(`</ol>`);
  }

  out.push(
    `<footer>Written ${esc(day)} from ${answers.length} answers and no sources: nothing was fetched, and every word quoted above is ${esc(provider.label)} answering out of its own weights.</footer>`,
  );
  out.push(`</div></body></html>`);
  return out.join("\n");
}

/** Generic first, then direct, then the owner's own — the report's reading
 *  order, which is not the order they were asked in. */
function ordered(answers: Answer[]): Answer[] {
  const rank: Record<GeoQuestionKind, number> = { generic: 0, direct: 1, extra: 2 };
  return [...answers].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function callout(big: string, of: string, captionHtml: string): string {
  return `<div class="callout"><div class="big">${esc(big)}${of ? `<span class="of">${esc(of)}</span>` : ""}</div><div class="cap">${captionHtml}</div></div>`;
}

function cell(v: boolean | null): string {
  if (v === null) return `<span class="nul">not judged</span>`;
  return v ? `<span class="yes">yes</span>` : `<span class="no">no</span>`;
}

function pill(label: string, v: boolean | null): string {
  if (v === null) return `<span class="pill pill-nul">${label}?</span>`;
  return v ? `<span class="pill pill-yes">${label}</span>` : `<span class="pill">not ${label}</span>`;
}

/** THE FOUR PARTS, WHICH ARE THE WHOLE POINT OF THE REDRAW. Prompt, response,
 *  what it means, what to do — in that order, every time, whether or not the
 *  judge filled the last two in. */
function askCard(a: Answer): string {
  const parts: string[] = [];
  parts.push(`<div class="askhead">`);
  parts.push(`<span class="badge${a.kind === "generic" ? " badge-generic" : ""}">${a.kind}</span>`);
  parts.push(pill("mentioned", a.mentioned));
  parts.push(pill("accurate", a.accurate));
  parts.push(pill("recommended", a.recommended));
  parts.push(`</div>`);
  if (a.rivals && a.rivals.length)
    parts.push(
      `<div class="part"><span class="label">NAMED INSTEAD</span><div>${a.rivals.map((r) => `<span class="chip">${esc(r)}</span>`).join(" ")}</div></div>`,
    );
  parts.push(`<div class="part"><span class="label">PROMPT</span><p class="prompt">${esc(a.question)}</p></div>`);
  parts.push(`<div class="part"><span class="label">RESPONSE</span><div class="response">${answerHtml(a.answer)}</div></div>`);
  parts.push(
    `<div class="part"><span class="label">WHAT THIS MEANS</span><p>${a.explanation ? esc(a.explanation) : `<span class="nul">not judged</span>`}</p></div>`,
  );
  parts.push(
    `<div class="part"><span class="label">WHAT TO DO</span><p>${a.action ? esc(a.action) : `<span class="nul">not judged</span>`}</p></div>`,
  );
  return `<article class="ask">${parts.join("")}</article>`;
}

/**
 * MENTIONED AND RECOMMENDED PER KIND, AS BARS — AND ONLY WHEN THAT COMPARISON
 * EXISTS. One kind of question is not a comparison, it is the table again with
 * rectangles on it, so the chart is skipped entirely below two kinds and a
 * kind with no rows is never drawn. Every bar carries its own figure, which is
 * the house rule: a bar nobody can label is a bar that should not be drawn.
 */
function barChart(answers: Answer[]): string | null {
  const kinds: GeoQuestionKind[] = ["generic", "direct", "extra"];
  const rows = kinds
    .map((kind) => {
      const of = answers.filter((a) => a.kind === kind);
      return {
        kind,
        total: of.length,
        mentioned: of.filter((a) => a.mentioned).length,
        recommended: of.filter((a) => a.recommended === true).length,
      };
    })
    .filter((r) => r.total > 0);
  if (rows.length < 2) return null;

  const max = Math.max(...rows.map((r) => r.total));
  const LEFT = 118;
  const TRACK = 300;
  const GROUP = 58;
  const height = rows.length * GROUP + 8;
  const w = (n: number) => Math.round((n / max) * TRACK);

  const svg: string[] = [];
  svg.push(
    `<svg viewBox="0 0 620 ${height}" width="100%" height="${height}" role="img" aria-label="Mentions and recommendations by question kind">`,
  );
  rows.forEach((r, i) => {
    const y = i * GROUP + 4;
    svg.push(
      `<text x="0" y="${y + 13}" font-size="12" font-weight="600" fill="#14161a">${r.kind}</text>`,
      `<text x="0" y="${y + 29}" font-size="11" fill="#6b7280">${r.total} ${r.total === 1 ? "ask" : "asks"}</text>`,
    );
    const bar = (row: number, value: number, label: string, fill: string) => {
      const by = y + row * 20;
      svg.push(
        `<rect x="${LEFT}" y="${by}" width="${TRACK}" height="14" rx="3" fill="#f0f1f4"></rect>`,
        `<rect x="${LEFT}" y="${by}" width="${w(value)}" height="14" rx="3" fill="${fill}"></rect>`,
        `<text x="${LEFT + TRACK + 10}" y="${by + 11}" font-size="11" fill="#6b7280">${value} of ${r.total} ${label}</text>`,
      );
    };
    bar(0, r.mentioned, "mentioned", "#4f63d2");
    bar(1, r.recommended, "recommended", "#a3adea");
  });
  svg.push(`</svg>`);
  return svg.join("");
}
