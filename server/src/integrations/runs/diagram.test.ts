import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiagram, renderDiagram } from "./diagram.ts";
import { cleanSvg, figureFault } from "./typst.ts";

const answer = [
  "```json diagram",
  JSON.stringify({
    stages: ["Signals", "Proposed scorer", "Action"],
    nodes: [
      { id: "a", label: "Customer message stream", stage: 0 },
      { id: "b", label: "Retrieval of past resolutions", stage: 0 },
      { id: "c", label: "Calibrated confidence model", stage: 1 },
      { id: "d", label: "Answer or escalate to a human", stage: 2 },
    ],
    edges: [
      { from: "a", to: "c", label: "embed" },
      { from: "b", to: "c" },
      { from: "c", to: "d", label: "score" },
      { from: "d", to: "c", label: "feedback" },
    ],
  }),
  "```",
].join("\n");

test("a boxes-and-arrows spec renders to an SVG the paper's own checks accept", () => {
  const spec = parseDiagram(answer);
  assert.ok(!("error" in spec));
  const svg = renderDiagram(spec);
  const cleaned = cleanSvg(svg);
  assert.ok("svg" in cleaned, "error" in cleaned ? cleaned.error : "");
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
  assert.ok(Number(box[1]) >= 320 && Number(box[1]) <= 560);
  assert.ok(Number(box[2]) >= 150 && Number(box[2]) <= 300);
  assert.match(svg, /Calibrated confidence/);
  assert.equal(figureFault(svg), null);
});

test("a spec is found behind reasoning text and bad references are dropped", () => {
  const spec = parseDiagram(
    'We need a diagram. {"nodes":[{"id":"x","label":"A","stage":7},{"id":"y","label":"B","stage":0}],"edges":[{"from":"x","to":"nope"},{"from":"y","to":"x"}]}',
  );
  assert.ok(!("error" in spec));
  assert.equal(spec.edges.length, 1);
  assert.ok(spec.nodes.every((n) => n.stage < spec.stages.length));
  assert.ok("svg" in cleanSvg(renderDiagram(spec)));
});

test("prose with no object is an error that says what came back", () => {
  const r = parseDiagram("Let me carefully plan this figure.");
  assert.ok("error" in r && r.error.includes("Let me carefully"));
});

test("cleanSvg takes the element, not the brief the model quoted while thinking", () => {
  const raw = 'Requirements:\n- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H"> ...\n\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="1" y="1" width="10" height="10"/></svg>';
  const r = cleanSvg(raw);
  assert.ok("svg" in r && r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">'));
});
