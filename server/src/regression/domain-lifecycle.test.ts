import test from "node:test";
import assert from "node:assert/strict";
import { allDomains, db, insertAccount, replaceDomains, upsertPlugin } from "../db.ts";
import { domainHasExpired, registeredDomains } from "../providers/domains.ts";
import { domains } from "../routes/domains.ts";
import { builtinEntities } from "../integrations/ventures/entities.ts";
import { allExpenses, expense, expensesForMonth, seedDomains, updateExpense } from "../integrations/finance/expenses.ts";
import { dashboardAlerts } from "../integrations/proactive/dashboard-alerts.ts";

const date = new Date("2026-09-15T12:00:00Z");
type DomainDoc = {
  domains: { name: string }[];
  summary: { total: number; lapsed: number; autoRenewOff: number; byRegistrar: Record<string, number>;
    byTld: Record<string, number>; expiring7: number; withoutExpiry: number; soonest: { name: string; days: number } | null };
};
const row = (name: string, expiresAt: string | null) => ({
  name, expiresAt, registrar: "Spaceship", registeredOn: "2025-01-01",
  autoRenew: false, locked: true, status: "ok", privacy: "on", nameservers: null,
});

test("expiry uses UTC days and does not retire today's renewals or unknown dates", () => {
  assert.equal(domainHasExpired("2026-09-14", date), true);
  assert.equal(domainHasExpired("2026-09-15", date), false);
  assert.equal(domainHasExpired("2026-09-16", date), false);
  assert.equal(domainHasExpired(null, date), false);
  assert.equal(domainHasExpired("invalid", date), false);
  assert.equal(domainHasExpired("2026-09-15", new Date("2026-09-16T00:00:00Z")), true);
});

test("expired domains leave every active domain summary, renewal cost and badge; renewal restores them", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: date });
  upsertPlugin("spaceship", true, null);
  const account = insertAccount("spaceship", "Lifecycle test");
  const records = [row("expired.test", "2026-08-31"), row("today.test", "2026-09-15"), row("future.test", "2027-01-01"), row("unknown.test", null)];
  replaceDomains("spaceship", account, "Lifecycle test", records);
  try {
    const doc = await (await domains.request("/")).json() as DomainDoc;
    assert.deepEqual(doc.domains.map((d: { name: string }) => d.name), ["future.test", "today.test", "unknown.test"]);
    assert.equal(doc.summary.total, 3);
    assert.equal(doc.summary.lapsed, 0);
    assert.equal(doc.summary.autoRenewOff, 3);
    assert.equal(doc.summary.byRegistrar.Spaceship, 3);
    assert.equal(doc.summary.byTld.test, 3);
    assert.equal(doc.summary.expiring7, 1);
    assert.equal(doc.summary.withoutExpiry, 1);
    assert.deepEqual(doc.summary.soonest, { name: "today.test", days: 0 });
    assert.equal(allDomains().length, 4, "raw records remain intact");
    assert.equal(registeredDomains({ includeExpired: true }).length, 4);
    assert.ok(!builtinEntities().some((d) => d.plugin === "spaceship" && d.entity === "expired.test"));
    const alerts = (await dashboardAlerts()).alerts.filter((a) => a.id.startsWith("domain:"));
    assert.deepEqual(alerts.map((a) => a.id), ["domain:today.test:expiry"]);

    seedDomains();
    const historical = allExpenses(true).find((r) => r.source_ref === "spaceship:expired.test")!;
    assert.ok(historical);
    updateExpense(historical.id, { amount: 120, notes: "Owner's renewal price" });
    assert.equal(expense(historical.id)?.ends_on, "2026-08-31");
    assert.ok(!allExpenses().some((r) => r.id === historical.id));
    assert.ok(expensesForMonth("2026-08").some((r) => r.id === historical.id));
    assert.ok(!expensesForMonth("2026-09").some((r) => r.id === historical.id));
    const raw = db.prepare("SELECT archived, ends_on FROM finance_expenses WHERE id = ?").get(historical.id);
    assert.deepEqual({ ...raw }, { archived: 0, ends_on: null }, "expiry does not persist a destructive archive");

    replaceDomains("spaceship", account, "Lifecycle test", records.slice(1));
    assert.ok(!allExpenses().some((r) => r.id === historical.id), "a registrar dropping an expired name must not reactivate its renewal bill");
    assert.equal(expense(historical.id)?.ends_on, "2026-08-31");

    records[0] = row("expired.test", "2027-08-31");
    replaceDomains("spaceship", account, "Lifecycle test", records);
    seedDomains();
    assert.equal(registeredDomains().length, 4);
    assert.ok(builtinEntities().some((d) => d.entity === "expired.test"));
    const renewed = allExpenses().find((r) => r.id === historical.id)!;
    assert.equal(renewed.amount, 120);
    assert.equal(renewed.notes, "Owner's renewal price");
    assert.equal(renewed.ends_on, null);

    replaceDomains("spaceship", account, "Lifecycle test", [row("expired.test", "2026-08-31")]);
    const empty = await (await domains.request("/")).json() as DomainDoc;
    assert.equal(empty.summary.total, 0);
    assert.deepEqual(empty.domains, []);
    assert.equal(empty.summary.soonest, null);
    assert.ok(!(await dashboardAlerts()).alerts.some((a) => a.id.startsWith("domain:")));
  } finally {
    db.exec("DELETE FROM finance_expenses");
    db.prepare("DELETE FROM domains WHERE account_id = ?").run(account);
    db.prepare("DELETE FROM plugin_accounts WHERE id = ?").run(account);
  }
});

test("a secondary provider cannot resurrect an expired registrar record", () => {
  upsertPlugin("spaceship", true, null);
  upsertPlugin("cloudflare", true, null);
  const registrar = insertAccount("spaceship", "Registrar");
  const secondary = insertAccount("cloudflare", "DNS");
  try {
    replaceDomains("spaceship", registrar, "Registrar", [row("shared.test", "2026-09-14")]);
    replaceDomains("cloudflare", secondary, "DNS", [row("shared.test", null)]);
    assert.equal(registeredDomains({ now: date }).length, 0);
    assert.equal(registeredDomains({ includeExpired: true }).length, 1);
    assert.equal(allDomains().length, 2);
  } finally {
    db.prepare("DELETE FROM domains WHERE account_id IN (?, ?)").run(registrar, secondary);
    db.prepare("DELETE FROM plugin_accounts WHERE id IN (?, ?)").run(registrar, secondary);
  }
});
