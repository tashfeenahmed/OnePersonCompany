import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarDay, workStats, shiftDay, validDay } from "../../../../shared/workJournal.ts";
import { journalRoutes } from "./journal.ts";

test("journal dates respect time zones and streaks survive daylight-saving transitions", () => {
  assert.equal(calendarDay(new Date("2026-09-13T00:30:00Z"), "America/Los_Angeles"), "2026-09-12");
  assert.equal(validDay("2026-02-30"), false);
  assert.equal(shiftDay("2026-03-29", -1), "2026-03-28");
  const stats = workStats([{ day: "2026-03-28", n: 1 }, { day: "2026-03-29", n: 2 }], "2026-03-30");
  assert.equal(stats.current, 2); assert.equal(stats.best, 2); assert.equal(stats.today, 0);
  assert.equal(workStats([{ day: "2026-03-28", n: 1 }], "2026-03-30").current, 0);
});
test("journal supports backdated work, edits, paging and deletion without counting notes as work", async () => {
  const initial = await (await journalRoutes.request("/")).json() as { today: string };
  const day = shiftDay(initial.today, -1);
  const create = (kind: string, date = day) => journalRoutes.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, text: "Shipped the release", day: date }) });
  const response = await create("shipped"); assert.equal(response.status, 201);
  const { entry } = await response.json() as { entry: { id: number } };
  await create("note");
  const report = await (await journalRoutes.request("/")).json() as { stats: { current: number; today: number }; entries: unknown[]; total: number };
  assert.equal(report.total, 2); assert.equal(report.stats.current, 1);
  assert.equal((await create("did", shiftDay(initial.today, 1))).status, 400);
  assert.equal((await journalRoutes.request(`/${entry.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Updated note", kind: "note" }) })).status, 200);
  const edited = await (await journalRoutes.request("/")).json() as typeof report;
  assert.equal(edited.stats.current, 0);
  assert.equal((await journalRoutes.request(`/${entry.id}`, { method: "DELETE" })).status, 200);
});
