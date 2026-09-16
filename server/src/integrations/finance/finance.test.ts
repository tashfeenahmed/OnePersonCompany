/**
 * The three things in this area that can be wrong without looking wrong:
 * period arithmetic, currency separation, and the difference between an actual
 * and a projection. Plus the allocation maths, because a share that sums past
 * one makes the portfolio's margin better than the portfolio's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  db,
  insertAccount,
  now,
  setConfig,
  upsertPlugin,
  writeAppStorePayouts,
  writeAppStoreReport,
  writeOpenAiCosts,
  writeStripeCharges,
  writeStripeLedgerDays,
  writeStripeSubscriptions,
} from "../../db.ts";
import {
  chargesForMonth,
  settledChargeSplit,
  splitCharges,
  ventureMrr,
  ventureOneOff,
  ventureRevenue,
  ventureStripeBook,
  type ChargeMonthRow,
} from "./attribution.ts";
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
import { findVenture, marginOf, portfolioPnl, venturePnl } from "./profit.ts";
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
  /* The report state, which the collector writes beside every payout it
     stores. Revenue passes the report gate only where this says the finance
     report actually arrived — the same gate /api/mobile/revenue applies, so
     this area cannot charge a margin against money that document withholds. */
  db.exec("DELETE FROM appstore_reports");
  db.prepare("UPDATE plugin_accounts SET connected = 1 WHERE id IN (?,?)").run(yen, usd);
  writeAppStoreReport(yen, "finance", "2026-08", "reported");
  writeAppStoreReport(usd, "finance", "2026-08", "reported");
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


/* ======================================================= one-off purchases ==
 *
 * The failure these are about: 191 succeeded $49 charges in thirty days — most
 * of one business's cash — were invisible to every per-venture figure on this
 * box, because a charge had no product and MRR is the only thing Stripe's
 * tables could attribute. The collector now copies the product off the
 * Checkout Session, and these hold the arithmetic that reads it to account.
 */

let accounts = 0;

/** One Stripe account, two ventures, and charges with and without a product. */
function oneOffFixture() {
  db.exec("DELETE FROM stripe_charges; DELETE FROM stripe_subscriptions; DELETE FROM venture_links; DELETE FROM ventures;");
  venture("v-lifetime", "lifetime", "Lifetime Co");
  venture("v-subs", "subs", "Subs Co");
  const link = db.prepare(
    "INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at) VALUES (?,?,?,?,?,?)",
  );
  /* Linked in one case, and in the CASE THE OTHER SIDE DOES NOT USE: the
     charge says "lifetime licence" and the link says "Lifetime Licence". */
  link.run("v-lifetime", "stripe", "Lifetime Licence", null, "owner", now());
  link.run("v-subs", "stripe", "Pro", null, "owner", now());

  upsertPlugin("stripe", true, null);
  /* A counter rather than the clock: two fixtures built inside one millisecond
     collide on the account label, which is a unique key. */
  const account = insertAccount("stripe", `stripe-${++accounts}`);
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const charge = (
    id: string,
    amount: number,
    product: string | null,
    ageDays: number,
    status = "succeeded",
  ) => ({
    id,
    accountId: account,
    amount,
    currency: "usd",
    status,
    paid: status === "succeeded",
    refunded: false,
    createdAt: day(ageDays),
    description: null,
    emailMasked: null,
    failureCode: null,
    failureMessage: null,
    outcomeType: null,
    product,
    priceId: product ? "price_x" : null,
  });

  writeStripeCharges([
    charge("ch_1", 49, "lifetime licence", 2),
    charge("ch_2", 49, "lifetime licence", 9),
    charge("ch_3", 49, "Lifetime Licence", 29),
    /* Outside the window by a day. */
    charge("ch_old", 49, "lifetime licence", 31),
    /* Declined: not money. */
    charge("ch_failed", 49, "lifetime licence", 3, "failed"),
    /* Paid outside Checkout, so no session named a product. Nobody's. */
    charge("ch_unattributed", 500, null, 4),
    /* Somebody else's product entirely. */
    charge("ch_other", 19, "Pro", 5),
  ]);
  return account;
}

test("one-off cash reaches the venture that sold it, and only that venture", () => {
  oneOffFixture();
  const mine = ventureOneOff("v-lifetime", 30);
  assert.equal(mine.count, 3);
  assert.deepEqual(mine.gross, { USD: 147 });
  /* One product, however the owner capitalised the link. */
  assert.deepEqual(mine.byProduct.map((b) => [b.product, b.count, b.gross]), [
    ["lifetime licence", 2, 98],
    ["Lifetime Licence", 1, 49],
  ]);

  /* The $500 charge with no product is in NOBODY's figure: unattributed is a
     fact, and spreading it would invent a receipt. */
  const other = ventureOneOff("v-subs", 30);
  assert.equal(other.count, 1);
  assert.deepEqual(other.gross, { USD: 19 });
});

test("a venture with no linked Stripe product gets no one-off money", () => {
  oneOffFixture();
  venture("v-none", "none", "Unlinked Co");
  const none = ventureOneOff("v-none", 30);
  assert.equal(none.count, 0);
  assert.deepEqual(none.gross, {});
  assert.deepEqual(none.byProduct, []);
});

test("the window is the caller's, and a charge outside it is not in it", () => {
  oneOffFixture();
  assert.equal(ventureOneOff("v-lifetime", 3).count, 1);
  assert.equal(ventureOneOff("v-lifetime", 90).count, 4);
  assert.match(ventureOneOff("v-lifetime", 90).window, /90 days/);
});

test("one-off cash is never folded into MRR", () => {
  oneOffFixture();
  /* Three lifetime purchases, no subscription: MRR is empty and the cash is
     not. The one figure this whole change exists to keep apart. */
  assert.deepEqual(ventureMrr("v-lifetime"), {});
  assert.equal(ventureOneOff("v-lifetime", 30).count, 3);
});

/* ------------------------------------------------- the book, per venture */

test("the per-venture book publishes only linked ventures, with the money apart", () => {
  const account = oneOffFixture();
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  writeStripeSubscriptions([
    {
      accountId: account, accountLabel: "acc", id: "sub_live", status: "active", currency: "usd",
      monthlyUsd: 29, listedMonthlyUsd: 29, interval: "month", intervalCount: 1, product: "Pro",
      plan: "Pro monthly", createdAt: day(200), endedAt: null, cancelAtPeriodEnd: false,
      cancelAt: null, trialStart: null, trialEnd: null, reason: null, paidCents: 2900,
    },
    {
      /* Cancelled last week: out of today's MRR, in the figure from thirty
         days ago, which is what makes the delta negative. */
      accountId: account, accountLabel: "acc", id: "sub_gone", status: "canceled", currency: "usd",
      monthlyUsd: 50, listedMonthlyUsd: 50, interval: "month", intervalCount: 1, product: "Pro",
      plan: "Pro monthly", createdAt: day(300), endedAt: day(7), cancelAtPeriodEnd: false,
      cancelAt: null, trialStart: null, trialEnd: null, reason: null, paidCents: 5000,
    },
  ]);

  const book = ventureStripeBook(30);
  const ids = book.map((r) => r.ventureId).sort();
  /* v-none is not in the fixture here; the two linked ventures are, and a
     venture with no link would never be. */
  assert.deepEqual(ids, ["v-lifetime", "v-subs"]);

  const subs = book.find((r) => r.ventureId === "v-subs")!;
  assert.equal(subs.mrr, 29);
  assert.equal(subs.subscribers, 1);
  assert.equal(subs.previousMrr, 79);
  assert.equal(subs.mrrDelta, -50);
  /* The field the seeded rule watches: the move without its sign, so one
     threshold catches a loss and a gain. */
  assert.equal(subs.mrrAbsDelta, 50);
  assert.equal(subs.mrrMovePct, 63.29);
  assert.equal(subs.oneOff, 19);
  assert.equal(subs.currency, "USD");

  const lifetime = book.find((r) => r.ventureId === "v-lifetime")!;
  /* No subscription at all: a real, empty book — and $147 of cash beside it. */
  assert.equal(lifetime.mrr, 0);
  assert.equal(lifetime.subscribers, 0);
  assert.equal(lifetime.oneOff, 147);
  assert.equal(lifetime.oneOffCount, 3);
});

test("a venture billing in two currencies publishes no scalar MRR", () => {
  const account = oneOffFixture();
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const row = (id: string, currency: string, amount: number) => ({
    accountId: account, accountLabel: "acc", id, status: "active", currency,
    monthlyUsd: amount, listedMonthlyUsd: amount, interval: "month", intervalCount: 1,
    product: "Pro", plan: "Pro monthly", createdAt: day(200), endedAt: null,
    cancelAtPeriodEnd: false, cancelAt: null, trialStart: null, trialEnd: null,
    reason: null, paidCents: 100,
  });
  writeStripeSubscriptions([row("sub_usd", "usd", 29), row("sub_eur", "eur", 19)]);

  const subs = ventureStripeBook(30).find((r) => r.ventureId === "v-subs")!;
  /* Null is "asked and not told" — an alert rule records an unreadable rather
     than reading a collapse to zero — and the truth is beside it. EVERY scalar
     goes, including the one-off cash, because a dollar figure printed beside a
     null euro one is the addition this rule exists to prevent. */
  assert.equal(subs.currency, null);
  assert.equal(subs.mrr, null);
  assert.equal(subs.mrrDelta, null);
  assert.equal(subs.mrrAbsDelta, null);
  assert.equal(subs.oneOff, null);
  assert.deepEqual(subs.mrrByCurrency, { EUR: 19, USD: 29 });
  assert.deepEqual(subs.oneOffByCurrency, { USD: 19 });
  /* Counting heads never needed a currency. */
  assert.equal(subs.subscribers, 2);
  assert.equal(subs.oneOffCount, 1);
});

/**
 * SETTLED STRIPE CASH, WHICH IS MOST OF THE MONEY AND USED TO REACH NOBODY.
 *
 * The defect these hold to account: `ventureRevenue` counted store payouts,
 * AdSense and — only when the owner switched a split on — an apportionment of
 * the Stripe ledger. The cash Stripe actually collected was in none of them,
 * and because the portfolio card added the ventures up, it was not in the
 * portfolio either. A month of thousands could read as a dollar.
 */

const MONTH = "2026-08";

/** Two linked ventures, one product nobody has linked, one linked to both,
 *  one charge with no product at all, and a second currency. */
function settledFixture() {
  reset();
  db.exec(
    "DELETE FROM stripe_charges; DELETE FROM stripe_ledger_days; DELETE FROM stripe_subscriptions; " +
      "DELETE FROM venture_links; DELETE FROM budget_usage; DELETE FROM openai_costs; " +
      "DELETE FROM plugin_config WHERE plugin_id = 'finance'",
  );
  venture("v-lifetime", "lifetime", "Lifetime Co");
  venture("v-subs", "subs", "Subs Co");
  const link = db.prepare(
    "INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at) VALUES (?,?,?,?,?,?)",
  );
  link.run("v-lifetime", "stripe", "Lifetime Licence", null, "owner", now());
  link.run("v-subs", "stripe", "Pro", null, "owner", now());
  /* One product the owner has linked to BOTH businesses. Splitting it would
     invent a receipt and giving it to the first would caption one company's
     money with the other's name, so it belongs to neither. */
  link.run("v-lifetime", "stripe", "Shared Thing", null, "owner", now());
  link.run("v-subs", "stripe", "Shared Thing", null, "owner", now());

  upsertPlugin("stripe", true, null);
  upsertPlugin("finance", true, null);
  const account = insertAccount("stripe", `settled-${++accounts}`);
  const charge = (
    id: string,
    amount: number,
    product: string | null,
    over: Record<string, unknown> = {},
  ) => ({
    id, accountId: account, amount, currency: "usd", status: "succeeded", paid: true,
    refunded: false, createdAt: `${MONTH}-14T10:00:00.000Z`, description: null, emailMasked: null,
    failureCode: null, failureMessage: null, outcomeType: null, product,
    priceId: product ? "price_x" : null, amountRefunded: 0, ...over,
  });

  writeStripeCharges([
    charge("ch_a", 100, "lifetime licence"),
    /* Partly refunded: worth what stayed, which the boolean beside it cannot say. */
    charge("ch_b", 50, "Lifetime Licence", { refunded: true, amountRefunded: 10 }),
    charge("ch_c", 40, "Pro"),
    /* No walk could name it. */
    charge("ch_d", 30, null),
    /* It bought something nobody has linked. */
    charge("ch_e", 20, "Unlinked Thing"),
    /* Linked to two ventures: counted for neither. */
    charge("ch_g", 60, "Shared Thing"),
    /* Another currency entirely, and it is never added to the above. */
    charge("ch_eur", 25, "Pro", { currency: "eur" }),
    /* A declined card is not revenue, and a charge in another month is not
       this month's. */
    charge("ch_failed", 999, "Pro", { status: "failed", paid: false }),
    charge("ch_july", 999, "Pro", { createdAt: "2026-07-14T10:00:00.000Z" }),
  ]);

  /* The settled ledger: $300 gross, $10 back, $30 of fees, $260 net — so the
     portfolio's total is $260 and the $80 the ventures do not carry is the
     $110 of unattributed charges less the account's $30 of fees. */
  writeStripeLedgerDays([
    {
      accountId: account, accountLabel: "acc", day: `${MONTH}-14`, currency: "usd",
      gross: 300, fees: 30, taxWithheld: 0, feesTotal: 30, refunds: 10, disputes: 0,
      other: 0, net: 260, count: 6, processing: 30, managedPayments: 0, disputeFees: 0,
      billing: 0, otherFees: 0,
    },
    {
      accountId: account, accountLabel: "acc", day: `${MONTH}-14`, currency: "eur",
      gross: 25, fees: 0, taxWithheld: 0, feesTotal: 0, refunds: 0, disputes: 0,
      other: 0, net: 25, count: 1, processing: 0, managedPayments: 0, disputeFees: 0,
      billing: 0, otherFees: 0,
    },
  ]);
  return account;
}

test("a charge reaches the venture whose product it paid for, per currency, less refunds", () => {
  settledFixture();
  const split = settledChargeSplit(MONTH);

  assert.deepEqual(split.byVenture.get("v-lifetime"), [
    /* $150 gross over two charges, $10 of it refunded. */
    { currency: "USD", count: 2, gross: 150, net: 140 },
  ]);
  /* Two currencies, two rows, and nothing adds them. */
  assert.deepEqual(split.byVenture.get("v-subs"), [
    { currency: "EUR", count: 1, gross: 25, net: 25 },
    { currency: "USD", count: 1, gross: 40, net: 40 },
  ]);
  assert.deepEqual(split.attributed, {
    EUR: { currency: "EUR", count: 1, gross: 25, net: 25 },
    USD: { currency: "USD", count: 3, gross: 190, net: 180 },
  });
});

test("what reached no venture is counted with the reason, and never spread over the rest", () => {
  settledFixture();
  const [usd, ...rest] = settledChargeSplit(MONTH).unattributed;
  assert.deepEqual(rest, [], "every euro charge was attributed");
  assert.equal(usd!.currency, "USD");
  assert.equal(usd!.count, 3);
  assert.equal(usd!.net, 110);
  assert.deepEqual(usd!.reasons, { "no-product": 1, "no-venture": 1, ambiguous: 1 });
  assert.deepEqual(usd!.products, ["Shared Thing", "Unlinked Thing"]);
});

test("a declined charge and a charge from another month are not this month's revenue", () => {
  settledFixture();
  const rows = chargesForMonth(MONTH);
  assert.equal(rows.reduce((n, r) => n + r.n, 0), 7, "six dollar charges and one euro one");
  assert.ok(!rows.some((r) => r.gross >= 999));
});

test("a charge flagged refunded with no figure is treated as refunded in full", () => {
  /* The rows written before the amount column existed. Dropping the whole
     charge is the direction that never flatters revenue, and the rolling
     rewalk replaces the row with its real figure. */
  const rows: ChargeMonthRow[] = [{ product: "Pro", currency: "usd", n: 1, gross: 40, refunded: 40 }];
  const split = splitCharges(rows, new Map([["pro", ["v-subs"]]]));
  assert.deepEqual(split.byVenture.get("v-subs"), [{ currency: "USD", count: 1, gross: 40, net: 0 }]);
});

test("the venture P&L now carries settled Stripe cash as a measurement", () => {
  settledFixture();
  const revenue = ventureRevenue(findVenture("lifetime")!, MONTH);
  const line = revenue.lines.find((l) => l.source === "stripe-charges")!;
  assert.equal(line.currency, "USD");
  assert.equal(line.gross, 150);
  assert.equal(line.net, 140);
  /* Measured, by the stored link, and not an apportionment of anything. */
  assert.equal(line.basis, "link");
  assert.equal(line.estimated, false);
  assert.match(line.note, /BEFORE Stripe's fees/);
  assert.deepEqual(revenue.net.byCurrency, { USD: 140 });
  /* With the split off, the remainder is named as the portfolio's and not
     handed to anybody. */
  assert.match(revenue.unavailable.join(" "), /reported at the portfolio/);
});

test("the portfolio's revenue is allocated plus unallocated, and its total is the ledger's net", () => {
  settledFixture();
  const p = portfolioPnl(MONTH, "2026-09-01T00:00:00.000Z");

  assert.deepEqual(p.revenue.allocated.amounts, [
    { currency: "EUR", amount: 25 },
    { currency: "USD", amount: 180 },
  ]);
  /* $260 settled less the $180 the ventures carry. The euro row is absent
     because nothing was left over in euros — a zero with no charges behind it
     is not news. */
  assert.deepEqual(
    p.revenue.unallocated.map((u) => [u.currency, u.amount, u.charges]),
    [["USD", 80, 3]],
  );
  assert.deepEqual(p.revenue.total.amounts, [
    { currency: "EUR", amount: 25 },
    { currency: "USD", amount: 260 },
  ]);

  /* THE IDENTITY THIS EXISTS FOR: per currency, the portfolio's total is the
     ledger's settled net, whatever the ventures did or did not carry. */
  for (const s of p.stripeSettled)
    assert.equal(
      p.revenue.total.amounts.find((a) => a.currency === s.currency)!.amount,
      s.net,
      s.currency,
    );

  /* And the old arithmetic — summing the venture rows — is the allocated half
     and nothing more. That is the defect, held in place. */
  const summed = p.ventures
    .flatMap((v) => v.margin)
    .filter((m) => m.currency === "USD")
    .reduce((n, m) => n + m.revenue, 0);
  assert.equal(summed, 180);

  assert.match(p.revenue.unallocated[0]!.note, /no invoice or Checkout Session named/);
  assert.match(p.revenue.unallocated[0]!.note, /linked to no venture/);
  assert.match(p.revenue.unallocated[0]!.note, /more than one venture/);
  assert.match(p.revenue.basis, /settled money, not billings/);
});

test("the mrr-share split applies to the remainder and never to what was measured", () => {
  const account = settledFixture();
  writeStripeSubscriptions([
    {
      accountId: account, accountLabel: "acc", id: "sub_live", status: "active", currency: "usd",
      monthlyUsd: 29, listedMonthlyUsd: 29, interval: "month", intervalCount: 1, product: "Pro",
      plan: "Pro monthly", createdAt: "2026-01-01T00:00:00.000Z", endedAt: null,
      cancelAtPeriodEnd: false, cancelAt: null, trialStart: null, trialEnd: null,
      reason: null, paidCents: 2900,
    },
  ]);
  setConfig("finance", "stripe_split", "mrr-share");

  const subs = ventureRevenue(findVenture("subs")!, MONTH);
  const share = subs.lines.find((l) => l.basis === "mrr-share")!;
  /* It holds the whole book's USD MRR, so it is apportioned the whole $80
     remainder — and NOT the $180 already attributed by product, which would
     be the same money counted twice. */
  assert.equal(share.net, 80);
  assert.equal(share.estimated, true);
  assert.ok(share.note.includes("180 of it was attributed"), share.note);
  assert.equal(subs.net.byCurrency.USD, 120, "its own $40 of charges plus the $80 remainder");

  /* The other venture bills nothing, so it is apportioned nothing — and keeps
     every dollar its own products took. */
  const lifetime = ventureRevenue(findVenture("lifetime")!, MONTH);
  assert.equal(lifetime.lines.some((l) => l.basis === "mrr-share"), false);
  assert.equal(lifetime.net.byCurrency.USD, 140);

  /* And the portfolio still ties to the ledger: the remainder moved into the
     ventures rather than appearing twice. */
  const p = portfolioPnl(MONTH, "2026-09-01T00:00:00.000Z");
  assert.equal(p.revenue.allocated.amounts.find((a) => a.currency === "USD")!.amount, 260);
  assert.deepEqual(p.revenue.unallocated.filter((u) => u.amount !== 0), []);
  assert.equal(p.revenue.total.amounts.find((a) => a.currency === "USD")!.amount, 260);
});

test("without a settled ledger the total is the charges themselves, and says the fees are missing", () => {
  settledFixture();
  db.exec("DELETE FROM stripe_ledger_days");
  const p = portfolioPnl(MONTH, "2026-09-01T00:00:00.000Z");
  /* $110 of unattributed charges, with no fees to take off them. */
  assert.deepEqual(
    p.revenue.unallocated.map((u) => [u.currency, u.amount]),
    [["USD", 110]],
  );
  assert.equal(p.revenue.total.amounts.find((a) => a.currency === "USD")!.amount, 290);
  assert.match(p.revenue.basis, /No Stripe balance report has been collected/);
  assert.match(p.revenue.unallocated[0]!.note, /fees are not in it/);
});

/* ------------------------------------------------ model spend nobody carries */

function meter(month: string, ventureId: string | null, tokens: number) {
  db.prepare(
    "INSERT INTO budget_usage (run_id, venture_id, automation, at, tokens, usd, status) VALUES (?,?,?,?,?,?,?)",
  ).run(`run-${ventureId ?? "none"}`, ventureId, 0, `${month}-14T10:00:00.000Z`, tokens, 0, "reported");
}

test("model spend no venture's tokens account for is a line nobody's margin is carrying", () => {
  const account = settledFixture();
  upsertPlugin("openai", true, null);
  const openai = insertAccount("openai", `openai-${account}`);
  writeOpenAiCosts([
    { accountId: openai, accountLabel: "acc", day: `${MONTH}-14`, projectId: "p", projectName: "p", usd: 100 },
  ]);
  /* Half the tokens ran for a venture; the other half is the box's own
     housekeeping, which was invoiced all the same and reached nobody. */
  meter(MONTH, "v-lifetime", 1000);
  meter(MONTH, null, 1000);

  const p = portfolioPnl(MONTH, "2026-09-01T00:00:00.000Z");
  assert.equal(p.modelSpend.usd, 100, "the invoice is the portfolio's cost");
  const line = p.ledger.unallocatedLines.find((l) => l.expenseId === "model-spend-unattributed")!;
  assert.equal(line.monthly, 50);
  assert.match(line.label, /Model spend, not attributed to a venture/);
  assert.match(line.label, /1,000 tokens/);
  assert.equal(p.ledger.unallocatedShared.amounts.find((a) => a.currency === "USD")!.amount, 50);
  /* Every invoiced dollar is now carried by somebody or named as carried by
     nobody — $50 in a venture's margin, $50 here. */
  assert.equal(p.ventures.reduce((n, v) => n + (v.modelUsd ?? 0), 0), 50);
  assert.ok(p.rules.some((r) => /Every invoiced model dollar is carried/.test(r)));
});

test("a month whose every token belongs to a venture leaves no remainder, and never a negative one", () => {
  const account = settledFixture();
  upsertPlugin("openai", true, null);
  const openai = insertAccount("openai", `openai-${account}`);
  writeOpenAiCosts([
    { accountId: openai, accountLabel: "acc", day: `${MONTH}-14`, projectId: "p", projectName: "p", usd: 100 },
  ]);
  meter(MONTH, "v-lifetime", 1000);
  meter(MONTH, "v-subs", 3000);

  const p = portfolioPnl(MONTH, "2026-09-01T00:00:00.000Z");
  assert.equal(p.ledger.unallocatedLines.some((l) => l.expenseId === "model-spend-unattributed"), false);
  assert.deepEqual(p.ledger.unallocatedShared.amounts, []);
  assert.equal(p.ventures.reduce((n, v) => n + (v.modelUsd ?? 0), 0), 100);
});
