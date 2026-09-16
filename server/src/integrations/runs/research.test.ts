import assert from "node:assert/strict";
import { test } from "node:test";
import { researchRun } from "./research.ts";
import { runArtifactFiles } from "./artifacts.ts";

const html = '<!doctype html><html><head><title>A finding</title></head><body><h1>A finding</h1><p>Supported conclusion. The supplied Search Console snapshot records 34 clicks over 28 days. No customer interviews were available, which limits the conclusions.</p></body></html>';
const base = { ventureName: "Example", focus: "Compare acquisition options", blocks: [{ source: "Search Console", text: "34 clicks over 28 days" }], writerUsesProvider: true, step: async <T>(_label: string, work: () => Promise<T>) => work() };

test("research separates investigation from writing and retains evidence even across a formatting retry", async () => {
  const outputs: string[] = []; let calls = 0;
  await researchRun({ ...base, runId: "r-research-test", hasTools: true, say: t => outputs.push(t), turn: async (turns, opts) => {
    calls++;
    assert.equal(opts.toOutput, false, "interim narration never becomes the report");
    if (calls === 1) { assert.match(turns[0]!.content, /EVIDENCE LOG/); return { text: "Observed 34 clicks. Source: Search Console. Uncovered: customer interviews." }; }
    assert.equal(opts.forceProvider, true, "writing must use the tool-free provider when available");
    assert.match(turns[1]!.content, /Uncovered: customer interviews/);
    return { text: calls === 2 ? "I will now write the report" : html };
  } });
  assert.equal(calls, 3);
  assert.deepEqual(outputs, [html]);
  const files = runArtifactFiles({ id: "r-research-test", kind: "research", title: "Example", status: "done", output: html, queued_at: "2026-09-16", finished_at: null });
  assert.match(files.find(f => f.name === "evidence.json")!.data.toString(), /34 clicks/);
});

test("no-tools research does no investigation and discloses its limits to the writer", async () => {
  let calls = 0;
  await researchRun({ ...base, runId: "r-no-tools", hasTools: false, say: () => {}, turn: async turns => {
    calls++; assert.match(turns[1]!.content, /Saved context only; no new research/);
    assert.match(turns[1]!.content, /no external investigation occurred/);
    return { text: html };
  } });
  assert.equal(calls, 1);
});

test("truncated reports fail after one repair and do not publish a partial page", async () => {
  const outputs: string[] = [];
  await assert.rejects(researchRun({ ...base, runId: "r-truncated", hasTools: false, say: t => outputs.push(t), turn: async () => ({ text: html.slice(0, -7) }) }), /complete HTML report/);
  assert.deepEqual(outputs, []);
});
