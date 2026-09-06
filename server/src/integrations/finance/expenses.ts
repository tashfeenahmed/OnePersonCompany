/**
 * THE RECURRING LEDGER — every bill the operation owes, in one table, whether
 * a provider quoted it or the owner typed it.
 *
 * WHY IT IS SEEDED RATHER THAN TYPED. This box already knows about seven
 * Hetzner boxes, a block volume and twenty-three domain renewals; asking the
 * owner to retype them into a rate card is asking them to maintain a second
 * copy of a list that changes without them. So the measured things arrive as
 * rows with `source` set to the thing that measured them, and a decommissioned
 * server's row is archived by the next refresh instead of billing forever.
 *
 * WHY THE OWNER'S EDITS SURVIVE IT. A seeded row is not finished: Hetzner
 * quotes a plan price net of VAT and says nothing about the backup add-on; a
 * registrar publishes a renewal DATE and no price at all. The moment the owner
 * corrects one of those columns, that column's name goes into `owner_fields`
 * and every subsequent refresh skips it. The result is a row that is measured
 * where nobody has looked and typed where somebody has — which is what a rate
 * card actually is.
 *
 * WHAT IS DELIBERATELY NOT SEEDED. Model-provider spend is NOT a ledger row.
 * It is metered, it moves every day, and /api/costs already reports it per
 * provider in the provider's own shape; a monthly "OpenAI" line in a table of
 * commitments would read as a subscription and would be a month out of date
 * the moment it was written. The P&L reads that spend live instead — see
 * profit.ts — and the ledger stays a list of things that recur.
 */
import { db, allDomains, now, ventureRowById } from "../../db.ts";
import {
  CATEGORIES,
  DECISIONS,
  PERIODS,
  addTo,
  annualOf,
  currencyCode,
  emptyTotals,
  monthlyOf,
  type Category,
  type CurrencyTotals,
  type Period,
  type RenewalDecision,
} from "./money.ts";

export const PLUGIN = "finance";

export type ExpenseRow = {
  id: string;
  venture_id: string | null;
  label: string;
  category: string;
  amount: number | null;
  currency: string;
  period: string;
  starts_on: string | null;
  ends_on: string | null;
  renewal_on: string | null;
  renewal_decision: string;
  source: string;
  source_ref: string | null;
  notes: string | null;
  confidence: string | null;
  archived: number;
  owner_fields: string;
  created_at: string;
  updated_at: string;
};

/** The columns a refresh may rewrite, and therefore the only names that can
 *  usefully appear in `owner_fields`. `label` is here because a server rename
 *  at Hetzner should reach the ledger.
 *
 *  `notes` IS HERE AND USED NOT TO BE, which was a real hole: the seeder
 *  rewrites the note on every row it touches, so an owner who wrote "cancel
 *  this after the migration" on a server lost it the next time Hetzner moved
 *  a price. It is a refreshable column like any other now, so writing one
 *  claims it. */
export const REFRESHABLE = [
  "label", "amount", "currency", "period", "renewal_on", "venture_id", "confidence", "ends_on", "notes",
] as const;

export const ownerFields = (r: ExpenseRow): string[] => {
  try {
    const parsed = JSON.parse(r.owner_fields) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------ reads */

export function allExpenses(includeArchived = false): ExpenseRow[] {
  return db
    .prepare(
      `SELECT * FROM finance_expenses ${includeArchived ? "" : "WHERE archived = 0"}
       ORDER BY category, label`,
    )
    .all() as unknown as ExpenseRow[];
}

export function expense(id: string): ExpenseRow | undefined {
  return db.prepare("SELECT * FROM finance_expenses WHERE id = ?").get(id) as ExpenseRow | undefined;
}

/** How the row goes on the wire, with the two derived cadences computed here
 *  so no caller invents its own idea of what a yearly bill costs a month. */
export function shapeExpense(r: ExpenseRow) {
  const period = r.period as Period;
  return {
    id: r.id,
    ventureId: r.venture_id,
    venture: r.venture_id ? (ventureRowById(r.venture_id)?.name ?? null) : null,
    shared: r.venture_id === null,
    label: r.label,
    category: r.category,
    amount: r.amount,
    currency: currencyCode(r.currency),
    period,
    monthly: monthlyOf(r.amount, period),
    annual: annualOf(r.amount, period),
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    renewalOn: r.renewal_on,
    renewalDecision: r.renewal_decision as RenewalDecision,
    source: r.source,
    sourceRef: r.source_ref,
    notes: r.notes,
    confidence: r.confidence,
    archived: r.archived === 1,
    /** Which columns the owner has corrected. A refresh skips exactly these. */
    ownerFields: ownerFields(r),
    updatedAt: r.updated_at,
  };
}

/**
 * Is this row owed in `month`?
 *
 * THE DATES DECIDE, AND `archived` DOES NOT. This used to short-circuit on
 * `archived === 1`, which quietly made every P&L a statement about the ledger
 * as it stands TODAY rather than about the month asked for: a Hetzner box
 * deleted in September vanished from August's costs too, and four ventures'
 * August margins improved retrospectively because a server was cancelled a
 * month later. Archiving stamps `ends_on` (see `archiveMissing` and
 * `removeExpense`), and `ends_on` is what takes the row out of the months
 * AFTER it stopped being owed — which is the only thing archiving should mean
 * to a closed month.
 *
 * A row that ends INSIDE the month is still a cost of that month. A monthly
 * bill cancelled on the 12th was owed for that cycle, and this file has no
 * per-day proration to offer instead.
 */
export function activeIn(r: ExpenseRow, month: string): boolean {
  if (r.starts_on && r.starts_on.slice(0, 7) > month) return false;
  if (r.ends_on && r.ends_on.slice(0, 7) < month) return false;
  return true;
}

/**
 * The rows a MONTH-SCOPED reader must start from: everything, archived
 * included, because whether a row belongs to that month is `activeIn`'s
 * decision and not the archive flag's. The current-state views (the ledger
 * table, the renewal list, the allocation editor) still use `allExpenses()`
 * and still exclude the archived, because those describe what is owed NOW.
 */
export const expensesForMonth = (month: string): ExpenseRow[] =>
  allExpenses(true).filter((r) => activeIn(r, month));

/** The monthly run rate of a set of rows, per currency. */
export function monthlyTotals(rows: ExpenseRow[]): CurrencyTotals {
  const totals = emptyTotals();
  for (const r of rows) addTo(totals, r.currency, monthlyOf(r.amount, r.period as Period));
  return totals;
}

export function annualTotals(rows: ExpenseRow[]): CurrencyTotals {
  const totals = emptyTotals();
  for (const r of rows) addTo(totals, r.currency, annualOf(r.amount, r.period as Period));
  return totals;
}

/* ----------------------------------------------------------------- writes */

let counter = 0;
const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type ExpensePatch = {
  ventureId?: string | null;
  label?: string;
  category?: Category;
  amount?: number | null;
  currency?: string;
  period?: Period;
  startsOn?: string | null;
  endsOn?: string | null;
  renewalOn?: string | null;
  renewalDecision?: RenewalDecision;
  notes?: string | null;
  archived?: boolean;
};

const COLUMN: Record<keyof ExpensePatch, string> = {
  ventureId: "venture_id", label: "label", category: "category", amount: "amount",
  currency: "currency", period: "period", startsOn: "starts_on", endsOn: "ends_on",
  renewalOn: "renewal_on", renewalDecision: "renewal_decision", notes: "notes", archived: "archived",
};

export function createExpense(p: ExpensePatch & { label: string; category: Category; currency: string; period: Period }): ExpenseRow {
  const id = newId("fx");
  const ts = now();
  db.prepare(
    `INSERT INTO finance_expenses
       (id, venture_id, label, category, amount, currency, period, starts_on, ends_on,
        renewal_on, renewal_decision, source, source_ref, notes, confidence, archived,
        owner_fields, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'manual',NULL,?,NULL,0,'[]',?,?)`,
  ).run(
    id, p.ventureId ?? null, p.label, p.category, p.amount ?? null, currencyCode(p.currency), p.period,
    p.startsOn ?? null, p.endsOn ?? null, p.renewalOn ?? null, p.renewalDecision ?? "undecided",
    p.notes ?? null, ts, ts,
  );
  return expense(id)!;
}

/**
 * The owner's edit.
 *
 * EVERY COLUMN TOUCHED HERE JOINS `owner_fields`, on a seeded row and a manual
 * one alike. On a manual row it changes nothing (nothing refreshes it); on a
 * seeded one it is the whole mechanism — the next collection will rewrite the
 * plan price and leave the price the owner corrected exactly where it is.
 */
export function updateExpense(id: string, patch: ExpensePatch): ExpenseRow | undefined {
  const row = expense(id);
  if (!row) return undefined;
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const owned = new Set(ownerFields(row));
  for (const [key, value] of Object.entries(patch) as [keyof ExpensePatch, unknown][]) {
    if (value === undefined) continue;
    const column = COLUMN[key];
    sets.push(`${column} = ?`);
    args.push(
      key === "archived" ? (value ? 1 : 0)
        : key === "currency" ? currencyCode(String(value))
          : (value as string | number | null),
    );
    /* `archived` is a state, not a measurement, and a refresh never writes it,
       so it does not belong in the list of columns a refresh must skip. */
    if (key !== "archived" && (REFRESHABLE as readonly string[]).includes(column)) owned.add(column);
  }
  if (!sets.length) return row;
  sets.push("owner_fields = ?", "updated_at = ?");
  args.push(JSON.stringify([...owned].sort()), now(), id);
  db.prepare(`UPDATE finance_expenses SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return expense(id);
}

export function setRenewalDecision(id: string, decision: RenewalDecision): ExpenseRow | undefined {
  const row = expense(id);
  if (!row) return undefined;
  db.prepare("UPDATE finance_expenses SET renewal_decision = ?, updated_at = ? WHERE id = ?")
    .run(decision, now(), id);
  return expense(id);
}

/** Manual rows are deleted outright; a seeded row is archived, because
 *  deleting one only means the next refresh puts it straight back. */
export function removeExpense(id: string): "deleted" | "archived" | null {
  const row = expense(id);
  if (!row) return null;
  if (row.source === "manual") {
    db.prepare("DELETE FROM finance_expenses WHERE id = ?").run(id);
    db.prepare("DELETE FROM finance_allocations WHERE expense_id = ?").run(id);
    return "deleted";
  }
  /* `ends_on` IS STAMPED HERE AND NOT ONLY IN `archiveMissing`, because
     `activeIn` decides a row's months from the dates alone. Without it an
     archived row would go on being a cost of every future month for ever —
     the exact opposite of the bug that used to be here, and the reason both
     archive paths must write the same two columns. COALESCE so an end date
     the owner already typed is not moved to today. */
  db.prepare(
    "UPDATE finance_expenses SET archived = 1, ends_on = COALESCE(ends_on, ?), updated_at = ? WHERE id = ?",
  ).run(now().slice(0, 10), now(), id);
  return "archived";
}

export const validCategory = (v: string): v is Category => (CATEGORIES as string[]).includes(v);
export const validPeriod = (v: string): v is Period => (PERIODS as string[]).includes(v);
export const validDecision = (v: string): v is RenewalDecision => (DECISIONS as string[]).includes(v);

/* ---------------------------------------------------------------- seeding */

export type Seed = {
  sourceRef: string;
  label: string;
  category: Category;
  amount: number | null;
  currency: string;
  period: Period;
  renewalOn: string | null;
  endsOn?: string | null;
  ventureId: string | null;
  confidence?: string | null;
  notes: string;
};

/**
 * Upsert one measured row, honouring `owner_fields`.
 *
 * Returns what happened, so a collector can report "3 added, 8 refreshed, 1
 * archived" rather than a bare success — the counts are how the owner sees
 * that a server they deleted has actually left the ledger.
 */
export function upsertSeed(source: string, s: Seed): "added" | "refreshed" | "unchanged" {
  const existing = db
    .prepare("SELECT * FROM finance_expenses WHERE source = ? AND source_ref = ?")
    .get(source, s.sourceRef) as ExpenseRow | undefined;
  const ts = now();
  if (!existing) {
    db.prepare(
      `INSERT INTO finance_expenses
         (id, venture_id, label, category, amount, currency, period, starts_on, ends_on,
          renewal_on, renewal_decision, source, source_ref, notes, confidence, archived,
          owner_fields, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?, 'undecided', ?,?,?,?,0,'[]',?,?)`,
    ).run(
      newId("fx"), s.ventureId, s.label, s.category, s.amount, currencyCode(s.currency), s.period,
      s.endsOn ?? null, s.renewalOn, source, s.sourceRef, s.notes, s.confidence ?? null, ts, ts,
    );
    return "added";
  }
  const owned = new Set(ownerFields(existing));
  const next: Record<string, string | number | null> = {
    label: s.label, amount: s.amount, currency: currencyCode(s.currency), period: s.period,
    renewal_on: s.renewalOn, venture_id: s.ventureId, confidence: s.confidence ?? null,
    ends_on: s.endsOn ?? null,
  };
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [column, value] of Object.entries(next)) {
    if (owned.has(column)) continue;
    if (existing[column as keyof ExpenseRow] === value) continue;
    sets.push(`${column} = ?`);
    args.push(value);
  }
  /* `notes` carries the sentence explaining where the figure came from, and it
     is rewritten whenever the row is otherwise touched so it cannot describe a
     measurement that has since changed — UNLESS the owner has written their
     own note on this row, in which case it is theirs like any other claimed
     column. Losing "cancel this after the migration" to a price change was
     the reason that exception exists. */
  if (!sets.length) return "unchanged";
  if (!owned.has("notes")) {
    sets.push("notes = ?");
    args.push(s.notes);
  }
  sets.push("updated_at = ?");
  args.push(ts, existing.id);
  db.prepare(`UPDATE finance_expenses SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return "refreshed";
}

/** A seeded row whose thing has gone. Archived rather than deleted: the row is
 *  evidence that the cost existed, and a closed month's margin was computed
 *  from it. */
export function archiveMissing(source: string, keep: Set<string>): number {
  /*
    AN EMPTY `keep` ARCHIVES NOTHING, and that guard is load-bearing rather
    than defensive. `domains` and `hetzner_servers` cascade on a
    `plugin_accounts` delete, so disconnecting Dynadot empties the table this
    seeder reads — and the next pass, thirty minutes later, would archive all
    twenty-three domain rows and take the renewal prices the owner typed with
    them. A source that answers with nothing has told us nothing about what
    still exists; it is a disconnection, not a mass deletion. The cost of the
    guard is that genuinely deleting your last server leaves one stale row,
    which the owner can archive by hand from the ledger.
  */
  if (!keep.size) return 0;
  const rows = db
    .prepare("SELECT id, source_ref FROM finance_expenses WHERE source = ? AND archived = 0")
    .all(source) as { id: string; source_ref: string | null }[];
  let gone = 0;
  for (const r of rows) {
    if (r.source_ref && keep.has(r.source_ref)) continue;
    db.prepare("UPDATE finance_expenses SET archived = 1, ends_on = COALESCE(ends_on, ?), updated_at = ? WHERE id = ?")
      .run(now().slice(0, 10), now(), r.id);
    gone += 1;
  }
  return gone;
}

/** Which venture, if any, is linked to this entity at this plugin. Null is the
 *  ordinary answer and means SHARED — see finance_allocations. */
function ventureOfEntity(plugin: string, entity: string): string | null {
  const row = db
    .prepare("SELECT venture_id FROM venture_links WHERE plugin = ? AND entity = ? ORDER BY venture_id LIMIT 1")
    .get(plugin, entity) as { venture_id: string } | undefined;
  return row?.venture_id ?? null;
}

export type SeedCounts = { added: number; refreshed: number; unchanged: number; archived: number };

export const tally = (): SeedCounts => ({ added: 0, refreshed: 0, unchanged: 0, archived: 0 });
export const bump = (t: SeedCounts, r: "added" | "refreshed" | "unchanged") => { t[r] += 1; };

/**
 * HETZNER: every server and every block volume the last collection saw.
 *
 * EUR, NET OF VAT, because that is what Hetzner's API returns and this file
 * will not add a tax it was not told about. A server's line is its plan price
 * PLUS its primary IPv4 — two figures Hetzner reports separately and one bill
 * — and a null plan price (Hetzner quoting no price for that plan at that
 * location) leaves the whole line unpriced rather than counting the IPv4 alone.
 *
 * SHARED BY DEFAULT. There is no venture link for a Hetzner server anywhere in
 * this box — the venture map has no Hetzner entity source — so every box seeds
 * with `venture_id` null and reaches a venture only through an allocation rule.
 * That is the correct default: a control plane really is shared.
 */
export function seedHetzner(): SeedCounts {
  const t = tally();
  const servers = db
    .prepare("SELECT id, name, plan, location, monthly_eur, ipv4_monthly_eur FROM hetzner_servers")
    .all() as { id: number; name: string | null; plan: string | null; location: string | null; monthly_eur: number | null; ipv4_monthly_eur: number | null }[];
  const volumes = db
    .prepare("SELECT id, name, size_gb, monthly_eur FROM hetzner_volumes")
    .all() as { id: number; name: string | null; size_gb: number | null; monthly_eur: number | null }[];
  const keep = new Set<string>();

  for (const s of servers) {
    const ref = `server:${s.id}`;
    keep.add(ref);
    const amount = s.monthly_eur === null ? null : s.monthly_eur + (s.ipv4_monthly_eur ?? 0);
    bump(t, upsertSeed("hetzner", {
      sourceRef: ref,
      label: s.name ?? `Hetzner server ${s.id}`,
      category: "server",
      amount,
      currency: "EUR",
      period: "monthly",
      renewalOn: null,
      ventureId: null,
      notes:
        amount === null
          ? `Hetzner quoted no price for ${s.plan ?? "this plan"} at ${s.location ?? "this location"}. Unpriced, not free.`
          : `Hetzner ${s.plan ?? "plan"} at ${s.location ?? "unknown location"}, EUR net of VAT, plan ${s.monthly_eur} + primary IPv4 ${s.ipv4_monthly_eur ?? 0}.`,
    }));
  }
  for (const v of volumes) {
    const ref = `volume:${v.id}`;
    keep.add(ref);
    bump(t, upsertSeed("hetzner", {
      sourceRef: ref,
      label: v.name ?? `Hetzner volume ${v.id}`,
      category: "server",
      amount: v.monthly_eur,
      currency: "EUR",
      period: "monthly",
      renewalOn: null,
      ventureId: null,
      notes: `Hetzner block volume, ${v.size_gb ?? "?"} GB, EUR net of VAT.`,
    }));
  }
  t.archived = archiveMissing("hetzner", keep);
  return t;
}

/**
 * THE REGISTRARS: one row per domain, with the renewal date and — usually —
 * no price.
 *
 * NEITHER REGISTRAR PUBLISHES A RENEWAL PRICE through the endpoints this box
 * reads, so `amount` seeds null and the row's whole value is its DATE and its
 * auto-renew flag. That is still the most actionable line in the ledger: a
 * name that renews itself in 40 days and a name that lapses in 40 days are
 * opposite decisions, and both are invisible without this row. Type the price
 * in once and it survives every refresh.
 *
 * The venture comes from the venture link when there is one — thirteen of
 * these are already linked — and null otherwise, which files the domain as a
 * shared cost until somebody links it.
 */
export function seedDomains(): SeedCounts {
  const t = tally();
  const keep = new Set<string>();
  for (const d of allDomains()) {
    const ref = `${d.source}:${d.name}`;
    keep.add(ref);
    bump(t, upsertSeed("registrar", {
      sourceRef: ref,
      label: d.name,
      category: "domain",
      amount: null,
      currency: "USD",
      period: "yearly",
      renewalOn: d.expires_at,
      ventureId: ventureOfEntity(d.source, d.name),
      notes:
        `${d.registrar} renewal${d.expires_at ? ` on ${d.expires_at}` : " — no expiry date reported"}. ` +
        `${d.auto_renew === 1 ? "Auto-renew is on." : d.auto_renew === 0 ? "Auto-renew is OFF: doing nothing loses the name." : "The registrar published no auto-renew flag; null is not “no”."} ` +
        `No renewal price is published through this registrar's API, so the amount is unpriced until you type it.`,
    }));
  }
  t.archived = archiveMissing("registrar", keep);
  return t;
}

/** A domain seeded above, matched back to its venture. Exported for the
 *  route that re-runs attribution after somebody links a domain. */
export function relinkDomains(): number {
  let moved = 0;
  for (const r of db.prepare("SELECT * FROM finance_expenses WHERE source = 'registrar'").all() as unknown as ExpenseRow[]) {
    if (ownerFields(r).includes("venture_id")) continue;
    const [plugin, ...rest] = (r.source_ref ?? "").split(":");
    const want = plugin && rest.length ? ventureOfEntity(plugin, rest.join(":")) : null;
    if (want === r.venture_id) continue;
    db.prepare("UPDATE finance_expenses SET venture_id = ?, updated_at = ? WHERE id = ?").run(want, now(), r.id);
    moved += 1;
  }
  return moved;
}

