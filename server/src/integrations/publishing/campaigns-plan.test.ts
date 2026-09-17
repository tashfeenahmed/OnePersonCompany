import assert from "node:assert/strict";
import test from "node:test";
import { readModelJson } from "../videoplus/json.ts";
import { parseJson, shapeConcepts } from "./campaigns.ts";

test("a plan sent as a bare run of concepts is still a plan", () => {
  const reply = `Here are the concepts.
{"theme":"Your server, your agent","description":"Runs on your own box.","imageNote":"a small server"},
{"title":"Memory that consolidates","description":"It remembers."}`;
  assert.deepEqual(shapeConcepts(parseJson(reply), 3), []);
  const concepts = shapeConcepts(readModelJson(reply, "concepts"), 3);
  assert.deepEqual(concepts.map((c) => c.theme), ["Your server, your agent", "Memory that consolidates"]);
});
