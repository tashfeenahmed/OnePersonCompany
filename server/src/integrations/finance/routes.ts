/**
 * /api/finance — the ledger, the allocation rules, and the profit model.
 *
 * ONE ROUTER FOR ALL OF IT, for the reason /api/costs is one route: a finance
 * page asks the same question of the same rows from half a dozen panels, and
 * six requests to answer it once is a burst this box does not need to serve.
 *
 * THE SHAPE OF EVERY MONEY FIELD IS A LIST KEYED BY CURRENCY, never a scalar.
 * There is no field anywhere below that adds euro to dollars; where the owner
 * has typed a rate, the converted figure appears BESIDE the per-currency
 * amounts, carrying the rate, its date and the word approximately. See
 * money.ts.
 *
 * THE WRITES ARE SMALL AND NAMED. An expense can be created, edited, given a
 * renewal decision and removed; an allocation set can be replaced or computed
 * from a basis; a power profile can be written. Nothing here can run a
 * command, reach a provider or touch another area's tables.
 */
import { Hono, type Context } from "hono";
import { configValue, ventureRowById, ventureRows } from "../../db.ts";
import {
  PLUGIN,
  allExpenses,
  annualTotals,
  createExpense,
  expense,
  monthlyTotals,
  relinkDomains,
  removeExpense,
  seedDomains,
  seedHetzner,
  setRenewalDecision,
  shapeExpense,
  updateExpense,
  validCategory,
  validDecision,
  validPeriod,
} from "./expenses.ts";
import {
  allocationsOf,
  computeSplit,
  defaultRule,
  setAllocations,
  shapeAllocation,
  validBasis,
} from "./allocations.ts";
import {
  convert,
  currencyCode,
  currentMonth,
  isMonth,
  parseRates,
  shapeTotals,
  type Basis,
} from "./money.ts";
import { findVenture, portfolioPnl, venturePnl } from "./profit.ts";
import { deleteProfile, machinesAvailable, powerLines, profiles, saveProfile, tariff } from "./power.ts";
import { seedPower } from "./power.ts";

export const financeRoutes = new Hono();

/* The display currency and its rates are SETTINGS and nothing else. Read on
   every request rather than cached, because the answer changes the moment the
   owner saves the integration's page and a cached rate is a rate nobody can
   correct. */
function fx() {
  const display = (configValue(PLUGIN, "display_currency") ?? "").trim() || null;
  const { rates, errors } = parseRates(configValue(PLUGIN, "fx"), display ?? "USD");
  return { display: display ? currencyCode(display) : null, rates, errors };
}

/** Every refusal in this file, in one shape: a sentence a person can act on
 *  and a status that means what it says. */
const bad = (c: Context, message: string, status: 400 | 404 = 400) =>
  c.json({ error: message }, status);

/* ------------------------------------------------------------------ summary */

financeRoutes.get("/", (c) => {
  const rows = allExpenses();
  const monthly = monthlyTotals(rows);
  const annual = annualTotals(rows);
  const { display, rates, errors } = fx();
  const shared = rows.filter((r) => r.venture_id === null);
  const withRule = shared.filter((r) => allocationsOf(r.id).length > 0);
  const soon = renewalsDue(90);

  return c.json({
    generatedAt: new Date().toISOString(),
    counts: {
      expenses: rows.length,
      shared: shared.length,
      allocated: withRule.length,
      unallocated: shared.length - withRule.length,
      unpriced: rows.filter((r) => r.amount === null).length,
      bySource: countBy(rows, (r) => r.source),
      byCategory: countBy(rows, (r) => r.category),
    },
    monthly: shapeTotals(monthly),
    annual: shapeTotals(annual),
    /* The one converted figure, and everything about it is caveated. Null
       until a display currency and a rate for every foreign currency present
       have been typed in — a partial conversion is refused, not silently
       short. */
    converted: display ? convert(monthly, display, rates) : null,
    fx: { displayCurrency: display, rates, errors },
    renewals: { within90Days: soon.length, undecided: soon.filter((r) => r.renewalDecision === "undecided").length },
    defaultAllocation: defaultRule(),
    tariff: tariff(),
    note:
      "Every amount is per currency and nothing here adds them. `monthly` normalises a yearly bill to a twelfth; " +
      "`annual` uses each bill's real cadence. A one-off is in neither — it is listed with its amount and never " +
      "amortised. `unpriced` is how many rows have a cost with no price yet; they are excluded from both totals.",
  });
});

function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}

/* ----------------------------------------------------------------- expenses */

financeRoutes.get("/expenses", (c) => {
  const includeArchived = c.req.query("archived") === "true";
  const ventureKey = c.req.query("venture");
  const category = c.req.query("category");
  let rows = allExpenses(includeArchived);
  if (ventureKey) {
    if (ventureKey === "shared") rows = rows.filter((r) => r.venture_id === null);
    else {
      const v = findVenture(ventureKey);
      if (!v) return bad(c, `There is no venture called “${ventureKey}”.`, 404);
      rows = rows.filter((r) => r.venture_id === v.id);
    }
  }
  if (category) rows = rows.filter((r) => r.category === category);
  return c.json({
    window: "current state of the ledger, not a month",
    count: rows.length,
    monthly: shapeTotals(monthlyTotals(rows)),
    annual: shapeTotals(annualTotals(rows)),
    expenses: rows.map((r) => ({ ...shapeExpense(r), allocations: allocationsOf(r.id).map(shapeAllocation) })),
    note:
      "`amount: null` is a cost whose price nobody has established — it is excluded from the totals and counted in " +
      "`unpriced`. `source` other than manual means the row is refreshed from a provider; `ownerFields` lists the " +
      "columns you have corrected, which a refresh will never overwrite.",
  });
});

financeRoutes.post("/expenses", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return bad(c, "Expected a JSON body.");
  const label = String(body.label ?? "").trim();
  if (!label) return bad(c, "An expense needs a label — what the bill is for.");
  const category = String(body.category ?? "other");
  if (!validCategory(category)) return bad(c, `“${category}” is not a category. Use server, domain, service, subscription, salary or other.`);
  const period = String(body.period ?? "monthly");
  if (!validPeriod(period)) return bad(c, `“${period}” is not a period. Use monthly, yearly or once.`);
  const currency = String(body.currency ?? "").trim();
  if (!/^[A-Za-z]{3}$/.test(currency)) return bad(c, "A three-letter currency code, please — EUR, USD. Money with no currency cannot be totalled.");
  const amount = body.amount === null || body.amount === undefined || body.amount === "" ? null : Number(body.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return bad(c, "The amount is a positive number, or null for a cost whose price you do not know yet.");
  const ventureId = body.ventureId === undefined || body.ventureId === null || body.ventureId === "" ? null : String(body.ventureId);
  if (ventureId && !ventureRowById(ventureId)) return bad(c, `There is no venture with the id “${ventureId}”. Leave it out for a shared cost.`, 404);
  const decision = String(body.renewalDecision ?? "undecided");
  if (!validDecision(decision)) return bad(c, "A renewal decision is keep, cancel or undecided.");

  const row = createExpense({
    label, category, period, currency, amount, ventureId,
    startsOn: body.startsOn ? String(body.startsOn) : null,
    endsOn: body.endsOn ? String(body.endsOn) : null,
    renewalOn: body.renewalOn ? String(body.renewalOn) : null,
    renewalDecision: decision,
    notes: body.notes ? String(body.notes) : null,
  });
  return c.json({ expense: shapeExpense(row) }, 201);
});

financeRoutes.patch("/expenses/:id", async (c) => {
  const row = expense(c.req.param("id"));
  if (!row) return bad(c, "There is no expense with that id.", 404);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return bad(c, "Expected a JSON body.");
  const patch: Parameters<typeof updateExpense>[1] = {};
  if (body.label !== undefined) {
    const label = String(body.label).trim();
    if (!label) return bad(c, "A label cannot be emptied.");
    patch.label = label;
  }
  if (body.category !== undefined) {
    const category = String(body.category);
    if (!validCategory(category)) return bad(c, `“${category}” is not a category.`);
    patch.category = category;
  }
  if (body.period !== undefined) {
    const period = String(body.period);
    if (!validPeriod(period)) return bad(c, `“${period}” is not a period.`);
    patch.period = period;
  }
  if (body.currency !== undefined) {
    const currency = String(body.currency).trim();
    if (!/^[A-Za-z]{3}$/.test(currency)) return bad(c, "A three-letter currency code, please.");
    patch.currency = currency;
  }
  if (body.amount !== undefined) {
    const amount = body.amount === null || body.amount === "" ? null : Number(body.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return bad(c, "The amount is a positive number, or null.");
    patch.amount = amount;
  }
  if (body.ventureId !== undefined) {
    const id = body.ventureId === null || body.ventureId === "" ? null : String(body.ventureId);
    if (id && !ventureRowById(id)) return bad(c, `There is no venture with the id “${id}”.`, 404);
    patch.ventureId = id;
  }
  for (const key of ["startsOn", "endsOn", "renewalOn", "notes"] as const)
    if (body[key] !== undefined) patch[key] = body[key] === null || body[key] === "" ? null : String(body[key]);
  if (body.renewalDecision !== undefined) {
    const decision = String(body.renewalDecision);
    if (!validDecision(decision)) return bad(c, "A renewal decision is keep, cancel or undecided.");
    patch.renewalDecision = decision;
  }
  if (body.archived !== undefined) patch.archived = Boolean(body.archived);

  const next = updateExpense(row.id, patch);
  return c.json({
    expense: shapeExpense(next!),
    note:
      "The columns you changed are now in `ownerFields`. A provider refresh rewrites the rest of this row and " +
      "leaves those exactly as you typed them.",
  });
});

financeRoutes.delete("/expenses/:id", (c) => {
  const what = removeExpense(c.req.param("id"));
  if (!what) return bad(c, "There is no expense with that id.", 404);
  return c.json({
    result: what,
    note:
      what === "archived"
        ? "This row is refreshed from a provider, so it was archived rather than deleted — a delete would only mean the next collection put it straight back. It is out of every total and still on record."
        : "Deleted, with its allocation rules.",
  });
});

financeRoutes.post("/expenses/:id/renewal", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const decision = String(body?.decision ?? "");
  if (!validDecision(decision)) return bad(c, "A renewal decision is keep, cancel or undecided.");
  const row = setRenewalDecision(c.req.param("id"), decision);
  if (!row) return bad(c, "There is no expense with that id.", 404);
  return c.json({ expense: shapeExpense(row) });
});

/* ----------------------------------------------------------------- renewals */

function renewalsDue(days: number) {
  const cutoff = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return allExpenses()
    .filter((r) => r.renewal_on !== null && r.renewal_on <= cutoff)
    .map((r) => ({
      ...shapeExpense(r),
      /* Negative means it has already passed — a renewal date in the past with
         auto-renew off is a name that may already be gone, which is worth
         showing rather than filtering out. */
      inDays: Math.round((Date.parse(`${r.renewal_on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
    }))
    .sort((a, b) => a.inDays - b.inDays);
}

financeRoutes.get("/renewals", (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 90) || 90, 1), 730);
  const rows = renewalsDue(days);
  return c.json({
    window: { days, through: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) },
    count: rows.length,
    undecided: rows.filter((r) => r.renewalDecision === "undecided").length,
    overdue: rows.filter((r) => r.inDays < 0).length,
    renewals: rows,
    note:
      "`inDays` is negative for a renewal date that has already passed — the registrar's own last reading, which " +
      "may be stale. `renewalDecision` is what YOU decided, not what the provider will do: a name with the " +
      "decision “cancel” and auto-renew on will still be charged unless you turn auto-renew off at the registrar. " +
      "`amount: null` means no price is known for that renewal.",
  });
});

/* -------------------------------------------------------------- allocations */

financeRoutes.get("/allocations", (c) => {
  const rows = allExpenses().filter((r) => r.venture_id === null);
  return c.json({
    defaultRule: defaultRule(),
    ventures: ventureRows().map((v) => ({ id: v.id, slug: v.slug, name: v.name, stage: v.stage })),
    shared: rows.map((r) => {
      const rules = allocationsOf(r.id);
      const assigned = rules.reduce((n, x) => n + x.share, 0);
      return {
        ...shapeExpense(r),
        allocations: rules.map(shapeAllocation),
        assignedShare: Number(assigned.toFixed(6)),
        unallocatedShare: Number(Math.max(0, 1 - assigned).toFixed(6)),
      };
    }),
    note:
      "A shared expense with no rules is carried by nobody's margin unless the default rule is `equal`, in which " +
      "case it is spread at read time without writing rules. Shares may sum to less than one; the remainder is " +
      "unallocated overhead and appears in the portfolio P&L.",
  });
});

financeRoutes.get("/unallocated", (c) => {
  const rows = allExpenses().filter((r) => r.venture_id === null && allocationsOf(r.id).length === 0);
  return c.json({
    count: rows.length,
    defaultRule: defaultRule(),
    monthly: shapeTotals(monthlyTotals(rows)),
    expenses: rows.map(shapeExpense),
    note:
      defaultRule() === "equal"
        ? "The default rule is `equal`, so these are spread evenly across every venture at read time. No rules are stored, so this list is still the honest answer to “what has nobody decided about”."
        : "The default rule is `none`, so none of this money is in any venture's margin. Every venture's profit is that much too good until these are allocated.",
  });
});

financeRoutes.put("/allocations/:expenseId", async (c) => {
  const row = expense(c.req.param("expenseId"));
  if (!row) return bad(c, "There is no expense with that id.", 404);
  if (row.venture_id !== null) return bad(c, "That expense belongs wholly to one venture, so there is nothing to allocate. Make it shared first by clearing its venture.");
  const body = await c.req.json().catch(() => null) as { shares?: unknown; basis?: unknown } | null;
  if (!body || !Array.isArray(body.shares)) return bad(c, "Expected { shares: [{ ventureId, share }], basis }.");
  const basis = String(body.basis ?? "manual");
  if (!validBasis(basis)) return bad(c, "A basis is equal, manual, revenue or traffic.");
  const shares = (body.shares as Record<string, unknown>[]).map((s) => ({
    ventureId: String(s.ventureId ?? ""),
    share: Number(s.share),
    note: s.note === undefined || s.note === null ? null : String(s.note),
  }));
  const error = setAllocations(row.id, shares, basis as Basis);
  if (error) return bad(c, error);
  return c.json({ expenseId: row.id, allocations: allocationsOf(row.id).map(shapeAllocation) });
});

financeRoutes.post("/allocations/:expenseId/auto", async (c) => {
  const row = expense(c.req.param("expenseId"));
  if (!row) return bad(c, "There is no expense with that id.", 404);
  if (row.venture_id !== null) return bad(c, "That expense belongs wholly to one venture, so there is nothing to allocate.");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const basis = String(body.basis ?? c.req.query("basis") ?? "equal");
  if (!validBasis(basis)) return bad(c, "A basis is equal, revenue or traffic. (`manual` is a set of shares you send yourself.)");
  const month = String(body.month ?? c.req.query("month") ?? currentMonth());
  if (!isMonth(month)) return bad(c, "A month is YYYY-MM.");
  const split = computeSplit(basis as Basis, month);
  if (!split.shares.length)
    return c.json({ written: 0, basis: split.basis, explanation: split.explanation, skipped: split.skipped });
  const error = setAllocations(row.id, split.shares, split.basis);
  if (error) return bad(c, error);
  return c.json({
    written: split.shares.length,
    basis: split.basis,
    month,
    explanation: split.explanation,
    skipped: split.skipped,
    allocations: allocationsOf(row.id).map(shapeAllocation),
    note:
      "The shares were computed once, from this month's evidence, and STORED. They do not re-evaluate: a margin " +
      "computed from them stays computed from them. Run this again to bring them up to date.",
  });
});

/* -------------------------------------------------------------------- P&L */

financeRoutes.get("/profit/portfolio", (c) => {
  const month = c.req.query("month") ?? currentMonth();
  if (!isMonth(month)) return bad(c, "A month is YYYY-MM.");
  return c.json(portfolioPnl(month));
});

financeRoutes.get("/profit/:venture", (c) => {
  const month = c.req.query("month") ?? currentMonth();
  if (!isMonth(month)) return bad(c, "A month is YYYY-MM.");
  const v = findVenture(c.req.param("venture"));
  if (!v) return bad(c, `There is no venture called “${c.req.param("venture")}”.`, 404);
  return c.json(venturePnl(v, month));
});

/* ------------------------------------------------------------------ power */

financeRoutes.get("/power", (c) => {
  const month = c.req.query("month") ?? currentMonth();
  if (!isMonth(month)) return bad(c, "A month is YYYY-MM.");
  return c.json({
    month,
    tariff: tariff(),
    profiles: profiles().map((p) => ({
      machineId: p.machine_id,
      label: p.label,
      idleWatts: p.idle_watts,
      busyWatts: p.busy_watts,
      ratePerKwh: p.rate_per_kwh,
      currency: currencyCode(p.currency),
      timezone: p.timezone,
      alwaysOn: p.always_on === 1,
      updatedAt: p.updated_at,
    })),
    lines: powerLines(month),
    machines: machinesAvailable(),
    note:
      "The wattage is always typed in — nothing here can read a wall socket — so every line is an estimate of " +
      "money even where `confidence` is `metered`. `metered` describes the HOURS: they came from the workstation " +
      "collector's own state samples. A line with `amount: null` could not be priced and is not free.",
  });
});

financeRoutes.put("/power/:machineId", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return bad(c, "Expected a JSON body.");
  const idle = Number(body.idleWatts);
  const busy = Number(body.busyWatts);
  if (!Number.isFinite(idle) || idle <= 0 || idle > 10_000) return bad(c, "Idle watts is a positive number under 10,000 — what the machine draws at the wall doing nothing.");
  if (!Number.isFinite(busy) || busy < idle || busy > 10_000) return bad(c, "Busy watts is at least the idle figure and under 10,000 — what it draws with the GPU working.");
  const rate = body.ratePerKwh === null || body.ratePerKwh === undefined || body.ratePerKwh === "" ? null : Number(body.ratePerKwh);
  if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) return bad(c, "A price per kWh is a positive number, or null to use the tariff on the integration's page.");
  const currency = String(body.currency ?? "EUR").trim();
  if (!/^[A-Za-z]{3}$/.test(currency)) return bad(c, "A three-letter currency code, please.");
  const saved = saveProfile({
    machineId: c.req.param("machineId"),
    label: body.label ? String(body.label) : null,
    idleWatts: idle,
    busyWatts: busy,
    ratePerKwh: rate,
    currency,
    timezone: body.timezone ? String(body.timezone) : null,
    alwaysOn: Boolean(body.alwaysOn),
  });
  const counts = seedPower();
  return c.json({
    profile: {
      machineId: saved.machine_id, label: saved.label, idleWatts: saved.idle_watts,
      busyWatts: saved.busy_watts, ratePerKwh: saved.rate_per_kwh,
      currency: currencyCode(saved.currency), timezone: saved.timezone, alwaysOn: saved.always_on === 1,
    },
    ledger: counts,
    note: "The monthly electricity line in the ledger was rewritten from the last complete month's samples.",
  });
});

financeRoutes.delete("/power/:machineId", (c) => {
  if (!deleteProfile(c.req.param("machineId"))) return bad(c, "There is no power profile for that machine.", 404);
  const counts = seedPower();
  return c.json({ removed: true, ledger: counts });
});

/* ---------------------------------------------------------------- refresh */

/**
 * Re-seed from the measured sources now, rather than waiting for the next
 * collection. Not destructive: it adds, refreshes and archives seeded rows and
 * cannot touch a manual one or a column the owner has edited.
 */
financeRoutes.post("/refresh", (c) => {
  const hetzner = seedHetzner();
  const registrar = seedDomains();
  const power = seedPower();
  const relinked = relinkDomains();
  return c.json({
    hetzner, registrar, power, domainsRelinked: relinked,
    monthly: shapeTotals(monthlyTotals(allExpenses())),
    note:
      "Seeded rows are rewritten from the provider; columns listed in an expense's `ownerFields` are left exactly " +
      "as you typed them, and a row whose server or domain has gone is archived rather than deleted.",
  });
});

/** Every amount in one currency, for a caller that has typed a rate. Kept as
 *  its own endpoint rather than a field on every document, so nothing can
 *  quote a converted figure without having asked for one. */
financeRoutes.get("/converted", (c) => {
  const { display, rates, errors } = fx();
  const monthly = monthlyTotals(allExpenses());
  if (!display)
    return c.json({
      converted: null,
      reason: "No display currency is set on the Finance integration's page, so nothing is converted.",
      amounts: shapeTotals(monthly).amounts,
      errors,
    });
  return c.json({ converted: convert(monthly, display, rates), amounts: shapeTotals(monthly).amounts, errors, rates });
});
