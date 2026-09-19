import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now, ventureRowById } from "../../db.ts";
import { geoRun, type GeoTools } from "./geo.ts";
import { looksLikeHtmlReport, splitTrailingFence } from "./html.ts";
import type { Step } from "./store.ts";

/* THE PROVIDER, STUBBED. Only `id` and `label` are read by the run — the rest
   of ModelProvider is the shape the models area needs to CALL one, and this
   run never calls it directly; `tools.turn` is the seam. */
const provider = { id: "stub", label: "Stub Provider" } as unknown as NonNullable<GeoTools["provider"]>;

function venture(slug: string, description: string) {
  const id = `v-${slug}`;
  db.prepare(
    "INSERT INTO ventures(id,slug,name,description,website,host,stage,color,color_source,created_at,updated_at,position,brand) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    slug,
    "Scallopbot",
    description,
    "https://scallopbot.com",
    "scallopbot.com",
    "launched",
    "#123456",
    "owner",
    now(),
    now(),
    0,
    "{}",
  );
  return ventureRowById(id)!;
}

/** The tools seam, with a `turn` the test supplies. Everything else is the
 *  minimum the run touches. */
function tools(turn: GeoTools["turn"], sink: string[]): GeoTools {
  return {
    say: (text) => sink.push(text),
    startStep: (tool, label): Step => ({ toolCallId: `${tool}:${label ?? ""}`, tool, label, startedAt: now(), finishedAt: null }),
    endStep: () => {},
    turn,
    provider,
    model: () => "stub-model-1",
  };
}

const ANSWER = "I have not heard of it. People generally use Intercom or Drift for this.";

/** A reply the judge's parser accepts, for `n` answers. */
function scores(n: number, extra: Record<string, unknown> = {}): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    accurate: false,
    recommended: false,
    rivals: ["Intercom", "Drift"],
    explanation: "It named Intercom and Drift and never mentioned the product.",
    action: "Get listed on the two comparison pages that rank for this category.",
    ...extra,
  }));
  return "```json scores\n" + JSON.stringify(rows) + "\n```";
}

const ADVICE =
  "```json recommendations\n" +
  JSON.stringify({
    recommendations: [{ title: "Get on the comparison pages", why: "Four answers named rivals", cost: "A week", change: "The generic asks" }],
    cards: [{ title: "Pitch the roundup", body: "Ask the two category roundups to include the product.", urgency: 2 }],
  }) +
  "\n```";

test("the generic questions are generated, never name the product, and every judged field lands on the row", async () => {
  const v = venture("geo-generated", "Scallopbot is a support chatbot widget for websites");
  const sink: string[] = [];
  const asked: string[] = [];
  let generatorPrompt = "";
  await geoRun({
    runId: "r-geo-generated",
    venture: v,
    input: { questions: "Does it integrate with Slack?" },
    tools: tools(async (turns, opts) => {
      assert.equal(opts.toOutput, false, "every turn is silent; the document is said once at the end");
      assert.equal(opts.forceProvider, true, "the measurement is the raw provider, never an agent");
      const system = turns[0]!.content;
      if (system.includes("STRANGER")) {
        generatorPrompt = system;
        /* One of these names the product and must be thrown away; the panel
           and the report both depend on a generic ask being genuinely blind. */
        return {
          text:
            "```json questions\n" +
            JSON.stringify([
              "What's the best tool for a support chatbot widget?",
              "I need to answer customer questions on my site overnight — what should I use?",
              "Compare the top live chat widgets for a small site.",
              "Is Scallopbot any good?",
              "Is there a free way to add a support chatbot?",
            ]) +
            "\n```",
        };
      }
      if (system.includes("marking another model's answers")) return { text: scores(asked.length) };
      if (system.includes("advising the owner")) return { text: ADVICE };
      asked.push(turns[1]!.content);
      return { text: ANSWER };
    }, sink),
  });

  assert.match(generatorPrompt, /never to be repeated in a question/);

  const rows = db
    .prepare("SELECT question, kind, rivals, explanation, action, accurate, recommended FROM geo_answers WHERE run_id=? ORDER BY rowid")
    .all("r-geo-generated") as unknown as {
    question: string;
    kind: string;
    rivals: string;
    explanation: string;
    action: string;
    accurate: number;
    recommended: number;
  }[];

  assert.deepEqual(
    rows.map((r) => r.kind),
    ["direct", "direct", "direct", "generic", "generic", "generic", "generic", "extra"],
    "three direct asks, the four surviving generated ones, then the owner's",
  );
  const generic = rows.filter((r) => r.kind === "generic");
  assert.equal(generic.length, 4, "the generated question naming the product was thrown away");
  for (const r of generic) {
    assert.doesNotMatch(r.question.toLowerCase(), /scallopbot/, "a generic ask never names the product");
    assert.doesNotMatch(r.question.toLowerCase(), /scallopbot\.com/, "nor its host");
  }
  assert.equal(rows[0]!.explanation, "It named Intercom and Drift and never mentioned the product.");
  assert.equal(rows[0]!.action, "Get listed on the two comparison pages that rank for this category.");
  assert.deepEqual(JSON.parse(rows[0]!.rivals), ["Intercom", "Drift"]);
  assert.equal(rows[0]!.accurate, 0);
  assert.equal(rows[0]!.recommended, 0);
});

test("a generator that fails falls back to category templates that still never name the product", async () => {
  const v = venture("geo-fallback", "Scallopbot is a support chatbot widget for websites");
  const sink: string[] = [];
  await geoRun({
    runId: "r-geo-fallback",
    venture: v,
    input: {},
    tools: tools(async (turns) => {
      const system = turns[0]!.content;
      if (system.includes("STRANGER")) throw new Error("provider refused");
      if (system.includes("marking another model's answers")) return { text: scores(8) };
      if (system.includes("advising the owner")) return { text: ADVICE };
      return { text: ANSWER };
    }, sink),
  });

  const generic = db
    .prepare("SELECT question FROM geo_answers WHERE run_id=? AND kind='generic' ORDER BY rowid")
    .all("r-geo-fallback") as unknown as { question: string }[];
  assert.equal(generic.length, 5, "the deterministic templates are the whole fallback set");
  for (const r of generic) {
    assert.doesNotMatch(r.question.toLowerCase(), /scallopbot/, "the venture's own name is stripped out of the category first");
    assert.match(r.question.toLowerCase(), /support chatbot widget for websites/);
  }
});

test("the report is one HTML document with the four parts per question and the cards fence after it", async () => {
  const v = venture("geo-document", "Scallopbot is a support chatbot widget for websites");
  const sink: string[] = [];
  const nasty = "Never heard of it. <script>alert(1)</script> Try Intercom.";
  await geoRun({
    runId: "r-geo-document",
    venture: v,
    input: {},
    tools: tools(async (turns) => {
      const system = turns[0]!.content;
      if (system.includes("STRANGER"))
        return {
          text: "```json questions\n" + JSON.stringify(["What's the best support chat widget?", "I need overnight support cover — what should I use?", "Compare the top chat widgets."]) + "\n```",
        };
      if (system.includes("marking another model's answers")) return { text: scores(6) };
      if (system.includes("advising the owner")) return { text: ADVICE };
      return { text: nasty };
    }, sink),
  });

  const output = sink.join("");
  assert.ok(looksLikeHtmlReport(output), "the page must be framed as a report, not drawn as markdown");
  const { doc, tail } = splitTrailingFence(output);
  assert.ok(doc.trim().startsWith("<!doctype html>"));
  assert.ok(doc.includes("</html>"));

  assert.ok(!doc.includes("<script>"), "an answer containing a script tag is escaped, not embedded");
  assert.ok(doc.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "and it survives on the page as text");

  for (const label of ["PROMPT", "RESPONSE", "WHAT THIS MEANS", "WHAT TO DO"])
    assert.equal(doc.split(label).length - 1, 6, `${label} appears once per question`);
  assert.ok(doc.includes("max-height: 16rem"), "a long answer is boxed rather than left to swamp the page");
  assert.ok(doc.includes("Get on the comparison pages"), "the recommendations are rendered into the document");
  assert.ok(doc.includes("<svg"), "two kinds of question earn the chart");

  assert.match(tail, /```json cards/);
  assert.deepEqual(JSON.parse(tail.replace(/```json cards|```/g, "").trim()), [
    { title: "Pitch the roundup", body: "Ask the two category roundups to include the product.", urgency: 2 },
  ]);
});

test("a judge that fails leaves nulls, does not fail the run, and the page says not judged", async () => {
  const v = venture("geo-nojudge", "Scallopbot is a support chatbot widget for websites");
  const sink: string[] = [];
  await geoRun({
    runId: "r-geo-nojudge",
    venture: v,
    input: {},
    tools: tools(async (turns) => {
      const system = turns[0]!.content;
      if (system.includes("STRANGER")) throw new Error("no generator");
      if (system.includes("marking another model's answers")) throw new Error("the judge fell over");
      if (system.includes("advising the owner")) return { text: "I would rather not." };
      return { text: ANSWER };
    }, sink),
  });

  const rows = db
    .prepare("SELECT accurate, recommended, rivals, explanation, action FROM geo_answers WHERE run_id=?")
    .all("r-geo-nojudge") as unknown as Record<string, unknown>[];
  assert.equal(rows.length, 8, "every question was still asked and stored");
  for (const r of rows)
    assert.deepEqual({ ...r }, { accurate: null, recommended: null, rivals: null, explanation: null, action: null });

  const output = sink.join("");
  assert.ok(looksLikeHtmlReport(output));
  assert.ok(output.includes("No judgement on whether models recommend"), "the headline refuses to print a zero nobody measured");
  assert.ok(output.includes("not judged"));
  assert.ok(!output.includes("```json cards"), "an unusable recommendations turn proposes no cards");
  assert.ok(output.includes("did not answer usably"));
});
