import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { db, ventureRow } from "../../db.ts";
import { registerProvider, setProviderChoiceReader } from "../../models/provider.ts";
import { readJourney } from "../ventures/journey.ts";
import { knownRivals } from "../runs/competitors.ts";
import { callTurn, callTurns, finishCall, spoken, type CallEvent } from "./call.ts";
import { ideaCallRoutes } from "./routes.ts";

/** A model that says what the test scripted, and remembers what it was sent. */
const script: unknown[] = [];
const sent: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
    sent.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "m", choices: [{ message: script.shift() ?? { role: "assistant", content: "…" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
registerProvider("local", () => ({
  id: "local", label: "Local", endpoints: [{ baseUrl: base, key: null, label: "test" }],
  defaultModel: "m", policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 10_000 },
}) as never);
setProviderChoiceReader(() => "local");
test.after(() => server.close());

const now = new Date().toISOString();
db.prepare("INSERT INTO ventures(id,slug,name,description,host,stage,color,color_source,created_at,updated_at,position) VALUES('v-call','tripvote','Tripvote','A shared notebook for trips',NULL,'idea','#334455','owner',?,?,0)").run(now, now);
const venture = () => ventureRow("v-call")!;
const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const drain = async (message: string | null) => { const events: CallEvent[] = []; for await (const e of callTurn(venture(), message, new AbortController().signal)) events.push(e); return events; };

test("a turn runs the tools it asked for, writes the idea page, and speaks plain text", async () => {
  script.push(
    { role: "assistant", content: null, tool_calls: [
      call("update_idea", { problem: "Nobody books the trip after the group chat.", customer: "The friend who always ends up organising.", description: "Turns a group chat into a booked trip." }),
      call("save_competitors", { competitors: [{ name: "Wanderlog", url: "wanderlog.com", positioning: "Itinerary planner", strengths: ["maps"] }, { name: "No site" }] }),
      call("save_name", { name: "Tripvote", domain: "tripvote.com", status: "shortlisted", evidence: "Domain looked free." }),
    ] },
    { role: "assistant", content: "**Good.** So the locking is the product.\n\n- Who decides in your group?" },
  );
  const events = await drain("Seventeen screenshots and nobody booked anything");

  assert.deepEqual(events.filter(e => e.type === "tool").map(e => e.type === "tool" && `${e.tool}:${e.status}`), [
    "update_idea:running", "update_idea:completed", "save_competitors:running", "save_competitors:completed", "save_name:running", "save_name:completed"]);
  const updated = events.filter(e => e.type === "updated").at(-1);
  assert.ok(updated?.type === "updated");
  assert.deepEqual([...updated.update.fields].sort(), ["Description", "First customer", "Problem to solve"]);
  assert.deepEqual(updated.update.competitors, ["Wanderlog"], "a rival with no website is not filed");
  assert.deepEqual(updated.update.names, ["Tripvote"]);

  const say = events.at(-1);
  assert.equal(say?.type === "say" && say.turn.text, "Good. So the locking is the product. Who decides in your group?");

  const doc = readJourney(venture());
  assert.equal(doc.state.profile.problem, "Nobody books the trip after the group chat.");
  assert.equal(doc.state.names[0]?.domain, "tripvote.com");
  assert.equal(doc.state.tasks["idea:common:alternatives"]?.status, "done");
  assert.equal(venture().description, "Turns a group chat into a booked trip.");
  assert.deepEqual(knownRivals("v-call").map(r => [r.name, r.url, r.domain]), [["Wanderlog", "https://wanderlog.com", "wanderlog.com"]]);

  /* The second round was handed the tool results, and the brief named the page. */
  assert.equal(sent.at(-1)?.messages.filter(m => m.role === "tool").length, 3);
  assert.match(String(sent[0]?.messages[0]?.content), /Tripvote[\s\S]*Problem to solve \[problem\]: \(empty\)/);
  assert.ok(sent[0]?.tools?.length);
  assert.deepEqual(callTurns("v-call").map(t => t.role), ["user", "assistant"]);
});

test("the next turn remembers the conversation, and sees what the page now says", async () => {
  sent.length = 0;
  script.push({ role: "assistant", content: "Welcome back. We had the problem; who pays?" });
  await drain(null);
  const messages = sent[0]!.messages;
  assert.match(String(messages[0]!.content), /Problem to solve \[problem\]: Nobody books the trip/);
  assert.match(String(messages[0]!.content), /Wanderlog \(https:\/\/wanderlog\.com\)/);
  assert.equal(messages[1]!.content, "Seventeen screenshots and nobody booked anything");
  assert.match(String(messages.at(-1)!.content), /rejoined the call/);
  assert.equal(callTurns("v-call").length, 3, "opening the line stores the greeting and no invented user turn");
});

test("hanging up files what the call settled and the page does not say", async () => {
  script.push({ role: "assistant", content: 'Here you go: {"revenueModel":"A flat fee per booked trip.","competitors":[{"name":"Troupe","url":"https://troupe.com"}]}' });
  const update = await finishCall(venture());
  assert.deepEqual(update, { fields: ["Offer & pricing assumptions"], competitors: ["Troupe"], names: [] });
  assert.equal(readJourney(venture()).state.profile.revenueModel, "A flat fee per booked trip.");
  assert.equal(readJourney(venture()).state.profile.problem, "Nobody books the trip after the group chat.", "a field it did not name is left alone");
});

test("the routes answer: the document, a refused empty message, an unknown venture", async () => {
  const doc = await (await ideaCallRoutes.request("/tripvote")).json() as { ready: boolean; turns: unknown[] };
  assert.equal(doc.ready, true); assert.equal(doc.turns.length, 3);
  const post = (body: unknown) => ideaCallRoutes.request("/tripvote/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ message: "  " })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await ideaCallRoutes.request("/nope")).status, 404);
  script.push({ role: "assistant", content: "Tell me who pays." });
  const stream = await (await post({ message: "ok" })).text();
  assert.match(stream, /event: say\ndata: \{"id":\d+,"role":"assistant","text":"Tell me who pays\."/);
  assert.equal((await (await ideaCallRoutes.request("/tripvote", { method: "DELETE" })).json() as { deleted: number }).deleted, 5);
});

test("spoken text carries no markup", () => {
  assert.equal(spoken("<think>hmm</think>## Title\n1. **One** thing\n* and [a link](https://x.y)"), "Title One thing and a link");
});

test("the call's models are chosen together with their provider, and a model never outlives it", async () => {
  const put = (body: unknown) => ideaCallRoutes.request("/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put({ provider: "openai" })).status, 400, "a provider that is not connected is refused");
  const chosen = await (await put({ provider: "local", model: "fast-one", sttModel: "whisper-x", ttsVoice: "nova" })).json() as { text: { provider: string; model: string; answering: { model: string }; providers: { id: string; models: string[] }[] }; listen: { chosen: string }; speak: { chosenVoice: string }; secure: { httpsPort: number | null } };
  assert.deepEqual([chosen.text.provider, chosen.text.model, chosen.text.answering.model, chosen.listen.chosen, chosen.speak.chosenVoice], ["local", "fast-one", "fast-one", "whisper-x", "nova"]);
  assert.deepEqual(chosen.text.providers.map(p => [p.id, p.models]), [["local", ["m"]]], "the picker is offered what the endpoint lists");
  assert.equal(chosen.secure.httpsPort, null);

  sent.length = 0; script.push({ role: "assistant", content: "Hello." });
  await drain(null);
  assert.equal((sent[0] as unknown as { model: string }).model, "fast-one", "the chosen model is the one asked");

  const cleared = await (await put({ provider: null })).json() as { text: { provider: string | null; model: string | null } };
  assert.deepEqual([cleared.text.provider, cleared.text.model], [null, null]);
  assert.equal((await ideaCallRoutes.request("/listen", { method: "POST", body: new FormData() })).status, 400);
  assert.equal((await ideaCallRoutes.request("/say", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
});
