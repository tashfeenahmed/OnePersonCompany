/**
 * The three things in this area that can be wrong without looking wrong:
 * period arithmetic, currency separation, and the difference between an actual
 * and a projection. Plus the allocation maths, because a share that sums past
 * one makes the portfolio's margin better than the portfolio's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, now, setConfig, upsertPlugin, writeAppStorePayouts } from "../../db.ts";
import {
  addTo,
  annualOf,
  convert,
  daysInMonth,
  elapsedDays,
  emptyTotals,
  monthlyOf,
  parseRates,
  projectProRata,
  shapeTotals,
} from "./money.ts";
import {
  activeIn,
  allExpenses,
  archiveMissing,
  createExpense,
  expense,
  expensesForMonth,
  monthlyTotals,
  removeExpense,
  seedDomains,
  ownerFields,
  updateExpense,
  upsertSeed,
  type ExpenseRow,
} from "./expenses.ts";
import { equalSplit, revenueSplit, setAllocations, shareFor, type AllocationRow } from "./allocations.ts";
import { marginOf, venturePnl } from "./profit.ts";
import { powerLine, profile, saveProfile, seedPower } from "./power.ts";

function reset() {
  db.exec("DELETE FROM finance_expenses; DELETE FROM finance_allocations; DELETE FROM finance_power_profiles; DELETE FROM ventures;");
}

function venture(id: string, slug: string, name: string) {
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,?,'','',NULL,'launched','#000','auto',0,'{}',?,?)`,
  ).run(id, slug, name, now(), now());
}

/* ------------------------------------------------------------ the periods */

test("a yearly bill is a twelfth of a month and its exact self a year; a one-off is neither", () => {
  assert.equal(monthlyOf(120, "yearly"), 10);
  assert.equal(annualOf(120, "yearly"), 120);
  assert.equal(monthlyOf(10, "monthly"), 10);
  assert.equal(annualOf(10, "monthly"), 120);
  /* The rule that matters: a fee paid once is not a run rate. */
  assert.equal(monthlyOf(500, "once"), 0);
  assert.equal(annualOf(500, "once"), 0);
  /* And an unpriced row stays unpriced rather than becoming free. */
  assert.equal(monthlyOf(null, "yearly"), null);
  assert.equal(annualOf(null, "monthly"), null);
});

/* -------------------------------------------------------- currency safety */

test("two currencies are never added and there is no combined figure", () => {
  const t = emptyTotals();
  addTo(t, "EUR", 63.5);
  addTo(t, "usd", 20);
  addTo(t, "EUR", 3.835);
  addTo(t, "USD", null);
  const shaped = shapeTotals(t);
  assert.deepEqual(shaped.amounts, [
    { currency: "EUR", amount: 67.335 },
    { currency: "USD", amount: 20 },
  ]);
  assert.equal(shaped.combined, null);
  /* The null amount is counted, not dropped: a total missing a priceless row
     has to say how many it is missing. */
  assert.equal(shaped.unpriced, 1);
});

test("a conversion is refused outright when any currency present has no rate", () => {
  const t = emptyTotals();
  addTo(t, "EUR", 100);
  addTo(t, "GBP", 50);
  const { rates } = parseRates("EUR = 1.08 on 2026-09-01", "USD");
  const result = convert(t, "USD", rates);
  assert.ok(result && "error" in result, "a partial conversion must not produce a number");
  assert.match((result as { error: string }).error, /GBP/);
});

test("a conversion that can be made carries its rate and is always approximate", () => {
  const t = emptyTotals();
  addTo(t, "EUR", 100);
  addTo(t, "USD", 10);
  const { rates, errors } = parseRates("EUR = 1.10 on 2026-09-01", "USD");
  assert.deepEqual(errors, []);
  const result = convert(t, "USD", rates);
  assert.ok(result && !("error" in result));
  const ok = result as { amount: number; approximate: true; currency: string; rates: { asOf: string | null }[] };
  assert.equal(ok.currency, "USD");
  assert.equal(ok.amount, 120);
  assert.equal(ok.approximate, true);
  assert.equal(ok.rates[0]!.asOf, "2026-09-01");
});

test("an unparsable rate line is an error rather than a silently skipped one", () => {
  const { rates, errors } = parseRates("EUR 1.08\nUSD = 1 on 2026-01-01", "USD");
  assert.equal(rates.length, 0);
  assert.equal(errors.length, 2);
});

/* --------------------------------------------------- actual vs projected */

test("a closed month is fully elapsed, a future month not at all, and a part month is a fraction", () => {
  assert.equal(elapsedDays("2026-08", "2026-09-06T12:00:00.000Z"), 31);
  assert.equal(elapsedDays("2026-10", "2026-09-06T12:00:00.000Z"), 0);
  assert.equal(elapsedDays("2026-09", "2026-09-06T12:00:00.000Z"), 5.5);
  assert.equal(daysInMonth("2026-02"), 28);
});

test("a projection is the daily average of the measured part, and refuses to project from nothing", () => {
  /* €100 over 5 days of a 30-day month projects to €600. */
  assert.equal(projectProRata(100, 5, 30), 600);
  /* Nothing elapsed and nothing measured are both refusals, not zeroes. */
  assert.equal(projectProRata(100, 0, 30), null);
  assert.equal(projectProRata(null, 5, 30), null);
});

/* ------------------------------------------------------------ allocation */

test("shares that add up past one are refused, and the sum is quoted", () => {
  reset();
  venture("v-a", "a", "A");
  venture("v-b", "b", "B");
  const e = createExpense({ label: "Control plane", category: "server", currency: "EUR", period: "monthly", amount: 7.59 });
  const error = setAllocations(e.id, [
    { ventureId: "v-a", share: 0.7 },
    { ventureId: "v-b", share: 0.6 },
  ], "manual");
  assert.match(String(error), /130\.0%/);
  /* And nothing was written — a refused split leaves the previous one alone. */
  assert.equal((db.prepare("SELECT count(*) AS n FROM finance_allocations").get() as { n: number }).n, 0);
});

test("shares may sum to less than one, and the remainder stays unallocated", () => {
  reset();
  venture("v-a", "a", "A");
  venture("v-b", "b", "B");
  const e = createExpense({ label: "Control plane", category: "server", currency: "EUR", period: "monthly", amount: 10 });
  assert.equal(setAllocations(e.id, [{ ventureId: "v-a", share: 0.25 }], "manual"), null);
  const rows = db.prepare("SELECT * FROM finance_allocations WHERE expense_id = ?").all(e.id) as unknown as AllocationRow[];
  assert.equal(rows.length, 1);
  assert.equal(shareFor("v-a", rows, "none", 2).share, 0.25);
  /* A venture NOT in an existing split gets nothing — the split is a decision
     that has been made, and the default rule does not override it. */
  assert.equal(shareFor("v-b", rows, "equal", 2).share, 0);
});

test("the default rule only applies where nobody has decided", () => {
  reset();
  venture("v-a", "a", "A");
  venture("v-b", "b", "B");
  createExpense({ label: "Shared", category: "server", currency: "EUR", period: "monthly", amount: 10 });
  assert.equal(shareFor("v-a", [], "none", 2).share, 0);
  assert.equal(shareFor("v-a", [], "equal", 2).share, 0.5);
  assert.equal(shareFor("v-a", [], "equal", 2).basis, "fallback-equal");
});

test("an equal split covers every venture and sums to one", () => {
  reset();
  for (const [i, name] of ["A", "B", "C"].entries()) venture(`v-${i}`, `s${i}`, name);
  const split = equalSplit();
  assert.equal(split.shares.length, 3);
  assert.ok(Math.abs(split.shares.reduce((n, s) => n + s.share, 0) - 1) < 1e-9);
});

/* --------------------------------------------------------- seeded rows */

test("a refresh rewrites a measured column and never one the owner corrected", () => {
  reset();
  const seed = {
    sourceRef: "server:1", label: "box", category: "server" as const, amount: 6.99,
    currency: "EUR", period: "monthly" as const, renewalOn: null, ventureId: null, notes: "from Hetzner",
  };
  assert.equal(upsertSeed("hetzner", seed), "added");
  const row = db.prepare("SELECT * FROM finance_expenses WHERE source_ref = 'server:1'").get() as ExpenseRow;
  /* The owner types a real price including the backup add-on Hetzner does not
     quote, and renames the box. */
  updateExpense(row.id, { amount: 9.5, label: "control plane" });
  assert.equal(upsertSeed("hetzner", { ...seed, amount: 6.99, label: "box" }), "unchanged");
  const after = expense(row.id)!;
  assert.equal(after.amount, 9.5);
  assert.equal(after.label, "control plane");
  /* A column the owner has NOT touched still refreshes. */
  assert.equal(upsertSeed("hetzner", { ...seed, amount: 6.99, label: "box", currency: "USD" }), "refreshed");
  assert.equal(expense(row.id)!.currency, "USD");
  assert.equal(expense(row.id)!.amount, 9.5);
});

test("a row that has not started or has already ended is not a cost of the month", () => {
  reset();
  const r = createExpense({
    label: "Accountant", category: "service", currency: "EUR", period: "monthly", amount: 150,
    startsOn: "2026-05-01", endsOn: "2026-07-31",
  });
  assert.equal(activeIn(r, "2026-04"), false);
  assert.equal(activeIn(r, "2026-06"), true);
  assert.equal(activeIn(r, "2026-08"), false);
});

/* ------------------------------------------------------------- the margin */

test("a margin is one row per currency and neither side is ever folded into the other", () => {
  const revenue = emptyTotals();
  addTo(revenue, "USD", 300);
  const costs = emptyTotals();
  addTo(costs, "EUR", 63);
  addTo(costs, "USD", 12);
  const rows = marginOf(revenue, costs);
  assert.deepEqual(rows, [
    { currency: "EUR", revenue: 0, cost: 63, margin: -63 },
    { currency: "USD", revenue: 300, cost: 12, margin: 288 },
  ]);
});

test("a venture P&L is actual for a closed month and projected for the one running", () => {
  reset();
  venture("v-a", "a", "A");
  const v = db.prepare("SELECT * FROM ventures WHERE id = 'v-a'").get() as Parameters<typeof venturePnl>[0];
  createExpense({ label: "Its own domain", category: "domain", currency: "USD", period: "yearly", amount: 24, ventureId: "v-a" });

  const closed = venturePnl(v, "2026-08", "2026-09-06T12:00:00.000Z");
  assert.equal(closed.actual, true);
  assert.equal(closed.projected, null);
  /* A yearly $24 domain is $2 a month, and it is a DIRECT cost. */
  assert.deepEqual(closed.costs.direct.amounts, [{ currency: "USD", amount: 2 }]);
  assert.deepEqual(closed.costs.allocated.amounts, []);

  const running = venturePnl(v, "2026-09", "2026-09-06T12:00:00.000Z");
  assert.equal(running.actual, false);
  assert.ok(running.projected, "a month in progress must carry a projection");
  assert.match(running.projected!.method, /Pro-rata/);
  /* Costs are NOT scaled by the elapsed fraction — the bill is owed in full. */
  assert.deepEqual(running.costs.ledgerTotal.amounts, [{ currency: "USD", amount: 2 }]);
  assert.match(String(running.projected!.costs), /not projected/);
});

test("an unpriced cost makes the margin a ceiling and says which cost", () => {
  reset();
  venture("v-a", "a", "A");
  const v = db.prepare("SELECT * FROM ventures WHERE id = 'v-a'").get() as Parameters<typeof venturePnl>[0];
  createExpense({ label: "example.com", category: "domain", currency: "USD", period: "yearly", amount: null, ventureId: "v-a" });
  const pnl = venturePnl(v, "2026-08", "2026-09-06T12:00:00.000Z");
  assert.equal(pnl.costs.complete, false);
  assert.deepEqual(pnl.costs.unpriced, ["example.com"]);
  /* And the unpriced row is out of the total rather than counted as free. */
  assert.deepEqual(pnl.costs.ledgerTotal.amounts, []);
  assert.equal(pnl.costs.ledgerTotal.unpriced, 1);
});

test("the ledger's monthly run rate excludes one-offs and unpriced rows", () => {
  reset();
  createExpense({ label: "Server", category: "server", currency: "EUR", period: "monthly", amount: 7 });
  createExpense({ label: "Domain", category: "domain", currency: "EUR", period: "yearly", amount: 12 });
  createExpense({ label: "Trademark filing", category: "other", currency: "EUR", period: "once", amount: 900 });
  createExpense({ label: "Unknown", category: "other", currency: "EUR", period: "yearly", amount: null });
  const shaped = shapeTotals(monthlyTotals(allExpenses()));
  assert.deepEqual(shaped.amounts, [{ currency: "EUR", amount: 8 }]);
  assert.equal(shaped.unpriced, 1);
});

/* ----------------------------------------------------------------- power */

function samples(accountId: number, rows: [string, boolean, number | null][]) {
  db.exec("DELETE FROM workstation_state");
  for (const [ts, reachable, util] of rows)
    db.prepare("INSERT INTO workstation_state (account_id, ts, reachable, uptime_s, gpu, gpu_note, error) VALUES (?,?,?,?,?,?,?)")
      .run(accountId, ts, reachable ? 1 : 0, null, util === null ? null : JSON.stringify([{ utilisationPercent: util }]), null, null);
}

test("a machine with no samples is unpriced, not free", () => {
  reset();
  db.exec("DELETE FROM workstation_state");
  saveProfile({ machineId: "9", label: "Desk", idleWatts: 60, busyWatts: 400, ratePerKwh: 0.3, currency: "EUR" });
  const line = powerLine(profile("9")!, "2026-08", "2026-09-06T12:00:00.000Z");
  assert.equal(line.amount, null);
  assert.equal(line.confidence, null);
  assert.match(line.note, /Unpriced rather than nought/);
});

test("an always-on machine is a flat idle month, labelled estimated", () => {
  reset();
  db.exec("DELETE FROM workstation_state");
  saveProfile({ machineId: "9", label: "Pi", idleWatts: 5, busyWatts: 5, ratePerKwh: 0.3, currency: "EUR", alwaysOn: true });
  const line = powerLine(profile("9")!, "2026-06", "2026-09-06T12:00:00.000Z");
  /* 5W for the 720 hours of June is 3.6 kWh, at €0.30 is €1.08. */
  assert.equal(line.kwh, 3.6);
  assert.equal(line.amount, 1.08);
  assert.equal(line.confidence, "estimated");
  assert.match(line.note, /Always-on/);
});

test("observed hours are charged in two bands and the coverage is reported", () => {
  reset();
  saveProfile({ machineId: "9", label: "Desk", idleWatts: 100, busyWatts: 400, ratePerKwh: 0.5, currency: "EUR" });
  /* Four samples an hour apart on 1 August: awake-idle, awake-busy, awake with
     nvidia-smi silent, then asleep. The span belongs to the sample that opened
     it, so that is 3h awake of which 1h busy, and 4h covered — the last sample
     runs to the end of the window, clamped to the two-hour ceiling. */
  samples(9, [
    ["2026-08-01T00:00:00.000Z", true, 2],
    ["2026-08-01T01:00:00.000Z", true, 95],
    ["2026-08-01T02:00:00.000Z", true, null],
    ["2026-08-01T03:00:00.000Z", false, null],
  ]);
  const line = powerLine(profile("9")!, "2026-08", "2026-09-06T12:00:00.000Z");
  assert.equal(line.confidence, "metered");
  assert.equal(line.hours!.awake, 3);
  assert.equal(line.hours!.busy, 1);
  /* 3h × 100W + 1h × 300W = 0.6 kWh, at €0.50 is €0.30. A sample whose GPU
     could not be read is NEVER counted busy — that is a fact about ssh. */
  assert.equal(line.kwh, 0.6);
  assert.equal(line.amount, 0.3);
  assert.equal(line.hours!.inMonth, 744);
  assert.match(line.note, /PART-MONTH/);
});

test("an unpriced tariff leaves the electricity line with no money on it", () => {
  reset();
  saveProfile({ machineId: "9", label: "Desk", idleWatts: 100, busyWatts: 400, ratePerKwh: null, currency: "EUR" });
  samples(9, [["2026-08-01T00:00:00.000Z", true, 5], ["2026-08-01T01:00:00.000Z", false, null]]);
  const line = powerLine(profile("9")!, "2026-08", "2026-09-06T12:00:00.000Z");
  assert.equal(line.amount, null);
  assert.ok(line.kwh !== null, "the kilowatt-hours are still known; only the price is not");
  assert.match(line.note, /No price per kWh/);
});

test("the electricity ledger row carries its confidence and is refreshed, not duplicated", () => {
  reset();
  saveProfile({ machineId: "9", label: "Desk", idleWatts: 100, busyWatts: 400, ratePerKwh: 0.5, currency: "EUR" });
  samples(9, [["2026-08-01T00:00:00.000Z", true, 95], ["2026-08-01T01:00:00.000Z", false, null]]);
  /* Seeded for the month that has ENDED, so a 6 September run prices August. */
  seedPower("2026-09-06T12:00:00.000Z");
  seedPower("2026-09-06T12:00:00.000Z");
  const rows = db.prepare("SELECT * FROM finance_expenses WHERE source = 'power'").all() as unknown as ExpenseRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.confidence, "metered");
  assert.equal(rows[0]!.period, "monthly");
  assert.match(rows[0]!.label, /Electricity/);
  assert.match(rows[0]!.notes!, /^2026-08:/);
});

/* ================================================================= *
 * REGRESSIONS. Each of these failed before the review fix beside it. *
 * ================================================================= */

/* P1 — an archived row must stay in the months it was actually owed in. */
test("archiving a row takes it out of future months and leaves the closed ones alone", () => {
  reset();
  venture("v-a", "a", "A");
  const v = db.prepare("SELECT * FROM ventures WHERE id = 'v-a'").get() as Parameters<typeof venturePnl>[0];
  const row = createExpense({
    label: "control-plane", category: "server", currency: "EUR", period: "monthly", amount: 7.09, ventureId: "v-a",
  });
  /* The server is deleted at Hetzner in September. */
  db.prepare("UPDATE finance_expenses SET source = 'hetzner', source_ref = 'server:1' WHERE id = ?").run(row.id);
  assert.equal(archiveMissing("hetzner", new Set(["server:9999"])), 1);
  const archived = expense(row.id)!;
  assert.equal(archived.archived, 1);
  assert.ok(archived.ends_on, "archiving must stamp an end date, or the row is owed for ever");

  /* August closed with the box running: its cost is still August's cost. */
  const august = venturePnl(v, "2026-08", "2026-10-01T00:00:00.000Z");
  assert.deepEqual(august.costs.ledgerTotal.amounts, [{ currency: "EUR", amount: 7.09 }]);
  /* The month AFTER it ended does not carry it. */
  const later = `${archived.ends_on!.slice(0, 4)}-${String(Number(archived.ends_on!.slice(5, 7)) + 1).padStart(2, "0")}`;
  assert.deepEqual(venturePnl(v, later, "2027-01-01T00:00:00.000Z").costs.ledgerTotal.amounts, []);
  /* And the ledger's CURRENT state has dropped it, which is the other half. */
  assert.equal(allExpenses().length, 0);
  assert.equal(expensesForMonth("2026-08").length, 1);
});

test("removing a seeded row archives it AND stamps an end date", () => {
  reset();
  const row = createExpense({ label: "box", category: "server", currency: "EUR", period: "monthly", amount: 5 });
  db.prepare("UPDATE finance_expenses SET source = 'hetzner', source_ref = 'server:2' WHERE id = ?").run(row.id);
  assert.equal(removeExpense(row.id), "archived");
  const after = expense(row.id)!;
  assert.equal(after.archived, 1);
  assert.ok(after.ends_on, "without an end date an archived row is a cost of every future month");
  /* `activeIn` no longer reads the archive flag; the dates decide. */
  assert.equal(activeIn(after, after.ends_on!.slice(0, 7)), true);
  assert.equal(activeIn(after, "2099-01"), false);
});


/**
 * Two ventures earning in two currencies through the App Store, which is the
 * only per-venture revenue source with a real currency column. Returns nothing:
 * every caller asks `revenueSplit` what it made of them.
 */
function twoCurrencyVentures() {
  db.exec("DELETE FROM appstore_payouts; DELETE FROM venture_links; DELETE FROM plugin_config WHERE plugin_id = 'finance'");
  venture("v-yen", "yen", "Yen Co");
  venture("v-usd", "usd", "Dollar Co");
  const link = db.prepare(
    "INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at) VALUES (?,?,?,?,?,?)",
  );
  link.run("v-yen", "appstore", "app-yen", null, "owner", now());
  link.run("v-usd", "appstore", "app-usd", null, "owner", now());
  /* Real accounts: `appstore_payouts` has a foreign key onto `plugin_accounts`,
     which in turn has one onto `plugins`. */
  upsertPlugin("appstore", true, null);
  const yen = insertAccount("appstore", `yen-${Date.now()}`);
  const usd = insertAccount("appstore", `usd-${Date.now()}`);
  writeAppStorePayouts(yen, "2026-08", [{ appId: "app-yen", currency: "JPY", amount: 120_000 }]);
  writeAppStorePayouts(usd, "2026-08", [{ appId: "app-usd", currency: "USD", amount: 1_200 }]);
}

/* P1 — the revenue basis must never build a denominator across currencies. */
test("a revenue split refuses when the ventures earn in different currencies", () => {
  reset();
  twoCurrencyVentures();

  const split = revenueSplit("2026-08");
  /* The old code summed 120000 and 1200 and handed the yen venture 99%. */
  assert.deepEqual(split.shares, []);
  assert.match(split.explanation, /JPY, USD/);
  assert.match(split.explanation, /adds no currencies/);
});

test("a revenue split across currencies works once the owner has typed rates, and says so", () => {
  reset();
  twoCurrencyVentures();
  /* `plugin_config` keys onto `plugins`, and in a test database the finance
     pseudo-plugin has not been through `onStart`. */
  upsertPlugin("finance", true, null);
  setConfig("finance", "display_currency", "USD");
  setConfig("finance", "fx", "JPY = 0.0067 on 2026-09-01");

  const split = revenueSplit("2026-08");
  assert.equal(split.shares.length, 2);
  /* ¥120,000 is $804 at the typed rate, so the dollar venture is the larger. */
  const usd = split.shares.find((s) => s.ventureId === "v-usd")!;
  assert.ok(usd.share > 0.5, `expected the $1,200 venture to outweigh ¥120,000; got ${usd.share}`);
  assert.ok(Math.abs(split.shares.reduce((n, x) => n + x.share, 0) - 1) < 1e-9);
  assert.match(split.explanation, /converted to USD/);
  assert.match(split.explanation, /approximate/);
  db.exec("DELETE FROM plugin_config WHERE plugin_id = 'finance'");
});

/* P2 — a source that answers with nothing is a disconnection, not a deletion. */
test("an empty source result archives nothing", () => {
  reset();
  upsertSeed("registrar", {
    sourceRef: "dynadot:example.com", label: "example.com", category: "domain", amount: 31.2,
    currency: "USD", period: "yearly", renewalOn: "2027-01-01", ventureId: null, notes: "seeded",
  });
  db.exec("DELETE FROM domains");
  /* The registrar's accounts were disconnected, so `domains` is empty. The old
     code archived all of them and took the typed price with them. */
  seedDomains();
  const row = db.prepare("SELECT * FROM finance_expenses WHERE source = 'registrar'").get() as ExpenseRow;
  assert.equal(row.archived, 0);
  assert.equal(row.amount, 31.2);
  assert.equal(archiveMissing("registrar", new Set()), 0);
});

/* P2 — a note the owner wrote is theirs, like any other claimed column. */
test("an owner's note survives a provider refresh", () => {
  reset();
  const seed = {
    sourceRef: "server:3", label: "box", category: "server" as const, amount: 6.99,
    currency: "EUR", period: "monthly" as const, renewalOn: null, ventureId: null, notes: "from Hetzner",
  };
  upsertSeed("hetzner", seed);
  const row = db.prepare("SELECT * FROM finance_expenses WHERE source_ref = 'server:3'").get() as ExpenseRow;
  updateExpense(row.id, { notes: "cancel this after the migration" });
  /* A price change touches the row, which is what used to clobber the note. */
  assert.equal(upsertSeed("hetzner", { ...seed, amount: 7.99, notes: "from Hetzner, new price" }), "refreshed");
  const after = expense(row.id)!;
  assert.equal(after.amount, 7.99);
  assert.equal(after.notes, "cancel this after the migration");
  assert.ok(ownerFields(after).includes("notes"));
});

/* P2 — an always-on line watched none of the month and must not claim to. */
test("an always-on line reports no covered hours", () => {
  reset();
  db.exec("DELETE FROM workstation_state");
  saveProfile({ machineId: "9", label: "Pi", idleWatts: 5, busyWatts: 5, ratePerKwh: 0.3, currency: "EUR", alwaysOn: true });
  const line = powerLine(profile("9")!, "2026-06", "2026-09-06T12:00:00.000Z");
  assert.equal(line.samples, 0);
  assert.equal(line.hours!.covered, 0);
  assert.equal(line.hours!.inMonth, 720);
  assert.equal(line.confidence, "estimated");
});
