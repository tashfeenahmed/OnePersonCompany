import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSuggestions, type SuggestionContext } from "./suggestions.ts";

const context = (): SuggestionContext => ({ day: "2026-09-16", ventureId: null, alerts: [], cards: [], runs: [], activity: [], journal: [], agents: [],
  ventures: Array.from({ length: 12 }, (_, i) => ({ id: `v-${i}`, name: `Venture ${i}`, slug: `venture-${i}`, stage: "launched", description: `Product ${i}` })) });

test("six unique, reproducible suggestions rotate across days without invented alerts", () => {
  const ctx = context();
  const today = selectSuggestions(ctx);
  assert.equal(today.length, 6);
  assert.equal(new Set(today.map(s => s.id)).size, 6);
  assert.equal(new Set(today.map(s => s.ventureId)).size, 6);
  assert.deepEqual(selectSuggestions(ctx), today);
  const tomorrow = selectSuggestions({ ...ctx, day: "2026-09-17" });
  assert.notDeepEqual(new Set(today.map(s => s.id)), new Set(tomorrow.map(s => s.id)));
  assert.ok(today.every(s => s.kind === "venture"));
});

test("urgent current alerts persist, deduplicate by affected resource, and disappear when resolved", () => {
  const ctx = context();
  ctx.alerts = [
    { id: "disk", title: "Host disk is full", detail: "Disk at 98%", severity: "critical", sources: ["fleet"], entity: { kind: "server", id: "1" } },
    { id: "memory", title: "Host memory high", detail: "Memory at 94%", severity: "critical", sources: ["fleet"], entity: { kind: "server", id: "1" } },
  ];
  for (const day of ["2026-09-16", "2026-09-17"]) {
    const suggestions = selectSuggestions({ ...ctx, day });
    assert.equal(suggestions[0]!.kind, "alert");
    assert.equal(suggestions.filter(s => s.kind === "alert").length, 1);
    assert.equal(suggestions[0]!.source.href, "/dashboards/servers");
  }
  assert.ok(selectSuggestions({ ...ctx, alerts: [] }).every(s => s.kind !== "alert"));
});

test("selection mixes overdue work, agent results, activity and venture opportunities", () => {
  const ctx = context();
  ctx.cards = Array.from({ length: 12 }, (_, i) => ({ id: i, title: `Task ${i}`, ventureId: `v-${i}`, urgency: 1, due: "2026-09-15", column: "Doing" }));
  ctx.runs = [{ id: "r-seo", title: "SEO review", status: "done", ventureId: "v-1", finishedAt: "2026-09-16T08:00:00Z", href: "/ventures/venture-1/team/seo/runs/r-seo", agent: "SEO analyst" }];
  ctx.activity = [{ kind: "signup", ventureId: "v-3", count: 5, latest: "2026-09-16" }];
  const selected = selectSuggestions(ctx);
  assert.ok(selected.some(s => s.kind === "board" && s.reason.includes("Overdue")));
  assert.ok(selected.some(s => s.kind === "report"));
  assert.ok(new Set(selected.map(s => s.kind)).size >= 3);
  const report = selected.find(s => s.kind === "report")!;
  assert.match(report.prompt, /Reuse this report/);
  assert.equal(report.source.href, ctx.runs[0]!.href);
});

test("venture filtering keeps prompts and enabled team scoped to the selected business", () => {
  const ctx = context(); ctx.ventureId = "v-2";
  ctx.agents = [{ id: "sa-two", name: "Two analyst", title: "Analyst", ventureId: "v-2" }, { id: "sa-other", name: "Other analyst", title: "Analyst", ventureId: "v-3" }];
  const selected = selectSuggestions(ctx);
  assert.equal(selected.length, 6);
  assert.ok(selected.every(s => s.ventureId === "v-2" && s.ventureName === "Venture 2"));
  assert.ok(selected.every(s => s.prompt.includes("sa-two") && !s.prompt.includes("sa-other")));
});

test("empty workspaces have six honest starters; deleted venture references and active runs are omitted", () => {
  const ctx = context(); ctx.ventures = [];
  ctx.runs = [{ id: "active", title: "Active", status: "running", ventureId: null, finishedAt: null, href: "/apps/seo/active", agent: null },
    { id: "deleted", title: "Deleted venture", status: "done", ventureId: "v-deleted", finishedAt: ctx.day, href: "/apps/seo/deleted", agent: null }];
  const selected = selectSuggestions(ctx);
  assert.equal(selected.length, 6);
  assert.ok(selected.every(s => s.kind === "workspace"));
  assert.ok(selected.some(s => s.reason === "0 ventures in this view"));
});
