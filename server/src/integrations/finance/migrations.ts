/**
 * FINANCE — the tables behind the operating-cost ledger and the profit model.
 *
 * Pure SQL, no imports: integrations/migrations.ts concatenates this and db.ts
 * runs it at import, before any manifest module could be loaded. See
 * integrations/manifest.ts for why.
 *
 * THE LEDGER IS A MODEL, NOT A MEASUREMENT, and the schema is shaped by that
 * one fact. Everything else this box stores is something a provider said;
 * `finance_expenses` is what the operation OWES, which is partly measured
 * (Hetzner quotes a plan price, a registrar quotes a renewal date) and partly
 * typed in by the owner (an accountant, a domain's renewal price nobody's API
 * publishes, a salary). So every row carries where it came from — `source` —
 * and which of its columns the owner has since corrected by hand —
 * `owner_fields`. A refresh from the provider rewrites the measured columns of
 * a measured row and never touches a column the owner edited. Without that
 * pair, a re-collect either destroys the owner's corrections every half hour or
 * lets a decommissioned server go on being billed forever.
 *
 * `amount` IS NULLABLE AND NULL IS NOT ZERO. Twenty-three domains have a
 * renewal DATE from the registrar and no PRICE — neither Dynadot's nor
 * Spaceship's inventory endpoint publishes one — so the honest seeded row is a
 * dated renewal with no money on it. A zero there would say "this domain is
 * free", which is the one thing it certainly is not.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "240_finance_expenses",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_expenses (
        id               TEXT PRIMARY KEY,
        -- NULL is SHARED, and it is the interesting value: a shared cost is
        -- the one that needs an allocation rule before any venture's margin
        -- can be right. A venture id here means the cost is wholly that
        -- venture's and no allocation applies.
        venture_id       TEXT,
        label            TEXT NOT NULL,
        -- server | domain | service | subscription | salary | other
        category         TEXT NOT NULL,
        -- NULL = the price is not known. Never a zero standing in for one.
        amount           REAL,
        currency         TEXT NOT NULL,
        -- monthly | yearly | once. A one-off is never amortised: it counts
        -- toward no run rate, which is why the period is stored rather than
        -- everything being normalised on the way in.
        period           TEXT NOT NULL,
        starts_on        TEXT,
        ends_on          TEXT,
        renewal_on       TEXT,
        -- keep | cancel | undecided. The decision the owner has made about the
        -- next renewal, which is the only thing that makes a renewal date
        -- actionable rather than a countdown.
        renewal_decision TEXT NOT NULL DEFAULT 'undecided',
        -- manual | hetzner | registrar | provider | power. Anything but
        -- 'manual' is refreshed from the thing that measured it.
        source           TEXT NOT NULL DEFAULT 'manual',
        source_ref       TEXT,
        notes            TEXT,
        -- metered | estimated | NULL. Set on rows whose amount depends on
        -- observed usage (electricity); NULL on rows that are a quoted price.
        confidence       TEXT,
        -- The owner has retired this row. A refresh leaves it alone rather
        -- than resurrecting it, so hiding a seeded line is a decision that
        -- survives the next collection.
        archived         INTEGER NOT NULL DEFAULT 0,
        -- JSON array of column names the owner edited by hand. A refresh skips
        -- exactly these and rewrites the rest.
        owner_fields     TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );

      -- One seeded row per measured thing. NULLs compare distinct in a SQLite
      -- unique index, so every manual row (source_ref NULL) is still its own.
      CREATE UNIQUE INDEX IF NOT EXISTS finance_expenses_source
        ON finance_expenses(source, source_ref);
      CREATE INDEX IF NOT EXISTS finance_expenses_venture
        ON finance_expenses(venture_id);
      CREATE INDEX IF NOT EXISTS finance_expenses_renewal
        ON finance_expenses(renewal_on);
    `,
  },
  {
    name: "241_finance_allocations",
    sql: `
      -- HOW A SHARED COST IS SPLIT. One row per venture per expense; `+"`share`"+`
      -- is a fraction of the whole expense, and the shares of an expense may
      -- sum to LESS than one — the remainder is unallocated overhead, which is
      -- a real answer and better than forcing a split nobody believes.
      --
      -- `+"`basis`"+` records HOW the share was arrived at, not how to recompute it:
      -- 'equal' and 'revenue' and 'traffic' are written by a route that did the
      -- arithmetic once against dated evidence, so the split a margin was
      -- computed from is the split the page shows, months later.
      CREATE TABLE IF NOT EXISTS finance_allocations (
        expense_id  TEXT NOT NULL,
        venture_id  TEXT NOT NULL,
        share       REAL NOT NULL,
        -- equal | manual | revenue | traffic
        basis       TEXT NOT NULL,
        note        TEXT,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (expense_id, venture_id)
      );

      CREATE INDEX IF NOT EXISTS finance_allocations_venture
        ON finance_allocations(venture_id);
    `,
  },
  {
    name: "242_finance_power_profiles",
    sql: `
      -- WHAT A MACHINE ON THE OWNER'S DESK DRAWS, so local inference can be
      -- priced beside the model providers it is supposed to be cheaper than.
      --
      -- OPTIONAL AND EMPTY BY DEFAULT. No machine has a profile until somebody
      -- types one, because idle and busy wattage cannot be measured over ssh —
      -- nvidia-smi reports a GPU's draw, not a wall socket's — and a built-in
      -- default would be this file inventing the number the whole feature
      -- exists to make explicit.
      --
      -- `+"`machine_id`"+` is the workstation account's id as text. It is text so a
      -- future source of machines (a fleet box, a laptop with no account) can
      -- key into the same table without a migration.
      CREATE TABLE IF NOT EXISTS finance_power_profiles (
        machine_id    TEXT PRIMARY KEY,
        label         TEXT,
        idle_watts    REAL NOT NULL,
        busy_watts    REAL NOT NULL,
        -- NULL means no tariff on this profile; the plugin-wide rate is used
        -- and the line says which rate priced it.
        rate_per_kwh  REAL,
        currency      TEXT NOT NULL DEFAULT 'EUR',
        timezone      TEXT,
        -- The machine never sleeps, so there is nothing to observe and the
        -- line is a flat idle-watt estimate for the whole month.
        always_on     INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL
      );
    `,
  },
];
