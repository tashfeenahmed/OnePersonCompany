import { test } from "node:test";
import assert from "node:assert/strict";
import { localItems, markParts, mergeItems, nameScore, newItemForKey, type SpotlightSources } from "./spotlight.ts";

const sources: SpotlightSources = {
  pages: [{ to: "/board", label: "Board" }, { to: "/dashboards", label: "Dashboards" }, { to: "/outputs/research", label: "Research", also: "outputs reports" }],
  ventures: [{ id: "v1", slug: "acme", name: "Acme Boards" }],
  dashboards: [{ id: "d1", name: "Revenue board", to: "/dashboards/revenue" }],
  sessions: [
    { id: "s1", title: "Pricing for the board game", ventureId: "v1", children: [{ id: "run:r1", runId: "r1", title: "Board game market", to: "/team/researcher/runs/r1" }] },
    { id: "s2", title: "Something else" },
  ],
};

test("nothing typed is the start screen: the action, recent chats, every page", () => {
  const items = localItems("", sources);
  assert.deepEqual([items[0].key, items[0].to], ["action:chat", "/"]);
  assert.equal(items.filter(i => i.group === "Actions").length, 1, "the start screen offers the one action made daily");
  assert.deepEqual(items.filter(i => i.group === "Chats").map(i => i.key), ["chat:s1", "chat:s2"]);
  assert.equal(items.filter(i => i.group === "Pages").length, 3);
});

test("names match on every word, and a name that starts with it comes first", () => {
  assert.equal(nameScore("Board", ["boa"]), 3);
  assert.equal(nameScore("Revenue board", ["boa"]), 2);
  assert.equal(nameScore("Dashboards", ["boa"]), 1);
  assert.equal(nameScore("Dashboards", ["boa", "zzz"]), 0);
  const items = localItems("board", sources);
  assert.deepEqual(items.filter(i => i.group === "Pages").map(i => i.title), ["Board", "Dashboards"]);
  assert.deepEqual(items.map(i => i.group).filter((g, i, all) => all.indexOf(g) === i), ["Pages", "Ventures", "Dashboards", "Chats", "Reports"]);
  assert.equal(localItems("reports", sources)[0].title, "Research", "a page answers to what it is as well as its name");
  assert.deepEqual(localItems("new", sources).filter(i => i.group === "Actions").map(i => i.key), ["action:chat", "action:dashboard", "action:venture-idea", "action:venture-pre-launch", "action:venture-launched"]);
  assert.equal(localItems("venture launched", sources)[0].to, "/ventures/new?stage=launched");
  assert.equal(newItemForKey("P")?.id, "venture-pre-launch");
  assert.equal(newItemForKey("Enter"), undefined);
});

test("a chat both sides found is one row: the server's address, the owner's title", () => {
  const local = localItems("board", sources);
  const merged = mergeItems(local, [
    { group: "chat", id: "s1", title: "first words", snippet: "…the board game costs…", to: "/chat/s1?m=7", ventureId: null, at: null, matches: 3 },
    { group: "chat", id: "s9", title: "Only the server knows", snippet: "a board", to: "/chat/s9?m=2", ventureId: null, at: null, matches: 1 },
    { group: "report", id: "r1", title: "Board game market", snippet: "boards sell", to: "/elsewhere", ventureId: null, at: null },
    { group: "card", id: "4", title: "Fix the board", snippet: null, to: "/board?card=4", ventureId: "v1", at: null },
  ], sources);
  const chats = merged.filter(i => i.group === "Chats");
  assert.deepEqual(chats.map(i => i.key), ["chat:s1", "chat:s9"]);
  assert.deepEqual([chats[0].title, chats[0].to, chats[0].detail], ["Pricing for the board game", "/chat/s1?m=7", "3 messages"]);
  assert.equal(chats[1].detail, undefined);
  const report = merged.filter(i => i.group === "Reports");
  assert.equal(report.length, 1);
  assert.deepEqual([report[0].to, report[0].snippet], ["/team/researcher/runs/r1", "boards sell"]);
  assert.equal(merged.find(i => i.group === "Cards")?.detail, "Acme Boards");
  assert.ok(merged.findIndex(i => i.group === "Cards") > merged.findIndex(i => i.group === "Chats"));
});

test("a watched person from the server lands in a People group of its own", () => {
  const merged = mergeItems(localItems("nadia", sources), [
    { group: "person", id: "p1", title: "Nadia Okonkwo", snippet: null, to: "/outputs/dossier?person=p1", ventureId: null, at: null },
  ], sources);
  const person = merged.find((i) => i.group === "People");
  assert.deepEqual([person?.key, person?.to, person?.title], ["person:p1", "/outputs/dossier?person=p1", "Nadia Okonkwo"]);
  assert.ok(merged.findIndex((i) => i.group === "People") > merged.findIndex((i) => i.group === "Reports"),
    "People sorts last, so a name the palette already had never buries a page");
});

test("marks keep the text's own case and do not overlap", () => {
  assert.deepEqual(markParts("The Board boards", ["board", "boa"]), [
    { text: "The ", hit: false }, { text: "Board", hit: true }, { text: " ", hit: false }, { text: "board", hit: true }, { text: "s", hit: false },
  ]);
  assert.deepEqual(markParts("plain", []), [{ text: "plain", hit: false }]);
});
