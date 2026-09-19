import assert from "node:assert/strict";
import { test } from "node:test";
import { demandRun } from "./demand.ts";
import { demandBlock } from "./context.ts";
import { runArtifactFiles } from "./artifacts.ts";

/**
 * THE DEMAND RUN'S TWO TURNS, and the one rule that matters more here than in
 * any other report: a count in the page is a count this box computed, and a
 * phrase nobody could ask about is not a phrase nobody uses. The first three
 * tests are research.test.ts's, because the shape is deliberately the same
 * one; the last is about the tally the block now computes, which is the only
 * honest source of the numbers the chart is drawn from.
 */

const html =
  '<!doctype html><html><head><title>Nobody says the phrase we watch</title></head><body><h1>Nobody says the phrase we watch</h1>' +
  '<p>Three strangers asked for the same thing in different words this month. The collected signals record 2 Reddit threads for "free llm api" and none for the phrase on the watch list.</p>' +
  '<table><tr><th>Ask</th><th>Where</th></tr><tr><td>"is there a free llm api that does not rate limit"</td><td>reddit.com</td></tr></table></body></html>';

const base = {
  ventureName: "Example",
  focus: "Which phrases are dead",
  blocks: [{ source: "Demand — Reddit, Hacker News, the search node", text: "- free llm api — Reddit 2; Hacker News 0" }],
  writerUsesProvider: true,
  runSeconds: 7200,
  step: async <T>(_label: string, work: () => Promise<T>) => work(),
};

test("demand investigates, then writes the page with a tool-free writer, and keeps the notes", async () => {
  const outputs: string[] = [];
  let calls = 0;
  await demandRun({
    ...base,
    runId: "r-demand-test",
    hasTools: true,
    say: t => outputs.push(t),
    turn: async (turns, opts) => {
      calls++;
      assert.equal(opts.toOutput, false, "interim narration never becomes the report");
      if (calls === 1) {
        assert.match(turns[0]!.content, /EVIDENCE LOG/);
        assert.match(turns[0]!.content, /DO NOT EDIT THE WATCH LIST/);
        assert.match(turns[0]!.content, /VERBATIM/);
        return { text: 'Observed: "is there a free llm api that does not rate limit" — reddit.com, 2026-09-10, 41 upvotes. Failed source: the forum refused.' };
      }
      assert.equal(opts.forceProvider, true, "writing must use the tool-free provider when available");
      assert.equal(opts.document, true, "the writer needs the document ceiling, not a thinking budget");
      assert.match(turns[0]!.content, /verbatim asks/);
      assert.match(turns[0]!.content, /NOT MEASURED/);
      assert.match(turns[1]!.content, /Failed source: the forum refused/);
      return { text: calls === 2 ? "I will now write the demand report" : html };
    },
  });
  assert.equal(calls, 3, "one investigation, one refused draft, one repair");
  assert.deepEqual(outputs, [html], "only the finished page is published");
  const files = runArtifactFiles({ id: "r-demand-test", kind: "demand", title: "Example", status: "done", output: html, queued_at: "2026-09-19", finished_at: null });
  assert.match(files.find(f => f.name === "evidence.json")!.data.toString(), /does not rate limit/);
  assert.ok(files.some(f => f.name === "report.html"), "the page is shipped as report.html, not report.md");
});

test("a demand run with no agent does no investigation and discloses that it read saved signals only", async () => {
  let calls = 0;
  await demandRun({
    ...base,
    runId: "r-demand-no-tools",
    hasTools: false,
    say: () => {},
    turn: async turns => {
      calls++;
      assert.match(turns[1]!.content, /Saved signals only; no new research/);
      assert.match(turns[1]!.content, /no external investigation occurred/);
      assert.match(turns[0]!.content, /NO TOOLS WERE AVAILABLE FOR THIS RUN/);
      return { text: html };
    },
  });
  assert.equal(calls, 1, "no tools means no investigation turn at all");
});

test("a truncated demand page fails after one repair and publishes nothing", async () => {
  const outputs: string[] = [];
  await assert.rejects(
    demandRun({ ...base, runId: "r-demand-truncated", hasTools: false, say: t => outputs.push(t), turn: async () => ({ text: html.slice(0, -7) }) }),
    /complete HTML report/,
  );
  assert.deepEqual(outputs, []);
});

test("the demand block counts threads per phrase per source and never calls an unasked phrase a zero", async t => {
  const doc = {
    windowDays: 30,
    terms: ["free llm api", "planning permission ireland"],
    reddit: {
      connected: true,
      threads: 2,
      signals: [
        /* The same thread found by one phrase twice — one conversation, and the
           tally must say 2 rather than 3 for this phrase. */
        { id: "t3_a", term: "free llm api", title: "Free LLM API that does not rate limit?", points: 41, createdAt: "2026-09-10T08:00:00Z", url: "https://www.reddit.com/r/selfhosted/comments/a", context: "r/selfhosted" },
        { id: "t3_a", term: "free llm api", title: "Free LLM API that does not rate limit?", points: 41, createdAt: "2026-09-10T08:00:00Z", url: "https://www.reddit.com/r/selfhosted/comments/a", context: "r/selfhosted" },
        { id: "t3_b", term: "free llm api", title: "Cheapest way to call a model", points: null, createdAt: null, url: "https://www.reddit.com/r/LocalLLaMA/comments/b", context: "r/LocalLLaMA" },
      ],
      queries: [
        { term: "free llm api", status: "ok", items: 3 },
        { term: "planning permission ireland", status: "throttled", items: null, error: "one query a minute without a feed token" },
      ],
    },
    hn: {
      connected: true,
      threads: 1,
      signals: [{ id: "h1", term: "planning permission ireland", title: "Ask HN: planning rules", points: 3, createdAt: "2026-09-02T09:00:00Z", url: "https://news.ycombinator.com/item?id=1", context: "story" }],
      queries: [
        { term: "free llm api", status: "ok", items: 0 },
        { term: "planning permission ireland", status: "ok", items: 1 },
      ],
    },
  };
  t.mock.method(globalThis, "fetch", async () => Response.json(doc));
  const block = await demandBlock();

  assert.match(block.text, /- free llm api — Reddit 2; Hacker News 0$/m, "distinct thread ids, and a measured zero stays a zero");
  assert.match(block.text, /- planning permission ireland — Reddit 0 NOT MEASURED \(throttled: one query a minute/, "a throttled phrase is never reported as no demand");
  assert.match(block.text, /planning permission ireland — Reddit 0 NOT MEASURED \([^)]*\); Hacker News 1$/m);
  assert.match(block.text, /Totals for the window[^\n]*Reddit 2, Hacker News 1/);
  assert.match(block.text, /NOT evidence that nobody is talking about them/, "the sentence the report is told to quote is still in the block");
  assert.match(block.text, /planning permission ireland via Reddit: throttled/);
  assert.match(block.text, /\(41 upvotes\)/, "Reddit scores are read from `points`, which is the field the route sends");
  assert.match(block.text, /\(3 points\)/);
  assert.match(block.text, /\(upvotes not recorded\) — r\/LocalLLaMA — undated/, "an unscored, undated row says so rather than reading as a zero");
});
