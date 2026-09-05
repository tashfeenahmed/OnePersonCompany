/**
 * The database.
 *
 * WHY SQLITE, AND WHY THE ONE BUILT INTO NODE.
 *
 * The workload is one person and one box. The configuration side is dozens of
 * rows that are read constantly and written by hand a few times a month; the
 * measurement side is an append-only series of small snapshots. Both of those
 * are what SQLite is for. Postgres would mean a daemon to keep running, a
 * connection pool, a separate backup story and a second thing that can be down
 * — real weight, bought for a dataset that fits in a file and a write rate of
 * a few rows an hour.
 *
 * `node:sqlite` in particular, rather than better-sqlite3, because it ships
 * with Node 22.5+ and needs no native build. That matters more than it sounds:
 * this is meant to run on the same class of box as the collectors — a Pi — and
 * a dependency that compiles at install time is a dependency that eventually
 * fails to install on the machine you care about.
 *
 * WAL is on so a long read cannot block the collector's write, and foreign
 * keys are on because a secret without a plugin is a bug worth catching at the
 * database rather than in a route.
 *
 * WHEN THIS STOPS BEING THE RIGHT ANSWER: more than one machine writing, or
 * more than one person needing their own view. Neither is true, and the schema
 * below is plain SQL with no SQLite-only types, so the move to Postgres is a
 * migration rather than a rewrite.
 */
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "./config.ts";
import { INTEGRATION_MIGRATIONS } from "./integrations/migrations.ts";

export const db = new DatabaseSync(DB_FILE);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

/**
 * Migrations are a numbered list, applied in order, recorded as they go. Each
 * one runs once; adding a step means appending to the array and never editing
 * a step that has shipped.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001_init",
    sql: `
      CREATE TABLE plugins (
        id          TEXT PRIMARY KEY,
        connected   INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL,
        last_error  TEXT
      );

      -- One row per vault entry. Ciphertext only: there is no column here that
      -- holds a readable credential, and no query that returns one.
      CREATE TABLE secrets (
        name        TEXT PRIMARY KEY,
        plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        iv          BLOB NOT NULL,
        tag         BLOB NOT NULL,
        ct          BLOB NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Every read of a secret, so "what touched the Hetzner token last night"
      -- is a query rather than a guess.
      CREATE TABLE secret_access (
        ts     TEXT NOT NULL,
        name   TEXT NOT NULL,
        reader TEXT NOT NULL
      );
      CREATE INDEX secret_access_ts ON secret_access(ts);

      -- One row per collection attempt, successful or not. A failed run is
      -- data: it is how the UI can say when something last worked.
      CREATE TABLE runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id    TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        ok           INTEGER,
        error        TEXT,
        note         TEXT
      );
      CREATE INDEX runs_plugin_started ON runs(plugin_id, started_at DESC);

      -- Append-only measurements. One table for every metric the dashboard can
      -- draw, because a widget wants a series and does not care which provider
      -- produced it.
      CREATE TABLE readings (
        metric TEXT NOT NULL,
        ts     TEXT NOT NULL,
        value  REAL NOT NULL,
        meta   TEXT
      );
      CREATE INDEX readings_metric_ts ON readings(metric, ts DESC);
    `,
  },
  {
    name: "002_hetzner",
    sql: `
      -- Current state, not history: one row per server the account still has.
      -- History lives in readings; a decommissioned box leaves this table and
      -- its cost stops counting, which is the behaviour you want from a bill.
      CREATE TABLE hetzner_servers (
        id                INTEGER PRIMARY KEY,
        token_label       TEXT NOT NULL,
        name              TEXT,
        ipv4              TEXT,
        status            TEXT,
        plan              TEXT,
        specs             TEXT,
        location          TEXT,
        cores             INTEGER,
        memory_gb         REAL,
        disk_gb           INTEGER,
        architecture      TEXT,
        monthly_eur       REAL,
        ipv4_monthly_eur  REAL,
        created_at        TEXT,
        seen_at           TEXT NOT NULL
      );

      CREATE TABLE hetzner_volumes (
        id           INTEGER PRIMARY KEY,
        token_label  TEXT NOT NULL,
        name         TEXT,
        size_gb      INTEGER,
        location     TEXT,
        server_id    INTEGER,
        monthly_eur  REAL,
        seen_at      TEXT NOT NULL
      );
    `,
  },
  {
    name: "003_hetzner_load",
    sql: `
      -- What each box has been DOING, as opposed to what it is and what it
      -- costs. Kept apart from \`readings\` because the two are different
      -- shapes of measurement: readings is one row per collection of a
      -- fleet-wide figure, this is a day of fifteen-minute samples per box per
      -- metric — three orders of magnitude more rows, with its own retention.
      --
      -- The key is (server, metric, moment), so re-reading a window the last
      -- run already saw REPLACES those rows instead of doubling them. That is
      -- what makes "always pull the last 24h" safe to run every half hour.
      CREATE TABLE hetzner_load (
        server_id  INTEGER NOT NULL,
        metric     TEXT NOT NULL,
        ts         TEXT NOT NULL,
        value      REAL NOT NULL,
        PRIMARY KEY (server_id, metric, ts)
      ) WITHOUT ROWID;

      CREATE INDEX hetzner_load_ts ON hetzner_load(ts);
    `,
  },
  {
    name: "004_domains",
    sql: `
      -- One row per domain per registrar. Current state, replaced per source:
      -- a domain transferred away leaves the table on the next collection, and
      -- each registrar owns only its own rows, so a Dynadot outage cannot take
      -- the Spaceship names with it.
      --
      -- THE EXPIRY DATE IS STORED; THE DAYS LEFT ARE NOT. A "renews in 30 days"
      -- written down at collection time is wrong by one the next morning and
      -- wrong by thirty a month later if a collection fails — and a stale
      -- renewal countdown is the most dangerous number a domains page can show.
      -- The countdown is computed when the row is read.
      CREATE TABLE domains (
        name           TEXT NOT NULL,
        source         TEXT NOT NULL,
        registrar      TEXT NOT NULL,
        expires_at     TEXT,
        registered_on  TEXT,
        -- 0 / 1 / NULL, and NULL means "asked and not told" rather than "no".
        auto_renew     INTEGER,
        locked         INTEGER,
        status         TEXT,
        privacy        TEXT,
        nameservers    TEXT,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (name, source)
      );

      CREATE INDEX domains_expires ON domains(expires_at);
    `,
  },
  {
    name: "005_accounts",
    sql: `
      -- A PLUGIN HOLDS A LIST OF ACCOUNTS, NOT A CREDENTIAL.
      --
      -- Hetzner is the case that forced it: a token is scoped to a single
      -- PROJECT, so an account with three projects needs three tokens. The old
      -- shape coped by storing a newline-separated blob under one entry name,
      -- which worked and was invisible — no name per token, no state per
      -- token, and one dead token reported as one warning on the plugin rather
      -- than as "this project stopped answering". The registrars have the same
      -- shape for a different reason: two Dynadot logins are two portfolios.
      --
      -- So an account is the unit that owns a credential SET (one field for
      -- Hetzner, a key and a secret for the registrars), a label, its own
      -- connected flag and its own last error. The plugin row above keeps
      -- meaning "is any of this connected", which is the question the index
      -- page asks.
      --
      -- The label is UNIQUE per plugin because it is what the collected rows
      -- are attributed by on screen: two accounts called "Main" would make
      -- "which project is this server in" unanswerable by looking.
      CREATE TABLE plugin_accounts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        label       TEXT NOT NULL,
        connected   INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        -- When this account last answered its provider. Kept apart from
        -- updated_at, which moves when the CREDENTIAL changes: "stored an hour
        -- ago" and "last worked on Tuesday" are two different sentences and a
        -- failing account needs both of them said.
        last_ok_at  TEXT,
        last_error  TEXT,
        UNIQUE (plugin_id, label)
      );

      -- EVERY EXISTING PLUGIN THAT HOLDS A CREDENTIAL BECOMES ONE ACCOUNT.
      -- Its connected flag and last error are carried across rather than
      -- reset, because the three plugins connected the moment this runs are
      -- connected the moment after it, and a migration that made the owner
      -- re-paste three working credentials would be a migration that lost
      -- them. A plugin row with no secrets gets no account: it was never
      -- connected, and inventing an empty account for it would put a row on
      -- the page claiming something is set up.
      INSERT INTO plugin_accounts
        (plugin_id, label, connected, created_at, updated_at, last_error)
      SELECT p.id, 'Account 1', p.connected, p.updated_at, p.updated_at, p.last_error
        FROM plugins p
       WHERE EXISTS (SELECT 1 FROM secrets s WHERE s.plugin_id = p.id);

      -- SECRETS GAIN AN OWNER AND A FIELD KEY.
      --
      -- Rebuilt rather than ALTERed, because both columns want NOT NULL and
      -- the real key of the table is now (account_id, field) — one value per
      -- field per account. "name" stays the PRIMARY KEY because it is the
      -- ASSOCIATED DATA the ciphertext was sealed with: it has to be globally
      -- unique and it can never change for a row that is not being re-sealed.
      -- That is also why the rebuild copies name/iv/tag/ct across untouched —
      -- moving a blob is safe, renaming one is not.
      CREATE TABLE secrets_next (
        name        TEXT PRIMARY KEY,
        plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        account_id  INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        -- Which half of the credential set this is: "token", "key", "secret".
        field       TEXT NOT NULL,
        iv          BLOB NOT NULL,
        tag         BLOB NOT NULL,
        ct          BLOB NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE (account_id, field)
      );

      -- The five names that can exist at this point are enumerated rather than
      -- derived: a migration is a statement about the data that was actually
      -- there, and a rule that re-reads the registry would change meaning
      -- every time the registry grows. Anything else keeps its own name as its
      -- field key — unique by construction, so an unrecognised entry survives
      -- as an odd-looking field instead of failing the migration or colliding.
      INSERT INTO secrets_next
        (name, plugin_id, account_id, field, iv, tag, ct, updated_at)
      SELECT s.name, s.plugin_id,
             (SELECT a.id FROM plugin_accounts a WHERE a.plugin_id = s.plugin_id),
             CASE s.name
               WHEN 'hetzner-token'    THEN 'token'
               WHEN 'dynadot-key'      THEN 'key'
               WHEN 'dynadot-secret'   THEN 'secret'
               WHEN 'spaceship-key'    THEN 'key'
               WHEN 'spaceship-secret' THEN 'secret'
               ELSE s.name
             END,
             s.iv, s.tag, s.ct, s.updated_at
        FROM secrets s;

      DROP TABLE secrets;
      ALTER TABLE secrets_next RENAME TO secrets;

      -- DOMAINS ARE ATTRIBUTED TO THE ACCOUNT THAT READ THEM.
      --
      -- "source" stays the plugin id, because that is the contract the API and
      -- every widget filtering on "dynadot" already read. What changes is the
      -- key: two accounts at the same registrar are two portfolios, and
      -- (name, source) would let the second one overwrite the first's row for
      -- a name they both hold. The account joins the key, and replacement is
      -- scoped to one account so a failing login cannot clear a working one's
      -- names.
      --
      -- The label is stored beside the id, as it stood at collection time. A
      -- renamed account should not silently rewrite what last night's page
      -- said it read; the id is what joins to the account that exists now.
      CREATE TABLE domains_next (
        name           TEXT NOT NULL,
        source         TEXT NOT NULL,
        account_id     INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label  TEXT NOT NULL,
        registrar      TEXT NOT NULL,
        expires_at     TEXT,
        registered_on  TEXT,
        auto_renew     INTEGER,
        locked         INTEGER,
        status         TEXT,
        privacy        TEXT,
        nameservers    TEXT,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (name, source, account_id)
      );

      -- A row whose registrar has no account is a row nothing can refresh and
      -- nothing can explain — it survives only from a credential that has
      -- already been deleted. It is dropped rather than carried forward under
      -- an invented owner, which is the same rule the rest of this codebase
      -- follows about stale figures.
      INSERT INTO domains_next
        (name, source, account_id, account_label, registrar, expires_at,
         registered_on, auto_renew, locked, status, privacy, nameservers, seen_at)
      SELECT d.name, d.source, a.id, a.label, d.registrar, d.expires_at,
             d.registered_on, d.auto_renew, d.locked, d.status, d.privacy,
             d.nameservers, d.seen_at
        FROM domains d
        JOIN plugin_accounts a ON a.plugin_id = d.source;

      DROP TABLE domains;
      ALTER TABLE domains_next RENAME TO domains;
      CREATE INDEX domains_expires ON domains(expires_at);

      -- The two Hetzner state tables are REPLACED WHOLE on every collection,
      -- so they only need the column added: the next run fills it, and a null
      -- here means "collected before accounts existed", which is true and
      -- lasts one collection. That is worth far less churn than rebuilding two
      -- tables to make a cache non-null.
      --
      -- token_label keeps its name. It already holds exactly what it will hold
      -- from now on — the label of the account a row came from — and renaming
      -- a column that is already correct is churn a shipped migration cannot
      -- take back.
      ALTER TABLE hetzner_servers ADD COLUMN account_id INTEGER;
      ALTER TABLE hetzner_volumes ADD COLUMN account_id INTEGER;
    `,
  },
  {
    name: "006_github_npm",
    sql: `
      -- CONFIGURATION THAT IS NOT A CREDENTIAL.
      --
      -- npm forced this. Its downloads API is public, so there is nothing to
      -- seal in the vault and nothing to verify before storing — but the
      -- collector still cannot run without knowing WHICH PACKAGES are mine.
      -- That is a setting: public by design, safe to return from a route,
      -- shown in full on the page. Putting it in \`secrets\` would have meant a
      -- write-only field the owner could never read back to check, which is
      -- exactly the wrong property for a list you maintain by hand.
      --
      -- Keyed per plugin rather than globally, so the closed registry above
      -- the route can say which keys each plugin accepts — the same rule the
      -- vault's entry names follow, for the same reason: a route that can
      -- write any key is a route that can quietly invent a setting nothing
      -- reads.
      CREATE TABLE plugin_config (
        plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );

      -- WHAT A REPO IS, as of the last collection. Current state, replaced per
      -- account, exactly like the domains table and for the same reason: a
      -- token that answers 401 must lose its own account's repos and nobody
      -- else's. The key carries the account because two logins can legitimately
      -- see one repo, and (full_name) alone would let the second one overwrite
      -- the first's row.
      CREATE TABLE github_repos (
        full_name       TEXT NOT NULL,
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label   TEXT NOT NULL,
        owner           TEXT NOT NULL,
        name            TEXT NOT NULL,
        is_org          INTEGER NOT NULL DEFAULT 0,
        private         INTEGER NOT NULL DEFAULT 0,
        fork            INTEGER NOT NULL DEFAULT 0,
        archived        INTEGER NOT NULL DEFAULT 0,
        stars           INTEGER,
        forks           INTEGER,
        -- GitHub's own open_issues_count, WHICH INCLUDES OPEN PULL REQUESTS.
        -- Named for the field it is rather than for "issues", because
        -- separating the two costs a call per repo and every label above it
        -- says "issues & PRs" as a result.
        open_issues     INTEGER,
        watchers        INTEGER,
        language        TEXT,
        homepage        TEXT,
        default_branch  TEXT,
        pushed_at       TEXT,
        created_at      TEXT,
        seen_at         TEXT NOT NULL,
        PRIMARY KEY (full_name, account_id)
      );

      -- WHAT PEOPLE DID TO A REPO, day by day.
      --
      -- Its own table for the reason hetzner_load has one: this is a different
      -- shape of measurement from \`readings\`. GitHub serves a DAILY series and
      -- only ever fourteen days of it, so the key is (repo, metric, day) and a
      -- re-read of a window we already have REPLACES those days rather than
      -- doubling them. That is what makes "always pull the last fourteen days"
      -- safe to run on a timer — and it is also how this dashboard ends up
      -- holding more history than GitHub itself will show you, because the
      -- days accumulate here long after they fall out of GitHub's window.
      --
      -- Deliberately NOT wiped when a repo's row is replaced: the facts about
      -- a repo and what happened to it are two different collections, and a
      -- run that refreshed the first should not blank the second.
      CREATE TABLE github_traffic (
        full_name  TEXT NOT NULL,
        -- views | uniques | clones | cloneUniques
        metric     TEXT NOT NULL,
        day        TEXT NOT NULL,
        value      REAL NOT NULL,
        PRIMARY KEY (full_name, metric, day)
      ) WITHOUT ROWID;

      CREATE INDEX github_traffic_day ON github_traffic(day);

      -- GITHUB'S OWN FOURTEEN-DAY TOTALS, which are NOT the sum of the days
      -- above and must never be recomputed from them.
      --
      -- Views are views and do add up. UNIQUES DO NOT: GitHub de-duplicates
      -- visitors across the whole window for this figure and within each day
      -- for the series, so adding fourteen daily uniques counts every returning
      -- visitor again — for this account's busiest repo that is the difference
      -- between 56,707 real people and about 78,000 imaginary ones. The only
      -- honest source for "unique visitors over the window" is the header
      -- figure, so it is stored as the header figure said it, with the moment
      -- it was read.
      CREATE TABLE github_traffic_window (
        full_name      TEXT PRIMARY KEY,
        days           INTEGER NOT NULL,
        views          INTEGER,
        uniques        INTEGER,
        clones         INTEGER,
        clone_uniques  INTEGER,
        -- Which of the four traffic calls refused, and why. A 403 on a repo
        -- the token can read but not push to is an honest answer, not a fault.
        note           TEXT,
        seen_at        TEXT NOT NULL
      );

      -- The top ten referrers and the top ten paths, per repo. A SNAPSHOT over
      -- the same fourteen days, not a series: GitHub offers no history for
      -- these, and storing yesterday's beside today's would invent one.
      CREATE TABLE github_popular (
        full_name  TEXT NOT NULL,
        -- referrer | path
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        title      TEXT,
        count      INTEGER NOT NULL,
        uniques    INTEGER NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (full_name, kind, name)
      );

      -- One row per GitHub account: who the token belongs to, and WHAT IS LEFT
      -- OF THE HOUR.
      --
      -- The rate limit is published rather than merely respected. The first
      -- symptom of crossing it is a dashboard that silently stops updating, at
      -- three in the morning, for a reason nothing on the page can state —
      -- so the remaining budget, the ceiling, the moment it refills and the
      -- cost of the last run are all kept. Whether "4,780 left" is still true
      -- is decided when it is READ, against reset_at, not written down as a
      -- claim that decays.
      CREATE TABLE github_state (
        account_id      INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        login           TEXT,
        name            TEXT,
        followers       INTEGER,
        public_repos    INTEGER,
        rate_remaining  INTEGER,
        rate_limit      INTEGER,
        rate_reset_at   TEXT,
        -- What this account's last run spent, so "who is burning the budget"
        -- has an answer that is not a guess.
        requests        INTEGER,
        -- When traffic was last asked for. Traffic is four calls per repo and
        -- the series is day-grained, so it is refreshed on its own, slower
        -- cadence; this is the clock that decides.
        traffic_at      TEXT,
        checked_at      TEXT NOT NULL
      );

      -- npm's daily downloads, per package. Same shape and same rule as
      -- github_traffic: keyed by its own day so re-reading a window rewrites
      -- it, and never a stored weekly total — the ISO weeks the dashboard
      -- draws are bucketed from these when they are read, because a week that
      -- was partial when it was written stops being partial the next morning.
      CREATE TABLE npm_downloads (
        package    TEXT NOT NULL,
        day        TEXT NOT NULL,
        downloads  INTEGER NOT NULL,
        PRIMARY KEY (package, day)
      ) WITHOUT ROWID;

      -- One row per configured package: which endpoint answered, the range npm
      -- actually covered, and its own last error. Per package and not per run,
      -- because one name 404ing must not cost the others their figures.
      CREATE TABLE npm_packages (
        package      TEXT PRIMARY KEY,
        endpoint     TEXT,
        range_start  TEXT,
        range_end    TEXT,
        last_error   TEXT,
        last_ok_at   TEXT,
        seen_at      TEXT NOT NULL
      );
    `,
  },
  {
    name: "007_costs",
    sql: `
      -- WHAT THE LLM AND MEDIA HABIT COSTS.
      --
      -- Five tables and not one, because the three providers do not answer the
      -- same question and folding them into a shared "spend" table would mean
      -- inventing the columns the loser of that merge does not have. OpenAI
      -- reports money per day per project; OpenRouter reports money per day per
      -- MODEL and, separately and unjoinably, per KEY; Replicate reports no
      -- money at all and a prediction history instead. A schema that pretended
      -- otherwise would be the first place the lie was told.
      --
      -- EVERY TABLE HERE STORES WHAT WAS MEASURED AND NOT WHAT FOLLOWS FROM IT.
      -- There is no "spend this month" column anywhere: a month's total is a
      -- sum over rows computed on the read, because a total written down on the
      -- 4th is wrong on the 5th and badly wrong after a week of failed
      -- collections — which is exactly when someone goes looking at it.

      -- OpenAI: one row per day per project, the single grouped cut the Costs
      -- API gives. Both totals anyone asks of it — by day, by project — are
      -- sums over these same rows, so they agree by construction rather than
      -- by luck.
      --
      -- Keyed rather than replaced wholesale, because the recent buckets LAG:
      -- the same day is read again tomorrow with a larger figure in it, and the
      -- newer read has to win rather than land beside the old one. That also
      -- lets history accumulate past the 30-day window each run asks for.
      CREATE TABLE openai_costs (
        account_id    INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        day           TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        project_name  TEXT,
        usd           REAL NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (account_id, day, project_id)
      ) WITHOUT ROWID;

      -- OpenRouter, cut one: per day per model per provider. Same replacement
      -- rule, same reason — today's row is partial when it is first read and
      -- complete when it is read again.
      CREATE TABLE openrouter_activity (
        account_id        INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label     TEXT NOT NULL,
        day               TEXT NOT NULL,
        model             TEXT NOT NULL,
        provider          TEXT NOT NULL,
        usd               REAL NOT NULL,
        -- Inference OpenRouter ROUTED to the owner's own provider account and
        -- did not bill for. Its own column and never added to usd: one means
        -- "what OpenRouter charged" and the other means "what somebody else
        -- charged", and the sum is a figure no invoice matches.
        byok_usd          REAL NOT NULL,
        requests          INTEGER NOT NULL,
        prompt_tokens     INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        reasoning_tokens  INTEGER NOT NULL,
        seen_at           TEXT NOT NULL,
        PRIMARY KEY (account_id, day, model, provider)
      ) WITHOUT ROWID;

      -- OpenRouter, cut two: per key. THIS DOES NOT JOIN TO THE TABLE ABOVE.
      -- The API has no per-day-per-key figure anywhere, so there is no key
      -- column up there and no day column down here, and nothing downstream
      -- can accidentally cross them.
      --
      -- Current state, replaced per account each run: a key deleted at
      -- OpenRouter stops existing here too, which is exactly why the sum of
      -- this table is smaller than the account's lifetime spend. No primary
      -- key, because the only identifier that survives the drop of the hash is
      -- the key's NAME and two keys may share one — collapsing them under a
      -- unique constraint would hide a key that is spending money.
      CREATE TABLE openrouter_keys (
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label   TEXT NOT NULL,
        name            TEXT NOT NULL,
        usd             REAL NOT NULL,
        usd_month       REAL NOT NULL,
        usd_week        REAL NOT NULL,
        usd_day         REAL NOT NULL,
        disabled        INTEGER NOT NULL,
        created_at      TEXT,
        -- NULL is "no cap", the opposite fact from a cap with nothing left on
        -- it. They must not both arrive on the page as zero.
        spend_limit     REAL,
        limit_remaining REAL,
        seen_at         TEXT NOT NULL
      );
      CREATE INDEX openrouter_keys_account ON openrouter_keys(account_id);

      -- OpenRouter's ledger: bought and spent, over the account's whole life.
      -- One row per account, replaced each run, because a balance is a current
      -- state and yesterday's is worth nothing.
      CREATE TABLE openrouter_credits (
        account_id    INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        purchased     REAL,
        spent         REAL,
        seen_at       TEXT NOT NULL
      );

      -- REPLICATE HAS NO MONEY COLUMN, AND THAT IS THE POINT.
      --
      -- Its API publishes no billing surface at all — /v1/billing,
      -- /v1/account/billing and /v1/usage are all 404 — a prediction record
      -- carries no hardware SKU and no price, and /v1/hardware lists the SKUs
      -- without rates. On top of that the models this account actually runs are
      -- priced per OUTPUT, per image and per second of video, so a rate per
      -- compute-second would not price them even if one existed. This table
      -- therefore holds what Replicate does report, in its own units, and any
      -- cost card built on it would have to invent the missing number.
      --
      -- One row per PREDICTION rather than a daily rollup: the rollup is three
      -- different questions — per day, per model, succeeded or not — and
      -- storing one of them would answer the other two with a guess.
      -- Keyed by the prediction's own id, so re-reading a window that overlaps
      -- what is already held corrects a prediction that was still running
      -- rather than counting it twice.
      CREATE TABLE replicate_predictions (
        id              TEXT PRIMARY KEY,
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label   TEXT NOT NULL,
        model           TEXT,
        status          TEXT,
        created_at      TEXT NOT NULL,
        -- metrics.predict_time. NULL where the prediction never ran or had not
        -- finished when it was read — which is not zero seconds of compute.
        predict_seconds REAL,
        -- The output-side counters, each NULL where the model does not report
        -- that kind of output at all.
        image_outputs   INTEGER,
        video_seconds   REAL,
        output_tokens   INTEGER,
        source          TEXT,
        seen_at         TEXT NOT NULL
      );
      CREATE INDEX replicate_predictions_created ON replicate_predictions(created_at);
    `,
  },
  {
    name: "008_stock",
    sql: `
      -- The stock libraries report exactly one thing worth keeping: how much of
      -- a monthly request allowance is left. One row per library per account
      -- per reading, append-only, because the SERIES is the point — a single
      -- "24,999 remaining" says nothing, and the same figure sampled four times
      -- a day is a burn rate and a date the pipeline runs out.
      --
      -- Nullable throughout: a header that is absent is not a zero. A service
      -- that stops reporting its remaining allowance has told us nothing about
      -- what is left, and storing that as 0 would raise an alarm about the one
      -- thing that did not happen.
      CREATE TABLE stock_quota (
        library     TEXT NOT NULL,
        account_id  INTEGER,
        ts          TEXT NOT NULL,
        quota_limit INTEGER,
        remaining   INTEGER,
        resets_at   TEXT,
        PRIMARY KEY (library, account_id, ts)
      ) WITHOUT ROWID;

      CREATE INDEX stock_quota_ts ON stock_quota(ts);
    `,
  },
  {
    name: "009_stripe_adsense",
    sql: `
      -- REVENUE, AND THE TWO PROVIDERS THAT DO NOT MEASURE IT THE SAME WAY.
      --
      -- Stripe reports settled money: a card was charged, a fee was taken, a
      -- payout left for a bank. AdSense reports ESTIMATED earnings, revised by
      -- Google for days after the fact. Nothing below adds the two together
      -- and no table here holds a figure spanning both — the same rule the
      -- costs tables keep between euro and dollars, for a stronger reason:
      -- these two are not even the same KIND of number.

      -- Payment ATTEMPTS, per UTC day per currency. The only place a failure
      -- exists: a decline never posts to the balance, so the ledger table
      -- below cannot see one. gross and succeeded are succeeded charges
      -- only, which is what every chart drawn off this assumes.
      --
      -- BLOCKED AND DECLINED ARE COUNTED APART and never share a denominator.
      -- Stripe's own outcome.type separates a Radar block — an attack
      -- stopped before a bank saw it — from a bank refusing a real customer.
      -- This account fails 553 of 1,135 attempts over ninety days, and
      -- reporting that as "49% of payments fail" would be an alarm about card
      -- testing rather than about the business.
      --
      -- Keyed and REPLACED, because every run rewalks ninety days: a refund
      -- that lands in September against a July charge changes July's row, and
      -- a plain insert would double it on every collection.
      CREATE TABLE stripe_charge_days (
        account_id    INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        day           TEXT NOT NULL,
        currency      TEXT NOT NULL,
        gross         REAL NOT NULL,
        refunded      REAL NOT NULL,
        refunds       INTEGER NOT NULL,
        succeeded     INTEGER NOT NULL,
        failed        INTEGER NOT NULL,
        blocked       INTEGER NOT NULL,
        declined      INTEGER NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (account_id, day, currency)
      ) WITHOUT ROWID;

      -- SETTLEMENT, per UTC day per currency, straight off the balance ledger.
      --
      -- fees is Stripe's own cut EX-TAX and is the only figure a blended rate
      -- may be derived from. tax_withheld is sales tax Stripe collects as
      -- merchant of record and remits onward: real money off the top and not a
      -- cost, because it is not the business's money at any point. Folding the
      -- two together is how an 8.2% processing cost reads as 15.3%.
      -- fees_total is the two added, which is the term the identity needs:
      --     net = gross - refunds - disputes - fees_total + other
      --
      -- Its gross is NOT the charge table's gross and the two are never
      -- summed together: one is dated by the charge, the other by the ledger's
      -- posting, and they disagree by whatever crossed midnight.
      CREATE TABLE stripe_ledger_days (
        account_id       INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label    TEXT NOT NULL,
        day              TEXT NOT NULL,
        currency         TEXT NOT NULL,
        gross            REAL NOT NULL,
        fees             REAL NOT NULL,
        tax_withheld     REAL NOT NULL,
        fees_total       REAL NOT NULL,
        refunds          REAL NOT NULL,
        disputes         REAL NOT NULL,
        other            REAL NOT NULL,
        net              REAL NOT NULL,
        count            INTEGER NOT NULL,
        -- The fee scalar decomposed. These five always add back up to
        -- fees_total, with anything Stripe's own details did not account for
        -- landing in other_fees rather than disappearing.
        processing       REAL NOT NULL,
        managed_payments REAL NOT NULL,
        dispute_fees     REAL NOT NULL,
        billing          REAL NOT NULL,
        other_fees       REAL NOT NULL,
        seen_at          TEXT NOT NULL,
        PRIMARY KEY (account_id, day, currency)
      ) WITHOUT ROWID;

      -- ONE ROW PER SUBSCRIPTION, LIVE OR DEAD, AND NO AGGREGATE ANYWHERE.
      --
      -- MRR, the active count, the plan mix and every churn rate are computed
      -- from these rows when somebody asks. A stored "MRR: $875" is wrong the
      -- moment a subscription cancels and badly wrong after a week of failed
      -- collections — which is the week somebody looks. monthly_usd is the
      -- one derived number kept, because it is a property of the subscription
      -- (its price, normalised by its own interval, net of its own coupons)
      -- and not of the window it is read in.
      --
      -- paid_cents is what this subscription ever actually collected, and
      -- NULL means "not asked yet" rather than zero. It is the fact that
      -- decides whether a cancellation is churn at all: a cancelled free trial
      -- and an expired checkout collected nothing and lost nothing, and
      -- counting them cost workdash $415 of imaginary churn in a $430 month.
      -- It costs one request per cancellation and is asked once, ever.
      CREATE TABLE stripe_subscriptions (
        id                  TEXT PRIMARY KEY,
        account_id          INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label       TEXT NOT NULL,
        status              TEXT NOT NULL,
        currency            TEXT NOT NULL,
        monthly_usd         REAL NOT NULL,
        listed_monthly_usd  REAL NOT NULL,
        bill_interval       TEXT,
        interval_count      INTEGER,
        product             TEXT,
        plan                TEXT,
        created_at          TEXT NOT NULL,
        -- Set only when it has actually ENDED. A subscription that has merely
        -- asked to cancel still bills and is still MRR; Stripe fills its
        -- canceled_at the moment the cancellation is scheduled, which is why
        -- that field alone cannot be read as "gone".
        ended_at            TEXT,
        cancel_at_period_end INTEGER NOT NULL,
        cancel_at           TEXT,
        trial_start         TEXT,
        trial_end           TEXT,
        reason              TEXT,
        paid_cents          INTEGER,
        seen_at             TEXT NOT NULL
      );
      CREATE INDEX stripe_subscriptions_account ON stripe_subscriptions(account_id);
      CREATE INDEX stripe_subscriptions_ended ON stripe_subscriptions(ended_at);

      -- What Stripe is holding, per currency. Current state, replaced each
      -- run: yesterday's balance is worth nothing.
      CREATE TABLE stripe_balance (
        account_id    INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        currency      TEXT NOT NULL,
        available     REAL NOT NULL,
        pending       REAL NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (account_id, currency)
      ) WITHOUT ROWID;

      -- The last few payouts, keyed by Stripe's own id. This exists so the
      -- balance card can say when money last actually left for a bank —
      -- and so nothing has to guess when the next one is. This account's
      -- payouts are all MANUAL, so there is no schedule to read and no
      -- "next payout Friday" to print.
      CREATE TABLE stripe_payouts (
        id            TEXT PRIMARY KEY,
        account_id    INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        amount        REAL NOT NULL,
        currency      TEXT NOT NULL,
        status        TEXT NOT NULL,
        automatic     INTEGER NOT NULL,
        arrival_date  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        seen_at       TEXT NOT NULL
      );
      CREATE INDEX stripe_payouts_created ON stripe_payouts(created_at);

      -- HOW FAR BACK THE TWO DAY TABLES REACH, per account.
      --
      -- Every run rewalks ninety days and adds one older chunk until it finds
      -- nothing older still. This is that bookmark, and it lives in the
      -- database rather than in a variable because the process is restarted
      -- far more often than the account is. backfilled is set only on the
      -- evidence of a probe that found nothing older — never because a walk
      -- came back empty, which is also what a page cap looks like.
      CREATE TABLE stripe_state (
        account_id   INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        history_from TEXT,
        backfilled   INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL
      );

      -- ADSENSE: ESTIMATED earnings per site per day, in the account's own
      -- reporting currency, which the report header names and this stores
      -- rather than assumes. Estimated is Google's word: the figures are
      -- revised for days afterwards, so recent rows are REPLACED on every
      -- collection rather than added to.
      --
      -- No RPM column. RPM is earnings per thousand impressions and does not
      -- add up across days or sites; the two figures it is made of do. It is
      -- divided out when somebody asks, from rows that are still true.
      CREATE TABLE adsense_days (
        account_id    INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        day           TEXT NOT NULL,
        site          TEXT NOT NULL,
        currency      TEXT NOT NULL,
        usd           REAL NOT NULL,
        page_views    INTEGER NOT NULL,
        impressions   INTEGER NOT NULL,
        clicks        INTEGER NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (account_id, day, site)
      ) WITHOUT ROWID;

      -- Calendar months, including the running one. Whether a month is
      -- complete is decided when it is READ, against today's month — a stored
      -- flag would be true on the day it was written and wrong on the first of
      -- the next month, and a part month printed as a monthly figure halves it.
      CREATE TABLE adsense_months (
        account_id    INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        month         TEXT NOT NULL,
        site          TEXT NOT NULL,
        currency      TEXT NOT NULL,
        usd           REAL NOT NULL,
        page_views    INTEGER NOT NULL,
        impressions   INTEGER NOT NULL,
        clicks        INTEGER NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (account_id, month, site)
      ) WITHOUT ROWID;
    `,
  },
  {
    name: "010_mobile",
    sql: `
      -- THE TWO APP STORES, AND THE ONE DISTINCTION THAT SHAPES EVERY TABLE.
      --
      -- Both stores publish TWO kinds of money and they are not the same
      -- money. Apple's daily sales report carries its ESTIMATED developer
      -- proceeds; Apple's monthly finance report carries the partner share it
      -- actually paid. Google's sales/ ZIPs carry what buyers were charged in
      -- their own currencies; Google's earnings/ ZIPs carry the merchant
      -- amount that lands, with its fee netted off. The estimate and the
      -- payout are different measurements of different things, so they are in
      -- different tables with different keys — there is no column anywhere
      -- below into which one could be added to the other by accident.
      --
      -- AND NOTHING HERE ADDS ACROSS CURRENCIES. Every money table is keyed by
      -- currency, because an account selling in nine storefronts earns in nine
      -- currencies and this box fetches no exchange rate. The route reports
      -- them side by side and offers no total, exactly as /api/costs does with
      -- euro and dollars.

      -- Per account: the three IDENTIFIERS a report request needs, written
      -- down as they were actually used. The key id, the issuer and the vendor
      -- number are not secrets — they are printed in Apple's own console — and
      -- an owner who cannot read back which vendor number the collector is
      -- sending cannot debug the one failure that produces an empty board.
      CREATE TABLE appstore_state (
        account_id    INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        key_id        TEXT,
        issuer_id     TEXT,
        vendor        TEXT,
        apps          INTEGER NOT NULL,
        seen_at       TEXT NOT NULL
      );

      -- The apps as they stand, replaced per account each run. WHETHER AN APP
      -- IS ON THE STORE IS A FINDING THE MONEY CANNOT EXPRESS: an app at
      -- WAITING_FOR_REVIEW earns nothing and is not failing to earn, and a
      -- revenue card with no such column invites "no proceeds" to be read as a
      -- verdict about an app nobody could buy.
      --
      -- The rating comes from the public iTunes listing rather than the API,
      -- which has no ratings at all. NULL average with a zero count is "nobody
      -- has rated it" — never zero stars.
      CREATE TABLE appstore_apps (
        account_id     INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label  TEXT NOT NULL,
        app_id         TEXT NOT NULL,
        bundle_id      TEXT,
        name           TEXT,
        sku            TEXT,
        primary_locale TEXT,
        state          TEXT,
        version        TEXT,
        on_store       INTEGER,
        storefront     TEXT,
        listed         INTEGER,
        rating_avg     REAL,
        rating_count   INTEGER,
        released_at    TEXT,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (account_id, app_id)
      ) WITHOUT ROWID;

      -- WHICH REPORTS WERE ASKED FOR AND WHAT APPLE SAID. This is the table
      -- that keeps a zero apart from an absence, which no other table here
      -- could hold: a day with no sales has no rows, and so does a day Apple
      -- has not generated yet.
      --
      --   kind 'sales'   period a day    state reported | zero | absent | gone
      --   kind 'finance' period a month  state reported | none
      --
      -- Finance has no 'zero'. Probed on 2026-09-04, that endpoint answers the
      -- same 404 sentence for a settled month, the running month and a month
      -- in the future alike — so "Apple issued no report" is as far as it can
      -- be read, and a payout of zero is never written from an absence.
      CREATE TABLE appstore_reports (
        account_id INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        period     TEXT NOT NULL,
        state      TEXT NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (account_id, kind, period)
      ) WITHOUT ROWID;

      -- Units, per day per app. Downloads are FIRST-TIME installs (Apple's "1"
      -- product family); updates and re-downloads are their own column because
      -- adding them to downloads would fill the top of a funnel with people
      -- who were already there.
      CREATE TABLE appstore_sales (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        day          TEXT NOT NULL,
        app_id       TEXT NOT NULL,
        downloads    INTEGER NOT NULL,
        updates      INTEGER NOT NULL,
        in_app_units INTEGER NOT NULL,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, day, app_id)
      ) WITHOUT ROWID;

      -- Apple's ESTIMATED developer proceeds — the preview, never the payout.
      -- Only non-zero rows are stored: every free download reports 0.00 in its
      -- storefront's currency, and keeping those would turn "this app has
      -- never earned" into a currency breakdown of nothing.
      CREATE TABLE appstore_proceeds (
        account_id INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        day        TEXT NOT NULL,
        app_id     TEXT NOT NULL,
        currency   TEXT NOT NULL,
        amount     REAL NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (account_id, day, app_id, currency)
      ) WITHOUT ROWID;

      -- THE ACTUAL PAYOUT: extended partner share per closed fiscal month, per
      -- currency. An empty app_id means the row matched no app on the account
      -- and is kept anyway — it is money Apple paid, and a payout total that
      -- quietly dropped it would disagree with the statement Apple sent.
      CREATE TABLE appstore_payouts (
        account_id INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        month      TEXT NOT NULL,
        app_id     TEXT NOT NULL,
        currency   TEXT NOT NULL,
        amount     REAL NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (account_id, month, app_id, currency)
      ) WITHOUT ROWID;

      -- Per Play account: the bucket that was read and the service account
      -- that read it. Both are identifiers rather than secrets, and both are
      -- what an owner needs in front of them to fix the one failure this
      -- integration actually has — a key that exists in Cloud but has not been
      -- invited to the Play Console.
      CREATE TABLE play_state (
        account_id      INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label   TEXT NOT NULL,
        bucket          TEXT,
        service_account TEXT,
        packages        INTEGER NOT NULL,
        seen_at         TEXT NOT NULL
      );

      -- Which report OBJECT was ingested for each month, so a settled month is
      -- downloaded once and never again. Google re-uploads a month as it
      -- finalises and the revision is in the object's name, so a name that has
      -- not changed is a month that has not changed.
      CREATE TABLE play_files (
        account_id  INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        folder      TEXT NOT NULL,
        month       TEXT NOT NULL,
        object      TEXT NOT NULL,
        updated_at  TEXT,
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (account_id, folder, month)
      ) WITHOUT ROWID;

      -- The console's daily export, one row per package per day. Every column
      -- is nullable because a column this era's export does not carry is not a
      -- zero, and Google writes 0.0 into "daily average rating" for a day
      -- nobody rated — which is read as "nobody rated it", because zero stars
      -- is not the average of no ratings.
      CREATE TABLE play_stats (
        account_id       INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        package          TEXT NOT NULL,
        day              TEXT NOT NULL,
        installs         INTEGER,
        uninstalls       INTEGER,
        active_devices   INTEGER,
        install_events   INTEGER,
        uninstall_events INTEGER,
        rating_daily     REAL,
        rating_total     REAL,
        seen_at          TEXT NOT NULL,
        PRIMARY KEY (account_id, package, day)
      ) WITHOUT ROWID;

      -- THE PAYOUT, from earnings/. Merchant currency, and net is what
      -- lands: charges, minus refunds, minus Google's fee. The three parts are
      -- kept beside the total because "what did Google take" is a question the
      -- netted figure can no longer answer.
      CREATE TABLE play_earnings (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        month        TEXT NOT NULL,
        package      TEXT NOT NULL,
        currency     TEXT NOT NULL,
        charged      REAL NOT NULL,
        refunds      REAL NOT NULL,
        fees         REAL NOT NULL,
        net          REAL NOT NULL,
        transactions INTEGER NOT NULL,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, month, package, currency)
      ) WITHOUT ROWID;

      -- THE ESTIMATE, from sales/. What buyers were charged, in the BUYER's
      -- currency, tax included and before Google's cut — nine currencies in
      -- this account's August against one in the payout above. It exists for
      -- the month still running, which has no earnings ZIP at all, and it is
      -- never added to the table above or converted into it.
      CREATE TABLE play_sales (
        account_id INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        month      TEXT NOT NULL,
        package    TEXT NOT NULL,
        currency   TEXT NOT NULL,
        charged    REAL NOT NULL,
        taxes      REAL NOT NULL,
        orders     INTEGER NOT NULL,
        refunds    INTEGER NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (account_id, month, package, currency)
      ) WITHOUT ROWID;
    `,
  },
  {
    name: "011_search",
    sql: `
      -- THE TWO SEARCH ENGINES, AND WHY THEY SHARE A MIGRATION AND NOTHING
      -- ELSE.
      --
      -- Search Console answers "what did Google show, and what did people
      -- click" for a property that is already ranking. Bing Webmaster answers
      -- three unrelated questions — how Bing crawls and indexes a site, who
      -- links to it, and how many people search a NAMED PHRASE whether or not
      -- there is a page for it. There is no column below into which one
      -- engine's impressions could be added to the other's: they count
      -- different searches on different networks with different anonymisation
      -- rules, and a "total impressions" spanning both would be a number about
      -- nothing. Two sets of tables, two routes, no join.
      --
      -- GOOGLE'S TWO TRAPS ARE BUILT INTO THE SHAPE OF THESE TABLES.
      --
      -- 1. THE RECENT DAYS ARE NOT FINISHED. Search Console finalises a day
      --    over roughly two to three days, so today's row is a fraction of
      --    what today will eventually have been — drawn on a line, a cliff
      --    that nothing caused. Every window the collector asks for therefore
      --    ends three days back and is asked with dataState "final", and
      --    gsc_sites records the window that was actually covered, so a reader
      --    sees where the data stops rather than inferring it from a fall.
      --
      -- 2. THE QUERY ROWS DO NOT SUM TO THE PROPERTY TOTAL, EVER. Google
      --    withholds queries too rare to be anonymous and caps the rows it
      --    will return at all. Measured on this account on 2026-09-04, the two
      --    hundred query rows of example-app-1.example.test carried 2% of that property's
      --    impressions and freellmapi.co's carried 77% — so a headline built
      --    by summing gsc_queries would be wrong by somewhere between a
      --    quarter and fifty times, depending on which property you asked.
      --    The property's own total is therefore measured SEPARATELY
      --    (gsc_sites.total_*, a dimensionless query Google answers with the
      --    real figure) and the two are never mixed. gsc_queries is a RANKING
      --    and never a total.
      --
      -- The daily rows are the exception that makes the totals cheap: measured
      -- against Google's own dimensionless answer, the ["date"] rows summed
      -- over the same window agreed EXACTLY (23,157 against 23,157 on
      -- example-app-3.example.test), because a date is not a thing that can be
      -- anonymised. So every window figure downstream is summed from gsc_days
      -- on the read, and no window total is stored anywhere to go stale.

      -- One row per property, replaced each run by the account that saw it.
      -- Current state, the way hetzner_servers is: a property removed from the
      -- service account's access leaves this table and stops being counted,
      -- while gsc_days keeps the history it earned.
      --
      -- total_* is Google's own answer for the window named by window_start
      -- and window_end, kept so the route can say what fraction of it the
      -- ranked rows actually cover. total_position is NULL rather than 0 when
      -- there were no impressions: Google reports 0.0 for a property nobody
      -- saw, and an average position of zero is not a rank, it is the absence
      -- of one.
      CREATE TABLE gsc_sites (
        property          TEXT PRIMARY KEY,
        account_id        INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label     TEXT NOT NULL,
        permission        TEXT,
        window_start      TEXT,
        window_end        TEXT,
        total_clicks      INTEGER,
        total_impressions INTEGER,
        total_position    REAL,
        -- The ranked rows' own sums, written beside the total they are a
        -- fraction OF. Stored rather than recomputed on the read because the
        -- coverage is a statement about the rows Google returned at the moment
        -- it returned them, under a cap that moves with the property.
        query_rows        INTEGER,
        query_impressions INTEGER,
        query_clicks      INTEGER,
        -- 'reported' | 'none' | 'failed'. THREE STATES AND NOT TWO: a property
        -- that has submitted no sitemap and a property whose sitemaps call was
        -- refused both have no rows, and only one of them is a thing to fix.
        -- The counts are NULL in every state but 'reported'.
        sitemap_state      TEXT,
        sitemap_count      INTEGER,
        sitemap_submitted  INTEGER,
        sitemap_errors     INTEGER,
        sitemap_warnings   INTEGER,
        sitemap_pending    INTEGER,
        sitemap_downloaded TEXT,
        -- This property's own last failure, so one property answering 403
        -- costs its own row and nothing else — the rule github_repos'
        -- traffic_note follows, for the same reason.
        error             TEXT,
        seen_at           TEXT NOT NULL
      );

      -- One row per property per day, keyed and REPLACED. The window overlaps
      -- every run by design: Google revises a day for two to three days after
      -- it, so a row read again is a CORRECTION and must overwrite rather than
      -- accumulate. This is the table every total on the board is summed from.
      --
      -- position is stored per day and impression-weighted when it is read.
      -- Averaging daily positions unweighted would let a day with four
      -- impressions move a property's rank as far as a day with four thousand.
      CREATE TABLE gsc_days (
        property    TEXT NOT NULL,
        day         TEXT NOT NULL,
        clicks      INTEGER NOT NULL,
        impressions INTEGER NOT NULL,
        position    REAL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (property, day)
      ) WITHOUT ROWID;

      CREATE INDEX gsc_days_day ON gsc_days(day);

      -- The ranked breakdowns, replaced per property each run. A SNAPSHOT of a
      -- moving window and never a history: the window they describe is on
      -- gsc_sites, and yesterday's top-query list is not a measurement anybody
      -- asked for.
      --
      -- Google sorts these by CLICKS and offers no other order, so a query with
      -- ten thousand impressions and no clicks can fall off the end of the list
      -- entirely. Anything downstream that ranks these by impressions is
      -- ranking within what the clicks-ordered cap returned, and says so.
      CREATE TABLE gsc_queries (
        property    TEXT NOT NULL,
        query       TEXT NOT NULL,
        clicks      INTEGER NOT NULL,
        impressions INTEGER NOT NULL,
        ctr         REAL,
        position    REAL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (property, query)
      ) WITHOUT ROWID;

      CREATE TABLE gsc_pages (
        property    TEXT NOT NULL,
        page        TEXT NOT NULL,
        clicks      INTEGER NOT NULL,
        impressions INTEGER NOT NULL,
        ctr         REAL,
        position    REAL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (property, page)
      ) WITHOUT ROWID;

      -- BING. One row per verified site, replaced each run.
      --
      -- in_links is Bing's own inbound-link count out of its CRAWL statistics,
      -- and it is NOT the same measurement as the endpoint that names linking
      -- pages. Probed on 2026-09-04, GetLinkCounts answered HTTP 200 with
      -- TotalPages 0 and an empty list for all three verified sites here, while
      -- the crawl statistics for one of them reported 219 inbound links the
      -- same day. So linked_pages is what the endpoint that can name a link
      -- said, in_links is what the crawler counted, and they are different
      -- columns because they are different claims.
      CREATE TABLE bing_sites (
        site             TEXT PRIMARY KEY,
        account_id       INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label    TEXT NOT NULL,
        verified         INTEGER,
        -- The newest crawl-statistics row, which is a state rather than a
        -- series. The series itself is bing_crawl_days.
        in_index         INTEGER,
        in_links         INTEGER,
        crawled_pages    INTEGER,
        crawl_errors     INTEGER,
        blocked_robots   INTEGER,
        crawl_day        TEXT,
        -- What GetLinkCounts named. NULL is "the call failed"; 0 is "Bing
        -- answered and knows of no page of ours with a link into it", which is
        -- what it actually says for every site on this account.
        linked_pages     INTEGER,
        link_pages_total INTEGER,
        error            TEXT,
        seen_at          TEXT NOT NULL
      );

      -- What Bing showed and what was clicked, per site per day. Its own table
      -- rather than a column beside the crawl figures: an impression is
      -- something a person did and a crawled page is something a robot did, and
      -- one table holding both invites a chart that puts them on one axis.
      CREATE TABLE bing_traffic_days (
        site        TEXT NOT NULL,
        day         TEXT NOT NULL,
        impressions INTEGER,
        clicks      INTEGER,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (site, day)
      ) WITHOUT ROWID;

      CREATE TABLE bing_crawl_days (
        site           TEXT NOT NULL,
        day            TEXT NOT NULL,
        crawled_pages  INTEGER,
        in_index       INTEGER,
        in_links       INTEGER,
        crawl_errors   INTEGER,
        blocked_robots INTEGER,
        code_2xx       INTEGER,
        code_4xx       INTEGER,
        code_5xx       INTEGER,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (site, day)
      ) WITHOUT ROWID;

      -- Bing's own query report: per site, per query, per DAY. Kept at the
      -- grain Bing reports it at rather than pre-summed, so the route can
      -- answer "over the last fortnight" and "on Tuesday" from the same rows —
      -- and so re-reading a day corrects it instead of doubling it.
      --
      -- This is the same KIND of thing as gsc_queries — search terms a site
      -- already ranks for — measured on a different engine, and it is filed
      -- apart from the keyword tables below for exactly that reason.
      CREATE TABLE bing_queries (
        site        TEXT NOT NULL,
        query       TEXT NOT NULL,
        day         TEXT NOT NULL,
        impressions INTEGER,
        clicks      INTEGER,
        position    REAL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (site, query, day)
      ) WITHOUT ROWID;

      -- KEYWORD VOLUME, WHICH ANSWERS A DIFFERENT QUESTION FROM EVERY OTHER
      -- TABLE IN THIS MIGRATION.
      --
      -- gsc_queries and bing_queries are rear-view mirrors: they can only ever
      -- report phrases a page of ours already ranks for. This is the one source
      -- on the box that can say how many people search a phrase we have NO page
      -- about at all — and it is not derived from the others, it is Bing's
      -- GetKeywordStats answering about a phrase somebody named.
      --
      -- The phrases are a SETTING, not a discovery. Nothing here invents them:
      -- with no list there is nothing to ask, exactly as npm has nothing to ask
      -- about without a package list.
      --
      -- The market is part of the key because it is part of the measurement.
      -- Bing counts impressions per country and language; "team chat" in
      -- us/en-US and in ie/en-GB are two different numbers, and a row that did
      -- not carry its market would eventually be read as a world total.
      CREATE TABLE bing_keyword_weeks (
        phrase      TEXT NOT NULL,
        market      TEXT NOT NULL,
        week        TEXT NOT NULL,
        impressions INTEGER,
        broad       INTEGER,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (phrase, market, week)
      ) WITHOUT ROWID;

      -- WHAT HAPPENED WHEN WE ASKED, WHICH IS THE WHOLE REASON THIS TABLE
      -- EXISTS. Bing answers a phrase nobody searches and a phrase it is
      -- declining to discuss with the identical empty body, so the two have to
      -- be told apart by something outside the answer: a CONTROL phrase with
      -- large, stable, year-round volume is asked alongside each batch, and a
      -- batch whose control came back empty is not a measurement of anything.
      --
      --   'ok'      Bing returned weeks. The volume is in the table above.
      --   'na'      Bing returned nothing and the control DID answer, so this
      --             phrase really is too rare for Bing to report. Not a zero.
      --   'void'    the control returned nothing either. Unmeasured. Recording
      --             this as a volume of 0 would put "nobody wants this" beside
      --             a phrase that was merely throttled, and roadmaps get made
      --             out of that.
      --   'failed'  the call itself failed, with Bing's own reason.
      CREATE TABLE bing_keyword_state (
        phrase   TEXT NOT NULL,
        market   TEXT NOT NULL,
        status   TEXT NOT NULL,
        weeks    INTEGER,
        error    TEXT,
        asked_at TEXT NOT NULL,
        PRIMARY KEY (phrase, market)
      ) WITHOUT ROWID;
    `,
  },
  {
    name: "012_cloudflare",
    sql: `
      -- CURRENT STATE, replaced per account. A zone the owner removes from
      -- Cloudflare leaves this table on the next collection and stops being
      -- counted, which is what you want from an inventory. Its traffic history
      -- below outlives it, which is what you want from a measurement.
      CREATE TABLE cloudflare_zones (
        zone_id          TEXT PRIMARY KEY,
        account_id       INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label    TEXT NOT NULL,
        name             TEXT NOT NULL,
        status           TEXT,
        paused           INTEGER NOT NULL,
        plan             TEXT,
        zone_type        TEXT,
        created_on       TEXT,
        -- The nameservers CLOUDFLARE assigns. The other half of the drift join
        -- is the registrar's own list, over in the domains table; nothing here
        -- stores the comparison, because the answer changes when either side
        -- moves and a stored verdict would go quietly stale between them.
        name_servers     TEXT,
        -- NULL, never 0. An unreadable record listing says nothing about how
        -- many records a zone has, and "0 records" reads as a broken zone.
        records          INTEGER,
        proxied          INTEGER,
        on_pages         INTEGER,
        -- Mail posture, derived from records that were fetched anyway. All
        -- four are NULL together when the listing failed: four falses would
        -- read as an alarm about a zone nobody could look at.
        mx               INTEGER,
        spf              INTEGER,
        dmarc            INTEGER,
        dmarc_policy     TEXT,
        -- Three-state on purpose: a zone with no mail at all cannot be said to
        -- be missing DKIM, so NULL is "nothing to conclude" rather than "no".
        dkim             INTEGER,
        records_note     TEXT,
        traffic_note     TEXT,
        cf_account_id    TEXT,
        cf_account_name  TEXT,
        seen_at          TEXT NOT NULL
      );
      CREATE INDEX cloudflare_zones_account ON cloudflare_zones(account_id);
      CREATE INDEX cloudflare_zones_name ON cloudflare_zones(name);

      -- One row per zone per UTC day, keyed and REPLACED. Today's bucket is
      -- partial while Cloudflare is still writing it, so it is stored as the
      -- measurement it is and corrected tomorrow rather than doubled; the route
      -- decides which days a window may include.
      --
      -- No foreign key to the account: this is HISTORY, and the chart of what a
      -- zone used to serve should survive the zone leaving the account, exactly
      -- as the readings table survives a decommissioned server. It ages out on
      -- the long retention like every other day-grained table here.
      CREATE TABLE cloudflare_traffic (
        zone_id     TEXT NOT NULL,
        day         TEXT NOT NULL,
        requests    INTEGER NOT NULL,
        cached      INTEGER NOT NULL,
        bytes       INTEGER NOT NULL,
        -- NULL where the field set that answered did not carry it, which is not
        -- the same as Cloudflare counting none. The fields column says which.
        threats     INTEGER,
        page_views  INTEGER,
        -- Cloudflare de-duplicates visitors WITHIN a day. Stored per zone per
        -- day because that is the only grain at which the figure is true;
        -- nothing sums it without saying that it has.
        uniques     INTEGER,
        s2xx        INTEGER,
        s3xx        INTEGER,
        s4xx        INTEGER,
        s5xx        INTEGER,
        fields      TEXT NOT NULL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (zone_id, day)
      ) WITHOUT ROWID;
      CREATE INDEX cloudflare_traffic_day ON cloudflare_traffic(day);

      -- Domains registered AT Cloudflare. Empty is the ordinary answer on this
      -- account and it is a measurement, not a gap — which is why the state
      -- table below records separately whether the list could be READ.
      CREATE TABLE cloudflare_registrar (
        account_id     INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        account_label  TEXT NOT NULL,
        expires_at     TEXT,
        auto_renew     INTEGER,
        locked         INTEGER,
        registrar      TEXT,
        status         TEXT,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (account_id, name)
      ) WITHOUT ROWID;

      -- What each account's last collection could and could not read. Three
      -- states have to survive to the wire — read it and it was empty, read it
      -- and it had rows, could not read it at all — and only the flags here
      -- keep the first two apart from the third.
      CREATE TABLE cloudflare_state (
        account_id          INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label       TEXT NOT NULL,
        cf_account_id       TEXT,
        cf_account_name     TEXT,
        zones               INTEGER NOT NULL,
        registrar_readable  INTEGER NOT NULL,
        registrar_count     INTEGER NOT NULL,
        registrar_note      TEXT,
        analytics_zones     INTEGER NOT NULL,
        analytics_note      TEXT,
        seen_at             TEXT NOT NULL
      );
    `,
  },
  {
    name: "013_social",
    sql: `
      -- FACEBOOK PAGES. Current state, replaced per account: a Page the system
      -- user loses access to leaves this table on the next collection, the way
      -- a decommissioned server leaves hetzner_servers.
      --
      -- No history table beside it, and that is a measurement of the API rather
      -- than a shortcut. Page-level insights are unreachable with this token
      -- twice over — the metric names for reach were retired in Nov 2025 and
      -- everything still valid needs a Page Access Token this system user
      -- cannot mint — so there is no Page series to accumulate. Follower counts
      -- are recorded as readings, which is the one Page figure that moves.
      CREATE TABLE meta_pages (
        page_id           TEXT PRIMARY KEY,
        account_id        INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label     TEXT NOT NULL,
        name              TEXT,
        -- Two follower fields, because Meta has two and they are not the same
        -- thing: followers_count is people following, fan_count is people who
        -- liked. NULL in either is "not reported", never nought.
        followers         INTEGER,
        fans              INTEGER,
        followers_source  TEXT,
        link              TEXT,
        category          TEXT,
        about             TEXT,
        -- A SIGNED, EXPIRING scontent URL. Meta stamps an oe= deadline a few
        -- days out, so this is only as good as the row is fresh; nothing may
        -- cache it and whatever renders it survives a 403.
        picture           TEXT,
        -- THE THREE-STATE FIELD THIS WHOLE INSTAGRAM INTEGRATION TURNS ON.
        -- ig_checked records that the question was asked; ig_id NULL with
        -- ig_checked 1 is Meta answering "no Instagram Business account is
        -- linked to this Page", which is a measurement and not a gap. A Page
        -- with no Instagram account and a Page nobody asked about must never
        -- read the same, and these two columns are the only thing keeping them
        -- apart.
        ig_checked        INTEGER NOT NULL,
        ig_id             TEXT,
        ig_username       TEXT,
        ig_followers      INTEGER,
        seen_at           TEXT NOT NULL
      );
      CREATE INDEX meta_pages_account ON meta_pages(account_id);

      -- ONE ROW PER AD ACCOUNT, replaced per plugin account.
      --
      -- The window figures are stored rather than derived, which is the one
      -- exception this codebase makes to "compute totals on the read" — and it
      -- is forced by the data. Spend, impressions and clicks could be summed
      -- from meta_ad_days; REACH AND FREQUENCY COULD NOT. Meta de-duplicates
      -- reach over the row's own window, so a 30-day reach is not the sum of
      -- thirty daily reaches and cannot be recovered from them at any grain.
      -- Storing Meta's own answer is the only way to have it, so it is stored
      -- WITH THE DATES IT COVERS: window_from and window_to are what stop a
      -- card captioning a stale figure as "the last 30 days".
      CREATE TABLE meta_ad_accounts (
        ad_account_id   TEXT PRIMARY KEY,
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label   TEXT NOT NULL,
        name            TEXT,
        -- The account's OWN currency. Every money column in this migration is
        -- in it, and nothing anywhere adds two accounts' figures together
        -- without a dated FX rate this box does not fetch.
        currency        TEXT,
        -- Meta's account_status. 1 is active; anything else is listed and not
        -- queried, so its window columns are NULL rather than zero.
        status          INTEGER,
        active          INTEGER NOT NULL,
        timezone        TEXT,
        created_at      TEXT,
        lifetime_spend  REAL,
        window_from     TEXT,
        window_to       TEXT,
        spend           REAL,
        impressions     INTEGER,
        clicks          INTEGER,
        cpc             REAL,
        ctr             REAL,
        -- De-duplicated over the window above and nowhere else. Never summed
        -- with a campaign's reach, never averaged with another account's.
        reach           INTEGER,
        frequency       REAL,
        leads           INTEGER,
        cost_per_lead   REAL,
        -- Asked for on every call and NULL on this account, because ROAS is
        -- revenue over spend and this account buys lead forms — there is no
        -- purchase event and no revenue figure for Meta to divide by. Null is
        -- "asked and not told"; it is not 0x and never renders as one.
        roas            REAL,
        note            TEXT,
        seen_at         TEXT NOT NULL
      );
      CREATE INDEX meta_ad_accounts_account ON meta_ad_accounts(account_id);

      -- Campaigns, replaced per AD ACCOUNT rather than per plugin account, so
      -- one ad account's campaign edge refusing cannot take another's rows.
      --
      -- status is effective_status, never the configured status: an ad left
      -- ACTIVE inside a paused campaign is not running, and only
      -- effective_status folds the parents and Meta's own vetoes in.
      CREATE TABLE meta_campaigns (
        campaign_id     TEXT PRIMARY KEY,
        ad_account_id   TEXT NOT NULL,
        name            TEXT,
        status          TEXT,
        objective       TEXT,
        window_from     TEXT,
        window_to       TEXT,
        spend           REAL,
        impressions     INTEGER,
        clicks          INTEGER,
        ctr             REAL,
        reach           INTEGER,
        frequency       REAL,
        leads           INTEGER,
        cost_per_lead   REAL,
        seen_at         TEXT NOT NULL
      );
      CREATE INDEX meta_campaigns_account ON meta_campaigns(ad_account_id);

      -- One row per ad account per day, keyed and REPLACED. Meta revises recent
      -- days, so a re-read has to correct a row rather than sit beside it as a
      -- duplicate the totals would count twice.
      --
      -- A DAY THAT DELIVERED NOTHING HAS NO ROW HERE, because Meta reports none
      -- and inventing one would turn "the account stopped spending on the 16th"
      -- into a measured zero. The route draws the days that exist and says how
      -- many of the window they were.
      --
      -- No foreign key to the plugin account: this is HISTORY and should
      -- survive the credential being replaced, exactly as readings do. It ages
      -- out on the long retention with the other day-grained tables.
      CREATE TABLE meta_ad_days (
        ad_account_id  TEXT NOT NULL,
        day            TEXT NOT NULL,
        spend          REAL,
        impressions    INTEGER,
        clicks         INTEGER,
        leads          INTEGER,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (ad_account_id, day)
      ) WITHOUT ROWID;
      CREATE INDEX meta_ad_days_day ON meta_ad_days(day);

      -- What each account's last collection could and could not read.
      --
      -- ig_linked BESIDE pages_checked, not instead of it. "0 Instagram
      -- accounts" is only a finding if you know how many Pages were asked, and
      -- "0 of 0" (no Pages readable) and "0 of 3" (three Pages, none linked)
      -- are completely different sentences — only the second is the state this
      -- integration reports as "connected, and there is nothing to read".
      --
      -- proofed says whether the calls carried appsecret_proof. False is not a
      -- failure: it means no app pair is stored, and the token reads everything
      -- without one.
      CREATE TABLE meta_state (
        account_id     INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label  TEXT NOT NULL,
        graph_user     TEXT,
        graph_user_id  TEXT,
        proofed        INTEGER NOT NULL,
        pages          INTEGER NOT NULL,
        pages_checked  INTEGER NOT NULL,
        ig_linked      INTEGER NOT NULL,
        ad_accounts    INTEGER NOT NULL,
        note           TEXT,
        seen_at        TEXT NOT NULL
      );
    `,
  },
  {
    name: "014_demand",
    sql: `
      -- DEMAND SIGNALS: REDDIT, HACKER NEWS, AND THE SEARCH NODE BEHIND BOTH.
      --
      -- Every other table in this file measures something the owner OWNS — a
      -- fleet, a portfolio, a book of subscriptions, an ad account, a set of
      -- verified sites. These three measure what STRANGERS said in public
      -- about a phrase somebody named, which is the one input to a roadmap
      -- that cannot be derived from a dashboard.
      --
      -- The phrases are a SETTING, not a discovery, for npm's reason and
      -- bing's: nothing on this box knows which phrases matter, and the two
      -- obvious ways to invent them are both wrong. Seeding from Search
      -- Console's own queries asks "who is talking about what we already rank
      -- for", which is the question these sources exist not to answer, and a
      -- generated matrix of product names would put a watch list on the
      -- owner's dashboard that the owner never wrote. So plugin_config holds
      -- one list, it reads back, and with none of it there is nothing to ask.

      -- One row per thread per phrase that found it.
      --
      -- THE KEY IS (source, id, term) AND THAT IS THREE COLUMNS ON PURPOSE.
      -- The id is the SOURCE'S own — t3_…  for a Reddit thread, Algolia's
      -- objectID for a Hacker News item — so the same thread found by the Atom
      -- feed and again by SearXNG is one row that changes tier, rather than
      -- two rows that would count twice in every total on the board. The term
      -- is in the key because "which of my phrases turned this up" is a
      -- question worth answering, and a thread that answers two of them is
      -- evidence about both; anything counting THREADS counts DISTINCT ids and
      -- says so.
      --
      -- created_at, points and comments are all NULLABLE and the nulls are the
      -- point. A row learned through SearXNG has no date and no score because a
      -- web index knows neither — not because the thread is new or unloved —
      -- and a comment on Hacker News has no score because Algolia's index does
      -- not carry one. Written as zeroes, every one of those would be a
      -- measurement nobody made.
      CREATE TABLE demand_items (
        source        TEXT NOT NULL,           -- 'reddit' | 'hn'
        id            TEXT NOT NULL,
        term          TEXT NOT NULL,
        title         TEXT NOT NULL,
        url           TEXT NOT NULL,
        -- 'r/selfhosted' for Reddit; 'story' or 'comment' for Hacker News.
        context       TEXT,
        created_at    TEXT,
        points        INTEGER,
        comments      INTEGER,
        -- HOW THIS ROW WAS LEARNED: 'feed', 'feed+token', 'searxng',
        -- 'algolia'. On the wire and on the card, because "12 posts from the
        -- Atom feed" and "12 posts from SearXNG, unscored and unaged" are
        -- different claims about the same twelve links.
        tier          TEXT NOT NULL,
        -- The first run that ever saw this URL. OURS, not the source's, and
        -- that is what makes it honest: "new since Tuesday" is a fact about
        -- what this box had already noticed, and it is the only freshness
        -- figure the SearXNG tier can contribute at all.
        first_seen_at TEXT NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (source, id, term)
      ) WITHOUT ROWID;

      CREATE INDEX demand_items_created ON demand_items(created_at);

      -- WHAT HAPPENED WHEN WE ASKED, which is the whole reason this table
      -- exists — the same job bing_keyword_state does for keyword volume, for
      -- the same reason. A source that was throttled and a phrase nobody has
      -- posted about both produce no rows in the table above, and only one of
      -- them is a finding.
      --
      --   'ok'        the source answered. "items" may be 0, and that is a
      --               measurement: nobody is talking about this.
      --   'throttled' the source refused on rate grounds. Unmeasured.
      --   'failed'    the call failed, with the source's own reason.
      --   'skipped'   this run deliberately did not ask. Reddit's anonymous
      --               feed allows one query a minute and a collection is not
      --               allowed to take an hour, so the list is walked stalest
      --               first and the tail is asked next time. Not a failure,
      --               and emphatically not a zero.
      --
      -- asked_at is what makes that walk possible: the collector orders the
      -- list by it, so no phrase can starve while another is asked twice.
      CREATE TABLE demand_queries (
        source   TEXT NOT NULL,
        term     TEXT NOT NULL,
        status   TEXT NOT NULL,
        tier     TEXT,
        items    INTEGER,
        error    TEXT,
        asked_at TEXT NOT NULL,
        PRIMARY KEY (source, term)
      ) WITHOUT ROWID;

      -- THE SEARCH NODE, WHICH CANNOT COUNT ITS OWN QUERIES.
      --
      -- The catalog promised "Agent searches · 24h" for this source and no
      -- such number exists: probed on 2026-09-04, /stats is HTML only (the
      -- format parameter is ignored), it counts ENGINES rather than queries,
      -- and a search response carries no total either. What the node CAN say
      -- is whether a search made right now came back with anything and how
      -- long it took, so that is what this row holds — one per account,
      -- replaced each probe.
      CREATE TABLE searxng_state (
        account_id    INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        -- The endpoint that was actually called. Stored beside the result
        -- because it is a SETTING and not a constant — the node is on the
        -- owner's own box and its hostname carries that box's IP.
        url           TEXT NOT NULL,
        ok            INTEGER NOT NULL,
        -- The phrase the probe spent itself on: a real watch term where there
        -- is one, so the request the node serves is a request somebody wanted.
        query         TEXT,
        results       INTEGER,
        -- OF THOSE RESULTS, HOW MANY WERE ON THE SITE THE QUERY ASKED FOR.
        -- The probe is a site:reddit.com search, because that is the one thing
        -- this box actually depends on the node for — it is Reddit's fallback
        -- tier. Measured 2026-09-04 on this instance: ten results, NONE of them
        -- on reddit.com, because the one engine still answering returned links
        -- about free games. A node that answers ten links to a query it
        -- ignored is the failure a results COUNT cannot see, and the fallback
        -- silently produces nothing when it happens.
        on_site       INTEGER,
        ms            INTEGER,
        engines_ok    INTEGER,
        engines_bad   INTEGER,
        error         TEXT,
        seen_at       TEXT NOT NULL
      );

      -- Per engine, from the last probe. THIS IS THE MEASUREMENT THAT MATTERS
      -- HERE: on the probe that built this table, brave answered "too many
      -- requests", duckduckgo answered with a CAPTCHA and qwant answered
      -- "access denied", so all ten results came from Bing alone. A metasearch
      -- node down to one engine still returns ten links and still looks
      -- healthy, which is exactly the failure nothing else on this box can
      -- see. "refused" is the node's OWN words, kept verbatim — "CAPTCHA" and
      -- "too many requests" are two different problems with two different
      -- fixes.
      CREATE TABLE searxng_engines (
        account_id INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        engine     TEXT NOT NULL,
        results    INTEGER NOT NULL,
        refused    TEXT,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (account_id, engine)
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "017_telegram",
    sql: `
      -- THE TELEGRAM BRIDGE: ONE BOT PER ACCOUNT, ONE CHAT PER BOT.
      --
      -- Everything else in this file records what a service SAID when it was
      -- asked. This records a conversation, which is a different kind of thing
      -- and gets a different rule: the counters and the cursor live here so
      -- they survive a restart, the message TEXT lives here because a chat with
      -- no memory of the last exchange is not a chat — and neither the text nor
      -- anything that could name a person is on any route or in any log.
      --
      -- WHY A CURSOR IS STORED AT ALL. getUpdates is acknowledged by asking for
      -- the next offset: an update Telegram has not seen us get past is
      -- redelivered. Held only in memory, a restart mid-answer would re-answer
      -- the message that caused it — and a bot that replies twice to one
      -- question looks broken in exactly the way an owner cannot debug from a
      -- phone. It is written after the update is handled, so a crash BEFORE the
      -- reply still redelivers, which is the safe half of the trade.
      CREATE TABLE telegram_state (
        account_id      INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        -- Who the token turned out to be, from getMe. The bot's OWN username,
        -- which is a public handle chosen by the owner and not a person's name.
        bot_id          INTEGER,
        bot_username    TEXT,
        next_offset     INTEGER NOT NULL DEFAULT 0,
        -- Messages from the locked chat that were answered, and messages from
        -- any other chat that were dropped. Two counters because they are two
        -- findings: the second one is "somebody else found this bot".
        handled         INTEGER NOT NULL DEFAULT 0,
        ignored         INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        last_reply_at   TEXT,
        last_ignored_at TEXT,
        -- The last thing that went wrong, in the source's own words, already
        -- scrubbed of the token. Cleared by the next success rather than left
        -- to age into a permanent red mark.
        last_error      TEXT,
        last_error_at   TEXT,
        updated_at      TEXT NOT NULL
      );

      -- THE ROLLING HISTORY, PER CHAT — AND SUPERSEDED BY 018.
      --
      -- This table is dropped again by 018_telegram_history: 016_chat landed
      -- the shared transcript while this was being written, the bridge writes
      -- there now, and two stores for one conversation is precisely what that
      -- table exists to prevent. The step is left exactly as it shipped
      -- because an applied migration must never change. What follows is the
      -- reasoning as it stood, and most of it survives the move.
      --
      -- The chat id is TEXT here and in plugin_config, for one reason: it is
      -- the same identifier in both places and a value that is a string in one
      -- and a number in the other is a comparison that eventually goes wrong.
      -- Telegram's group ids are large negatives (-100…) and its own docs
      -- promise only 52 significant bits, which is a promise about the future
      -- rather than the present.
      --
      -- Keyed by CHAT and not by account, because the conversation belongs to
      -- the chat: the same chat re-paired to a second bot is the same person
      -- carrying on, and a bot re-pointed at a different chat must not carry
      -- the previous chat's words into it (which is why unlocking deletes
      -- these rows rather than orphaning them).
      CREATE TABLE telegram_messages (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        -- 'user' or 'assistant' — the two roles the chat backend's ChatTurn
        -- takes from a bridge. A system turn is composed at ask time and is
        -- not conversation, so it is never stored.
        role    TEXT NOT NULL,
        content TEXT NOT NULL,
        at      TEXT NOT NULL
      );

      CREATE INDEX telegram_messages_chat ON telegram_messages(chat_id, id);
    `,
  },

  {
    name: "015_mail",
    sql: `
      -- MAIL: WHAT ARRIVES (GMAIL) AND WHAT LEAVES (RESEND).
      --
      -- Two providers, two plugins, two collectors — and one route above them,
      -- for the reason /api/mobile is one route for two app stores. They are
      -- kept apart in here because they measure two different things and there
      -- is no figure anywhere below that spans them: a person answering mail
      -- and a service sending a password reset are not addends.
      --
      -- THE PRIVACY RULE IS A PROPERTY OF THE SCHEMA, not of the code above it.
      -- There is no column in this migration that can hold a subject, a message
      -- body, or the address or name of anybody other than the mailbox owner —
      -- gmail_correspondents holds an HMAC and nothing else, and resend_emails
      -- holds our OWN sending address and no recipient. A route cannot leak
      -- what the tables cannot store, which is a stronger guarantee than a
      -- careful SELECT.

      -- The HMAC key behind gmail_correspondents.fingerprint, generated ONCE,
      -- here, by SQLite itself.
      --
      -- A plain SHA-256 of an email address is not a hash of anything private:
      -- the input space is a word list, and anyone holding the database could
      -- recover every address in an afternoon. Salted, a fingerprint is
      -- meaningless outside this install — which is all it needs to be, because
      -- its only job is letting two collections agree that they saw the same
      -- person.
      --
      -- It lives in a table rather than in the vault because the vault is for
      -- credentials that reach a service, and this reaches nothing. Losing it
      -- costs the contact history and no access.
      CREATE TABLE mail_secret (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        salt BLOB NOT NULL
      );
      INSERT INTO mail_secret (id, salt) VALUES (1, randomblob(32));

      -- ONE ROW PER CONNECTED MAILBOX, replaced per account.
      --
      -- scopes is what GOOGLE said the grant carries, read off the refresh
      -- response rather than off the token file — the file's own list is what
      -- somebody wrote down. It is stored because it is the evidence for the
      -- sentence the mail card makes: this token can archive and trash, and the
      -- code that holds it only ever issues GETs.
      CREATE TABLE gmail_mailboxes (
        account_id     INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label  TEXT NOT NULL,
        -- The mailbox's own address, from users.getProfile. This is the ONE
        -- address in this migration, and it is the owner's.
        address        TEXT,
        messages_total INTEGER,
        threads_total  INTEGER,
        labels_total   INTEGER,
        history_id     TEXT,
        scopes         TEXT,
        note           TEXT,
        seen_at        TEXT NOT NULL
      );

      -- ONE ROW PER LABEL PER MAILBOX, replaced per account.
      --
      -- The four counters are GMAIL'S OWN, from labels.get, and they are exact:
      -- there is no listing and no estimate anywhere behind them. Asked for the
      -- unread inbox as a search, Gmail answered 201 against a true 263 on this
      -- mailbox — which is why resultSizeEstimate is not used anywhere here.
      --
      -- THE TRIAGE COLUMNS ARE NULLABLE AND THAT IS LOAD-BEARING. needing_reply
      -- NULL means the scan did not reach this label; 0 means it did and found
      -- nothing waiting. A label nobody looked at and a label with a clear
      -- queue must never read alike, and "scanned" beside it says how many
      -- threads the verdict is over — a count with no denominator is not a
      -- measurement.
      CREATE TABLE gmail_labels (
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        label_id        TEXT NOT NULL,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        messages_total  INTEGER,
        messages_unread INTEGER,
        threads_total   INTEGER,
        threads_unread  INTEGER,
        scanned         INTEGER,
        needing_reply   INTEGER,
        oldest_waiting_days INTEGER,
        -- The list or the run's budget ran out, so needing_reply is a FLOOR.
        truncated       INTEGER NOT NULL DEFAULT 0,
        note            TEXT,
        seen_at         TEXT NOT NULL,
        PRIMARY KEY (account_id, label_id)
      ) WITHOUT ROWID;

      -- ONE ROW PER MAILBOX PER DAY, keyed and REPLACED.
      --
      -- KEYED BY ADDRESS RATHER THAN BY ACCOUNT ROW, and with no foreign key,
      -- for the reason meta_ad_days has none: this is HISTORY. The chart of
      -- what a mailbox did in March should survive the credential being
      -- re-pasted under a new account row, exactly as readings survive a
      -- decommissioned server.
      --
      -- Received and sent are separate columns and are never added. They are
      -- two different acts — one costs you attention and the other costs you a
      -- reply — and a single "mail" line would hide the ratio between them,
      -- which is the only interesting thing about the pair.
      CREATE TABLE gmail_days (
        address         TEXT NOT NULL,
        day             TEXT NOT NULL,
        received        INTEGER,
        sent            INTEGER,
        -- Gmail had more ids than one page carried, so the figure is a floor.
        received_capped INTEGER NOT NULL DEFAULT 0,
        sent_capped     INTEGER NOT NULL DEFAULT 0,
        seen_at         TEXT NOT NULL,
        PRIMARY KEY (address, day)
      ) WITHOUT ROWID;
      CREATE INDEX gmail_days_day ON gmail_days(day);

      -- ONE ROW PER PERSON WRITTEN TO, AS A FINGERPRINT.
      --
      -- There is no address column and there is not going to be one. The
      -- fingerprint is an HMAC under mail_secret.salt, computed in the provider
      -- and never reversed by anything; every figure the route builds out of
      -- this table is a COUNT of rows, so nothing downstream needs an identity
      -- and nothing downstream can have one.
      --
      -- WHY IT IS SENT MAIL AND NOT RECEIVED MAIL. collect_contacts.py refuses
      -- to publish a mailing-list census — "a sender you have never replied to
      -- is not a relationship, it is a subscription" — and enforces that with a
      -- two-way test over the whole mailbox. Reading only what you WROTE gets
      -- the same filter for free and for a hundredth of the requests: nobody
      -- has ever been subscribed to a newsletter by writing to it. On this
      -- mailbox that is 141 messages over ninety days against about 1,900
      -- received.
      --
      -- first_at ACCUMULATES ACROSS RUNS and the other two are window figures.
      -- That is what makes "new contact" mean anything: a person first written
      -- to inside the window, judged against every day of sent mail this table
      -- has ever seen, rather than against the window judging itself.
      CREATE TABLE gmail_correspondents (
        mailbox     TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        first_at    TEXT NOT NULL,
        last_at     TEXT NOT NULL,
        messages    INTEGER NOT NULL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (mailbox, fingerprint)
      ) WITHOUT ROWID;
      CREATE INDEX gmail_correspondents_last ON gmail_correspondents(last_at);

      -- ONE ROW PER SENDING DOMAIN, replaced per account.
      --
      -- status is RESEND'S OWN WORD and is never reduced to a boolean:
      -- "pending" is a domain part-way through verification and "failed" is one
      -- that will not send, and a green/red pair would put those two together.
      --
      -- open_tracking and click_tracking are stored because they are the reason
      -- there is no open rate on this board. Both are FALSE on every domain
      -- here, so Resend never writes an "opened" event for them — an open rate
      -- would be a measurement of a feature nobody switched on.
      CREATE TABLE resend_domains (
        domain_id      TEXT PRIMARY KEY,
        account_id     INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label  TEXT NOT NULL,
        name           TEXT NOT NULL,
        status         TEXT,
        region         TEXT,
        created_at     TEXT,
        sending        TEXT,
        receiving      TEXT,
        open_tracking  INTEGER,
        click_tracking INTEGER,
        -- Whether the per-domain call that carries the DNS records answered.
        -- A domain with no records read is not a domain with no records, and
        -- the health figure below it is null rather than zero in that case.
        records_read   INTEGER NOT NULL,
        note           TEXT,
        seen_at        TEXT NOT NULL
      );
      CREATE INDEX resend_domains_account ON resend_domains(account_id);

      -- The DNS records behind a verification, one row each, replaced per
      -- domain. Each carries its OWN status: a domain that reads "verified"
      -- while one of its three records has gone pending is a domain about to
      -- stop sending, and the listing endpoint cannot show that.
      CREATE TABLE resend_dns (
        domain_id TEXT NOT NULL REFERENCES resend_domains(domain_id) ON DELETE CASCADE,
        record    TEXT NOT NULL,
        type      TEXT NOT NULL,
        name      TEXT NOT NULL,
        status    TEXT,
        priority  INTEGER,
        seen_at   TEXT NOT NULL,
        PRIMARY KEY (domain_id, record, type, name)
      ) WITHOUT ROWID;

      -- ONE ROW PER EMAIL RESEND SENT, keyed by Resend's own id and REPLACED.
      --
      -- REPLACED, NOT INSERTED, BECAUSE last_event MOVES. An email delivered
      -- this morning can be bounced or complained-about this afternoon, and a
      -- row written once would be wrong in the direction that flatters — a
      -- bounce rate that only ever counts the bounces it saw on the first pass
      -- is a bounce rate that goes down on its own.
      --
      -- No recipient and no subject. Both are in the API response and neither
      -- is in this table: from_address is OURS, which is what makes "which
      -- address on this domain actually sends" answerable without knowing who
      -- anything was sent to.
      --
      -- No foreign key, for the reason gmail_days has none: this is history and
      -- should outlive the key that read it.
      CREATE TABLE resend_emails (
        email_id     TEXT PRIMARY KEY,
        domain       TEXT NOT NULL,
        day          TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        from_address TEXT,
        -- Resend reports the LATEST event rather than a history, so these are
        -- mutually exclusive and every email is in exactly one bucket.
        last_event   TEXT,
        seen_at      TEXT NOT NULL
      );
      CREATE INDEX resend_emails_day ON resend_emails(domain, day);

      -- What each key's last walk actually covered. "pages" and "truncated"
      -- are why a count may be a floor, and "oldest" is how far back the
      -- figures reach — the same job stripe_state does for a window that is
      -- still filling in.
      CREATE TABLE resend_state (
        account_id    INTEGER PRIMARY KEY REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label TEXT NOT NULL,
        domains       INTEGER NOT NULL,
        emails        INTEGER NOT NULL,
        pages         INTEGER NOT NULL,
        oldest        TEXT,
        truncated     INTEGER NOT NULL,
        note          TEXT,
        seen_at       TEXT NOT NULL
      );
    `,
  },

  {
    name: "016_chat",
    sql: `
      -- THE TRANSCRIPT. One table, and it is the only place a conversation
      -- lives.
      --
      -- WHY THE SERVER HOLDS IT AND NOT THE BROWSER. The Chat page could
      -- perfectly well keep its own messages in localStorage beside the
      -- sessions it already keeps there, and for a page on its own that would
      -- be the smaller design. It stops working the moment there is a SECOND
      -- door onto the same agent — and there is one being built: a Telegram
      -- bridge, which has no localStorage, no React store, and no way to
      -- reconstruct what was said on the page an hour ago. Two doors with two
      -- transcripts is one agent with amnesia on whichever door you did not
      -- come in through.
      --
      -- So the session id is the join, the channel says which door the message
      -- came in by, and both doors read and write the same rows. A session id
      -- from the dashboard is the store's own ("s-1"); Telegram's will be its
      -- chat id. They cannot collide in practice and nothing here needs them
      -- not to: this table has no opinion about where an id came from, which
      -- is what lets the bridge land without a migration of its own.
      --
      -- IT IS NOT A FOREIGN KEY ONTO ANYTHING. There is no sessions table on
      -- this side and there should not be — sessions are the CLIENT's idea,
      -- created and renamed and deleted in the browser, and a foreign key here
      -- would mean the server had to be told about a chat before the chat
      -- could have a message in it. A row whose session no longer exists on
      -- the page is harmless; it is read by nobody and pruned by nothing,
      -- because a transcript is the one thing on this dashboard that is not a
      -- measurement and does not age out.
      CREATE TABLE chat_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        -- ISO, written here rather than taken from the client: a timestamp
        -- from a browser is a timestamp from whatever that browser's clock
        -- says, and the ordering of a conversation is not something to hand to
        -- an unsynced laptop.
        ts         TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content    TEXT NOT NULL,
        -- WHICH AGENT WROTE IT, on the assistant rows. Null on a user's own
        -- message, because the owner is not a backend — null here means "not
        -- applicable", which is the one reading of null this codebase allows
        -- beside "asked and not told".
        --
        -- Stored per MESSAGE rather than per session on purpose. The whole
        -- point of the selector is that the live backend can change, and it
        -- can change mid-conversation; a transcript that recorded only the
        -- current choice would retroactively attribute Hermes's answers to
        -- OpenClaw the moment somebody switched, which is precisely the "the
        -- owner is entitled to know which one answered" rule in
        -- chat/backend.ts, broken by a schema.
        backend    TEXT,
        -- 'web' or 'telegram'. Not a CHECK constraint: a third door would
        -- otherwise need a migration to say hello, and the value is written by
        -- this codebase alone.
        channel    TEXT NOT NULL,
        -- What the agent reported using, and what the turn cost, when it said.
        -- Null is "not reported" everywhere here — a backend that counts no
        -- tokens has not told us the turn was free.
        model      TEXT,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        -- Round trip in milliseconds, measured on this side. Only on
        -- assistant rows, and it is the honest number: it includes the
        -- gateway's own thinking, which is what the person waiting actually
        -- experienced.
        ms         INTEGER
      );

      -- Every read this table serves is "one session, in order". The id is
      -- the tiebreak rather than the timestamp because two messages written in
      -- the same millisecond are possible and a conversation with two turns in
      -- an arbitrary order is worse than useless.
      CREATE INDEX chat_messages_session ON chat_messages (session_id, id);
    `,
  },

  {
    name: "018_telegram_history",
    sql: `
      -- TWO STORES FOR ONE CONVERSATION, RESOLVED IN FAVOUR OF THE SHARED ONE.
      --
      -- 017 gave the Telegram bridge its own rolling history because, when it
      -- was written, there was nowhere else to put one. 016_chat then landed
      -- the transcript both doors were always going to need — and its header
      -- makes the argument better than this comment can: two doors onto one
      -- agent with two transcripts is one agent with amnesia on whichever door
      -- you did not come in through. It even names this bridge as the reason
      -- the table is on the server at all.
      --
      -- So the bridge writes its turns to chat_messages under the session id
      -- 'telegram:<chat id>' — the same id it hands ask() — and this drops the
      -- table it briefly had. A migration is APPENDED rather than 017 being
      -- edited, because a step that has been applied anywhere is a step that
      -- must never change; the database that ran 017 and the one that never
      -- saw it both end up here.
      --
      -- Nothing is migrated across. The only rows that could have existed were
      -- written by a bridge that had not been paired with a chat yet, on the
      -- box this was built on, and inventing a session id for them would have
      -- meant guessing which conversation they belonged to.
      DROP TABLE IF EXISTS telegram_messages;
    `,
  },

  {
    name: "019_chat_tools",
    sql: `
      -- WHAT A STREAMED TURN KNOWS THAT A FETCHED ONE DID NOT.
      --
      -- 016_chat stored the two facts a completed turn has: who said it and
      -- what they said. Streaming adds two more, and both of them are about
      -- the SHAPE of the answer rather than about the conversation:
      --
      --   tools    the agent's tool calls, in the order they happened
      --   partial  this answer was cut off half way and is not the whole thing
      --
      -- PARTIAL IS THE WHOLE REASON STREAMING WAS DECLINED UNTIL NOW, and the
      -- route header said so: "a stream that dies half way has already put
      -- half an answer on screen and there is no truthful way to store that as
      -- a message". This column is the truthful way. A dropped connection, a
      -- gateway that dies mid-sentence or a tab that closes leaves text that
      -- WAS said, and the two dishonest options are to drop it (the owner
      -- watched it appear and then watched it vanish) or to store it as a
      -- complete answer (a transcript that lies about where the agent
      -- stopped). So it is stored, and flagged, and the page draws it with the
      -- flag showing. 0 for every row written before this migration, which is
      -- correct: they came back whole or they were never written.
      --
      -- TOOLS AS A JSON COLUMN RATHER THAN A chat_tool_calls TABLE, which was
      -- the other option and is the one a schema purist would take.
      --
      -- The argument for the table is indexing: "which sessions used the
      -- terminal tool", "how often does it call search". The argument against
      -- is that nothing asks those questions and nothing here is going to —
      -- these rows are a RENDERING ARTEFACT of one message. They are read
      -- exactly when that message is read, never joined, never aggregated,
      -- never queried across sessions, and their ORDER is load-bearing (a tool
      -- line renders at the point in the text where it happened). A JSON array
      -- keeps the order for free; a table needs a sequence column to get it
      -- back, plus a foreign key onto an AUTOINCREMENT id, plus a second write
      -- inside the same turn that must not half-succeed. That is three moving
      -- parts bought to make a query nobody runs faster.
      --
      -- If the day comes that somebody wants tool usage across a month, this
      -- is a migration that reads the JSON and fills the table. Until then the
      -- honest shape is "a message, and what it did while writing itself".
      --
      -- The shape, written down here because SQLite will not check it:
      --   [{ toolCallId, tool, label, emoji, startedAt, finishedAt, offset }]
      -- One entry per CALL, not per event — the running and completed events
      -- for one toolCallId are merged into one record with two timestamps.
      -- \`offset\` is how many characters of the answer had been streamed when
      -- the call started, which is what lets a reloaded transcript put the
      -- line back where it happened instead of in a pile at the end.
      ALTER TABLE chat_messages ADD COLUMN tools TEXT;
      ALTER TABLE chat_messages ADD COLUMN partial INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: "020_board",
    sql: `
      -- THE BOARD: columns, and cards that sit in them in an order somebody
      -- chose. The first thing on this server that stores what the OWNER
      -- typed rather than what a provider reported — every other table here
      -- is a collector's transcript, and a row in one of those is replaced
      -- when the next collection disagrees with it. These rows are the record.
      -- Nothing may ever overwrite one because an API said something else.
      --
      -- THE COLUMNS ARE ROWS RATHER THAN AN ENUM. A board whose columns are a
      -- CHECK constraint cannot be renamed without a migration, and "Doing"
      -- becoming "In progress" is a Tuesday rather than a schema change. The
      -- five below are seeded because an empty board with no columns is not a
      -- board, and picking five is a better first minute than an empty screen
      -- asking somebody to invent a workflow.
      --
      -- \`key\` IS THE STABLE NAME AND \`title\` IS THE VISIBLE ONE, and they
      -- are two columns because a rename must not change what the code means.
      -- Two keys are STRUCTURAL — \`backlog\` is where a card with nowhere else
      -- to be lands, and \`done\` is the one column that means a thing is
      -- finished (moving a card in stamps \`done_at\`, moving it out clears it).
      -- Both can be renamed; neither may be deleted. There is no delete route
      -- for a column at all today, so nothing enforces that yet — the key is
      -- what a future one would refuse on, which is why it is stored rather
      -- than derived from the title or from position 0.
      CREATE TABLE board_columns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL,
        position    INTEGER NOT NULL,
        -- NULL means no limit, and it is a real third answer: a column with a
        -- limit of 0 is a column nothing may sit in, which is a different
        -- (and legitimate) instruction from "I have not set a limit here".
        wip_limit   INTEGER,
        created_at  TEXT NOT NULL
      );

      -- POSITIONS ARE SPARSE INTEGERS, IN STEPS OF 1000, AND THAT IS THE WHOLE
      -- POINT OF THIS SCHEMA.
      --
      -- The obvious design is a dense 0..n-1 index per column. It is also the
      -- one that turns every drag into a rewrite of two whole columns: pulling
      -- a card out of the middle of Backlog renumbers everything below it, and
      -- dropping it into the middle of Doing renumbers everything below THAT.
      -- Twenty cards moved one place is twenty UPDATEs to express one
      -- intention, inside a transaction, every time somebody drags anything.
      --
      -- With gaps of 1000 a move is ONE row update: the new position is the
      -- midpoint of the two neighbours it landed between, and the neighbours
      -- do not move. The board is read \`ORDER BY position\`, so the numbers
      -- themselves are private — nothing outside this table means anything by
      -- 3000 rather than 3.
      --
      -- The cost is that a gap eventually closes. Dropping repeatedly into the
      -- same slot halves the interval each time, and after ten drops into one
      -- gap there is no integer left between the neighbours. That case is
      -- handled by renumbering THAT COLUMN back to 1000, 2000, 3000 — which is
      -- the dense design's cost, paid once every ten drops into the same gap
      -- instead of on every drag. Floats were the other way to avoid the
      -- renumber and were declined: doubles run out of mantissa in the same
      -- shape, silently and later, and an ORDER BY that starts comparing
      -- 3.0000000000000004 to 3.000000000000001 is a bug nobody will find.
      --
      -- THE COLUMNS THEMSELVES ARE NUMBERED DENSELY, 0..n-1, and the
      -- difference is deliberate rather than an oversight. There are five of
      -- them, they are reordered about once, and rewriting five rows to
      -- express that is not worth a scheme; cards are dragged all day and
      -- there can be hundreds in one column. The rule is "sparse where the
      -- writes are, dense where they are not", and each table's own header
      -- says which it is so nobody has to infer it from the numbers.
      CREATE TABLE board_cards (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        column_id   INTEGER NOT NULL REFERENCES board_columns(id),
        position    INTEGER NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        -- The venture this is work FOR, or NULL for work that is not about one
        -- of them. It is a bare string with no foreign key because ventures do
        -- not live on this server at all: they are client state in
        -- lib/store.tsx, mirrored to localStorage, and the board's document
        -- carries \`ventureId\` and never a name or a colour. A card whose
        -- venture has since been deleted therefore keeps an id that resolves to
        -- nothing, and the page draws it as unfiled rather than inventing a
        -- chip — which is the honest outcome and the reason this is not
        -- REFERENCES anything.
        venture_id  TEXT,
        -- 0 low, 1 normal, 2 high, 3 urgent. An integer rather than the four
        -- words because it is an ORDER: "is this more urgent than that" is a
        -- comparison, and a TEXT column makes it a lookup table. The words
        -- live on the client, which is the only place they are read.
        urgency     INTEGER NOT NULL DEFAULT 1,
        -- A date, 'YYYY-MM-DD', not a timestamp. A due date is a day in the
        -- owner's own calendar; storing 23:59 in some timezone would make
        -- "overdue" a question about UTC offsets on the one screen where it
        -- should be a question about whether today is past it.
        due         TEXT,
        -- When it reached Done, set by the move and cleared by a move out.
        -- NULL on a card that has never been finished — which is different
        -- from 0 or from an empty string, and is the reason it is nullable.
        done_at     TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        -- ARCHIVED IS NOT DELETED. A finished card that is out of the way is
        -- still a record of work done; a deleted one is gone. Both are offered
        -- because they are different intentions, and every read of the board
        -- filters \`archived_at IS NULL\`.
        archived_at TEXT
      );
      CREATE INDEX board_cards_column_position
        ON board_cards(column_id, position);

      -- THE SEAM FOR CARDS NOBODY TYPED.
      --
      -- Nothing writes this column today and no route sets it. It is here
      -- because the shape of "something filed this automatically" is known and
      -- costs one nullable column to leave room for: \`origin\` is the
      -- DERIVATION'S OWN ID with a namespace on it, and the unique index is
      -- what makes filing idempotent — a sweep that runs twice, or in two
      -- tabs, leaves one card rather than two. A card somebody typed has NULL
      -- here, and SQLite treats NULLs as distinct in a unique index, so a
      -- hundred hand-written cards do not collide with each other.
      --
      -- That is the whole seam. There is no filer, no ranking and no collector
      -- pointed at this table, because the cards on this board are the owner's
      -- and a board that fills itself is a different product decision than the
      -- one being made here.
      ALTER TABLE board_cards ADD COLUMN origin TEXT;
      CREATE UNIQUE INDEX board_cards_origin ON board_cards(origin);

      INSERT INTO board_columns (key, title, position, wip_limit, created_at)
      VALUES
        ('backlog', 'Backlog', 0, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        ('next',    'Next',    1, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        ('doing',   'Doing',   2, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        ('blocked', 'Blocked', 3, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        ('done',    'Done',    4, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
    `,
  },
  {
    name: "021_ventures",
    sql: `
      -- THE VENTURES: the businesses this dashboard is about.
      --
      -- They were client state until now — a list in lib/store.tsx, mirrored to
      -- localStorage — and 020_board's own header says so at length, in the
      -- paragraph that argues \`board_cards.venture_id\` cannot be a foreign key
      -- because "ventures do not live on this server at all". That sentence is
      -- no longer true and this table is why. What moved it was the AGENT: the
      -- one field that changes what good advice looks like is the STAGE, and a
      -- stage the agent cannot read is a stage that changes nothing. An idea
      -- wants demand validated; a launched business wants churn watched; the
      -- same question deserves two different answers and only the owner knows
      -- which. Keeping that in a browser meant every conversation started by
      -- being told, or by being guessed at.
      --
      -- THE FOUR SEEDED IDS ARE THE ONES THE BROWSER ALREADY USED, and they are
      -- spelled out rather than generated for exactly that reason. Board cards
      -- carry \`venture_id\` and chat sessions carry a venture id, both written
      -- before this table existed; a fresh set of ids here would have orphaned
      -- every one of them silently — the card would still draw, just unfiled,
      -- which is the failure that looks like nothing went wrong.
      --
      -- \`venture_id\` ON board_cards IS STILL NOT A FOREIGN KEY, deliberately,
      -- and routes/board.ts's header now carries the argument: a card outlives
      -- the venture it was about. ON DELETE CASCADE would take work with it and
      -- ON DELETE SET NULL would silently unfile it; leaving the id opaque
      -- keeps the third answer, which is that the card is still there and
      -- resolves to nothing.
      CREATE TABLE ventures (
        id          TEXT PRIMARY KEY,
        -- The URL segment, unique, decided ONCE from the name at creation and
        -- never touched by a rename. Two columns rather than one for the same
        -- reason board_columns has \`key\` beside \`title\`: renaming a thing
        -- must not change what it is addressed by, or every link anybody kept
        -- to /ventures/example-support breaks the day it becomes "Example Support Ltd".
        slug        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        -- "What it is", in the owner's own words. Empty string rather than
        -- NULL: this one is always ASKED, so a blank is an answer given.
        description TEXT NOT NULL DEFAULT '',
        -- The absolute normalised URL, or NULL for a venture with no site yet
        -- — which is the normal state of an idea and not a gap in the record.
        website     TEXT,
        -- The hostname without a leading "www.", stored rather than derived
        -- because it is what everything JOINS on by eye: a Cloudflare zone, a
        -- Search Console property, a sending domain. Derived at write time so
        -- there is one parse of the URL rather than one per reader.
        host        TEXT,
        -- WHAT THE OWNER SAYS THIS IS TODAY, and the one column the agent
        -- changes its advice on. A CHECK rather than a lookup table because
        -- these three are a closed set that means something to the code: the
        -- prose that explains each is on the wire, in routes/ventures.ts, so
        -- the page and the agent read the same sentences.
        stage       TEXT NOT NULL CHECK(stage IN ('idea','pre-launch','launched')),
        color       TEXT NOT NULL,
        -- WHERE THE COLOUR CAME FROM, kept because it decides who may change
        -- it. 'owner' is a colour somebody chose and no measurement may
        -- overwrite; 'site' was read off the live site and is replaced by the
        -- next reading; 'default' is one of the seven and is replaced by the
        -- first successful reading. Without this column a re-read would either
        -- always clobber the owner's choice or never update anything.
        color_source TEXT NOT NULL,
        -- The owner's order on the Ventures page. Dense 0..n-1 rather than the
        -- board's sparse scheme, and for the reason 020_board names: there are
        -- four of these and they are reordered about once, so rewriting the
        -- lot is cheaper than a scheme nobody can see the benefit of.
        position    INTEGER NOT NULL,
        -- WHAT WAS MEASURED FROM THE SITE, as JSON, and it is one column
        -- rather than fifteen on purpose. Every field in it is EVIDENCE — a
        -- favicon, a palette, a title, and the notes saying what could not be
        -- read and why — none of it is queried, all of it is read together
        -- with the row, and its shape is owned by ventures/enrich.ts, which is
        -- free to learn a new field without a migration. The columns above are
        -- the ones the owner typed and the ones anything filters on; this is
        -- the reading beside them. '{}' means never read, which the wire
        -- reports as \`enrichedAt: null\`.
        brand       TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      INSERT INTO ventures
        (id, slug, name, description, website, host, stage, color, color_source,
         position, brand, created_at, updated_at)
      VALUES
        ('v-example-support', 'example-support', 'Example Support',
         'Support chatbot sold as a drop-in widget. Engine, site and pricing.',
         'https://support.example.test', 'support.example.test', 'launched', '#c1663f',
         'owner', 0, '{}',
         strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        ('v-example-video', 'example-video', 'Example Video',
         'Long video in, short-form reels out. Mobile app, API and the marketing site.',
         'https://video.example.test', 'video.example.test', 'launched', '#635bff',
         'owner', 1, '{}',
         strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        ('v-example-app-1', 'example-app-1', 'Example App 1',
         'Planning-permission search for Ireland. Subscription, one market.',
         'https://example-app-1.example.test', 'example-app-1.example.test', 'launched', '#2f7d4f',
         'owner', 2, '{}',
         strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        ('v-example-content', 'example-content', 'example.ie',
         'The oldest one. Content site, ad revenue, almost no maintenance.',
         'https://example.ie', 'example.ie', 'launched', '#3b7bd8',
         'owner', 3, '{}',
         strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
    `,
  },
  /* The integration areas' own migrations — see integrations/manifest.ts. */
  ...INTEGRATION_MIGRATIONS,
];

db.exec(`CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);

const applied = new Set(
  db
    .prepare("SELECT name FROM migrations")
    .all()
    .map((r) => String((r as { name: string }).name)),
);

for (const m of MIGRATIONS) {
  if (applied.has(m.name)) continue;
  db.exec("BEGIN");
  try {
    db.exec(m.sql);
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      m.name,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
    console.log(`[db] applied ${m.name}`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ plugins */

export type PluginRow = {
  id: string;
  connected: number;
  updated_at: string;
  last_error: string | null;
};

export function upsertPlugin(id: string, connected: boolean, error?: string | null) {
  db.prepare(
    `INSERT INTO plugins (id, connected, updated_at, last_error)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       connected = excluded.connected,
       updated_at = excluded.updated_at,
       last_error = excluded.last_error`,
  ).run(id, connected ? 1 : 0, now(), error ?? null);
}

export function getPlugin(id: string): PluginRow | undefined {
  return db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as
    | PluginRow
    | undefined;
}

export function allPlugins(): PluginRow[] {
  return db.prepare("SELECT * FROM plugins").all() as unknown as PluginRow[];
}

/* ----------------------------------------------------------------- accounts */

export type AccountRow = {
  id: number;
  plugin_id: string;
  label: string;
  connected: number;
  created_at: string;
  updated_at: string;
  last_ok_at: string | null;
  last_error: string | null;
};

export function accountRows(pluginId: string): AccountRow[] {
  return db
    .prepare("SELECT * FROM plugin_accounts WHERE plugin_id = ? ORDER BY id")
    .all(pluginId) as unknown as AccountRow[];
}

export function accountRow(id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM plugin_accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
}

export function insertAccount(pluginId: string, label: string): number {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO plugin_accounts (plugin_id, label, connected, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
    .run(pluginId, label, ts, ts);
  return Number(info.lastInsertRowid);
}

export function renameAccount(id: number, label: string) {
  db.prepare("UPDATE plugin_accounts SET label = ?, updated_at = ? WHERE id = ?").run(
    label,
    now(),
    id,
  );
}

/**
 * What this account's provider said last time it was asked.
 *
 * `last_ok_at` moves only on a success, so a failing account keeps the date it
 * last worked instead of losing it to the failure that is the reason anyone is
 * looking. A success clears the error; a failure does NOT clear `connected`,
 * because a provider having a bad minute is not a credential being withdrawn.
 */
export function markAccount(id: number, ok: boolean, error?: string | null) {
  const ts = now();
  if (ok) {
    db.prepare(
      "UPDATE plugin_accounts SET last_ok_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
    ).run(ts, error ?? null, ts, id);
  } else {
    db.prepare(
      "UPDATE plugin_accounts SET last_error = ?, updated_at = ? WHERE id = ?",
    ).run(error ?? null, ts, id);
  }
}

export function setAccountConnected(id: number, connected: boolean) {
  db.prepare(
    "UPDATE plugin_accounts SET connected = ?, updated_at = ? WHERE id = ?",
  ).run(connected ? 1 : 0, now(), id);
}

/** The account and, by the foreign key's cascade, its ciphertext with it. */
export function deleteAccount(id: number) {
  db.prepare("DELETE FROM plugin_accounts WHERE id = ?").run(id);
}

/**
 * The plugin's own flag, recomputed from its accounts rather than set by hand.
 *
 * A plugin is connected when ANY of its accounts is. Two callers each writing
 * their own idea of the plugin's state is how "Connected" ends up on a page
 * whose only account was deleted an hour ago, so the flag is derived in one
 * place and derived every time an account changes.
 */
export function syncPlugin(pluginId: string, error?: string | null) {
  db.prepare(
    `UPDATE plugins
        SET connected = (SELECT COUNT(*) FROM plugin_accounts
                          WHERE plugin_id = ? AND connected = 1) > 0,
            updated_at = ?,
            last_error = ?
      WHERE id = ?`,
  ).run(pluginId, now(), error ?? null, pluginId);
}

/* --------------------------------------------------------------------- runs */

export function startRun(pluginId: string): number {
  const info = db
    .prepare("INSERT INTO runs (plugin_id, started_at) VALUES (?, ?)")
    .run(pluginId, now());
  return Number(info.lastInsertRowid);
}

export function finishRun(id: number, ok: boolean, note?: string, error?: string) {
  db.prepare(
    "UPDATE runs SET finished_at = ?, ok = ?, note = ?, error = ? WHERE id = ?",
  ).run(now(), ok ? 1 : 0, note ?? null, error ?? null, id);
}

export type RunRow = {
  id: number;
  plugin_id: string;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  error: string | null;
  note: string | null;
};

export function recentRuns(pluginId: string, limit = 10): RunRow[] {
  return db
    .prepare(
      "SELECT * FROM runs WHERE plugin_id = ? ORDER BY started_at DESC LIMIT ?",
    )
    .all(pluginId, limit) as unknown as RunRow[];
}

/* ----------------------------------------------------------------- readings */

export function record(metric: string, value: number, meta?: unknown) {
  db.prepare("INSERT INTO readings (metric, ts, value, meta) VALUES (?, ?, ?, ?)").run(
    metric,
    now(),
    value,
    meta === undefined ? null : JSON.stringify(meta),
  );
}

export type Reading = { ts: string; value: number; meta: string | null };

export function series(metric: string, days: number): Reading[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .prepare(
      "SELECT ts, value, meta FROM readings WHERE metric = ? AND ts >= ? ORDER BY ts ASC",
    )
    .all(metric, since) as unknown as Reading[];
}

/* ------------------------------------------------------------ domains */

export type DomainRecord = {
  name: string;
  source: string;
  account_id: number;
  account_label: string;
  registrar: string;
  expires_at: string | null;
  registered_on: string | null;
  auto_renew: number | null;
  locked: number | null;
  status: string | null;
  privacy: string | null;
  nameservers: string | null;
  seen_at: string;
};

/**
 * One ACCOUNT's domains, replacing that account's rows and no others.
 *
 * Scoped this narrowly because every level above it is collected
 * independently: a Spaceship read that runs while Dynadot is down must not
 * take Dynadot's names off the page, and — since a plugin now holds several
 * logins — one Dynadot account that answers 401 must not take the other
 * Dynadot account's names with it. Truncating by source would do exactly that.
 * In one transaction, because a half-replaced portfolio is worse than an old
 * one.
 *
 * The label is written down as it stood at collection time; the id is what
 * still points at the account after a rename.
 */
export function replaceDomains(
  source: string,
  accountId: number,
  accountLabel: string,
  rows: {
    name: string;
    registrar: string;
    expiresAt: string | null;
    registeredOn: string | null;
    autoRenew: boolean | null;
    locked: boolean | null;
    status: string | null;
    privacy: string | null;
    nameservers: string[] | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM domains WHERE source = ? AND account_id = ?").run(
      source,
      accountId,
    );
    const ins = db.prepare(
      `INSERT INTO domains
         (name, source, account_id, account_label, registrar, expires_at,
          registered_on, auto_renew, locked, status, privacy, nameservers, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const flag = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    for (const d of rows) {
      ins.run(
        d.name, source, accountId, accountLabel, d.registrar, d.expiresAt,
        d.registeredOn, flag(d.autoRenew), flag(d.locked), d.status, d.privacy,
        d.nameservers ? JSON.stringify(d.nameservers) : null, seen,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function allDomains(): DomainRecord[] {
  return db
    .prepare("SELECT * FROM domains ORDER BY name")
    .all() as unknown as DomainRecord[];
}

/* ---------------------------------------------------------------- stock */

export type StockQuotaRow = {
  library: string;
  account_id: number | null;
  account_label: string | null;
  ts: string;
  quota_limit: number | null;
  remaining: number | null;
  resets_at: string | null;
};

export function recordQuota(
  library: string,
  accountId: number | null,
  quota: { limit: number | null; remaining: number | null; resetsAt: string | null },
) {
  db.prepare(
    `INSERT OR REPLACE INTO stock_quota
       (library, account_id, ts, quota_limit, remaining, resets_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(library, accountId, now(), quota.limit, quota.remaining, quota.resetsAt);
}

/** Every reading in the window, newest last, with the account's own label
 *  joined on so a card can name which key is running out. */
export function stockQuota(days: number): StockQuotaRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT q.library, q.account_id, a.label AS account_label, q.ts,
              q.quota_limit, q.remaining, q.resets_at
         FROM stock_quota q
         LEFT JOIN plugin_accounts a ON a.id = q.account_id
        WHERE q.ts >= ?
        ORDER BY q.ts ASC`,
    )
    .all(since) as unknown as StockQuotaRow[];
}

/* --------------------------------------------------------------- load */

export type LoadPoint = { serverId: number; metric: string; ts: string; value: number };

/**
 * A run's worth of per-server samples, in one transaction.
 *
 * REPLACE rather than INSERT: every run re-reads the last 24 hours, so most of
 * what arrives is already here. Replacing is also how a correction lands — if
 * Hetzner revises a sample, the newer value wins rather than sitting beside
 * the old one as a duplicate the charts would average.
 */
export function writeLoad(rows: LoadPoint[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO hetzner_load (server_id, metric, ts, value) VALUES (?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(r.serverId, r.metric, r.ts, r.value);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function loadSince(hours: number): LoadPoint[] {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db
    .prepare(
      `SELECT server_id AS serverId, metric, ts, value
         FROM hetzner_load WHERE ts >= ? ORDER BY ts ASC`,
    )
    .all(since) as unknown as LoadPoint[];
}

/* ----------------------------------------------------------- plugin config */

/**
 * A plugin's non-secret settings.
 *
 * SAFE TO RETURN FROM A ROUTE, which is the whole difference between this and
 * the vault. npm's package list is a thing the owner maintains by hand and has
 * to be able to read back to check; sealing it write-only would have made it
 * impossible to correct a typo without retyping the lot.
 */
export function configValues(pluginId: string): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM plugin_config WHERE plugin_id = ? ORDER BY key")
    .all(pluginId) as unknown as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function configValue(pluginId: string, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM plugin_config WHERE plugin_id = ? AND key = ?")
    .get(pluginId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** An empty value DELETES the row rather than storing "". "Set to nothing" and
 *  "never set" are the same state for a setting, and keeping both would mean
 *  every reader had to know which empty it was looking at. */
export function setConfig(pluginId: string, key: string, value: string) {
  if (!value) {
    db.prepare("DELETE FROM plugin_config WHERE plugin_id = ? AND key = ?").run(
      pluginId,
      key,
    );
    return;
  }
  db.prepare(
    `INSERT INTO plugin_config (plugin_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(plugin_id, key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at`,
  ).run(pluginId, key, value, now());
}

/* ------------------------------------------------------------------ github */

export type GithubRepoRow = {
  full_name: string;
  account_id: number;
  account_label: string;
  owner: string;
  name: string;
  is_org: number;
  private: number;
  fork: number;
  archived: number;
  stars: number | null;
  forks: number | null;
  open_issues: number | null;
  watchers: number | null;
  language: string | null;
  homepage: string | null;
  default_branch: string | null;
  pushed_at: string | null;
  created_at: string | null;
  seen_at: string;
};

/**
 * One ACCOUNT's repos, replacing that account's rows and no others.
 *
 * Scoped this narrowly for the reason replaceDomains is: every account is
 * collected independently, and a token that answers 401 must lose its own
 * login's repos rather than emptying the page. In one transaction, because
 * half a portfolio is worse than an old one.
 */
export function replaceGithubRepos(
  accountId: number,
  accountLabel: string,
  rows: {
    fullName: string;
    owner: string;
    name: string;
    org: boolean;
    private: boolean;
    fork: boolean;
    archived: boolean;
    stars: number;
    forks: number;
    openIssues: number;
    watchers: number;
    language: string | null;
    homepage: string | null;
    defaultBranch: string | null;
    pushedAt: string | null;
    createdAt: string | null;
  }[],
) {
  const seen = now();
  const flag = (v: boolean) => (v ? 1 : 0);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM github_repos WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO github_repos
         (full_name, account_id, account_label, owner, name, is_org, private,
          fork, archived, stars, forks, open_issues, watchers, language,
          homepage, default_branch, pushed_at, created_at, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows) {
      ins.run(
        r.fullName, accountId, accountLabel, r.owner, r.name, flag(r.org),
        flag(r.private), flag(r.fork), flag(r.archived), r.stars, r.forks,
        r.openIssues, r.watchers, r.language, r.homepage, r.defaultBranch,
        r.pushedAt, r.createdAt, seen,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function allGithubRepos(): GithubRepoRow[] {
  return db
    .prepare("SELECT * FROM github_repos ORDER BY stars DESC, full_name")
    .all() as unknown as GithubRepoRow[];
}

export type TrafficPoint = {
  fullName: string;
  metric: string;
  day: string;
  value: number;
};

/** REPLACE, not INSERT: every run re-reads the same fourteen days, so most of
 *  what arrives is already here, and a day GitHub revises should overwrite its
 *  old value rather than sit beside it as a duplicate a chart would sum. */
export function writeGithubTraffic(rows: TrafficPoint[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO github_traffic (full_name, metric, day, value) VALUES (?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(r.fullName, r.metric, r.day, r.value);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function githubTrafficSince(days: number): TrafficPoint[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT full_name AS fullName, metric, day, value
         FROM github_traffic WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as TrafficPoint[];
}

export type GithubWindowRow = {
  full_name: string;
  days: number;
  views: number | null;
  uniques: number | null;
  clones: number | null;
  clone_uniques: number | null;
  note: string | null;
  seen_at: string;
};

export function writeGithubWindow(
  fullName: string,
  w: {
    days: number;
    views: number | null;
    uniques: number | null;
    clones: number | null;
    cloneUniques: number | null;
    note: string | null;
  },
) {
  db.prepare(
    `INSERT INTO github_traffic_window
       (full_name, days, views, uniques, clones, clone_uniques, note, seen_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(full_name) DO UPDATE SET
       days = excluded.days, views = excluded.views, uniques = excluded.uniques,
       clones = excluded.clones, clone_uniques = excluded.clone_uniques,
       note = excluded.note, seen_at = excluded.seen_at`,
  ).run(
    fullName, w.days, w.views, w.uniques, w.clones, w.cloneUniques, w.note, now(),
  );
}

export function githubWindows(): GithubWindowRow[] {
  return db
    .prepare("SELECT * FROM github_traffic_window")
    .all() as unknown as GithubWindowRow[];
}

export type GithubPopularRow = {
  full_name: string;
  kind: string;
  name: string;
  title: string | null;
  count: number;
  uniques: number;
  seen_at: string;
};

/** One repo's top-ten list, replaced whole. A referrer that has dropped off
 *  GitHub's list has dropped off; leaving it behind would draw a chart of
 *  where traffic used to come from and label it today. */
export function replaceGithubPopular(
  fullName: string,
  rows: { kind: string; name: string; title: string | null; count: number; uniques: number }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM github_popular WHERE full_name = ?").run(fullName);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO github_popular
         (full_name, kind, name, title, count, uniques, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(fullName, r.kind, r.name, r.title, r.count, r.uniques, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function githubPopular(): GithubPopularRow[] {
  return db
    .prepare("SELECT * FROM github_popular ORDER BY count DESC")
    .all() as unknown as GithubPopularRow[];
}

export type GithubStateRow = {
  account_id: number;
  login: string | null;
  name: string | null;
  followers: number | null;
  public_repos: number | null;
  rate_remaining: number | null;
  rate_limit: number | null;
  rate_reset_at: string | null;
  requests: number | null;
  traffic_at: string | null;
  checked_at: string;
};

/** `traffic_at` is only moved when traffic was actually asked for; a run that
 *  skipped it must not reset the clock that decides when to ask again. */
export function writeGithubState(
  accountId: number,
  s: {
    login: string | null;
    name: string | null;
    followers: number | null;
    publicRepos: number | null;
    rateRemaining: number | null;
    rateLimit: number | null;
    rateResetAt: string | null;
    requests: number;
    trafficAt: string | null;
  },
) {
  db.prepare(
    `INSERT INTO github_state
       (account_id, login, name, followers, public_repos, rate_remaining,
        rate_limit, rate_reset_at, requests, traffic_at, checked_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET
       login = excluded.login, name = excluded.name,
       followers = excluded.followers, public_repos = excluded.public_repos,
       rate_remaining = excluded.rate_remaining, rate_limit = excluded.rate_limit,
       rate_reset_at = excluded.rate_reset_at, requests = excluded.requests,
       traffic_at = COALESCE(excluded.traffic_at, github_state.traffic_at),
       checked_at = excluded.checked_at`,
  ).run(
    accountId, s.login, s.name, s.followers, s.publicRepos, s.rateRemaining,
    s.rateLimit, s.rateResetAt, s.requests, s.trafficAt, now(),
  );
}

export function githubStates(): GithubStateRow[] {
  return db
    .prepare("SELECT * FROM github_state")
    .all() as unknown as GithubStateRow[];
}

/* --------------------------------------------------------------------- npm */

export function writeNpmDownloads(pkg: string, days: { day: string; downloads: number }[]) {
  if (!days.length) return 0;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO npm_downloads (package, day, downloads) VALUES (?,?,?)",
  );
  db.exec("BEGIN");
  try {
    for (const d of days) stmt.run(pkg, d.day, d.downloads);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return days.length;
}

export type NpmDay = { package: string; day: string; downloads: number };

export function npmDownloadsSince(days: number): NpmDay[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT package, day, downloads FROM npm_downloads
        WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as NpmDay[];
}

export type NpmPackageRow = {
  package: string;
  endpoint: string | null;
  range_start: string | null;
  range_end: string | null;
  last_error: string | null;
  last_ok_at: string | null;
  seen_at: string;
};

/** A success clears the error and moves `last_ok_at`; a failure keeps the date
 *  it last worked, because that is the fact somebody looking at a red row
 *  actually needs. */
export function writeNpmPackage(
  pkg: string,
  s: {
    endpoint: string | null;
    rangeStart: string | null;
    rangeEnd: string | null;
    error: string | null;
  },
) {
  const ts = now();
  db.prepare(
    `INSERT INTO npm_packages
       (package, endpoint, range_start, range_end, last_error, last_ok_at, seen_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(package) DO UPDATE SET
       endpoint = COALESCE(excluded.endpoint, npm_packages.endpoint),
       range_start = COALESCE(excluded.range_start, npm_packages.range_start),
       range_end = COALESCE(excluded.range_end, npm_packages.range_end),
       last_error = excluded.last_error,
       last_ok_at = COALESCE(excluded.last_ok_at, npm_packages.last_ok_at),
       seen_at = excluded.seen_at`,
  ).run(
    pkg, s.endpoint, s.rangeStart, s.rangeEnd, s.error,
    s.error ? null : ts, ts,
  );
}

export function npmPackages(): NpmPackageRow[] {
  return db
    .prepare("SELECT * FROM npm_packages ORDER BY package")
    .all() as unknown as NpmPackageRow[];
}

/**
 * Forget the packages that are no longer configured, downloads and all.
 *
 * A name taken off the list is a name the owner has said is not theirs, and
 * leaving its downloads in the table would keep it inside every total the
 * dashboard adds up — quietly, since nothing on the page would name it any
 * more. Removing the configuration has to remove the figures with it.
 */
export function forgetNpmPackages(keep: string[]) {
  const rows = db.prepare("SELECT package FROM npm_packages").all() as unknown as {
    package: string;
  }[];
  const stale = rows.map((r) => r.package).filter((p) => !keep.includes(p));
  for (const pkg of stale) {
    db.prepare("DELETE FROM npm_downloads WHERE package = ?").run(pkg);
    db.prepare("DELETE FROM npm_packages WHERE package = ?").run(pkg);
  }
  return stale.length;
}

/**
 * Two retentions, because the two tables are two different weights.
 *
 * `readings` is a handful of rows a day and worth keeping for a year — that is
 * how "what did this cost in March" stays answerable. `hetzner_load` is a few
 * thousand rows a day, and the questions it answers ("was the box busy last
 * night", "has this been climbing all week") are asked of recent history. A
 * year of it would be a million rows kept to answer nothing.
 */
export function prune(retainDays: number, loadRetainDays = retainDays) {
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
  const loadCutoff = new Date(Date.now() - loadRetainDays * 86_400_000).toISOString();
  const readings = db.prepare("DELETE FROM readings WHERE ts < ?").run(cutoff);
  const runs = db.prepare("DELETE FROM runs WHERE started_at < ?").run(cutoff);
  const access = db.prepare("DELETE FROM secret_access WHERE ts < ?").run(cutoff);
  const load = db.prepare("DELETE FROM hetzner_load WHERE ts < ?").run(loadCutoff);
  // Quota readings age with the long retention: four rows a day is nothing to
  // keep, and "what did the allowance do last quarter" is a real question.
  db.prepare("DELETE FROM stock_quota WHERE ts < ?").run(cutoff);
  /*
    The two day-grained tables age out on the LONG retention, not the load
    one. They are a few hundred rows a day between them, and the questions
    they answer — "was this repo's traffic better before the launch", "what did
    downloads look like the week the CLI shipped" — are asked of history, which
    is exactly what hetzner_load's thirty days is not for. Their keys are
    calendar days rather than instants, so the cutoff is sliced to match.
  */
  const dayCutoff = cutoff.slice(0, 10);
  const traffic = db
    .prepare("DELETE FROM github_traffic WHERE day < ?")
    .run(dayCutoff);
  const downloads = db
    .prepare("DELETE FROM npm_downloads WHERE day < ?")
    .run(dayCutoff);
  /*
    The cost tables keep the long retention for the same reason: "what did the
    LLM habit cost in March" is the question a year of history exists to answer,
    and a day of it is a few dozen rows. Replicate's predictions are keyed by a
    full instant rather than a day, so they take the untrimmed cutoff.
  */
  /*
    The ad account's daily spend ages with them, and for the same reason: it is
    a handful of rows a day, and "what did the ads cost last spring" is a
    question a year of history exists to answer. Its key is a calendar day, so
    it takes the sliced cutoff.
  */
  db.prepare("DELETE FROM meta_ad_days WHERE day < ?").run(dayCutoff);
  const costs =
    Number(db.prepare("DELETE FROM openai_costs WHERE day < ?").run(dayCutoff).changes) +
    Number(
      db.prepare("DELETE FROM openrouter_activity WHERE day < ?").run(dayCutoff)
        .changes,
    ) +
    Number(
      db.prepare("DELETE FROM replicate_predictions WHERE created_at < ?").run(cutoff)
        .changes,
    );
  return {
    readings: Number(readings.changes),
    runs: Number(runs.changes),
    access: Number(access.changes),
    load: Number(load.changes),
    traffic: Number(traffic.changes),
    downloads: Number(downloads.changes),
    costs,
    /* The day-grained store tables, on the same long retention and for the
       same reason. The monthly money tables are never pruned — see
       pruneMobile, which is where that decision is written down. */
    mobile: pruneMobile(retainDays),
    /* The two mail history tables, on the same long retention. The contact
       fingerprints beside them are deliberately never pruned — see pruneMail,
       which is where that decision is written down. */
    mail: pruneMail(retainDays),
    /* Cloudflare's daily rollups age with the rest of the day-grained tables.
       "Was this zone busier before the launch" is a question about history, and
       twenty-three zones is twenty-three rows a day — nothing worth trimming
       early. The zone inventory beside it is replaced wholesale every run and
       has nothing to prune. */
    cloudflare: Number(
      db.prepare("DELETE FROM cloudflare_traffic WHERE day < ?").run(dayCutoff).changes,
    ),
    /*
      The search day tables age with the rest of the day-grained ones. Twenty-two
      sites between the two engines is twenty-two rows a day, and "were we
      ranking for this before the rewrite" is precisely the question a year of
      history exists to answer. The ranked snapshots beside them are replaced
      wholesale every run and have nothing to prune, and the keyword weeks are
      left alone on purpose: they are a handful of rows per phrase and the point
      of them is the multi-year seasonal shape. */
    search: Number(
      db.prepare("DELETE FROM gsc_days WHERE day < ?").run(dayCutoff).changes,
    ) +
      Number(
        db.prepare("DELETE FROM bing_traffic_days WHERE day < ?").run(dayCutoff).changes,
      ) +
      Number(
        db.prepare("DELETE FROM bing_crawl_days WHERE day < ?").run(dayCutoff).changes,
      ) +
      Number(
        db.prepare("DELETE FROM bing_queries WHERE day < ?").run(dayCutoff).changes,
      ),
    /* Demand rows age on `seen_at` rather than on the thread's own date — see
       pruneDemand, which is where that decision is written down. The query
       states beside them are one row per phrase per source and are never
       pruned: they are the answer to "when was this last asked", which a
       cutoff would turn back into "never". */
    demand: pruneDemand(retainDays),
  };
}

/* -------------------------------------------------------------------- costs */

/**
 * The three cost providers' tables, and the one rule they share: a row is
 * written where it was measured and every total over them is computed on the
 * read. There is no "spend this month" column to go stale in here.
 */

export type OpenAiCostRecord = {
  account_id: number;
  account_label: string;
  day: string;
  project_id: string;
  project_name: string | null;
  usd: number;
  seen_at: string;
};

/**
 * A collection's worth of OpenAI cost rows.
 *
 * INSERT OR REPLACE, keyed by (account, day, project), because OpenAI's
 * buckets lag: today's row is partial when it is first read and larger when it
 * is read tomorrow, and the newer figure has to win. Plain inserts would
 * double the month; a delete-then-insert of the window would throw away the
 * history that has accumulated outside it.
 */
export function writeOpenAiCosts(
  rows: {
    accountId: number;
    accountLabel: string;
    day: string;
    projectId: string;
    projectName: string;
    usd: number;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO openai_costs
       (account_id, account_label, day, project_id, project_name, usd, seen_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.accountId, r.accountLabel, r.day, r.projectId, r.projectName, r.usd, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/** Every OpenAI cost row on or after a UTC day. The route slices the window;
 *  this hands over what is stored. */
export function openAiCosts(sinceDay: string): OpenAiCostRecord[] {
  return db
    .prepare("SELECT * FROM openai_costs WHERE day >= ? ORDER BY day ASC")
    .all(sinceDay) as unknown as OpenAiCostRecord[];
}

export type OpenRouterActivityRecord = {
  account_id: number;
  account_label: string;
  day: string;
  model: string;
  provider: string;
  usd: number;
  byok_usd: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  seen_at: string;
};

/** Same replacement rule as the OpenAI rows above, for the same reason: the
 *  current day is read again tomorrow with more in it. */
export function writeOpenRouterActivity(
  rows: {
    accountId: number;
    accountLabel: string;
    day: string;
    model: string;
    provider: string;
    usd: number;
    byokUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO openrouter_activity
       (account_id, account_label, day, model, provider, usd, byok_usd, requests,
        prompt_tokens, completion_tokens, reasoning_tokens, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.accountId, r.accountLabel, r.day, r.model, r.provider, r.usd, r.byokUsd,
        r.requests, r.promptTokens, r.completionTokens, r.reasoningTokens, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function openRouterActivity(sinceDay: string): OpenRouterActivityRecord[] {
  return db
    .prepare("SELECT * FROM openrouter_activity WHERE day >= ? ORDER BY day ASC")
    .all(sinceDay) as unknown as OpenRouterActivityRecord[];
}

export type OpenRouterKeyRecord = {
  account_id: number;
  account_label: string;
  name: string;
  usd: number;
  usd_month: number;
  usd_week: number;
  usd_day: number;
  disabled: number;
  created_at: string | null;
  spend_limit: number | null;
  limit_remaining: number | null;
  seen_at: string;
};

/**
 * One account's keys, replacing that account's rows and no others.
 *
 * A whole replacement rather than a merge, because the disappearance of a key
 * is the news: a key deleted at OpenRouter has to leave this table, and a
 * merge would keep its lifetime spend in every total forever under a name
 * that no longer exists anywhere.
 */
export function replaceOpenRouterKeys(
  accountId: number,
  accountLabel: string,
  rows: {
    name: string;
    usd: number;
    usdMonth: number;
    usdWeek: number;
    usdDay: number;
    disabled: boolean;
    createdAt: string | null;
    spendLimit: number | null;
    limitRemaining: number | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM openrouter_keys WHERE account_id = ?").run(accountId);
    const stmt = db.prepare(
      `INSERT INTO openrouter_keys
         (account_id, account_label, name, usd, usd_month, usd_week, usd_day,
          disabled, created_at, spend_limit, limit_remaining, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const k of rows)
      stmt.run(
        accountId, accountLabel, k.name, k.usd, k.usdMonth, k.usdWeek, k.usdDay,
        k.disabled ? 1 : 0, k.createdAt, k.spendLimit, k.limitRemaining, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function openRouterKeys(): OpenRouterKeyRecord[] {
  return db
    .prepare("SELECT * FROM openrouter_keys ORDER BY usd DESC")
    .all() as unknown as OpenRouterKeyRecord[];
}

export type OpenRouterCreditsRecord = {
  account_id: number;
  account_label: string;
  purchased: number | null;
  spent: number | null;
  seen_at: string;
};

/** A balance is a current state; there is one row per account and the newest
 *  read replaces it. */
export function writeOpenRouterCredits(
  accountId: number,
  accountLabel: string,
  purchased: number,
  spent: number,
) {
  db.prepare(
    `INSERT OR REPLACE INTO openrouter_credits
       (account_id, account_label, purchased, spent, seen_at)
     VALUES (?,?,?,?,?)`,
  ).run(accountId, accountLabel, purchased, spent, now());
}

export function openRouterCredits(): OpenRouterCreditsRecord[] {
  return db
    .prepare("SELECT * FROM openrouter_credits ORDER BY account_id")
    .all() as unknown as OpenRouterCreditsRecord[];
}

export type ReplicatePredictionRecord = {
  id: string;
  account_id: number;
  account_label: string;
  model: string | null;
  status: string | null;
  created_at: string;
  predict_seconds: number | null;
  image_outputs: number | null;
  video_seconds: number | null;
  output_tokens: number | null;
  source: string | null;
  seen_at: string;
};

/**
 * Predictions, keyed by Replicate's own id.
 *
 * REPLACE rather than INSERT, because every collection re-reads a few hours of
 * overlap: a prediction that was still running when it was last seen arrives
 * again with a status and a predict time, and the newer record is the true
 * one. Inserting would leave the unfinished copy in every count.
 */
export function writeReplicatePredictions(
  rows: {
    accountId: number;
    accountLabel: string;
    id: string;
    model: string | null;
    status: string | null;
    createdAt: string;
    predictSeconds: number | null;
    imageOutputs: number | null;
    videoSeconds: number | null;
    outputTokens: number | null;
    source: string | null;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO replicate_predictions
       (id, account_id, account_label, model, status, created_at,
        predict_seconds, image_outputs, video_seconds, output_tokens, source, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const p of rows)
      stmt.run(
        p.id, p.accountId, p.accountLabel, p.model, p.status, p.createdAt,
        p.predictSeconds, p.imageOutputs, p.videoSeconds, p.outputTokens,
        p.source, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function replicatePredictions(sinceIso: string): ReplicatePredictionRecord[] {
  return db
    .prepare(
      "SELECT * FROM replicate_predictions WHERE created_at >= ? ORDER BY created_at ASC",
    )
    .all(sinceIso) as unknown as ReplicatePredictionRecord[];
}

/**
 * The newest prediction held per account, which is where the next collection
 * starts from. Asked of the database rather than remembered in a variable,
 * because the collector is restarted far more often than the account is.
 */
export function newestReplicatePrediction(): Map<number, string> {
  const rows = db
    .prepare(
      "SELECT account_id, MAX(created_at) AS newest FROM replicate_predictions GROUP BY account_id",
    )
    .all() as unknown as { account_id: number; newest: string }[];
  return new Map(rows.map((r) => [r.account_id, r.newest]));
}

/* ------------------------------------------------------------------ stripe */

/**
 * Stripe's five tables, and the one rule they share with the cost tables: a
 * row is written where it was MEASURED and every total over them is computed
 * on the read. There is no "MRR" column in here and no "net revenue this
 * month" — there is a priced subscription, a day of charges and a day of
 * ledger, and the arithmetic happens when somebody asks.
 */

export type StripeChargeDayRecord = {
  account_id: number;
  account_label: string;
  day: string;
  currency: string;
  gross: number;
  refunded: number;
  refunds: number;
  succeeded: number;
  failed: number;
  blocked: number;
  declined: number;
  seen_at: string;
};

export type StripeLedgerDayRecord = {
  account_id: number;
  account_label: string;
  day: string;
  currency: string;
  gross: number;
  fees: number;
  tax_withheld: number;
  fees_total: number;
  refunds: number;
  disputes: number;
  other: number;
  net: number;
  count: number;
  processing: number;
  managed_payments: number;
  dispute_fees: number;
  billing: number;
  other_fees: number;
  seen_at: string;
};

export type StripeSubscriptionRecord = {
  id: string;
  account_id: number;
  account_label: string;
  status: string;
  currency: string;
  monthly_usd: number;
  listed_monthly_usd: number;
  bill_interval: string | null;
  interval_count: number | null;
  product: string | null;
  plan: string | null;
  created_at: string;
  ended_at: string | null;
  cancel_at_period_end: number;
  cancel_at: string | null;
  trial_start: string | null;
  trial_end: string | null;
  reason: string | null;
  paid_cents: number | null;
  seen_at: string;
};

export type StripeBalanceRecord = {
  account_id: number;
  account_label: string;
  currency: string;
  available: number;
  pending: number;
  seen_at: string;
};

export type StripePayoutRecord = {
  id: string;
  account_id: number;
  account_label: string;
  amount: number;
  currency: string;
  status: string;
  automatic: number;
  arrival_date: string;
  created_at: string;
  seen_at: string;
};

/**
 * A collection's worth of charge days.
 *
 * INSERT OR REPLACE, keyed by (account, day, currency), because the walk is
 * AUTHORITATIVE over the days it covered: a refund landing today against a
 * July charge changes July's row, and a merge that added the two would double
 * July's gross on every collection. Days outside the walk are carried across
 * untouched, which is the whole point of keeping the table.
 */
export function writeStripeChargeDays(
  rows: {
    accountId: number;
    accountLabel: string;
    day: string;
    currency: string;
    gross: number;
    refunded: number;
    refunds: number;
    succeeded: number;
    failed: number;
    blocked: number;
    declined: number;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stripe_charge_days
       (account_id, account_label, day, currency, gross, refunded, refunds,
        succeeded, failed, blocked, declined, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.accountId, r.accountLabel, r.day, r.currency, r.gross, r.refunded,
        r.refunds, r.succeeded, r.failed, r.blocked, r.declined, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function stripeChargeDays(sinceDay: string): StripeChargeDayRecord[] {
  return db
    .prepare("SELECT * FROM stripe_charge_days WHERE day >= ? ORDER BY day ASC")
    .all(sinceDay) as unknown as StripeChargeDayRecord[];
}

/** Same replacement rule as the charge days above, for the same reason. */
export function writeStripeLedgerDays(
  rows: {
    accountId: number;
    accountLabel: string;
    day: string;
    currency: string;
    gross: number;
    fees: number;
    taxWithheld: number;
    feesTotal: number;
    refunds: number;
    disputes: number;
    other: number;
    net: number;
    count: number;
    processing: number;
    managedPayments: number;
    disputeFees: number;
    billing: number;
    otherFees: number;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stripe_ledger_days
       (account_id, account_label, day, currency, gross, fees, tax_withheld,
        fees_total, refunds, disputes, other, net, count, processing,
        managed_payments, dispute_fees, billing, other_fees, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.accountId, r.accountLabel, r.day, r.currency, r.gross, r.fees,
        r.taxWithheld, r.feesTotal, r.refunds, r.disputes, r.other, r.net,
        r.count, r.processing, r.managedPayments, r.disputeFees, r.billing,
        r.otherFees, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function stripeLedgerDays(sinceDay: string): StripeLedgerDayRecord[] {
  return db
    .prepare("SELECT * FROM stripe_ledger_days WHERE day >= ? ORDER BY day ASC")
    .all(sinceDay) as unknown as StripeLedgerDayRecord[];
}

/**
 * The subscription book, keyed by Stripe's own id.
 *
 * REPLACE rather than a delete-and-insert of the whole table: the walk reads
 * every subscription the account has, so a replacement per row is a complete
 * refresh — and a run that fails half way leaves the older half of the book
 * standing rather than emptying the page. A subscription is never deleted at
 * Stripe, so nothing here goes stale by omission.
 */
export function writeStripeSubscriptions(
  rows: {
    accountId: number;
    accountLabel: string;
    id: string;
    status: string;
    currency: string;
    monthlyUsd: number;
    listedMonthlyUsd: number;
    interval: string | null;
    intervalCount: number | null;
    product: string | null;
    plan: string | null;
    createdAt: string;
    endedAt: string | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: string | null;
    trialStart: string | null;
    trialEnd: string | null;
    reason: string | null;
    paidCents: number | null;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stripe_subscriptions
       (id, account_id, account_label, status, currency, monthly_usd,
        listed_monthly_usd, bill_interval, interval_count, product, plan,
        created_at, ended_at, cancel_at_period_end, cancel_at, trial_start,
        trial_end, reason, paid_cents, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const s of rows)
      stmt.run(
        s.id, s.accountId, s.accountLabel, s.status, s.currency, s.monthlyUsd,
        s.listedMonthlyUsd, s.interval, s.intervalCount, s.product, s.plan,
        s.createdAt, s.endedAt, s.cancelAtPeriodEnd ? 1 : 0, s.cancelAt,
        s.trialStart, s.trialEnd, s.reason, s.paidCents, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function stripeSubscriptions(): StripeSubscriptionRecord[] {
  return db
    .prepare("SELECT * FROM stripe_subscriptions ORDER BY created_at ASC")
    .all() as unknown as StripeSubscriptionRecord[];
}

/**
 * Which subscriptions already have an answer to "did this ever bill".
 *
 * The collector hands this to the provider so the question is asked once in a
 * subscription's life rather than once per collection — 154 cancellations on
 * this account, one GET each, and an answer that cannot change.
 */
export function stripePaidCents(): Map<string, number> {
  const rows = db
    .prepare("SELECT id, paid_cents FROM stripe_subscriptions WHERE paid_cents IS NOT NULL")
    .all() as unknown as { id: string; paid_cents: number }[];
  return new Map(rows.map((r) => [r.id, r.paid_cents]));
}

/** A balance is current state: one row per account per currency, replaced. */
export function writeStripeBalance(
  rows: {
    accountId: number;
    accountLabel: string;
    currency: string;
    available: number;
    pending: number;
  }[],
) {
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stripe_balance
       (account_id, account_label, currency, available, pending, seen_at)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const r of rows)
    stmt.run(r.accountId, r.accountLabel, r.currency, r.available, r.pending, seen);
  return rows.length;
}

export function stripeBalances(): StripeBalanceRecord[] {
  return db
    .prepare("SELECT * FROM stripe_balance ORDER BY currency ASC")
    .all() as unknown as StripeBalanceRecord[];
}

export function writeStripePayouts(
  rows: {
    accountId: number;
    accountLabel: string;
    id: string;
    amount: number;
    currency: string;
    status: string;
    automatic: boolean;
    arrivalDate: string;
    createdAt: string;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stripe_payouts
       (id, account_id, account_label, amount, currency, status, automatic,
        arrival_date, created_at, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const p of rows)
    stmt.run(
      p.id, p.accountId, p.accountLabel, p.amount, p.currency, p.status,
      p.automatic ? 1 : 0, p.arrivalDate, p.createdAt, seen,
    );
  return rows.length;
}

export function stripePayouts(limit = 20): StripePayoutRecord[] {
  return db
    .prepare("SELECT * FROM stripe_payouts ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as StripePayoutRecord[];
}

/** How far back each account's day tables reach, and whether that is the whole
 *  account. See the table's comment for why this is not a variable. */
export function stripeState(): Map<number, { historyFrom: string | null; backfilled: boolean }> {
  const rows = db
    .prepare("SELECT account_id, history_from, backfilled FROM stripe_state")
    .all() as unknown as {
    account_id: number;
    history_from: string | null;
    backfilled: number;
  }[];
  return new Map(
    rows.map((r) => [
      r.account_id,
      { historyFrom: r.history_from, backfilled: r.backfilled === 1 },
    ]),
  );
}

export function writeStripeState(
  accountId: number,
  state: { historyFrom: string | null; backfilled: boolean },
) {
  db.prepare(
    `INSERT OR REPLACE INTO stripe_state
       (account_id, history_from, backfilled, updated_at)
     VALUES (?,?,?,?)`,
  ).run(accountId, state.historyFrom, state.backfilled ? 1 : 0, now());
}

/* ----------------------------------------------------------------- adsense */

export type AdSenseDayRecord = {
  account_id: number;
  account_label: string;
  day: string;
  site: string;
  currency: string;
  usd: number;
  page_views: number;
  impressions: number;
  clicks: number;
  seen_at: string;
};

export type AdSenseMonthRecord = Omit<AdSenseDayRecord, "day"> & { month: string };

/**
 * AdSense days, keyed and REPLACED.
 *
 * Google revises estimated earnings for days after the fact, so a row read
 * today is not final and a row read tomorrow is the better one. Inserting
 * would stack three versions of Tuesday on top of each other.
 */
export function writeAdSenseDays(
  rows: {
    accountId: number;
    accountLabel: string;
    day: string;
    site: string;
    currency: string;
    usd: number;
    pageViews: number;
    impressions: number;
    clicks: number;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO adsense_days
       (account_id, account_label, day, site, currency, usd, page_views,
        impressions, clicks, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.accountId, r.accountLabel, r.day, r.site, r.currency, r.usd,
        r.pageViews, r.impressions, r.clicks, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function adSenseDays(sinceDay: string): AdSenseDayRecord[] {
  return db
    .prepare("SELECT * FROM adsense_days WHERE day >= ? ORDER BY day ASC")
    .all(sinceDay) as unknown as AdSenseDayRecord[];
}

export function writeAdSenseMonths(
  rows: {
    accountId: number;
    accountLabel: string;
    month: string;
    site: string;
    currency: string;
    usd: number;
    pageViews: number;
    impressions: number;
    clicks: number;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO adsense_months
       (account_id, account_label, month, site, currency, usd, page_views,
        impressions, clicks, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.accountId, r.accountLabel, r.month, r.site, r.currency, r.usd,
        r.pageViews, r.impressions, r.clicks, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function adSenseMonths(): AdSenseMonthRecord[] {
  return db
    .prepare("SELECT * FROM adsense_months ORDER BY month ASC")
    .all() as unknown as AdSenseMonthRecord[];
}

/* ------------------------------------------------------------------ mobile */

/**
 * The two app stores' tables, and the rule they share with the cost tables: a
 * row is written at the grain it was measured, and every total over them —
 * per window, per app, per currency — is computed when somebody reads it.
 * Nothing in here says "$118 in August"; it says which transactions happened,
 * in which currency, and August is a sum over them.
 */

export type AppStoreStateRow = {
  account_id: number;
  account_label: string;
  key_id: string | null;
  issuer_id: string | null;
  vendor: string | null;
  apps: number;
  seen_at: string;
};

export function writeAppStoreState(
  accountId: number,
  label: string,
  v: { keyId: string | null; issuerId: string | null; vendor: string | null; apps: number },
) {
  db.prepare(
    `INSERT OR REPLACE INTO appstore_state
       (account_id, account_label, key_id, issuer_id, vendor, apps, seen_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(accountId, label, v.keyId, v.issuerId, v.vendor, v.apps, now());
}

export function appStoreState(): AppStoreStateRow[] {
  return db
    .prepare("SELECT * FROM appstore_state ORDER BY account_id")
    .all() as unknown as AppStoreStateRow[];
}

export type AppStoreAppRow = {
  account_id: number;
  account_label: string;
  app_id: string;
  bundle_id: string | null;
  name: string | null;
  sku: string | null;
  primary_locale: string | null;
  state: string | null;
  version: string | null;
  on_store: number | null;
  storefront: string | null;
  listed: number | null;
  rating_avg: number | null;
  rating_count: number | null;
  released_at: string | null;
  seen_at: string;
};

/** One account's apps, replaced whole. An app removed from the account leaves
 *  the table the moment it leaves Apple — the same rule the fleet keeps. */
export function replaceAppStoreApps(
  accountId: number,
  label: string,
  apps: {
    id: string;
    bundleId: string;
    name: string;
    sku: string;
    primaryLocale: string;
    state: string | null;
    version: string | null;
    onStore: boolean;
    storefront: string | null;
    listed: boolean | null;
    ratingAverage: number | null;
    ratingCount: number | null;
    releasedAt: string | null;
  }[],
) {
  const seen = now();
  const insert = db.prepare(
    `INSERT INTO appstore_apps
       (account_id, account_label, app_id, bundle_id, name, sku, primary_locale,
        state, version, on_store, storefront, listed, rating_avg, rating_count,
        released_at, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM appstore_apps WHERE account_id = ?").run(accountId);
    for (const a of apps)
      insert.run(
        accountId, label, a.id, a.bundleId, a.name, a.sku, a.primaryLocale,
        a.state, a.version, a.onStore ? 1 : 0, a.storefront,
        a.listed === null ? null : a.listed ? 1 : 0,
        a.ratingAverage, a.ratingCount, a.releasedAt, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function appStoreApps(): AppStoreAppRow[] {
  return db
    .prepare("SELECT * FROM appstore_apps ORDER BY account_id, name")
    .all() as unknown as AppStoreAppRow[];
}

export type AppStoreReportRow = {
  account_id: number;
  kind: string;
  period: string;
  state: string;
  seen_at: string;
};

export function writeAppStoreReport(
  accountId: number,
  kind: "sales" | "finance",
  period: string,
  state: string,
) {
  db.prepare(
    `INSERT OR REPLACE INTO appstore_reports (account_id, kind, period, state, seen_at)
     VALUES (?,?,?,?,?)`,
  ).run(accountId, kind, period, state, now());
}

export function appStoreReports(kind: "sales" | "finance"): AppStoreReportRow[] {
  return db
    .prepare("SELECT * FROM appstore_reports WHERE kind = ? ORDER BY period")
    .all(kind) as unknown as AppStoreReportRow[];
}

/**
 * Which periods this account has already had an answer for.
 *
 * `absent` is deliberately NOT an answer: a day Apple had not generated when
 * we asked is a day worth asking about again tomorrow, which is the whole
 * reason the state is stored rather than a bare "we looked".
 */
export function appStoreAnswered(accountId: number, kind: "sales" | "finance"): Set<string> {
  const rows = db
    .prepare(
      "SELECT period FROM appstore_reports WHERE account_id = ? AND kind = ? AND state <> 'absent'",
    )
    .all(accountId, kind) as unknown as { period: string }[];
  return new Set(rows.map((r) => r.period));
}

/**
 * One day of sales for one account, replacing whatever that day held.
 *
 * Delete-then-insert per day rather than an upsert per row: an app that has
 * dropped out of a revised report must lose its row, and an upsert would leave
 * yesterday's figure behind under today's date.
 */
export function writeAppStoreDay(
  accountId: number,
  day: string,
  apps: { appId: string; downloads: number; updates: number; inAppUnits: number }[],
  proceeds: { appId: string; currency: string; amount: number }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM appstore_sales WHERE account_id = ? AND day = ?").run(accountId, day);
    db.prepare("DELETE FROM appstore_proceeds WHERE account_id = ? AND day = ?").run(accountId, day);
    const s = db.prepare(
      `INSERT INTO appstore_sales
         (account_id, day, app_id, downloads, updates, in_app_units, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const a of apps)
      s.run(accountId, day, a.appId, a.downloads, a.updates, a.inAppUnits, seen);
    const p = db.prepare(
      `INSERT INTO appstore_proceeds (account_id, day, app_id, currency, amount, seen_at)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const r of proceeds) p.run(accountId, day, r.appId, r.currency, r.amount, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type AppStoreSaleRow = {
  account_id: number;
  day: string;
  app_id: string;
  downloads: number;
  updates: number;
  in_app_units: number;
};

export function appStoreSales(days: number): AppStoreSaleRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT account_id, day, app_id, downloads, updates, in_app_units
         FROM appstore_sales WHERE day >= ? ORDER BY day`,
    )
    .all(since) as unknown as AppStoreSaleRow[];
}

export type AppStoreProceedRow = {
  account_id: number;
  day: string;
  app_id: string;
  currency: string;
  amount: number;
};

export function appStoreProceeds(days: number): AppStoreProceedRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT account_id, day, app_id, currency, amount
         FROM appstore_proceeds WHERE day >= ? ORDER BY day`,
    )
    .all(since) as unknown as AppStoreProceedRow[];
}

/** One month's payout, replaced whole for the same reason a day is. */
export function writeAppStorePayouts(
  accountId: number,
  month: string,
  rows: { appId: string | null; currency: string; amount: number }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM appstore_payouts WHERE account_id = ? AND month = ?").run(
      accountId,
      month,
    );
    const insert = db.prepare(
      `INSERT INTO appstore_payouts (account_id, month, app_id, currency, amount, seen_at)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const r of rows) insert.run(accountId, month, r.appId ?? "", r.currency, r.amount, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type AppStorePayoutRow = {
  account_id: number;
  month: string;
  app_id: string;
  currency: string;
  amount: number;
  seen_at: string;
};

export function appStorePayouts(): AppStorePayoutRow[] {
  return db
    .prepare("SELECT * FROM appstore_payouts ORDER BY month")
    .all() as unknown as AppStorePayoutRow[];
}

/* ------------------------------------------------------------------- play */

export type PlayStateRow = {
  account_id: number;
  account_label: string;
  bucket: string | null;
  service_account: string | null;
  packages: number;
  seen_at: string;
};

export function writePlayState(
  accountId: number,
  label: string,
  v: { bucket: string | null; serviceAccount: string | null; packages: number },
) {
  db.prepare(
    `INSERT OR REPLACE INTO play_state
       (account_id, account_label, bucket, service_account, packages, seen_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(accountId, label, v.bucket, v.serviceAccount, v.packages, now());
}

export function playState(): PlayStateRow[] {
  return db
    .prepare("SELECT * FROM play_state ORDER BY account_id")
    .all() as unknown as PlayStateRow[];
}

export function writePlayFile(
  accountId: number,
  folder: string,
  month: string,
  object: string,
  updatedAt: string | null,
) {
  db.prepare(
    `INSERT OR REPLACE INTO play_files
       (account_id, folder, month, object, updated_at, ingested_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(accountId, folder, month, object, updatedAt, now());
}

/** {folder/month: object name} — what has already been ingested, which is how
 *  a settled month costs a listing rather than a download. */
export function playFiles(accountId: number): Map<string, string> {
  const rows = db
    .prepare("SELECT folder, month, object FROM play_files WHERE account_id = ?")
    .all(accountId) as unknown as { folder: string; month: string; object: string }[];
  return new Map(rows.map((r) => [`${r.folder}/${r.month}`, r.object]));
}

export type PlayStatsRow = {
  account_id: number;
  package: string;
  day: string;
  installs: number | null;
  uninstalls: number | null;
  active_devices: number | null;
  install_events: number | null;
  uninstall_events: number | null;
  rating_daily: number | null;
  rating_total: number | null;
};

/** Daily rows, keyed and replaced: every run re-reads the running month's CSV,
 *  and a day Google revised has to win rather than land beside the old one. */
export function writePlayStats(
  accountId: number,
  pkg: string,
  days: {
    day: string;
    installs: number | null;
    uninstalls: number | null;
    activeDevices: number | null;
    installEvents: number | null;
    uninstallEvents: number | null;
    ratingDaily: number | null;
    ratingTotal: number | null;
  }[],
) {
  if (!days.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO play_stats
       (account_id, package, day, installs, uninstalls, active_devices,
        install_events, uninstall_events, rating_daily, rating_total, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const d of days)
      stmt.run(
        accountId, pkg, d.day, d.installs, d.uninstalls, d.activeDevices,
        d.installEvents, d.uninstallEvents, d.ratingDaily, d.ratingTotal, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return days.length;
}

export function playStats(days: number): PlayStatsRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT account_id, package, day, installs, uninstalls, active_devices,
              install_events, uninstall_events, rating_daily, rating_total
         FROM play_stats WHERE day >= ? ORDER BY day`,
    )
    .all(since) as unknown as PlayStatsRow[];
}

/** The newest rating each package has, whatever day it was last written on —
 *  Play's running average is a current state and the last day that carried one
 *  is the only honest answer, however old it is. Its date travels with it. */
export function playLatestRatings(): {
  account_id: number;
  package: string;
  day: string;
  rating_total: number;
}[] {
  return db
    .prepare(
      `SELECT s.account_id, s.package, s.day, s.rating_total
         FROM play_stats s
         JOIN (SELECT account_id, package, MAX(day) AS day
                 FROM play_stats WHERE rating_total IS NOT NULL
                GROUP BY account_id, package) newest
           ON newest.account_id = s.account_id
          AND newest.package = s.package
          AND newest.day = s.day`,
    )
    .all() as unknown as {
    account_id: number;
    package: string;
    day: string;
    rating_total: number;
  }[];
}

export type PlayEarningRow = {
  account_id: number;
  month: string;
  package: string;
  currency: string;
  charged: number;
  refunds: number;
  fees: number;
  net: number;
  transactions: number;
  seen_at: string;
};

export function writePlayEarnings(
  accountId: number,
  month: string,
  rows: {
    package: string;
    currency: string;
    charged: number;
    refunds: number;
    fees: number;
    net: number;
    transactions: number;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM play_earnings WHERE account_id = ? AND month = ?").run(
      accountId,
      month,
    );
    const insert = db.prepare(
      `INSERT INTO play_earnings
         (account_id, month, package, currency, charged, refunds, fees, net,
          transactions, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      insert.run(
        accountId, month, r.package, r.currency, r.charged, r.refunds, r.fees,
        r.net, r.transactions, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function playEarnings(): PlayEarningRow[] {
  return db
    .prepare("SELECT * FROM play_earnings ORDER BY month")
    .all() as unknown as PlayEarningRow[];
}

export type PlaySaleRow = {
  account_id: number;
  month: string;
  package: string;
  currency: string;
  charged: number;
  taxes: number;
  orders: number;
  refunds: number;
  seen_at: string;
};

export function writePlaySales(
  accountId: number,
  month: string,
  rows: {
    package: string;
    currency: string;
    charged: number;
    taxes: number;
    orders: number;
    refunds: number;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM play_sales WHERE account_id = ? AND month = ?").run(accountId, month);
    const insert = db.prepare(
      `INSERT INTO play_sales
         (account_id, month, package, currency, charged, taxes, orders, refunds, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      insert.run(
        accountId, month, r.package, r.currency, r.charged, r.taxes, r.orders,
        r.refunds, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function playSales(): PlaySaleRow[] {
  return db
    .prepare("SELECT * FROM play_sales ORDER BY month")
    .all() as unknown as PlaySaleRow[];
}

/**
 * The day-grained mobile tables age out on the long retention, like every
 * other day-grained table here: "what did downloads look like the week the app
 * shipped" is a question about history. The monthly money tables are not
 * pruned at all — a year is twelve rows per currency, and a payout is the
 * permanent record of what actually arrived.
 */
export function pruneMobile(retainDays: number) {
  const dayCutoff = new Date(Date.now() - retainDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return (
    Number(db.prepare("DELETE FROM appstore_sales WHERE day < ?").run(dayCutoff).changes) +
    Number(db.prepare("DELETE FROM appstore_proceeds WHERE day < ?").run(dayCutoff).changes) +
    Number(db.prepare("DELETE FROM appstore_reports WHERE kind = 'sales' AND period < ?").run(dayCutoff).changes) +
    Number(db.prepare("DELETE FROM play_stats WHERE day < ?").run(dayCutoff).changes)
  );
}

/* --------------------------------------------------------------- cloudflare */

export type CloudflareZoneRow = {
  zone_id: string;
  account_id: number;
  account_label: string;
  name: string;
  status: string | null;
  paused: number;
  plan: string | null;
  zone_type: string | null;
  created_on: string | null;
  name_servers: string | null;
  records: number | null;
  proxied: number | null;
  on_pages: number | null;
  mx: number | null;
  spf: number | null;
  dmarc: number | null;
  dmarc_policy: string | null;
  dkim: number | null;
  records_note: string | null;
  traffic_note: string | null;
  cf_account_id: string | null;
  cf_account_name: string | null;
  seen_at: string;
};

export type CloudflareTrafficRow = {
  zone_id: string;
  day: string;
  requests: number;
  cached: number;
  bytes: number;
  threats: number | null;
  page_views: number | null;
  uniques: number | null;
  s2xx: number | null;
  s3xx: number | null;
  s4xx: number | null;
  s5xx: number | null;
  fields: string;
};

export type CloudflareRegistrarRow = {
  account_id: number;
  account_label: string;
  name: string;
  expires_at: string | null;
  auto_renew: number | null;
  locked: number | null;
  registrar: string | null;
  status: string | null;
};

export type CloudflareStateRow = {
  account_id: number;
  account_label: string;
  cf_account_id: string | null;
  cf_account_name: string | null;
  zones: number;
  registrar_readable: number;
  registrar_count: number;
  registrar_note: string | null;
  analytics_zones: number;
  analytics_note: string | null;
  seen_at: string;
};

const flag = (v: boolean | null | undefined) =>
  v === null || v === undefined ? null : v ? 1 : 0;

/**
 * One ACCOUNT's zones, replacing that account's rows and no others.
 *
 * Scoped exactly the way replaceDomains is, and for the same reason: a second
 * Cloudflare token that answers 403 must not take the first account's zones off
 * the page. In one transaction, because a half-replaced inventory is worse than
 * an old one.
 */
export function replaceCloudflareZones(
  accountId: number,
  accountLabel: string,
  rows: {
    id: string;
    name: string;
    status: string | null;
    paused: boolean;
    plan: string | null;
    type: string | null;
    createdOn: string | null;
    nameServers: string[] | null;
    records: number | null;
    proxied: number | null;
    onPages: boolean | null;
    email: {
      mx: boolean;
      spf: boolean;
      dmarc: boolean;
      dmarcPolicy: string | null;
      dkim: boolean | null;
    } | null;
    recordsNote: string | null;
    trafficNote: string | null;
    cfAccountId: string | null;
    cfAccountName: string | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cloudflare_zones WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO cloudflare_zones
         (zone_id, account_id, account_label, name, status, paused, plan,
          zone_type, created_on, name_servers, records, proxied, on_pages,
          mx, spf, dmarc, dmarc_policy, dkim, records_note, traffic_note,
          cf_account_id, cf_account_name, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const z of rows) {
      ins.run(
        z.id, accountId, accountLabel, z.name, z.status, z.paused ? 1 : 0, z.plan,
        z.type, z.createdOn, z.nameServers ? JSON.stringify(z.nameServers) : null,
        z.records, z.proxied, flag(z.onPages),
        flag(z.email?.mx ?? null), flag(z.email?.spf ?? null), flag(z.email?.dmarc ?? null),
        z.email?.dmarcPolicy ?? null, flag(z.email ? z.email.dkim : null),
        z.recordsNote, z.trafficNote, z.cfAccountId, z.cfAccountName, seen,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/**
 * A run's worth of daily rollups, in one transaction.
 *
 * REPLACE rather than INSERT, because every run re-reads the same window: most
 * of what arrives is already here, and today's partial bucket has to be
 * CORRECTED tomorrow rather than sitting beside its finished self as a
 * duplicate the totals would count twice.
 */
export function writeCloudflareTraffic(
  rows: {
    zoneId: string;
    day: string;
    requests: number;
    cached: number;
    bytes: number;
    threats: number | null;
    pageViews: number | null;
    uniques: number | null;
    s2xx: number | null;
    s3xx: number | null;
    s4xx: number | null;
    s5xx: number | null;
    fields: string;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO cloudflare_traffic
         (zone_id, day, requests, cached, bytes, threats, page_views, uniques,
          s2xx, s3xx, s4xx, s5xx, fields, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(
        r.zoneId, r.day, r.requests, r.cached, r.bytes, r.threats, r.pageViews,
        r.uniques, r.s2xx, r.s3xx, r.s4xx, r.s5xx, r.fields, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/** One account's Cloudflare Registrar rows. Zero of them is the ordinary
 *  answer, and this still replaces — a domain moved away from Cloudflare
 *  Registrar should leave the table the way a decommissioned box does. */
export function replaceCloudflareRegistrar(
  accountId: number,
  accountLabel: string,
  rows: {
    name: string;
    expiresAt: string | null;
    autoRenew: boolean | null;
    locked: boolean | null;
    registrar: string | null;
    status: string | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cloudflare_registrar WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO cloudflare_registrar
         (account_id, name, account_label, expires_at, auto_renew, locked,
          registrar, status, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(
        accountId, r.name, accountLabel, r.expiresAt, flag(r.autoRenew),
        flag(r.locked), r.registrar, r.status, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function writeCloudflareState(
  accountId: number,
  accountLabel: string,
  state: {
    cfAccountId: string | null;
    cfAccountName: string | null;
    zones: number;
    registrarReadable: boolean;
    registrarCount: number;
    registrarNote: string | null;
    analyticsZones: number;
    analyticsNote: string | null;
  },
) {
  db.prepare(
    `INSERT OR REPLACE INTO cloudflare_state
       (account_id, account_label, cf_account_id, cf_account_name, zones,
        registrar_readable, registrar_count, registrar_note, analytics_zones,
        analytics_note, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    accountId, accountLabel, state.cfAccountId, state.cfAccountName, state.zones,
    state.registrarReadable ? 1 : 0, state.registrarCount, state.registrarNote,
    state.analyticsZones, state.analyticsNote, now(),
  );
}

export function cloudflareZones(): CloudflareZoneRow[] {
  return db
    .prepare("SELECT * FROM cloudflare_zones ORDER BY name")
    .all() as unknown as CloudflareZoneRow[];
}

/**
 * Daily rollups back to a calendar day, oldest first.
 *
 * A DAY CUTOFF rather than an instant, because the key is a UTC calendar day
 * and comparing it against an ISO timestamp would drop today's row on every
 * read. The route slices its own window out of what comes back.
 */
export function cloudflareTraffic(days: number): CloudflareTrafficRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT zone_id, day, requests, cached, bytes, threats, page_views,
              uniques, s2xx, s3xx, s4xx, s5xx, fields
         FROM cloudflare_traffic
        WHERE day >= ?
        ORDER BY day ASC`,
    )
    .all(since) as unknown as CloudflareTrafficRow[];
}

export function cloudflareRegistrar(): CloudflareRegistrarRow[] {
  return db
    .prepare("SELECT * FROM cloudflare_registrar ORDER BY name")
    .all() as unknown as CloudflareRegistrarRow[];
}

export function cloudflareState(): CloudflareStateRow[] {
  return db
    .prepare("SELECT * FROM cloudflare_state ORDER BY account_id")
    .all() as unknown as CloudflareStateRow[];
}

/* ------------------------------------------------------------------- search */

/**
 * Search Console and Bing Webmaster.
 *
 * ONE RULE RUNS THROUGH ALL OF THESE: nothing here stores a window total.
 * `gsc_days` and the two Bing day tables hold what was measured on a dated
 * day, and "impressions over 28 days" is summed when somebody asks — the same
 * decision the domain countdowns and the whole costs board are built on. A
 * stored 28-day figure is wrong the morning after it was written and badly
 * wrong after a week of failed collections, which is the week somebody
 * actually looks at it.
 *
 * The one exception is `gsc_sites.total_*`, and it is not a total the board
 * ever prints: it is Google's own dimensionless answer for the window the
 * ranked rows beside it were taken from, kept solely so the route can say what
 * fraction of the property those rows cover. See the migration.
 */

export type GscSiteRow = {
  property: string;
  account_id: number;
  account_label: string;
  permission: string | null;
  window_start: string | null;
  window_end: string | null;
  total_clicks: number | null;
  total_impressions: number | null;
  total_position: number | null;
  query_rows: number | null;
  query_impressions: number | null;
  query_clicks: number | null;
  sitemap_state: string | null;
  sitemap_count: number | null;
  sitemap_submitted: number | null;
  sitemap_errors: number | null;
  sitemap_warnings: number | null;
  sitemap_pending: number | null;
  sitemap_downloaded: string | null;
  error: string | null;
  seen_at: string;
};

/** One property's current state. INSERT OR REPLACE by the property, so a
 *  property that failed this run keeps neither a stale success nor a blank
 *  row — the caller writes it with its own error and its previous days
 *  untouched. */
export function writeGscSite(
  row: Omit<GscSiteRow, "seen_at"> & { seenAt?: string },
) {
  db.prepare(
    `INSERT OR REPLACE INTO gsc_sites
       (property, account_id, account_label, permission, window_start, window_end,
        total_clicks, total_impressions, total_position,
        query_rows, query_impressions, query_clicks,
        sitemap_state, sitemap_count, sitemap_submitted, sitemap_errors,
        sitemap_warnings, sitemap_pending, sitemap_downloaded, error, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.property, row.account_id, row.account_label, row.permission,
    row.window_start, row.window_end, row.total_clicks, row.total_impressions,
    row.total_position, row.query_rows, row.query_impressions, row.query_clicks,
    row.sitemap_state, row.sitemap_count, row.sitemap_submitted,
    row.sitemap_errors, row.sitemap_warnings, row.sitemap_pending,
    row.sitemap_downloaded, row.error, row.seenAt ?? now(),
  );
}

/**
 * A property's daily rows, keyed and REPLACED.
 *
 * The overlap is the point. Google revises a day for two to three days after
 * it, so every run re-reads a window it has already seen and a row read again
 * is a correction. A merge that added them would double ninety days of
 * impressions on the second collection.
 */
export function writeGscDays(
  property: string,
  rows: { day: string; clicks: number; impressions: number; position: number | null }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO gsc_days (property, day, clicks, impressions, position, seen_at)
     VALUES (?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(property, r.day, r.clicks, r.impressions, r.position, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type GscRankedRow = {
  property: string;
  /** The query, or the page URL. One column each because they are two tables. */
  query?: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  seen_at: string;
};

/**
 * The ranked rows of ONE property, replaced.
 *
 * Scoped to the property rather than wiping the table, so a property that
 * failed this run keeps the ranking it last earned while the others refresh —
 * the rule every per-account replace in this file follows, one level down.
 */
export function replaceGscRanked(
  kind: "queries" | "pages",
  property: string,
  rows: { key: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[],
) {
  const table = kind === "queries" ? "gsc_queries" : "gsc_pages";
  const column = kind === "queries" ? "query" : "page";
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM ${table} WHERE property = ?`).run(property);
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO ${table} (property, ${column}, clicks, impressions, ctr, position, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      stmt.run(property, r.key, r.clicks, r.impressions, r.ctr, r.position, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/**
 * Properties this account can no longer see, forgotten.
 *
 * A service account removed from a property stops being able to measure it,
 * and a row left behind would keep that property on the board with figures
 * nobody can refresh. Its `gsc_days` history goes with it: the rows are keyed
 * by property alone, and a property nothing can ask about is not a series
 * anybody can extend.
 */
export function forgetGscProperties(accountId: number, keep: string[]) {
  const rows = db
    .prepare("SELECT property FROM gsc_sites WHERE account_id = ?")
    .all(accountId) as unknown as { property: string }[];
  const gone = rows.map((r) => r.property).filter((p) => !keep.includes(p));
  if (!gone.length) return 0;
  db.exec("BEGIN");
  try {
    for (const p of gone) {
      db.prepare("DELETE FROM gsc_sites WHERE property = ?").run(p);
      db.prepare("DELETE FROM gsc_days WHERE property = ?").run(p);
      db.prepare("DELETE FROM gsc_queries WHERE property = ?").run(p);
      db.prepare("DELETE FROM gsc_pages WHERE property = ?").run(p);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return gone.length;
}

export function gscSites(): GscSiteRow[] {
  return db
    .prepare("SELECT * FROM gsc_sites ORDER BY total_impressions DESC, property")
    .all() as unknown as GscSiteRow[];
}

export type GscDayRow = {
  property: string;
  day: string;
  clicks: number;
  impressions: number;
  position: number | null;
};

/** Every property's days back to a calendar day, oldest first. A DAY cutoff
 *  rather than an instant, because the key is a calendar day and comparing it
 *  to an ISO timestamp drops the newest row on every read. */
export function gscDays(days: number): GscDayRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT property, day, clicks, impressions, position
         FROM gsc_days WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as GscDayRow[];
}

export function gscRanked(kind: "queries" | "pages"): GscRankedRow[] {
  const table = kind === "queries" ? "gsc_queries" : "gsc_pages";
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY clicks DESC, impressions DESC`)
    .all() as unknown as GscRankedRow[];
}

/* ---------------------------------------------------------------- bing */

export type BingSiteRow = {
  site: string;
  account_id: number;
  account_label: string;
  verified: number | null;
  in_index: number | null;
  in_links: number | null;
  crawled_pages: number | null;
  crawl_errors: number | null;
  blocked_robots: number | null;
  crawl_day: string | null;
  linked_pages: number | null;
  link_pages_total: number | null;
  error: string | null;
  seen_at: string;
};

export function writeBingSite(row: Omit<BingSiteRow, "seen_at">) {
  db.prepare(
    `INSERT OR REPLACE INTO bing_sites
       (site, account_id, account_label, verified, in_index, in_links,
        crawled_pages, crawl_errors, blocked_robots, crawl_day,
        linked_pages, link_pages_total, error, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.site, row.account_id, row.account_label, row.verified, row.in_index,
    row.in_links, row.crawled_pages, row.crawl_errors, row.blocked_robots,
    row.crawl_day, row.linked_pages, row.link_pages_total, row.error, now(),
  );
}

export function forgetBingSites(accountId: number, keep: string[]) {
  const rows = db
    .prepare("SELECT site FROM bing_sites WHERE account_id = ?")
    .all(accountId) as unknown as { site: string }[];
  const gone = rows.map((r) => r.site).filter((s) => !keep.includes(s));
  for (const s of gone) {
    db.prepare("DELETE FROM bing_sites WHERE site = ?").run(s);
    db.prepare("DELETE FROM bing_traffic_days WHERE site = ?").run(s);
    db.prepare("DELETE FROM bing_crawl_days WHERE site = ?").run(s);
    db.prepare("DELETE FROM bing_queries WHERE site = ?").run(s);
  }
  return gone.length;
}

export type BingTrafficDayRow = {
  site: string;
  day: string;
  impressions: number | null;
  clicks: number | null;
};

export function writeBingTrafficDays(site: string, rows: BingTrafficDayRow[]) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO bing_traffic_days (site, day, impressions, clicks, seen_at)
     VALUES (?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(site, r.day, r.impressions, r.clicks, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type BingCrawlDayRow = {
  site: string;
  day: string;
  crawled_pages: number | null;
  in_index: number | null;
  in_links: number | null;
  crawl_errors: number | null;
  blocked_robots: number | null;
  code_2xx: number | null;
  code_4xx: number | null;
  code_5xx: number | null;
};

export function writeBingCrawlDays(site: string, rows: BingCrawlDayRow[]) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO bing_crawl_days
       (site, day, crawled_pages, in_index, in_links, crawl_errors,
        blocked_robots, code_2xx, code_4xx, code_5xx, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        site, r.day, r.crawled_pages, r.in_index, r.in_links, r.crawl_errors,
        r.blocked_robots, r.code_2xx, r.code_4xx, r.code_5xx, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type BingQueryRow = {
  site: string;
  query: string;
  day: string;
  impressions: number | null;
  clicks: number | null;
  position: number | null;
};

export function writeBingQueries(site: string, rows: BingQueryRow[]) {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO bing_queries
       (site, query, day, impressions, clicks, position, seen_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(site, r.query, r.day, r.impressions, r.clicks, r.position, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function bingSites(): BingSiteRow[] {
  return db
    .prepare("SELECT * FROM bing_sites ORDER BY site")
    .all() as unknown as BingSiteRow[];
}

export function bingTrafficDays(days: number): BingTrafficDayRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT site, day, impressions, clicks FROM bing_traffic_days
        WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as BingTrafficDayRow[];
}

export function bingCrawlDays(days: number): (BingCrawlDayRow & { site: string })[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT site, day, crawled_pages, in_index, in_links, crawl_errors,
              blocked_robots, code_2xx, code_4xx, code_5xx
         FROM bing_crawl_days WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as (BingCrawlDayRow & { site: string })[];
}

export function bingQueries(days: number): BingQueryRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT site, query, day, impressions, clicks, position FROM bing_queries
        WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as BingQueryRow[];
}

export type BingKeywordStateRow = {
  phrase: string;
  market: string;
  status: string;
  weeks: number | null;
  error: string | null;
  asked_at: string;
};

/**
 * One phrase's answer, weeks and all.
 *
 * THE WEEKS ARE ONLY WRITTEN ON A REAL ANSWER, and the state row is written
 * whatever happened. A phrase that came back void or unavailable keeps the
 * weeks it earned last time — those were measurements and are still true of
 * the weeks they name — while its state says the newest answer was not one.
 * Deleting them because today's call was throttled would lose a history to a
 * transport problem.
 */
export function writeBingKeyword(
  phrase: string,
  market: string,
  status: "ok" | "na" | "void" | "failed",
  weeks: { week: string; impressions: number | null; broad: number | null }[],
  error: string | null,
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    if (status === "ok") {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO bing_keyword_weeks
           (phrase, market, week, impressions, broad, seen_at) VALUES (?,?,?,?,?,?)`,
      );
      for (const w of weeks)
        stmt.run(phrase, market, w.week, w.impressions, w.broad, seen);
    }
    db.prepare(
      `INSERT OR REPLACE INTO bing_keyword_state
         (phrase, market, status, weeks, error, asked_at) VALUES (?,?,?,?,?,?)`,
    ).run(phrase, market, status, status === "ok" ? weeks.length : null, error, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Phrases the owner has taken off the list, forgotten — the same promise
 *  forgetNpmPackages makes: a name removed from a setting must not go on
 *  drawing a line on a chart. */
export function forgetBingKeywords(keep: string[]) {
  const rows = db
    .prepare("SELECT DISTINCT phrase FROM bing_keyword_state")
    .all() as unknown as { phrase: string }[];
  const gone = rows.map((r) => r.phrase).filter((p) => !keep.includes(p));
  for (const p of gone) {
    db.prepare("DELETE FROM bing_keyword_state WHERE phrase = ?").run(p);
    db.prepare("DELETE FROM bing_keyword_weeks WHERE phrase = ?").run(p);
  }
  return gone.length;
}

export function bingKeywordStates(): BingKeywordStateRow[] {
  return db
    .prepare("SELECT * FROM bing_keyword_state ORDER BY phrase")
    .all() as unknown as BingKeywordStateRow[];
}

export type BingKeywordWeekRow = {
  phrase: string;
  market: string;
  week: string;
  impressions: number | null;
  broad: number | null;
};

export function bingKeywordWeeks(): BingKeywordWeekRow[] {
  return db
    .prepare(
      `SELECT phrase, market, week, impressions, broad FROM bing_keyword_weeks
        ORDER BY phrase, week ASC`,
    )
    .all() as unknown as BingKeywordWeekRow[];
}

/* ------------------------------------------------------------------- social */

/**
 * Meta: the Pages, the ad account and what it spent.
 *
 * TWO RULES SHAPE EVERY WRITER BELOW.
 *
 * PAGES AND AD ACCOUNTS ARE REPLACED PER PLUGIN ACCOUNT, so a second Meta
 * token losing its Pages cannot take the first one's off the page — the same
 * confinement the registrars and Cloudflare keep, for the same reason.
 *
 * THE DAILY ROWS ARE REPLACED BY KEY AND NEVER DELETED WHOLESALE. They are
 * history: the chart of what the account used to spend should survive the ad
 * account being closed, exactly as `readings` survives a decommissioned box.
 * Meta revises recent days, so a re-read corrects a row rather than doubling
 * it.
 */

export type MetaPageRow = {
  page_id: string;
  account_id: number;
  account_label: string;
  name: string | null;
  followers: number | null;
  fans: number | null;
  followers_source: string | null;
  link: string | null;
  category: string | null;
  about: string | null;
  picture: string | null;
  ig_checked: number;
  ig_id: string | null;
  ig_username: string | null;
  ig_followers: number | null;
  seen_at: string;
};

export function replaceMetaPages(
  accountId: number,
  accountLabel: string,
  rows: {
    id: string;
    name: string | null;
    followers: number | null;
    fans: number | null;
    followersSource: string | null;
    link: string | null;
    category: string | null;
    about: string | null;
    picture: string | null;
    instagram: {
      checked: boolean;
      id: string | null;
      username: string | null;
      followers: number | null;
    };
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM meta_pages WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO meta_pages
         (page_id, account_id, account_label, name, followers, fans,
          followers_source, link, category, about, picture,
          ig_checked, ig_id, ig_username, ig_followers, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const p of rows)
      ins.run(
        p.id, accountId, accountLabel, p.name, p.followers, p.fans,
        p.followersSource, p.link, p.category, p.about, p.picture,
        p.instagram.checked ? 1 : 0, p.instagram.id, p.instagram.username,
        p.instagram.followers, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type MetaAdAccountRow = {
  ad_account_id: string;
  account_id: number;
  account_label: string;
  name: string | null;
  currency: string | null;
  status: number | null;
  active: number;
  timezone: string | null;
  created_at: string | null;
  lifetime_spend: number | null;
  window_from: string | null;
  window_to: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  cpc: number | null;
  ctr: number | null;
  reach: number | null;
  frequency: number | null;
  leads: number | null;
  cost_per_lead: number | null;
  roas: number | null;
  note: string | null;
  seen_at: string;
};

type MetaWindow = {
  from: string | null;
  to: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  cpc: number | null;
  ctr: number | null;
  reach: number | null;
  frequency: number | null;
  leads: number | null;
  costPerLead: number | null;
  roas: number | null;
};

export function replaceMetaAdAccounts(
  accountId: number,
  accountLabel: string,
  rows: {
    id: string;
    name: string | null;
    currency: string | null;
    status: number | null;
    active: boolean;
    timezone: string | null;
    createdAt: string | null;
    lifetimeSpend: number | null;
    window: MetaWindow | null;
    note: string | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM meta_ad_accounts WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO meta_ad_accounts
         (ad_account_id, account_id, account_label, name, currency, status,
          active, timezone, created_at, lifetime_spend, window_from, window_to,
          spend, impressions, clicks, cpc, ctr, reach, frequency, leads,
          cost_per_lead, roas, note, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of rows) {
      const w = a.window;
      ins.run(
        a.id, accountId, accountLabel, a.name, a.currency, a.status,
        a.active ? 1 : 0, a.timezone, a.createdAt, a.lifetimeSpend,
        w?.from ?? null, w?.to ?? null, w?.spend ?? null, w?.impressions ?? null,
        w?.clicks ?? null, w?.cpc ?? null, w?.ctr ?? null, w?.reach ?? null,
        w?.frequency ?? null, w?.leads ?? null, w?.costPerLead ?? null,
        w?.roas ?? null, a.note, seen,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type MetaCampaignRow = {
  campaign_id: string;
  ad_account_id: string;
  name: string | null;
  status: string | null;
  objective: string | null;
  window_from: string | null;
  window_to: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  reach: number | null;
  frequency: number | null;
  leads: number | null;
  cost_per_lead: number | null;
  seen_at: string;
};

/** One ad account's campaigns. Scoped to the ad account rather than the plugin
 *  account, so an edge that refuses for one loses only its own rows. */
export function replaceMetaCampaigns(
  adAccountId: string,
  rows: {
    id: string;
    name: string | null;
    status: string | null;
    objective: string | null;
    window: MetaWindow | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM meta_campaigns WHERE ad_account_id = ?").run(adAccountId);
    const ins = db.prepare(
      `INSERT INTO meta_campaigns
         (campaign_id, ad_account_id, name, status, objective, window_from,
          window_to, spend, impressions, clicks, ctr, reach, frequency, leads,
          cost_per_lead, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const c of rows) {
      const w = c.window;
      ins.run(
        c.id, adAccountId, c.name, c.status, c.objective, w?.from ?? null,
        w?.to ?? null, w?.spend ?? null, w?.impressions ?? null, w?.clicks ?? null,
        w?.ctr ?? null, w?.reach ?? null, w?.frequency ?? null, w?.leads ?? null,
        w?.costPerLead ?? null, seen,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type MetaAdDayRow = {
  ad_account_id: string;
  day: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
};

export function writeMetaAdDays(
  rows: {
    adAccountId: string;
    day: string;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    leads: number | null;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO meta_ad_days
         (ad_account_id, day, spend, impressions, clicks, leads, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(r.adAccountId, r.day, r.spend, r.impressions, r.clicks, r.leads, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type MetaStateRow = {
  account_id: number;
  account_label: string;
  graph_user: string | null;
  graph_user_id: string | null;
  proofed: number;
  pages: number;
  pages_checked: number;
  ig_linked: number;
  ad_accounts: number;
  note: string | null;
  seen_at: string;
};

export function writeMetaState(
  accountId: number,
  accountLabel: string,
  state: {
    user: string | null;
    userId: string | null;
    proofed: boolean;
    pages: number;
    pagesChecked: number;
    igLinked: number;
    adAccounts: number;
    note: string | null;
  },
) {
  db.prepare(
    `INSERT OR REPLACE INTO meta_state
       (account_id, account_label, graph_user, graph_user_id, proofed, pages,
        pages_checked, ig_linked, ad_accounts, note, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    accountId, accountLabel, state.user, state.userId, state.proofed ? 1 : 0,
    state.pages, state.pagesChecked, state.igLinked, state.adAccounts,
    state.note, now(),
  );
}

export function metaPages(): MetaPageRow[] {
  return db
    .prepare("SELECT * FROM meta_pages ORDER BY followers DESC, name")
    .all() as unknown as MetaPageRow[];
}

export function metaAdAccounts(): MetaAdAccountRow[] {
  return db
    .prepare("SELECT * FROM meta_ad_accounts ORDER BY name")
    .all() as unknown as MetaAdAccountRow[];
}

export function metaCampaigns(): MetaCampaignRow[] {
  return db
    .prepare(
      `SELECT * FROM meta_campaigns
        ORDER BY COALESCE(spend, -1) DESC, name`,
    )
    .all() as unknown as MetaCampaignRow[];
}

/**
 * Daily rows back to a calendar day, oldest first.
 *
 * A DAY CUTOFF rather than an instant, the way cloudflareTraffic takes one: the
 * key is a calendar day and comparing it against an ISO timestamp would drop
 * today's row on every read. The route slices its own window out of this.
 */
export function metaAdDays(days: number): MetaAdDayRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT ad_account_id, day, spend, impressions, clicks, leads
         FROM meta_ad_days
        WHERE day >= ?
        ORDER BY day ASC`,
    )
    .all(since) as unknown as MetaAdDayRow[];
}

export function metaState(): MetaStateRow[] {
  return db
    .prepare("SELECT * FROM meta_state ORDER BY account_id")
    .all() as unknown as MetaStateRow[];
}

/* ------------------------------------------------------------------ demand */

/**
 * Reddit, Hacker News and the search node behind them.
 *
 * TWO RULES SHAPE EVERY WRITER BELOW, and they are the same two the rest of
 * this file keeps — they just bite harder here, because this is the only data
 * on the box that arrives from strangers over endpoints nobody is obliged to
 * serve.
 *
 * A ROW IS NEVER DELETED BY A FAILURE. A phrase that could not be asked this
 * morning keeps every thread it has already found, because those threads were
 * really posted and are still really there; what changes is the QUERY's status
 * beside them, which is what a card reads to decide whether to trust the count.
 *
 * AN UNMEASURED FIELD NEVER OVERWRITES A MEASURED ONE. A thread the Atom feed
 * scored at 40 and SearXNG later re-found carries 40 and a tier of `searxng`,
 * not a null — the score was true when it was measured and is still true of
 * the moment it names. This is bing_keyword_weeks' rule, and the alternative
 * is a card whose numbers vanish the day Reddit throttles.
 */

export type DemandItemRow = {
  source: string;
  id: string;
  term: string;
  title: string;
  url: string;
  context: string | null;
  created_at: string | null;
  points: number | null;
  comments: number | null;
  tier: string;
  first_seen_at: string;
  seen_at: string;
};

export type DemandItemWrite = Omit<DemandItemRow, "first_seen_at" | "seen_at">;

/**
 * One source's rows for one collection, in one transaction.
 *
 * `first_seen_at` is preserved on conflict and the counts are COALESCEd — the
 * two halves of the second rule above. Everything else is overwritten, because
 * a title can be edited and a tier changes with whoever answered.
 */
export function writeDemandItems(rows: DemandItemWrite[]): number {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT INTO demand_items
       (source, id, term, title, url, context, created_at, points, comments,
        tier, first_seen_at, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, id, term) DO UPDATE SET
       title      = excluded.title,
       url        = excluded.url,
       context    = COALESCE(excluded.context, demand_items.context),
       created_at = COALESCE(excluded.created_at, demand_items.created_at),
       points     = COALESCE(excluded.points, demand_items.points),
       comments   = COALESCE(excluded.comments, demand_items.comments),
       tier       = excluded.tier,
       seen_at    = excluded.seen_at`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.source,
        r.id,
        r.term,
        r.title,
        r.url,
        r.context,
        r.created_at,
        r.points,
        r.comments,
        r.tier,
        seen,
        seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/** Everything held, newest thread first. The route does the windowing, on the
 *  read, against each row's own date — a "signals this month" written down at
 *  collection time would be wrong by tomorrow morning. */
export function demandItems(): DemandItemRow[] {
  return db
    .prepare(
      `SELECT * FROM demand_items
        ORDER BY (created_at IS NULL), created_at DESC, first_seen_at DESC`,
    )
    .all() as unknown as DemandItemRow[];
}

export type DemandQueryRow = {
  source: string;
  term: string;
  status: string;
  tier: string | null;
  items: number | null;
  error: string | null;
  asked_at: string;
};

export function writeDemandQuery(
  row: Omit<DemandQueryRow, "asked_at">,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO demand_queries
       (source, term, status, tier, items, error, asked_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(row.source, row.term, row.status, row.tier, row.items, row.error, now());
}

export function demandQueries(source?: string): DemandQueryRow[] {
  return (
    source
      ? db
          .prepare("SELECT * FROM demand_queries WHERE source = ? ORDER BY term")
          .all(source)
      : db.prepare("SELECT * FROM demand_queries ORDER BY source, term").all()
  ) as unknown as DemandQueryRow[];
}

/**
 * The phrases of one source, STALEST FIRST — which is how the collector
 * decides what to spend Reddit's minute-wide budget on.
 *
 * A phrase nobody has ever asked sorts first, ahead of every phrase that has
 * an answer of any age. That is the escape the Bing collector keeps for a
 * newly typed phrase and the GitHub one keeps for a repo it has never seen,
 * and for the same reason: the point of typing a list in at nine is to see it.
 *
 * A 'skipped' ROW COUNTS AS NEVER ASKED, which is the whole reason the budget
 * is survivable. That status means this collector chose not to spend a request
 * on the phrase, so its `asked_at` records when we declined rather than when
 * Reddit answered — sorted by it, the phrase we just deferred would go to the
 * BACK of the queue and the same first phrase would be asked every run,
 * forever, while the tail was never asked at all.
 */
export function demandOrderedTerms(source: string, terms: string[]): string[] {
  const asked = new Map(
    demandQueries(source)
      .filter((q) => q.status !== "skipped")
      .map((q) => [q.term, q.asked_at] as const),
  );
  return [...terms].sort((a, b) => {
    const at = asked.get(a);
    const bt = asked.get(b);
    if (at === undefined && bt === undefined) return terms.indexOf(a) - terms.indexOf(b);
    if (at === undefined) return -1;
    if (bt === undefined) return 1;
    return at.localeCompare(bt);
  });
}

/**
 * Phrases the owner has taken off the list, forgotten — items and query
 * states alike.
 *
 * The promise forgetNpmPackages and forgetBingKeywords make: a phrase removed
 * from a setting must not go on contributing to a count on a card that no
 * longer names it. A thread that was found by a phrase that stays keeps its
 * own row, because the key carries the term.
 */
export function forgetDemandTerms(keep: string[]): number {
  const rows = db
    .prepare("SELECT DISTINCT term FROM demand_queries")
    .all() as unknown as { term: string }[];
  const items = db
    .prepare("SELECT DISTINCT term FROM demand_items")
    .all() as unknown as { term: string }[];
  const gone = [...new Set([...rows, ...items].map((r) => r.term))].filter(
    (t) => !keep.includes(t),
  );
  for (const term of gone) {
    db.prepare("DELETE FROM demand_queries WHERE term = ?").run(term);
    db.prepare("DELETE FROM demand_items WHERE term = ?").run(term);
  }
  return gone.length;
}

/**
 * Items nobody has seen for a long time, dropped.
 *
 * On the LONG retention and keyed on `seen_at` rather than on the thread's own
 * date: a thread that keeps coming back in the search results is still an
 * answer to the phrase, however old it is, and one that has stopped coming
 * back stopped being one the day it fell out of the window. The route windows
 * on `created_at` regardless, so nothing here decides what a card counts.
 */
export function pruneDemand(retainDays: number): number {
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
  return Number(
    db.prepare("DELETE FROM demand_items WHERE seen_at < ?").run(cutoff).changes,
  );
}

/* ---------------------------------------------------------------- searxng */

export type SearxngStateRow = {
  account_id: number;
  account_label: string;
  url: string;
  ok: number;
  query: string | null;
  results: number | null;
  /** Of those, how many were on the host the query restricted itself to. */
  on_site: number | null;
  ms: number | null;
  engines_ok: number | null;
  engines_bad: number | null;
  error: string | null;
  seen_at: string;
};

export function writeSearxngState(row: Omit<SearxngStateRow, "seen_at">) {
  db.prepare(
    `INSERT OR REPLACE INTO searxng_state
       (account_id, account_label, url, ok, query, results, on_site, ms,
        engines_ok, engines_bad, error, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.account_id,
    row.account_label,
    row.url,
    row.ok,
    row.query,
    row.results,
    row.on_site,
    row.ms,
    row.engines_ok,
    row.engines_bad,
    row.error,
    now(),
  );
}

export function searxngStates(): SearxngStateRow[] {
  return db
    .prepare("SELECT * FROM searxng_state ORDER BY account_id")
    .all() as unknown as SearxngStateRow[];
}

export type SearxngEngineRow = {
  account_id: number;
  engine: string;
  results: number;
  refused: string | null;
  seen_at: string;
};

/**
 * One probe's engine outcomes, replacing that account's previous ones.
 *
 * REPLACED WHOLESALE RATHER THAN ACCUMULATED, the way the zone and repo
 * inventories are: this is a STATE — which engines are working right now — and
 * an engine that has been taken out of the node's configuration should leave
 * the table rather than sit there forever with its last excuse. A failed probe
 * writes nothing here at all, so the last known engine state survives a
 * network blip instead of being replaced by an empty list that would read as
 * "no engines".
 */
export function replaceSearxngEngines(
  accountId: number,
  rows: Omit<SearxngEngineRow, "account_id" | "seen_at">[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM searxng_engines WHERE account_id = ?").run(accountId);
    const stmt = db.prepare(
      `INSERT INTO searxng_engines (account_id, engine, results, refused, seen_at)
       VALUES (?,?,?,?,?)`,
    );
    for (const r of rows) stmt.run(accountId, r.engine, r.results, r.refused, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function searxngEngines(): SearxngEngineRow[] {
  return db
    .prepare(
      `SELECT * FROM searxng_engines
        ORDER BY (refused IS NOT NULL), results DESC, engine`,
    )
    .all() as unknown as SearxngEngineRow[];
}

/* ---------------------------------------------------------------- telegram */

export type TelegramStateRow = {
  account_id: number;
  bot_id: number | null;
  bot_username: string | null;
  next_offset: number;
  handled: number;
  ignored: number;
  last_message_at: string | null;
  last_reply_at: string | null;
  last_ignored_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  updated_at: string;
};

/** The row exists from the moment a poller starts, so "connected and nothing
 *  has happened yet" is a row of zeroes rather than a missing row that every
 *  reader would have to treat as a third state. */
function telegramRow(accountId: number) {
  db.prepare(
    `INSERT INTO telegram_state (account_id, updated_at) VALUES (?, ?)
     ON CONFLICT(account_id) DO NOTHING`,
  ).run(accountId, now());
}

/** What getMe said this token is. Written once per poller start: a token
 *  replaced with another bot's changes the answer, and the label on the
 *  accounts page should follow it. */
export function writeTelegramBot(
  accountId: number,
  botId: number | null,
  username: string | null,
) {
  telegramRow(accountId);
  db.prepare(
    `UPDATE telegram_state
        SET bot_id = ?, bot_username = ?, updated_at = ?
      WHERE account_id = ?`,
  ).run(botId, username, now(), accountId);
}

/**
 * How far through the update stream this bot has got.
 *
 * Written AFTER an update has been dealt with, never before: Telegram
 * redelivers anything the offset has not passed, so a crash between receiving
 * and replying costs a duplicate delivery — which the bridge can cope with —
 * while a cursor written first would cost a lost message, which nothing can.
 */
export function writeTelegramOffset(accountId: number, nextOffset: number) {
  telegramRow(accountId);
  db.prepare(
    `UPDATE telegram_state SET next_offset = ?, updated_at = ? WHERE account_id = ?`,
  ).run(nextOffset, now(), accountId);
}

/**
 * One more message seen, on one side of the lock or the other.
 *
 * Two counters rather than one with a flag, because they answer two questions
 * that are never asked together: "is this working" and "has somebody else
 * found this bot".
 */
export function countTelegramMessage(accountId: number, kind: "handled" | "ignored") {
  telegramRow(accountId);
  const stamp = now();
  if (kind === "handled")
    db.prepare(
      `UPDATE telegram_state
          SET handled = handled + 1, last_message_at = ?, updated_at = ?
        WHERE account_id = ?`,
    ).run(stamp, stamp, accountId);
  else
    db.prepare(
      `UPDATE telegram_state
          SET ignored = ignored + 1, last_ignored_at = ?, updated_at = ?
        WHERE account_id = ?`,
    ).run(stamp, stamp, accountId);
}

/** A reply actually left for Telegram. Separate from `handled`, because a
 *  message received and a message answered are different events and the gap
 *  between the two timestamps is the whole diagnosis when a bridge is sick. */
export function writeTelegramReply(accountId: number) {
  telegramRow(accountId);
  const stamp = now();
  db.prepare(
    `UPDATE telegram_state SET last_reply_at = ?, updated_at = ? WHERE account_id = ?`,
  ).run(stamp, stamp, accountId);
}

/** The last failure, or null to clear it. Null on purpose rather than an
 *  untouched column: an error left standing after the next success is a red
 *  mark on a working bot. */
export function writeTelegramError(accountId: number, error: string | null) {
  telegramRow(accountId);
  db.prepare(
    `UPDATE telegram_state
        SET last_error = ?, last_error_at = ?, updated_at = ?
      WHERE account_id = ?`,
  ).run(error, error ? now() : null, now(), accountId);
}

export function telegramStates(): TelegramStateRow[] {
  return db
    .prepare("SELECT * FROM telegram_state ORDER BY account_id")
    .all() as unknown as TelegramStateRow[];
}

export function telegramState(accountId: number): TelegramStateRow | undefined {
  return db
    .prepare("SELECT * FROM telegram_state WHERE account_id = ?")
    .get(accountId) as TelegramStateRow | undefined;
}

/**
 * THE BRIDGE'S CONVERSATIONS LIVE IN `chat_messages`, NOT IN A TABLE OF ITS OWN.
 *
 * 017 created one — `telegram_messages` — and 018 drops it again, because
 * 016_chat landed the transcript this bridge needs while it was being written,
 * and its header says in as many words that a second store would be the same
 * agent with amnesia on whichever door you did not come in through. So the
 * bridge writes its turns with `appendChatMessage` and reads them with
 * `chatMessages`, under the session id `telegram:<chat id>`, exactly as the
 * Chat page writes its own under `s-1`.
 *
 * What is left here is the pair of questions the shared helpers do not answer:
 * how long one bridge conversation is, and which of them belong to pairings
 * that no longer exist.
 */

/** How many turns one bridged conversation holds. A COUNT rather than a read,
 *  because the plugin page wants the number and has no business loading a
 *  transcript to get it. */
export function telegramSessionTurns(sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?")
    .get(sessionId) as { n: number };
  return row.n;
}

/**
 * Forget every bridged conversation except the ones still paired.
 *
 * The settings door can clear or repoint a lock without saying what the old
 * value was, so this is the sweep behind it: a conversation whose chat is
 * paired with nothing can never be continued by anybody, and the words of a
 * chat the owner deliberately un-paired should not sit in the database
 * indefinitely.
 *
 * SCOPED TO `telegram:` SESSIONS, and that prefix is doing real work: the
 * table it sweeps is shared with the Chat page, whose sessions this has no
 * business deleting.
 */
export function forgetTelegramSessionsExcept(keep: string[]): number {
  const rows = db
    .prepare("SELECT DISTINCT session_id FROM chat_messages WHERE session_id LIKE 'telegram:%'")
    .all() as unknown as { session_id: string }[];
  const wanted = new Set(keep);
  let forgotten = 0;
  for (const row of rows) {
    if (wanted.has(row.session_id)) continue;
    forgotten += deleteChatSession(row.session_id);
  }
  return forgotten;
}

/* --------------------------------------------------------------------- mail */

/**
 * Gmail and Resend: what arrives and what leaves.
 *
 * THREE RULES SHAPE EVERY WRITER BELOW, and they are the ones this file already
 * keeps for Meta and Cloudflare.
 *
 * MAILBOXES, LABELS AND DOMAINS ARE REPLACED PER PLUGIN ACCOUNT, so a second
 * Gmail grant expiring cannot take the first mailbox's labels off the page, and
 * one Resend key going bad cannot take the other ten domains' verification with
 * it.
 *
 * THE DAY-GRAINED AND EMAIL-GRAINED ROWS ARE REPLACED BY KEY AND NEVER DELETED
 * WHOLESALE. They are history, they outlive the credential that read them, and
 * re-reading a window corrects rows rather than doubling them — which is the
 * whole reason `resend_emails` can be trusted for a bounce rate: `last_event`
 * moves after the fact and only a keyed replace catches it.
 *
 * NOTHING BELOW CAN CARRY AN IDENTITY. There is no parameter on any of these
 * functions that takes a subject, a body, a recipient or a correspondent's
 * address — the closest is a fingerprint, which the provider computes and
 * nothing reverses.
 */

/** The HMAC key behind every correspondent fingerprint. Generated once by the
 *  migration with SQLite's own `randomblob`, read here, and never leaving the
 *  server. */
export function mailSalt(): Buffer {
  const row = db.prepare("SELECT salt FROM mail_secret WHERE id = 1").get() as
    | { salt: Uint8Array }
    | undefined;
  if (!row) throw new Error("mail_secret is missing — 015_mail did not apply.");
  return Buffer.from(row.salt);
}

export type GmailMailboxRow = {
  account_id: number;
  account_label: string;
  address: string | null;
  messages_total: number | null;
  threads_total: number | null;
  labels_total: number | null;
  history_id: string | null;
  scopes: string | null;
  note: string | null;
  seen_at: string;
};

export type GmailLabelRow = {
  account_id: number;
  label_id: string;
  name: string;
  kind: string;
  messages_total: number | null;
  messages_unread: number | null;
  threads_total: number | null;
  threads_unread: number | null;
  scanned: number | null;
  needing_reply: number | null;
  oldest_waiting_days: number | null;
  truncated: number;
  note: string | null;
  seen_at: string;
};

/** One mailbox and its labels, in one transaction. Half a mailbox — an identity
 *  with last run's labels under it — is a page that reads as current and is
 *  not. */
export function replaceGmailMailbox(
  accountId: number,
  accountLabel: string,
  mailbox: {
    address: string | null;
    messagesTotal: number | null;
    threadsTotal: number | null;
    historyId: string | null;
    scopes: string[];
    note: string | null;
  },
  labels: {
    id: string;
    name: string;
    kind: string;
    messagesTotal: number | null;
    messagesUnread: number | null;
    threadsTotal: number | null;
    threadsUnread: number | null;
    scanned: number | null;
    needingReply: number | null;
    oldestWaitingDays: number | null;
    truncated: boolean;
    note: string | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT OR REPLACE INTO gmail_mailboxes
         (account_id, account_label, address, messages_total, threads_total,
          labels_total, history_id, scopes, note, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      accountId, accountLabel, mailbox.address, mailbox.messagesTotal,
      mailbox.threadsTotal, labels.length, mailbox.historyId,
      mailbox.scopes.join(" ") || null, mailbox.note, seen,
    );
    db.prepare("DELETE FROM gmail_labels WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO gmail_labels
         (account_id, label_id, name, kind, messages_total, messages_unread,
          threads_total, threads_unread, scanned, needing_reply,
          oldest_waiting_days, truncated, note, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const l of labels)
      ins.run(
        accountId, l.id, l.name, l.kind, l.messagesTotal, l.messagesUnread,
        l.threadsTotal, l.threadsUnread, l.scanned, l.needingReply,
        l.oldestWaitingDays, l.truncated ? 1 : 0, l.note, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return labels.length;
}

export type GmailDayRow = {
  address: string;
  day: string;
  received: number | null;
  sent: number | null;
  received_capped: number;
  sent_capped: number;
};

export function writeGmailDays(
  address: string,
  rows: {
    day: string;
    received: number;
    sent: number;
    receivedCapped: boolean;
    sentCapped: boolean;
  }[],
) {
  if (!address || !rows.length) return 0;
  const seen = now();
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO gmail_days
         (address, day, received, sent, received_capped, sent_capped, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(
        address, r.day, r.received, r.sent,
        r.receivedCapped ? 1 : 0, r.sentCapped ? 1 : 0, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/** Which days this mailbox already has. A finished day does not gain mail, so
 *  the collector asks about it once — this is the set it checks against. */
export function gmailKnownDays(address: string): Set<string> {
  if (!address) return new Set();
  const rows = db
    .prepare("SELECT day FROM gmail_days WHERE address = ?")
    .all(address) as unknown as { day: string }[];
  return new Set(rows.map((r) => r.day));
}

export function gmailDays(days: number): GmailDayRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT address, day, received, sent, received_capped, sent_capped
         FROM gmail_days WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as GmailDayRow[];
}

/**
 * The people this mailbox wrote to.
 *
 * first_at is MINIMISED against what is already held and the other two are
 * taken from the run, because they measure different things: the first is a
 * fact about a relationship that only ever gets older, and the other two are
 * this window's activity. Without the MIN, every contact would be "new" on
 * every collection.
 */
export function writeGmailCorrespondents(
  mailbox: string,
  rows: { fingerprint: string; firstAt: string; lastAt: string; messages: number }[],
) {
  if (!mailbox || !rows.length) return 0;
  const seen = now();
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      `INSERT INTO gmail_correspondents
         (mailbox, fingerprint, first_at, last_at, messages, seen_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(mailbox, fingerprint) DO UPDATE SET
         first_at = MIN(first_at, excluded.first_at),
         last_at  = MAX(last_at,  excluded.last_at),
         messages = excluded.messages,
         seen_at  = excluded.seen_at`,
    );
    for (const r of rows)
      ins.run(mailbox, r.fingerprint, r.firstAt, r.lastAt, r.messages, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type GmailCorrespondentRow = {
  mailbox: string;
  fingerprint: string;
  first_at: string;
  last_at: string;
  messages: number;
};

/** Every correspondent row, for counting. The fingerprint comes back so the
 *  route can de-duplicate a person written to from two mailboxes; nothing
 *  renders it and nothing could. */
export function gmailCorrespondents(): GmailCorrespondentRow[] {
  return db
    .prepare(
      `SELECT mailbox, fingerprint, first_at, last_at, messages
         FROM gmail_correspondents ORDER BY last_at DESC`,
    )
    .all() as unknown as GmailCorrespondentRow[];
}

export function gmailMailboxes(): GmailMailboxRow[] {
  return db
    .prepare("SELECT * FROM gmail_mailboxes ORDER BY account_id")
    .all() as unknown as GmailMailboxRow[];
}

export function gmailLabels(): GmailLabelRow[] {
  return db
    .prepare(
      `SELECT * FROM gmail_labels
        ORDER BY account_id, (label_id <> 'INBOX'), name`,
    )
    .all() as unknown as GmailLabelRow[];
}

/* ------------------------------------------------------------------ resend */

export type ResendDomainRow = {
  domain_id: string;
  account_id: number;
  account_label: string;
  name: string;
  status: string | null;
  region: string | null;
  created_at: string | null;
  sending: string | null;
  receiving: string | null;
  open_tracking: number | null;
  click_tracking: number | null;
  records_read: number;
  note: string | null;
  seen_at: string;
};

export type ResendDnsRow = {
  domain_id: string;
  record: string;
  type: string;
  name: string;
  status: string | null;
  priority: number | null;
};

/** One key's domains and their records, replaced together. The cascade on
 *  resend_dns is what keeps a deleted domain from leaving its records behind
 *  as a set of rows nothing points at. */
export function replaceResendDomains(
  accountId: number,
  accountLabel: string,
  rows: {
    id: string;
    name: string;
    status: string | null;
    region: string | null;
    createdAt: string | null;
    sending: string | null;
    receiving: string | null;
    openTracking: boolean | null;
    clickTracking: boolean | null;
    recordsRead: boolean;
    records: {
      record: string | null;
      type: string | null;
      name: string | null;
      status: string | null;
      priority: number | null;
    }[];
  }[],
  note: string | null,
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM resend_domains WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO resend_domains
         (domain_id, account_id, account_label, name, status, region, created_at,
          sending, receiving, open_tracking, click_tracking, records_read, note, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const dns = db.prepare(
      `INSERT OR REPLACE INTO resend_dns
         (domain_id, record, type, name, status, priority, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const d of rows) {
      ins.run(
        d.id, accountId, accountLabel, d.name, d.status, d.region, d.createdAt,
        d.sending, d.receiving,
        d.openTracking === null ? null : d.openTracking ? 1 : 0,
        d.clickTracking === null ? null : d.clickTracking ? 1 : 0,
        d.recordsRead ? 1 : 0, note, seen,
      );
      for (const r of d.records)
        dns.run(
          d.id, r.record ?? "?", r.type ?? "?", r.name ?? "", r.status,
          r.priority, seen,
        );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export type ResendEmailRow = {
  email_id: string;
  domain: string;
  day: string;
  created_at: string;
  from_address: string | null;
  last_event: string | null;
};

export function writeResendEmails(
  rows: {
    id: string;
    domain: string;
    day: string;
    createdAt: string;
    fromAddress: string | null;
    lastEvent: string | null;
  }[],
) {
  if (!rows.length) return 0;
  const seen = now();
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO resend_emails
         (email_id, domain, day, created_at, from_address, last_event, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(r.id, r.domain, r.day, r.createdAt, r.fromAddress, r.lastEvent, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function writeResendState(
  accountId: number,
  accountLabel: string,
  state: {
    domains: number;
    emails: number;
    pages: number;
    oldest: string | null;
    truncated: boolean;
    note: string | null;
  },
) {
  db.prepare(
    `INSERT OR REPLACE INTO resend_state
       (account_id, account_label, domains, emails, pages, oldest, truncated, note, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    accountId, accountLabel, state.domains, state.emails, state.pages,
    state.oldest, state.truncated ? 1 : 0, state.note, now(),
  );
}

export function resendDomains(): ResendDomainRow[] {
  return db
    .prepare("SELECT * FROM resend_domains ORDER BY name")
    .all() as unknown as ResendDomainRow[];
}

export function resendDns(): ResendDnsRow[] {
  return db
    .prepare(
      `SELECT domain_id, record, type, name, status, priority
         FROM resend_dns ORDER BY domain_id, record, name`,
    )
    .all() as unknown as ResendDnsRow[];
}

/** Emails back to a calendar day, oldest first. A day cutoff rather than an
 *  instant, the way metaAdDays takes one: the key is a day, and comparing it
 *  against an ISO timestamp would drop today's rows on every read. */
export function resendEmails(days: number): ResendEmailRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT email_id, domain, day, created_at, from_address, last_event
         FROM resend_emails WHERE day >= ? ORDER BY day ASC`,
    )
    .all(since) as unknown as ResendEmailRow[];
}

export type ResendStateRow = {
  account_id: number;
  account_label: string;
  domains: number;
  emails: number;
  pages: number;
  oldest: string | null;
  truncated: number;
  note: string | null;
  seen_at: string;
};

export function resendState(): ResendStateRow[] {
  return db
    .prepare("SELECT * FROM resend_state ORDER BY account_id")
    .all() as unknown as ResendStateRow[];
}

/**
 * The two mail history tables age with the long retention.
 *
 * They are a few dozen rows a day between them, and the questions they answer —
 * "was the inbox this bad in March", "when did that domain start bouncing" —
 * are asked of history, which is exactly what a thirty-day window is not for.
 * Both keys are calendar days, so both take the sliced cutoff.
 *
 * gmail_correspondents is deliberately NOT pruned here. Its whole value is
 * first_at, which only means something because it accumulates: aged out on the
 * same clock, every contact would turn "new" again the day its first row
 * expired.
 */
export function pruneMail(retainDays: number) {
  const dayCutoff = new Date(Date.now() - retainDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return (
    Number(db.prepare("DELETE FROM gmail_days WHERE day < ?").run(dayCutoff).changes) +
    Number(db.prepare("DELETE FROM resend_emails WHERE day < ?").run(dayCutoff).changes)
  );
}

/* -------------------------------------------------------------------- chat */

/**
 * The transcript store, shared by every door onto the agent.
 *
 * There is deliberately no `prune` beside these. Everything else in this file
 * is a MEASUREMENT — a fleet as it was at nine, a day's spend, a week of
 * downloads — and a measurement that is a month old has been replaced by a
 * newer one. A conversation is not that. It is the only thing on this
 * dashboard that was authored rather than collected, and ageing it out on the
 * retention clock would quietly delete the one kind of row the owner would
 * actually miss.
 */
/**
 * One tool call an agent made while writing an answer, as it is stored.
 *
 * ONE RECORD PER CALL, NOT PER EVENT. Hermes streams two named SSE events for
 * every call — running, then completed — and keeping both would store the same
 * tool name and label twice to record two timestamps. Merged on the way in,
 * they are one thing that happened with a start and an end, which is also what
 * the page draws: "💻 terminal · date · completed in 0.8s".
 *
 * `finishedAt` is null while a call is still running, and STAYS null on a turn
 * that was cut off mid-call — which is a fact worth keeping rather than
 * rounding to the moment the stream died. Null here is "asked and not told",
 * exactly as everywhere else in this file.
 *
 * `offset` is how many characters of the answer had been streamed when the
 * call started. It is what a reloaded transcript needs to put the grey line
 * back BETWEEN the paragraphs it happened between; without it every stored
 * tool call renders in a pile at the end of the message, which is a different
 * story about what the agent did.
 */
export type ChatToolCall = {
  toolCallId: string;
  tool: string;
  label: string | null;
  emoji: string | null;
  startedAt: string;
  finishedAt: string | null;
  offset: number;
};

export type ChatMessageRow = {
  id: number;
  session_id: string;
  ts: string;
  role: "user" | "assistant" | "system";
  content: string;
  backend: string | null;
  channel: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  ms: number | null;
  /** JSON: `ChatToolCall[]`. Null means the turn made no tool calls OR was not
   *  streamed — the two are indistinguishable here on purpose, because "an
   *  agent that used no tools" and "a turn that could not have reported them"
   *  both draw the same message. */
  tools: string | null;
  /** 1 when the answer was cut off before the agent finished it. */
  partial: number;
};

export function appendChatMessage(m: {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  channel: string;
  backend?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  ms?: number | null;
  /** Serialised here rather than by the caller, so there is one place that
   *  decides an empty list is stored as null. */
  tools?: ChatToolCall[] | null;
  partial?: boolean;
}): ChatMessageRow {
  const info = db
    .prepare(
      `INSERT INTO chat_messages
         (session_id, ts, role, content, backend, channel, model,
          prompt_tokens, completion_tokens, ms, tools, partial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.sessionId,
      now(),
      m.role,
      m.content,
      m.backend ?? null,
      m.channel,
      m.model ?? null,
      m.promptTokens ?? null,
      m.completionTokens ?? null,
      m.ms ?? null,
      m.tools && m.tools.length ? JSON.stringify(m.tools) : null,
      m.partial ? 1 : 0,
    );
  return db
    .prepare("SELECT * FROM chat_messages WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as unknown as ChatMessageRow;
}

/**
 * One session, oldest first, which is the order it is read in.
 *
 * `limit` takes the LAST n rather than the first, because a conversation's
 * recent end is the part anybody wants — and because this is what builds the
 * turns sent to the agent, where the limit is a context budget rather than a
 * page size. Taking the oldest n would send an agent the beginning of a long
 * conversation and none of what was just said to it.
 */
export function chatMessages(sessionId: string, limit = 200): ChatMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as ChatMessageRow[];
  return rows.reverse();
}

/**
 * Every conversation that has a message in it, newest activity first.
 *
 * WHY THERE IS STILL NO `chat_sessions` TABLE, which is the obvious thing to
 * add the moment somebody asks for a session LIST.
 *
 * 016_chat's header settled it and nothing since has changed the argument:
 * sessions are the CLIENT's idea. The browser creates them, names them,
 * renames them and deletes them, and it does all of that in localStorage
 * beside the ventures and dashboards they sit with. A table here would make
 * two authorities on one name — the rail's, and the server's — and the first
 * rename would put them out of step with no rule for which wins.
 *
 * So this is a DERIVATION and not a record. `title` is the first thing the
 * owner said in the conversation, which is the best guess available to
 * something that was never told the name; the page is free to overwrite it
 * with a name it holds, and does. What the server IS the authority on is what
 * this actually answers: which session ids have messages, how many, and when.
 * Those are facts about rows, and rows are this file's business.
 *
 * Capped at 200 characters rather than shortened to a rail-width label. Where
 * to trim a title for display is a layout question, and answering it here
 * would put the rail's pixel budget in a SQL file.
 */
export type ChatSessionSummary = {
  sessionId: string;
  title: string | null;
  messages: number;
  firstAt: string;
  lastAt: string;
  /** Which doors this conversation came in by — 'web', 'telegram', or both.
   *  Sorted, so the value is stable to compare. */
  channels: string[];
};

export function chatSessionSummaries(): ChatSessionSummary[] {
  const rows = db
    .prepare(
      `SELECT session_id,
              COUNT(*)            AS messages,
              MIN(ts)             AS first_at,
              MAX(ts)             AS last_at,
              MAX(id)             AS last_id,
              -- The first thing the owner said, which is the only text in the
              -- conversation that was not written by a machine and is
              -- therefore the only honest candidate for a name. A session that
              -- somehow holds no user turn gets null rather than the agent's
              -- opening words, and the caller says "Untitled" in its own
              -- voice.
              (SELECT substr(m2.content, 1, 200)
                 FROM chat_messages m2
                WHERE m2.session_id = m.session_id
                  AND m2.role = 'user'
                ORDER BY m2.id
                LIMIT 1)          AS title
         FROM chat_messages m
        GROUP BY session_id
        -- By the newest ROW rather than the newest timestamp: two messages
        -- written in the same millisecond are possible, and the id is the only
        -- total order this table has.
        ORDER BY last_id DESC`,
    )
    .all() as unknown as {
    session_id: string;
    messages: number;
    first_at: string;
    last_at: string;
    title: string | null;
  }[];

  const channels = db
    .prepare(
      "SELECT DISTINCT session_id, channel FROM chat_messages ORDER BY session_id, channel",
    )
    .all() as unknown as { session_id: string; channel: string }[];
  const bySession = new Map<string, string[]>();
  for (const c of channels) {
    const list = bySession.get(c.session_id);
    if (list) list.push(c.channel);
    else bySession.set(c.session_id, [c.channel]);
  }

  return rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title === null ? null : r.title.trim() || null,
    messages: r.messages,
    firstAt: r.first_at,
    lastAt: r.last_at,
    channels: bySession.get(r.session_id) ?? [],
  }));
}

/** Forget one conversation. Used by the route that clears a chat; there is no
 *  bulk version, because "delete every transcript" is not an operation this
 *  dashboard should be one fat-fingered request away from. */
export function deleteChatSession(sessionId: string): number {
  return Number(
    db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId).changes,
  );
}

/* ---------------------------------------------------------------- ventures */

/**
 * The businesses, as rows. See `021_ventures` for why they are here at all and
 * routes/ventures.ts for the document they are shaped into.
 *
 * WHAT LIVES IN THIS FILE AND WHAT DOES NOT. These are reads, one write that
 * only the enricher performs, and nothing else — every validation, every
 * default and every decision about what a PATCH means stays in the route, the
 * way the board's do. The one write is here because it has TWO callers (the
 * enrich route and the background pass at boot) and it is the only place in
 * the app where a measurement is allowed to change a row the owner typed. The
 * rule it enforces — an owner's colour is never overwritten — is enforced by
 * the caller passing it in, and the reason is stated at `writeVentureBrand`.
 */
export type VentureRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  website: string | null;
  host: string | null;
  stage: string;
  color: string;
  color_source: string;
  position: number;
  /** JSON, owned by ventures/enrich.ts. '{}' means never read. */
  brand: string;
  created_at: string;
  updated_at: string;
};

/** Every venture in the owner's own order. Ties broken on the id so the list
 *  is stable — two rows can share a position for the instant between two
 *  statements of a reorder, and a list that reshuffles under a refresh is a
 *  list nobody trusts. */
export function ventureRows(): VentureRow[] {
  return db
    .prepare("SELECT * FROM ventures ORDER BY position, id")
    .all() as unknown as VentureRow[];
}

export function ventureRowById(id: string): VentureRow | undefined {
  return db.prepare("SELECT * FROM ventures WHERE id = ?").get(id) as
    | VentureRow
    | undefined;
}

/**
 * One venture, by whichever name the caller had to hand.
 *
 * An id — `v-example-support` — is what a board card and a chat session carry; a
 * slug — `example-support` — is what the address bar carries. Both are accepted
 * because a caller holding one has no reason to look up the other first, and
 * they cannot collide: an id is a slug with a `v-` on the front, and the id is
 * tried first, so a venture that somehow slugged to another's id still
 * resolves to itself by id and to the other by slug, deterministically.
 */
export function ventureRow(key: string): VentureRow | undefined {
  return (
    ventureRowById(key) ??
    (db.prepare("SELECT * FROM ventures WHERE slug = ?").get(key) as
      | VentureRow
      | undefined)
  );
}

/**
 * Write back what was READ OFF THE SITE, and nothing the owner typed.
 *
 * The columns this touches are the ones a measurement is entitled to: the
 * brand blob, the host (which is derived from the website, not typed), and —
 * only when the caller says so — the colour. `color` is null on every call
 * where `color_source` is already 'owner', which is the whole of the rule and
 * is decided by the caller rather than here, because the caller is also the
 * one that knows whether a primary was measured at all. A venture whose colour
 * the owner chose keeps it through every re-read, for ever; that is the point
 * of storing where a colour came from.
 *
 * `updated_at` moves, because a re-read IS a change to the record — it is what
 * the page's "read the site" button changes, and a stamp that did not move
 * would make a successful re-read look like nothing happened.
 */
export function writeVentureBrand(
  id: string,
  patch: { host: string | null; brand: string; color: string | null },
): VentureRow | undefined {
  if (patch.color === null) {
    db.prepare(
      "UPDATE ventures SET host = ?, brand = ?, updated_at = ? WHERE id = ?",
    ).run(patch.host, patch.brand, now(), id);
  } else {
    db.prepare(
      `UPDATE ventures
          SET host = ?, brand = ?, color = ?, color_source = 'site', updated_at = ?
        WHERE id = ?`,
    ).run(patch.host, patch.brand, patch.color, now(), id);
  }
  return ventureRowById(id);
}
