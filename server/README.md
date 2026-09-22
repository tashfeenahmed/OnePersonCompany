# server

Start with the [root README](../README.md) for setup, the security model, production startup and recovery. [`docs/shared-modules.md`](../docs/shared-modules.md) describes the shared layer every area builds on, and the traps in it.

The half of the app that is allowed to hold a credential. TypeScript on Node 24,
run directly with `--experimental-strip-types` — no build step, no bundler.

```bash
cp .env.example .env     # optional; the defaults work
npm install
npm run dev              # http://127.0.0.1:8787
npm run collect          # one collection pass, then exit
npm run typecheck
```

The client's Vite dev server proxies `/api` here, so the browser only ever
talks to its own origin.

## Why this exists at all

A Hetzner token in a Vite bundle is a Hetzner token given to anyone who opens
the page. Hetzner's API also sends no CORS headers, so the call cannot be made
from a browser even if you wanted to. Both roads lead to a process, and this is
it: it holds the vault key, makes the outbound call, and is the only thing that
ever sees a token.

It binds to `127.0.0.1`. A service that can read your bill should not be
listening on every interface because a default said so.

## The database: SQLite, via `node:sqlite`

The workload is one person and one box. The configuration side is dozens of
rows, read constantly and written by hand a few times a month. The measurement
side is an append-only series of small snapshots — a few rows an hour. Both are
what SQLite is for.

Postgres was the real alternative and was declined on weight: a daemon to keep
running, a connection pool, a separate backup story, and a second thing that can
be down — bought for a dataset that fits in a file. DuckDB is an analytics
engine and the wrong shape for configuration reads. Plain JSON files were what
the system this replaces does today, and its own collectors document the pain:
one such file is 988K, and a document that has to be read whole to answer a
question about one row is a document that eventually will not fit in the thing
reading it.

`node:sqlite` in particular rather than `better-sqlite3`, because it ships with
Node 22.5+ and needs no native build. That matters more than it sounds: this is
meant to run on the same class of machine as the collectors — a Raspberry Pi —
and a dependency that compiles at install time is a dependency that eventually
fails to install on the box you care about. It also means the server has exactly
two runtime dependencies, both of them Hono.

WAL is on, so a long read cannot block the collector's write. Foreign keys are
on, so a secret without a plugin fails at the database rather than in a route.
A backup is `cp -r data/`.

**When this stops being right:** more than one machine writing, or more than one
person needing their own view. Neither is true. The schema is plain SQL with no
SQLite-only types, so that day is a migration rather than a rewrite.

### Schema

| table | what it holds |
| --- | --- |
| `plugins` | what is connected, when it changed, the last error |
| `plugin_accounts` | one row per account a plugin holds: label, state, last error |
| `secrets` | ciphertext only — there is no readable-credential column |
| `secret_access` | every read of a secret, so "what touched the token" is a query |
| `runs` | one row per collection attempt, **including the failures** |
| `readings` | append-only measurements, one row per metric per collection |
| `hetzner_servers` / `hetzner_volumes` | current state, replaced each run |
| `hetzner_load` | per-server samples: CPU, network and disk throughput |
| `domains` | the portfolio, one row per domain per registrar account |
| `openai_costs` | one row per day per project — the one cut the Costs API gives |
| `openrouter_activity` | one row per day per model per provider |
| `openrouter_keys` / `openrouter_credits` | per-key totals, and the ledger |
| `replicate_predictions` | one row per prediction: model, status, compute time |
| `plugin_config` | settings that are **not** credentials, and therefore read back |
| `github_repos` | one row per repo per account, replaced per account |
| `github_traffic` | one row per repo per metric per **day** — views, uniques, clones |
| `github_traffic_window` | GitHub's own 14-day totals, which are not the sum of the days |
| `github_popular` | the top ten referrers and paths per repo, a snapshot |
| `github_state` | per account: the login, the followers, and the API budget left |
| `npm_downloads` | one row per package per day. Never a weekly total |
| `npm_packages` | per package: which endpoint answered, the range, its own error |
| `appstore_state` / `appstore_apps` | per account: the identifiers it uses; per app: where it is on the store, and its rating |
| `appstore_reports` | which day and which month was asked for, and what Apple said |
| `appstore_sales` / `appstore_proceeds` | units per day per app; Apple's **estimated** proceeds per currency |
| `appstore_payouts` | the finance report: partner share per closed month per currency — the **payout** |
| `play_state` / `play_files` | the bucket and key that were read; which report object was ingested per month |
| `play_stats` | one row per package per day: installs, uninstalls, active devices, the running rating |
| `play_sales` | what buyers were **charged**, per month per buyer currency — the estimate |
| `play_earnings` | merchant earnings per month per currency, net of Google's fee — the **payout** |
| `stripe_charge_days` | payment **attempts** per day per currency: gross, refunds, and blocked vs declined |
| `stripe_ledger_days` | **settlement** per day per currency: the fee Stripe took, the tax it withheld, the net |
| `stripe_subscriptions` | one row per subscription, live or dead, priced. No aggregate anywhere |
| `stripe_balance` / `stripe_payouts` | what Stripe is holding; what has actually left for a bank |
| `stripe_state` | how far back each account's day tables reach, and whether that is all of it |
| `adsense_days` / `adsense_months` | **estimated** ad earnings per site per day, and per calendar month |
| `cloudflare_zones` | one row per zone: its records, its proxy count, its mail posture, and the nameservers Cloudflare assigned it |
| `cloudflare_traffic` | one row per zone per **UTC day** — requests, cache, bytes, threats, page views and uniques |
| `cloudflare_registrar` | domains registered **at** Cloudflare. Zero of them is the ordinary answer here |
| `cloudflare_state` | per account: how many zones answered, and whether the registrar list could be read at all |
| `gsc_sites` | one row per Search Console property: the window covered, Google's own total for it, how much of it the ranked rows cover, its sitemaps |
| `gsc_days` | one row per property per **finalised day** — clicks, impressions, and that day's own average position |
| `gsc_queries` / `gsc_pages` | the ranked breakdowns, replaced per property. A **ranking**, never a total |
| `bing_sites` | one row per verified Bing site: what is in its index, what it crawled, and its two disagreeing inbound-link figures |
| `bing_traffic_days` / `bing_crawl_days` | what Bing showed people, and what its crawler did. Two tables because they are two different actors |
| `bing_queries` | Bing's own query report, kept at its own grain: per site per query per **day** |
| `bing_keyword_weeks` / `bing_keyword_state` | search volume for phrases the owner named, and **what happened when we asked** |
| `meta_pages` | one row per Facebook Page: its followers, and whether an Instagram Business account is linked — `ig_checked` beside `ig_id`, because "asked and told no" is not "nobody looked" |
| `meta_ad_accounts` | one row per ad account: its own currency, its lifetime spend, and Meta's own window figures **with the dates they cover** |
| `meta_campaigns` | one row per campaign per ad account. Reach is a column and never a total |
| `meta_ad_days` | one row per ad account per **day it delivered**. A silent day has no row rather than a zero |
| `meta_state` | per account: who the token is, whether its calls were proofed, and `0 of 3 Pages` |
| `demand_items` | one row per thread per watch phrase that found it, with the TIER that learned it — and nullable date and score, because two of the tiers cannot supply either |
| `demand_queries` | what happened when one phrase was put to one source: `ok` (which may be zero), `throttled`, `failed`, `skipped` |
| `searxng_state` | the search node's last probe: did it answer, how fast, how many engines |
| `searxng_engines` | per engine, from that probe — and the node's own words for why the others refused |
| `telegram_state` | per bot: who the token is, how far through the update stream it has got, what it answered and what it ignored. The conversations are in `chat_messages` under `telegram:<chat id>`, and the paired chat id is in `plugin_config` |
| `gmail_mailboxes` | one row per connected mailbox: its address, what it holds, and the SCOPES the grant actually carries |
| `gmail_labels` | one row per label per mailbox: Gmail's own exact counters, plus the triage verdict where the scan reached it — `needing_reply` is **null** for a label nobody looked at and `0` for one with a clear queue |
| `gmail_days` | one row per mailbox per day: received and sent, never added. Keyed by the mailbox **address**, so history survives the credential being re-pasted |
| `gmail_correspondents` | one row per person written to, as a **salted HMAC**. There is no address column and there will not be one |
| `resend_domains` / `resend_dns` | one row per sending domain and one per DNS record behind it, each record with its **own** status |
| `resend_emails` | one row per email Resend sent: the day, our own from-address, and its latest event. No recipient, no subject |
| `resend_state` | per key: how many pages the walk spent, how far back it reached, and whether the ceiling cut it short |

Current state and history are kept apart on purpose. A decommissioned box leaves
`hetzner_servers` and stops costing money the moment it leaves the account;
`readings` is append-only, so the chart of what it used to cost survives.

`hetzner_load` is a third shape again, and has its own table for it. `readings`
is a handful of rows per collection of a fleet-wide figure; this is a day of
fifteen-minute samples per box per metric — a few thousand rows a day. Its key is
`(server, metric, moment)`, so re-reading a window the last run already saw
**replaces** those rows rather than doubling them, which is what makes "always
pull the last 24 hours" safe to run every half hour. It also ages out far sooner
than the rest: `OPC_LOAD_RETAIN_DAYS` defaults to 30 against `OPC_RETAIN_DAYS`'
400, because "what did this cost in March" is worth a year and "was the box busy
on Tuesday night" is not.

## A plugin holds accounts, not a credential

A Hetzner API token is scoped to a **single project**, so an account with three
projects needs three tokens. A registrar key covers one login, and a person can
have two. So the thing that owns a credential is an **account**: a label, its
own connected flag, its own last error, its own "last worked" date, and one
vault entry per field.

This replaced a design where Hetzner's single entry held a newline-separated
blob of tokens. That worked and the bill was right, but no token had a name, no
token had a state of its own, and one revoked token showed up as a warning on
the plugin rather than as "this project stopped answering". `005_accounts`
turned every connected plugin into its first account and split that blob into
one account per token, re-attributing the servers already collected — the two
Hetzner projects, the Dynadot login and the Spaceship login came through it
without a credential being re-pasted.

**Failure is per account, everywhere.** A dead token loses its own project's
servers and nothing else; a registrar login that answers 401 leaves the other
login's names on the page, because each account replaces only its own rows. A
run fails only when *every* account failed.

**A total says what it is a total of.** `GET /api/hetzner/summary` breaks the
fleet down by account and `GET /api/domains` counts `byAccount`, so a card
showing €63.47 across two projects can say "across 2 accounts" rather than
inviting the reader to go looking for that figure in one console.

**A Hetzner id is global**, so the same server arriving under two accounts
means one project has been connected twice. It is counted once, under the
account that saw it first, and the duplicate comes back as a warning naming
both — doubling the bill and silently dropping the rows are both worse.

### Entry names

The first account of a plugin takes the plain name — `hetzner-token`,
`dynadot-key`, `spaceship-secret` — which are the names the system this
replaces uses in its own vault, and the ones this file tells you to look for.
Every account after it is
suffixed with its own row id: `hetzner-token#4`. Not with its label and not
with its position, because the entry name is the ciphertext's associated data
and has to be stable for the life of the row; a label can be renamed and a
position moves the moment an earlier account is deleted. Renaming an account
therefore does **not** rename its vault entry.

## Credentials at rest

`src/vault.ts` mirrors the design the system this replaces used for its own
secrets store: AES-256-GCM, a 12-byte IV,
a 16-byte tag, and **the entry name as associated data** — so a ciphertext moved
into another row fails to open rather than opening as the wrong secret. The key
is 32 random bytes in `data/vault.key`, mode 0600, generated on first use.

What this buys: a copy of `opc.db` carries ciphertext, not a live token.
Database files travel — backups, synced folders, a stray `scp` — and they should
not travel readable. What it does not buy: defence against someone who already
has the whole `data/` directory, because the key is in it. That needs a key the
machine does not hold, which is a different product.

**No route returns a secret, and none should.** `GET /api/plugins/:id` answers
with entry names and timestamps only.

## Routes

| | |
| --- | --- |
| `GET /api/health` | liveness, which collectors exist, the cadence |
| `GET /api/plugins` | every known plugin, plus which ones are configurable |
| `GET /api/plugins/:id` | status, accounts, secret names, last five runs |
| `PUT /api/plugins/:id` | the single-account door: verify, store, collect |
| `DELETE /api/plugins/:id` | forget every account |
| `GET /api/plugins/:id/accounts` | the accounts, with state and entry names |
| `POST /api/plugins/:id/accounts` | verify, then add another account |
| `PATCH /api/plugins/:id/accounts/:n` | rename it, replace its credentials, or both |
| `DELETE /api/plugins/:id/accounts/:n` | forget one account |
| `POST /api/plugins/:id/collect` | run now |
| `GET /api/hetzner/summary` | counts and monthly cost from the last collection |
| `GET /api/hetzner/servers` | the fleet as last seen |
| `GET /api/hetzner/volumes` | block storage, with the server each is attached to |
| `GET /api/hetzner/load?hours=24` | what every box has been doing, and the fleet's own line |
| `GET /api/domains` | the portfolio merged across every registrar, plus its summary |
| `GET /api/stock?days=30` | the stock libraries' remaining allowance, and their burn rate |
| `GET /api/costs?days=30` | OpenAI, OpenRouter and Replicate — in their own units |
| `GET /api/mobile?days=30` | both app stores: store presence, installs, and each store's estimate and payout |
| `GET /api/plugins/:id/config` | the settings a plugin takes, **with their values** |
| `PUT /api/plugins/:id/config` | write them through a second closed registry, then collect |
| `GET /api/github` | the repos, the daily traffic line, and the budget left |
| `GET /api/npm` | downloads by day and by ISO week, bucketed on every read |
| `GET /api/npm/published?maintainer=` | what npm says that account publishes — a helper, never a collector |
| `GET /api/stripe?days=30` | the book, the ledger, the attempts and the balance — per currency, never summed |
| `GET /api/adsense?days=30` | ad earnings per site, or which not-authorised state this is in and what would change it |
| `GET /api/cloudflare?days=7` | the zones, what they served over complete UTC days, and where each one actually delegates |
| `GET /api/gsc?days=90` | every Search Console property, the finalised daily line, and what fraction of it the query rows cover |
| `GET /api/bing?days=90` | Bing's traffic, index and crawl, its inbound links, and demand for the phrases you named |
| `GET /api/meta?days=30` | the Pages, the ad account in its own currency, and the Instagram answer |
| `GET /api/demand?days=30` | Reddit, Hacker News and the search node — what strangers asked for, which tier answered, and which phrases nobody would let us ask |
| `GET /api/telegram` | the bot, the chat it is paired with, whether the poller is running, and how many messages from other chats it threw away |
| `DELETE /api/telegram/lock[/:accountId]` | un-pair a bot, so the next message from any chat pairs it again |
| `GET /api/mail?days=30` | every mailbox and every sending domain — what is waiting, what arrived, and what became of what left |
| `GET /api/searxng/instance` | the locally installed search node: what is on disk, what is running, the install's step and log |
| `POST /api/searxng/instance/install\|start\|stop` | install it, run it, stop it |
| `GET /api/search?q=` | **a tool, not a report** — search through whichever SearXNG instance is active |
| `GET /api/freellmapi` | the model gateway: what is installed under `data/freellmapi/`, what is running, both endpoints, which one answers, and its catalog |
| `POST /api/freellmapi/instance/install\|start\|stop` | install it, run it, stop it |
| `POST /api/freellmapi/instance/reconnect` | re-read the managed instance's own key and re-seal it |
| `PUT /api/freellmapi/account` | choose which endpoint answers, or `null` for automatic |
| `GET /api/models/providers` | every model provider, which is the default, and what the limiter is doing right now |
| `PUT /api/models/provider` | choose the default, or `null` for none |
| `PUT /api/models/:id/policy` | series or parallel, how many at once, which endpoint next, how long to wait |
| `DELETE /api/models/:id/policy` | forget those four, so the provider's own default stands again |
| `GET /api/models/local/models` | what each local endpoint is serving, asked live |
| `POST /api/models/complete` | one completion through the default provider, under its policy. Writes no transcript |
| `GET /api/metrics/:metric?days=30` | one series, for a widget |
| `GET /api/agents` | both agents as processes: installed, running, what each is pointed at, which is live |
| `GET /api/agents/:id` | one of them |
| `POST /api/agents/:id/install` | install Hermes or OpenClaw into `DATA_DIR/<agent>/` — a job, answered 202 |
| `POST /api/agents/:id/start\|stop` | configure from the active provider and spawn it; SIGTERM it |
| `POST /api/agents/:id/reconfigure` | rewrite its provider config now, restarting it if it is up |
| `POST /api/agents/:id/make-live` | make it the chat backend — the same `chat.backend` switch |
| `POST /api/agents/:id/mode` | which credential answers: the instance here, or a pasted remote one |
| `GET /api/board` | the board: every column with its cards in order, counts, and what a WIP limit says |
| `POST /api/board/cards` | write a card down — in Backlog, or in a column you name |
| `PATCH /api/board/cards/:id` | title, body, urgency, due, venture. A field left out is untouched; `null` clears it |
| `POST /api/board/cards/:id/move` | the drag: `{ columnId, before }` — that column, above that card, or `null` for the foot |
| `POST /api/board/cards/:id/archive` | out of the way, not gone |
| `DELETE /api/board/cards/:id` | gone |
| `PATCH /api/board/columns/:id` | rename it, or set a WIP limit (`null` removes it) |
| `POST /api/board/columns/:id/move` | reorder the columns, in the same `{ before }` vocabulary |
| `GET /api/skills` | the catalog: every data integration an agent can read, and what is not connected |
| `GET /api/skills/prompt` | the same, compressed into a system-prompt preamble for an agent with no skills of its own |
| `GET /api/skills/:id?<params>` | **a GET-only proxy** onto that integration's own route — one base URL for the whole board |

Every write goes through a **closed registry** (`src/routes/plugins.ts`), for
the same reason the previous system's own registry is closed too: a route that
can write any name into the vault
is a route that can overwrite `hetzner-token` with a typo. An id or field
outside the registry is refused, and the provider verifies the credential
before it is stored — for the fifth account exactly as for the first.

`PUT /api/plugins/:id` is kept because it is the shape every script already
speaks. It writes the first account, or replaces the only one; with several
accounts it refuses and names them, because "the credential" has no referent
then. `PATCH` on one account is the answer in that case, and a field left out
of a `PATCH` keeps the value already in the vault — which is what makes
"change just the secret" something the provider can still verify as a pair.

## Hetzner

**One read-only token per account.** A Hetzner token is scoped to a single
project, so an account with three projects is three accounts here — each named
for its project, each with its own state. Console → the project → Security →
API tokens → Read. A multi-line paste is refused with that instruction rather
than sealed as one very long bearer token; turning one paste into three
accounts silently would name three projects on the owner's behalf.

It reads four endpoints, all free, unmetered and read-only:
`GET /v1/pricing`, `GET /v1/servers`, `GET /v1/volumes` and
`GET /v1/servers/{id}/metrics`.

Prices are matched to **the server's own location**. Hetzner quotes every plan at
every location and they are not equal, so there is no fallback to "the first
price in the list" — a price from the wrong datacentre is a made-up number, and
this returns `null` and says so instead. The primary IPv4 is billed separately
from the plan, as Hetzner invoices it, so it is its own column. Everything is
net of VAT in EUR, because that is what the API returns.

A token is **verified against Hetzner before it is stored**, so a typo is refused
at the point it was made rather than becoming a silently empty dashboard an hour
later. One bad token among several does not lose the projects that answered:
that account goes red, its error is its own, and the rest of the fleet arrives
exactly as if it had not been there.

### What a running box can and cannot tell you

The metrics endpoint is measured by **the hypervisor, not inside the guest**, so
it knows exactly four things about a machine: how much CPU it is burning, and how
many bytes a second are crossing its network cards and its disks. It does not
know how much memory is in use, and it does not know how full the filesystem is.
Both of those live inside the operating system and need something running in
there — which is what the collectors on the previous system are.

That limit is not papered over anywhere downstream. The Servers dashboard has CPU
meters and no memory meter, and the disk card is titled for throughput rather
than capacity, because a capacity meter here would have to be invented.

**CPU is divided by the box's cores before it leaves the API.** Hetzner reports
CPU summed across cores, so a two-vCPU box flat out reads 200 — this fleet's real
peaks include 138.2 and 128.9. Handed to a meter with lines at 75 and 90 that is
not a busy box, it is a nonsense scale; and a raw 60 on a two-core box is not the
same fraction of a machine as a raw 60 on a four-core one. Divided by cores,
every figure on the page means the same thing: how much of *that* box is in use,
out of 100. A box whose core count is unknown is passed through undivided and
carries `cpuScaled: false` to say so, rather than being scaled by a guess.

The fleet's own CPU line is a **mean** across the boxes reporting at each moment
and never a sum — adding percentages of differently sized machines gives a number
in no unit, and a moment where a box did not report is averaged over the ones
that did, so a fleet that grew inside the window does not draw the earlier
absence as a collapse in load. Bandwidth is the other way round and is summed:
bytes a second do add up.

## Registrars

Two of them, and they answer the same question in two vocabularies. Dynadot
sends epoch milliseconds, `"yes"`/`"no"` strings and the name of its privacy
product; Spaceship sends ISO instants, real booleans, and the EPP statuses the
registry holds rather than a lock flag. `src/providers/domains.ts` is where both
fold onto one shape, so nothing downstream has to know which registrar a row
came from in order to read it. The rules are lifted from the domain collector
in the system this replaces, which is the version that has actually been run
against these two accounts.

**Dynadot signs every request.** The v2 surface wants the key as a bearer token
and an `X-Signature` over

```
key + "\n" + path?query + "\n" + X-Request-ID + "\n" + body
```

base64 of HMAC-SHA256 under the secret. This sends no request id and no body, so
the message ends in two EMPTY segments — which still means two trailing
newlines, not none. Sign three fields instead of four and Dynadot rebuilds a
different string on its side and rejects a perfectly good key. The path is
signed *with* its query string, which is why page one is requested as the bare
path.

**Spaceship's User-Agent is load-bearing.** It sits behind bot protection that
refuses a request on the strength of its agent string alone. Node's fetch sends
`node`; this names itself instead.

Both are verified as a PAIR before storage — neither half proves anything alone,
and "the key is fine but the secret is not" is a sentence only the provider can
say. The first account of each writes `dynadot-key`, `dynadot-secret`,
`spaceship-key` and `spaceship-secret`: the same names the system this replaces
uses in its own vault, which makes moving the credentials across a copy rather
than a migration.
A second login at either registrar is a second account, and its entries are
suffixed with that account's row id.

### Two rules that shape the domains table

**The expiry date is stored; the days left are not.** A "renews in 30 days"
written down at collection time is wrong by one the next morning, and wrong by
thirty if a collection fails for a month — which is exactly the situation in
which a renewal dashboard has to be right. `GET /api/domains` computes every
countdown against today, on every read.

**Null is a third answer, everywhere.** A registrar that does not report
auto-renew is not a registrar reporting auto-renew off, and the summary keeps
them apart: `autoRenewOff` is a list of things to fix, `autoRenewUnknown` is a
list of things nobody can vouch for. Folding them together turns the first into
a number too big to act on. For the same reason `lapsed` is counted on its own
and appears in none of the `expiring*` windows — a name whose date has passed
must not hide inside a figure that also means "there is a week to sort this
out".

Each **account** replaces only its own rows (`DELETE ... WHERE source = ? AND
account_id = ?`), so a Dynadot outage cannot take the Spaceship names off the
page — and one Dynadot login answering 401 cannot take the other one's names
either. `GET /api/domains` reports every name with the account that read it, and
counts the portfolio `byAccount` as well as by registrar.

## Settings that are not credentials

npm forced this. Its downloads API is public, so there is no key to paste and no
account to hold one — but it cannot be collected without knowing **which
packages are mine**. That is a list the owner maintains by hand, so it has to
read back: a write-only field you can never check is a field that eventually
holds a typo forever. `plugin_config` holds it, `GET /api/plugins/:id/config`
returns it in full, and the plugin page has a Settings section beneath the
credentials one.

It is a **second closed registry**, for the same reason the vault has one: a
route that can write any key under any plugin is a route that can invent a
setting nothing reads and leave the owner believing they configured something.
Every key has its own validator, so `@my scope/pkg` is refused where it was
typed rather than 404ing on every run for a week: npm's `packages`, GitHub's
`orgs`, Bing's `keywords`, SearXNG's `url`, and the demand `terms` — which is
one list registered on two plugins, mirrored between them so it cannot drift,
because a phrase is the same phrase whichever site somebody said it on.

For npm this is also what "connected" **means**: with no list there is nothing
to ask npm about, and with one it works immediately and without a credential.
That is the one plugin whose flag is not derived from its accounts, because it
has none and inventing one would put "Account 1 · connected" on a page
describing a credential that does not exist.

## GitHub

**Two tiers, and the split is the whole design.** Without a token the public
repo list is readable — stars, forks, open issues, last push, language — at
sixty requests an hour shared across the IP. With one, the same list plus
private repos and **per-repo traffic**: views and unique visitors over GitHub's
fixed 14-day window, clones, top referrers, top paths. Traffic needs *push*
access to each repo, which is why it cannot be had anonymously at any budget —
GitHub simply does not serve those endpoints without it. A repo the token can
read but not push to answers 403 "Must have push access", which is recorded as
that repo's `trafficNote` and costs nothing else: twenty-nine repos with traffic
and one without is a better answer than no answer.

One token per **account**, because a token belongs to exactly one GitHub
identity. It is verified against `/user` before storage, which also returns the
login — the natural name for the account row.

**Which thirty repos.** Traffic is four calls per repo, so the candidate list is
swept for repos last pushed over eighteen months ago (dropped *before* the cap,
not ranked by it), then ordered public-first, then by stars, then by recency.
Public first is the one that surprises and is the point: this exists to answer
"who is looking at the repos", and a private repo cannot be looked at. The run
note says how many were dropped for age and how many lost the ranking, because
those are two different reasons to be missing.

**Organisations are named, never swept.** `affiliation=organization_member`
would drag in the hundred dormant repos of an org this owner merely belongs to.
The `orgs` setting is an explicit list and the API reports which orgs were
walked, so "missing because it lost the ranking" and "missing because nobody
asked" stay different sentences.

**Traffic is collected on its own, slower clock.** The repo listing is one to
three requests and runs every collection. Traffic at every run would be 5,760
requests a day to redraw the same fourteen daily buckets — a fifth of the
authenticated budget, spent to learn nothing. `TRAFFIC_EVERY_HOURS` is 6. A repo
nothing has ever been asked about is asked about immediately regardless, so
adding an org at nine does not leave two repos blank until three.

**The rate limit is published, not merely respected.** The first symptom of
crossing GitHub's ceiling is a dashboard that silently stops updating at three
in the morning for a reason nothing on the page can state. Every response's
remaining/limit/reset is kept, along with what the last run spent — and whether
that figure still *means* anything is decided when it is read, against the reset
time, exactly as domain countdowns are.

### Two numbers that look alike and are not

Views add up: across days, across repos, always. **Uniques do not.** GitHub
de-duplicates visitors within each day for the series and across the whole
fortnight for the header figure, so adding fourteen daily uniques counts every
returning visitor again — for this account's busiest repo that is 56,707 real
people against about 78,000 imaginary ones. Both are stored, from their own
sources, and every field and card that carries a unique count says which kind it
is.

The daily line has one more trap in it. Repos do not all report the same
fourteen days — GitHub hands back stray older days for a quiet repo — so summing
them drew six days of "almost nothing" followed by a vertical jump on the day
the busiest repo's window began. Nothing happened that day; the coverage
changed. Each day therefore carries how many repos are in it, and days outside
the span every repo was measured over are marked `partial` and left off the
line. So is today: GitHub's aggregation lags its own clock, and at half past six
in the evening today's bucket still read zero.

## npm

**No credential, and a list instead.** `api.npmjs.org/downloads` is public.
`GET /api/npm/published?maintainer=` asks the registry what an account
publishes — that is how the four packages here were found — but nothing calls it
on a timer: a list that grows itself is a chart whose baseline moves without
anybody deciding, and a package that merely shares a maintainer would arrive as
a jump in "my downloads".

**It is downloads, never installs.** npm counts HTTP tarball fetches. A CI job
installing on every push, a Docker layer rebuild, a mirror warming its cache and
a person typing `npm i -g` are one download each and npm cannot tell them apart.
Calling that "installs" would put a number on the top of a funnel that is wrong
in an unknown direction and poison every rate computed below it. The word is
`downloads` in the database, on the wire and on the cards.

**Weeks are ISO, Monday to Sunday, and bucketed when they are read.** npm's own
`last-week` endpoint answers with a rolling seven days ending yesterday, which
is why npmjs.com can show 178 for a week this reports as 184 — the same
downloads over a different seven days. The database holds one row per package
per day and no weekly total at all, so the week that was in progress on Tuesday
is a finished week on Monday without anything being rewritten. A week short of
its seven days is marked `partial` and is never drawn beside complete ones.

Per package, never per run: one name that 404s keeps the figures it already has,
stamps its own error, and costs the others nothing.

## Costs: three providers, three different answers

`GET /api/costs` is one route for the whole board, the way `/api/domains` is
one route for the whole portfolio — a costs page asks the same question of the
same rows from a dozen cards. Every total on it is computed **on the read**:
nothing stored says "$31 this month", it says "$1.47 on the 9th, in this
project", and the window is summed when somebody asks. A stored monthly figure
is wrong the next morning and badly wrong after a week of failed collections,
which is the week someone actually looks.

**OpenAI** needs an **org admin key** (`sk-admin-…`). `/v1/organization/*` is
the admin surface and a project key is refused there with a 401 whatever scopes
it carries, so the key is verified against the Costs endpoint itself before it
is stored and the refusal comes back as that sentence rather than as an empty
month. Grouped by project, the Costs API gives per day **per project** in one
set of rows, so the daily totals and the project totals are sums over the same
rows and agree to the cent. It **cannot** answer per model — it groups by
project or by line item, never both, and the line-item cut is a billing
taxonomy rather than a model list. There is no per-model card downstream, and
the mock one that used to be there was deleted rather than wired up. The
buckets aggregate into UTC days and the recent ones **lag about a day**, so
rows are keyed and REPLACED (today's partial figure is corrected tomorrow, not
added to) and the route names the last complete day so nothing reads a partial
bucket as a fall in spend.

**OpenRouter** needs a **management key**; an ordinary inference key answers
`/credits` and its own `/key` and is refused by `/activity` and `/keys` with a
403 — so it would connect, show a balance, and never show what the balance went
on. `/key` says `is_management_key` about itself, which is what `verify` reads.
**Its two cuts do not join**: `/activity` is per day per model, `/keys` is per
key as four running totals, and there is no per-day-per-key figure anywhere. So
they are two tables sharing no column, two objects on the wire and two cards on
the board, and nothing computes a crossing of them. Its three headline totals
measure three different things — lifetime spend (every key that ever existed),
the sum of the keys that still exist, and about a month of activity — and the
card that shows all three labels each with what it is a total of. `byok_usage`
is inference OpenRouter routed and did not bill for; it has its own column and
is never added to `usd`.

**Replicate answers "what did this cost" with nothing, and the integration says
so.** Probed on 2026-09-04: `/v1/billing`, `/v1/account/billing` and
`/v1/usage` are all 404; a prediction record carries no hardware SKU and no
price; `/v1/hardware` lists the SKUs and publishes no rates. The gap cannot be
closed by inference either, because the models this account actually runs
(`openai/gpt-image-2`, `bytedance/seedance-2.5`) are priced **per output** —
per image, per second of video — so a rate per compute-second would not price
them even if one existed. `cost` is therefore `null` on the wire and stays
null, and the board carries a card listing what was asked and what came back.
What Replicate *does* report is a full prediction history, and that is what is
collected: model, status, `predict_time`, and the output counters. The listing
takes `created_after`, so each run asks only for what is newer than the newest
row held, less six hours of overlap — rows are keyed by the prediction's own id
and replaced, so a prediction caught mid-flight is corrected rather than
counted twice.

### Currency, which is the trap

OpenAI, OpenRouter and Replicate report **US dollars**. Hetzner reports **euro,
net of VAT**. Nothing here adds them. `/api/costs` carries a `currency` block
whose `combined` is `null` and whose note says why: a total would need a real,
dated exchange rate this box does not fetch, and one confident number spanning
two currencies is worth less than two numbers that are each right. The Costs
dashboard shows them side by side with their own units and says in as many
words that no total is offered.

## The two app stores

`GET /api/mobile` is one route for both, the way `/api/costs` is one route for
the whole bill: "what did the apps do this month" is a question asked of Apple
and Google at once, and a page that had to fetch two documents and join them is
a page that eventually joins them wrongly.

### Each store reports two kinds of money, and they are never added

This is the whole shape of the integration.

| | the estimate | the payout |
| --- | --- | --- |
| **Apple** | `/v1/salesReports` — a gzip'd TSV per day, units and **estimated developer proceeds** per storefront currency | `/v1/financeReports` — a gzip'd TSV per closed fiscal month, the **partner share** actually paid |
| **Google** | `sales/` — a ZIP per month, what buyers were **charged** in their own currency, tax included, before Google's cut | `earnings/` — a ZIP per month, the **merchant amount** that lands, with Google's fee as its own negative rows |

Only the right-hand column may be called revenue. They live in different tables
with different keys, they are separate blocks on the wire, they are separate
cards, and nothing anywhere adds one to the other. The estimate is not a worse
payout: on this account August was charged in nine buyer currencies and paid out
in one, so they are not even the same list of numbers.

The estimate is also the only figure that exists for the month still running —
Google writes an earnings export only once a month has closed — which is exactly
why it has to keep its own name rather than stand in for the payout.

### Currency, which is worse here than anywhere else

Both stores report per currency, and one month of one account produced ten:
AUD, CAD, CHF, CLP, COP, EUR, INR, JPY, TZS, USD. Nothing is added across them.
`currency.combined` is `null` with the reason attached and `currency.seen` lists
what turned up — the same contract `/api/costs` keeps between euro and dollars,
for a stronger reason: there are ten of them and they differ by four orders of
magnitude.

### Reading Apple's 404s is part of the integration

The sales endpoint answers three different ways with almost the same status
code, and the distinction is a measurement:

```
404 "There were no sales for the date specified."   a real ZERO day
404 "Report is not available yet. …"                not generated YET
410 "Report is no longer available. …"              past Apple's horizon
```

A zero is stored as one and never asked about again; an absence is asked about
tomorrow and is left OUT of the daily line rather than drawn as a zero — a day
Apple was slow would otherwise be a cliff that never happened. `appstore_reports`
exists to hold that difference, because both cases have no sales rows.

**The finance endpoint cannot make the distinction and the API says so.**
Probed on 2026-09-04, it answered the same "no sales for the date specified" for
a settled month, the running month and a month in the future alike. So a missing
finance report is recorded as "Apple issued none" and never as a payout of zero,
and the payout card says that in as many words rather than printing `$0.00`.

### What each API cannot do

Apple has **no ratings at all** — they come from the public iTunes lookup
endpoint instead, per storefront, and an app Apple reports `averageUserRating: 0`
for with a count of zero has no rating rather than a rating of nothing. Apple
pays **per fiscal month** and nothing finer. Google's console export carries a
running average and **no rating count**, so no average across packages can be
weighted, and its financial exports are stamped by **month** — no window
narrower than a month is measurable on that side at all. Every one of these is
on the wire in a `cannot` block and on a card, so a reader who goes looking for
a missing figure finds out why rather than assuming the collector is broken.

### Four values, one of which is a secret

App Store Connect needs a `.p8` private key, a key id, an issuer id, and a
**vendor number** that is not in the API at all — it is printed on the Payments
and Financial Reports page. Google Play needs a service account JSON and the
**developer id** that names its report bucket, which the key says nothing about.

The p8 and the JSON are secrets; the other four are identifiers, so they are
ordinary text fields, shown in full, and echoed back on `/api/mobile`. A wrong
vendor number is the one failure here that produces a permanently empty board —
Apple answers HTTP 500 to a vendor number belonging to another team — so both
verifiers make **two calls**: one to prove the credential, one to prove the
identifier the credential does not carry.

The entry names are `asc-key.p8`, `asc-key-id`, `asc-issuer-id`, `asc-vendor`,
`play-key.json` and `play-developer-id`. The first of each pair is the name
the system this replaces uses in its own vault, which makes moving a credential
across a copy.

### Two implementation notes worth keeping

**Apple's ES256 signature must be raw `r||s`, not DER.** Node's `crypto.sign`
emits DER by default and Apple answers 401 to it — a failure that reads exactly
like a rejected key and sends you to regenerate one that was never wrong.
`dsaEncoding: "ieee-p1363"` is the whole fix.

**Google's report ZIPs are read by about forty lines of ZIP reader.** Node ships
gzip and raw deflate but no archive reader, and the alternative was a dependency
on a box whose whole argument is that it has two. Google's own sales CSV also
carries the era's best trap: a refund row has a NEGATIVE "Charged Amount" and a
POSITIVE "Item Price", so signing the charged amount by the status column turns
a refund into a second sale. The charged amount is taken exactly as written.

### Collected every six hours

`MOBILE_EVERY_HOURS` is 6, for the reason `STOCK_EVERY_HOURS` is: Apple
generates one sales report a day and settles once a month, Google rewrites a
day's CSV once a day and writes an earnings ZIP once a month. A day already
answered is never re-fetched (bar the newest two, which Apple revises), and a
month whose newest object name has not changed is not downloaded again — so a
steady-state run is a handful of requests rather than forty.

## Stock media — the integration that measures a constraint, not a result

Pexels and Pixabay are not like the others, and the difference decides what got
built. Hetzner, the registrars, GitHub and the LLM providers are **measurement**
sources: you ask them what happened and they answer with a bill, a fleet, a
portfolio, a history. Pexels and Pixabay are **consumption** APIs — over in
the system this replaces they are called by its video-production worker to
search for b-roll, Pexels first and Pixabay as the fallback. Nothing over
there records what came back, and neither service keeps an account history
you can ask for later.

So there is no spend to chart (both are free at this tier), no usage history
(neither publishes one), and **no "clips used" card** — nothing on this box
knows. Its absence is the design, not an omission, and `/api/stock` ships a
`cannot` list saying so.

What there is, and it is the number that matters: a **monthly request
allowance**, reported in headers on every response. Probed live on 2026-09-04,
Pexels answers `x-ratelimit-limit: 25000`, `x-ratelimit-remaining: 24999`,
`x-ratelimit-reset` as unix seconds. Sampled over time that is also a burn rate,
and "the reel pipeline stops finding footage on the 28th" is a thing you would
rather know on the 14th.

### The measurement costs some of the thing it measures

Neither service publishes a "check my quota" endpoint, so **the only way to read
the counter is to spend one from it**. At the ordinary half-hourly cadence that
is ~1,440 requests a month against Pexels' 25,000 — nearly six percent of the
allowance burned watching the allowance. So these two collect on a six-hour
clock (`STOCK_EVERY_HOURS`): ~120 a month, under half a percent, and a quota
being burned fast is still caught the same day. A skipped run says
`quota not due — read 4h ago` rather than looking like a broken timer.

The burn rate is computed **on the read**, never stored, and only from the
falling segments of the series — when the allowance refills the counter jumps
*up*, and a naive first-minus-last would read that as negative consumption.

### Pixabay is registered and not connected

`pixabay-key` is declared in the previous system's own list of known secrets
but **no value was ever stored** for it, on the Pi or here. The provider, the registry entry and the
widgets are all built and will work the moment a key is pasted; until then the
plugin reads "not connected" and `pixabay.quota` falls back to its placeholder.
Its quota reader has therefore never been run against a live response, which is
why it is deliberately tolerant: absent headers produce nulls and the cards say
"quota not reported" rather than drawing a confident zero.

## Revenue: two providers that do not measure the same thing

Stripe reports **settled money** — a card was charged, a fee was taken, a payout
left for a bank. AdSense reports an ad network's **estimate** of what a day
earned, revised for days afterwards. So there is no `/api/revenue` and no total
across the pair, for the same reason `/api/costs` offers none across euro and
dollars but a stronger one: these are not even the same kind of number. Two
routes, two documents, and nothing that adds them.

### Stripe

**One restricted key per account, READ only.** `src/providers/stripe.ts` has a
single HTTP entry point, it takes no body and it sends no method but GET — so
"this cannot write to Stripe" is a property of the code rather than a promise in
a comment. The key still wants to be restricted: Balance, Balance transactions,
Charges, Subscriptions, Prices, Invoices, Payouts. A key missing one of those
would connect and then report an MRR of nothing, so `verify` asks the two
endpoints everything rests on rather than the cheapest one — and a **test-mode
key is refused outright**, because its figures would arrive on a revenue board
as real money.

**Two walks that look alike and are not.** The charge walk measures ATTEMPTS and
is the only place a failure exists, because a decline never posts to the
balance. The balance-transaction walk measures SETTLEMENT and is the only place
a fee exists. Their two `gross` figures are dated differently — one by the
charge, one by the ledger's posting — so they are two tables, two objects on the
wire, and nothing crosses them. **Net revenue is always the ledger's answer.**

**MRR is a normalisation, and it says so everywhere it appears.** Stripe
publishes no MRR. This computes it from `active` subscriptions only, each price
normalised to a month by its own billing interval — an annual plan counts as a
twelfth per month — net of recurring coupons. That is arithmetic performed on
somebody's cash flow rather than a figure Stripe reported, so `basis` travels
with it on the wire and the card says "359 annual, counted as a twelfth a
month". `trialing` is out because a trial has never sent a cent; `past_due` is
out because it is billing and failing; **one-off payments are out and can never
be in** — this account sells $3,000 research studies beside a $19 subscription,
and they are in gross, in net, and in no product's MRR.

**Churn's denominator is named because there are four defensible ones.** The
headline is REVENUE churn: MRR the window opened with that has since gone, over
the book it opened with — reconstructed as today's MRR minus what has been added
plus those losses. That is exact for additions and losses and blind to upgrades
and downgrades, so every row carries `approximate` and drifts further at ninety
days than at seven. A subscriber-count rate sits beside it with its own
denominator, because a churned $99 plan and a churned $1 plan are one row each
in a headcount and nothing alike in money.

**A cancellation that never collected a penny is not churn**, and on this
account that is most of them: 182 of 336 dead subscriptions are checkouts that
expired before their first payment. The system this replaces reported $415 of
a $430 monthly churn from exactly this mistake — revenue that had never existed. Whether a
subscription ever billed is not on the subscription object, so it costs one
invoice lookup each; the answer never changes, so it is stored per subscription
and asked at most sixty times a run, newest cancellation first. Until a row is
resolved it counts as **real** churn: an unreachable invoice list must never
quietly flatter the retention story. `unresolvedCancellations` says how many.

**Fees split into what Stripe kept and what it merely held.** `fees` is Stripe's
own cut ex-tax and is the only figure a blended rate may come from; `taxWithheld`
is sales tax Stripe collects as merchant of record and remits onward — real
money off the top and not a cost. Over thirty days here that is $868.84 against
$747.64: fold them together and an 8.0% processing cost reads as 14.9%.

**Blocked and declined never share a denominator.** Stripe's `outcome.type`
separates a Radar block — an attack stopped before a bank saw it — from a bank
refusing a real customer. This account fails 216 of 562 attempts in thirty days;
108 of those never reached a bank. One figure covering both would read as a
business whose payments are failing rather than as card testing being repelled.

**No "next payout" date.** Stripe publishes no payout schedule, and every payout
on this account is `automatic: false` — somebody presses the button. The catalog
card that promised one has been changed rather than filled with a guess.

**A year without walking a year.** Each run rewalks ninety days — the span in
which a refund or a dispute can still move a day — and rewrites exactly those
rows by primary key. Older days are settled history and are read **once**.
The previous system backfills the whole account on its first run, which is
right for a systemd timer and wrong here, because the first collection happens inside the
HTTP request that stores the credential. So history is filled BACKWARDS,
`HISTORY_CHUNK_DAYS` at a time, and the run that finds nothing older marks the
account complete and stops asking. Connecting costs one window; the year arrives
over the next few collections, and `history.from` says how far back the figures
actually reach so a wide window is read as a floor rather than as a total.

### AdSense is built and unauthorised

**There is no credential and there never has been.** No `adsense-token` in the
vault on the Pi, no equivalent file beside the collectors it replaced, no
consent ever granted. The catalog said "Connected"; that was a mock value
presented as a measurement, and it now says what is true.

Minting a refresh token needs a human approving a Google consent screen as the
AdSense account owner, which no process can do. So everything on the other side
of that consent is built — provider, registry entry, collector, route, widgets —
and it works on the next collection after three fields are pasted:
`adsense-client-id`, `adsense-client-secret`, `adsense-refresh-token`. Three
entries rather than the single JSON blob the previous system used, because
this vault stores fields: a JSON blob in a secret is a document that has to be parsed
before anything can be checked, and a typo inside it fails as "the grant was
refused" rather than as "the client secret is missing".

**Not authorised is a state, not a failure.** The previous system's own AdSense
collector writes `{"error": "not-authorised", …}` and exits ZERO, because a
daily timer must not
go red for a consent nobody has given. `collectAdSense` is therefore the one
collector here that does not treat "no account" as a failed run, and a refresh
grant Google refuses is recorded against its own account with Google's sentence
rather than as a broken collection. Only a transport failure fails the run,
because only a transport failure is fixed by trying again.

`GET /api/adsense` answers whether or not anything is connected, and `state`
says which of three unauthorised situations it is in. Two of them are worth
naming: **`SERVICE_DISABLED`** means the grant is fine and the AdSense
Management API has simply not been switched on for the Cloud project — Google
puts the activation link in the error's details and it is lifted out into
`enableUrl`, so the card shows the fix. And **a Cloud app still in "Testing"
issues refresh tokens that expire after seven days**, so an integration that
worked all week stops on the eighth; the answer is to publish the app, not to
mint another token that will also die.

The provider has **never been run against a live grant**, which is why every
reader in it is tolerant: absent fields produce nulls and empty lists, and
`earnings` is null — "asked and not told" — rather than a confident `$0`. The
report metrics asked for are the four that ADD (earnings, page views,
impressions, clicks); RPM is divided out when somebody asks, because averaging
thirty daily RPMs gives a figure no report of Google's would agree with.

## Cloudflare

**One token, and the smallest one that works.** Zone → Zone → Read plus Zone →
DNS → Read, and nothing else. A token that can edit a zone's settings or deploy
a Pages project is a token that can take twenty-three live sites down, and a
dashboard has no business holding one — so every permission this token turns
out not to have is reported as a gap rather than worked around, and the provider
sends no method but GET and one POST to the GraphQL endpoint.

It is **verified with two calls**, because "the token exists" and "the token can
read a zone" are different facts and only the second one matters.
`/user/tokens/verify` answers 200 for a token scoped to nothing at all, so a
credential that passed only that check would connect happily and then show an
empty board for a reason nothing on the page could state.

### Four sources, each degrading on its own

The shape is lifted from the domain collector in the system this replaces,
which is the version that has actually been run against this account.

| | | |
| --- | --- | --- |
| **zones** | REST | the only hard dependency. Without it there is no document |
| **dns_records** | REST, per zone | a zone that cannot be read keeps its row with a note and **null** counts — not zero records, which is a different and alarming claim |
| **registrar** | REST, account-scoped | most domains are registered elsewhere, so an **empty list is the normal answer**, not an error |
| **analytics** | GraphQL | batched at **ten zones per query**, which is Cloudflare's hard cap and not a tuning knob |

`httpRequests1dGroups` is the pre-aggregated, **unsampled** daily rollup behind
the free zone analytics dashboard. The adaptive datasets beside it are sampled
and would put a confidence interval on every figure this dashboard prints, for
a grain nothing here needs. Everything read is on the Free plan and costs
nothing.

### What the token could and could not read, probed 2026-09-04

```
GET  /user/tokens/verify              200, "active"
GET  /zones?per_page=50               200, 23 zones, one account, all Free
GET  /zones/{id}/dns_records          200, 247 records across the 23
GET  /accounts/{id}/registrar/domains 200 and EMPTY — nothing is registered
                                      at Cloudflare Registrar
POST /graphql httpRequests1dGroups    200, every zone, the full field set,
                                      90 days of daily rollups available
GET  /accounts?per_page=50            200 and an EMPTY LIST
GET  /zones/{id}/settings             403 9109 Unauthorized
GET  /accounts/{id}/pages/projects    403 10000 Authentication error
POST /graphql accounts{…1dGroups}     "not authorized for that account"
POST /graphql firewallEventsAdaptive  "zone does not have access to that path"
```

Two of those are worth reading twice. **The registrar list answered and was
empty**, which is a measurement — no domain on this account is registered at
Cloudflare — and the wire keeps `readable` beside `count` so a card can never
mistake a refusal for a portfolio of zero. And **`GET /accounts` answers 200
with an empty list rather than 403**, so a fallback to a listing call would have
silently produced no account id and no registrar read at all; the account id is
taken off the zone objects, which each carry one.

The refusals are in a `cannot` block on the wire, dated, written as the exchange
rather than as a conclusion — the same shape Replicate's carries — so a reader
who goes looking for a Pages figure finds out it was asked for, rather than
assuming the collector is broken.

### The join, which is the point

Cloudflare knows which nameservers it **assigned** a zone. The registrars know
which nameservers the domain actually **delegates** to. Neither of them knows
the other, and this box is the only place both halves are on hand at once — so
`/api/cloudflare` computes the join on every read, against `domains`.

**Five states, not a boolean**, because three of them are neither fine nor
broken:

- `aligned` — the registrar points at this zone's own nameservers.
- `off-cloudflare` — it points somewhere else entirely. **The records on every
  other card are not the records the internet is being served.**
- `elsewhere-on-cloudflare` — Cloudflare nameservers, but not this zone's pair.
  Usually a second Cloudflare account holding the live zone.
- `unknown` — the registrar did not report nameservers. Not safe: unknown.
- `no-registrar-row` — registered somewhere with no API here, so there is
  nothing to compare against. Not a lapse.

Beside them are the two gaps that are invisible everywhere else on the board:
**zones no connected registrar holds** (their renewal dates are not on the
domains page at all) and **registered names with no Cloudflare zone**. On this
account that is seven and five respectively; the verdict is computed at read
time and never stored, because it changes when either side moves.

### Two rules that shape the traffic tables

**The window ends yesterday.** Cloudflare aggregates into UTC days and is still
writing today's, so a seven-day total that included it would fall every morning
and climb all afternoon — a sawtooth describing this box's clock rather than
anything the zones did. Today is collected, stored, and carried in `daily`
marked `partial`; it is in none of the totals. Rows are keyed `(zone, day)` and
**replaced**, so the partial bucket is corrected tomorrow rather than doubled.

**Uniques do not add up, and nothing here pretends they do.** Cloudflare
de-duplicates visitors within one zone and one day and nowhere else. So
`summary.uniques` is `null` with the reason attached, every summed figure is
named for what it summed over — `uniquesByDay`, `uniquesByZone` — and
`uniquesBusiestDay` is the only unique count on the wire that is a real
headcount. This is the same rule GitHub's traffic follows, for the same reason.

A third rule, smaller and worth the sentence: **a cache ratio over zero requests
is `null`, not 0%**, and a zone with no analytics answer is `traffic: null` with
a `trafficNote` while a zone that was measured and served nothing has a traffic
object full of real zeroes. A card must never draw "no visitors" under a zone
nobody was able to ask about.

### Collected every six hours

`CLOUDFLARE_EVERY_HOURS` is 6, for the reason `STOCK_EVERY_HOURS` and
`MOBILE_EVERY_HOURS` are. The rollup is a figure that moves once a day and the
DNS records move when a human edits a zone; asking every half hour is ~1,100
requests a day spent redrawing a number that moved once. On this clock today's
partial bucket is still refreshed four times before it settles. A skipped run
says `zones not due — read 4h ago` rather than looking like a broken timer.

**Mail posture comes free with the records.** SPF, DMARC, DKIM and MX are
derived from the record listing that was fetched anyway for the host and proxy
counts, and cost no extra request. DKIM is three-state: a selector under
`*._domainkey` proves it, its absence proves nothing when a zone shows no sign
of handling mail, and it is only meaningfully false when the domain clearly does
send mail and the selector namespace is both empty and undelegated. `p=none` is
counted apart from "has DMARC", because a record that monitors and enforces
nothing is the most common way to believe you are protected.

## The two search engines

`GET /api/gsc` and `GET /api/bing`, on two routes rather than one — the same
split revenue takes, for a stronger reason. Google's impressions and Bing's
count different searches by different people on different networks under
different anonymisation rules. A single `/api/search` would be an invitation to
add them, and there is no figure anywhere in this codebase that spans the two.

### Search Console: nineteen properties, and two things Google will not say straight

**One credential**, a Cloud service account added as a user on each property,
scoped to `webmasters.readonly` — a token that cannot submit a sitemap, request
indexing, or add a user, because Google refuses those calls to this scope. The
entry name is `gsc-key.json`, chosen to match what the previous system's own
vault calls it.

`searchAnalytics.query` **is a POST and it is a read**, which is worth naming
because every other provider here is GET-only by construction. Google made it a
POST for a mechanical reason — the request carries a filter document that does
not fit in a query string — and it returns aggregates, creates nothing, and has
no resource that could have been modified. The exception is exactly one path.

**The last three days are not finished.** Search Console finalises a day over
roughly two to three days; ask for today and you get a real row carrying a
fraction of what today will eventually have been, which draws as a collapse
that never happened. Every window ends three days back **and** is asked with
`dataState: "final"` — the flag is Google's promise and the offset is ours, and
the free one keeps working when the other changes. Nothing in `gsc_days` can be
a partial day, and every card names the day its window ends on rather than
saying "28d" and letting a reader assume it means "ending now".

**The query rows do not add up to the property, ever.** Google withholds
queries too rare to keep a searcher anonymous and caps the rows it will return.
Measured across all nineteen properties on 2026-09-04, the ranked query rows
carried between **0% and 77%** of their own property's impressions — 2% on
acme.ie, where two hundred rows out of a long tail is a rounding error, and
19% across the portfolio. So the property's total is asked for **separately**,
as a dimensionless query, `queryCoverage` states the fraction per property, and
no card anywhere sums the query column into a headline.

The daily rows are the happy exception, and they are what makes the totals
cheap: summed over the same window they matched Google's own dimensionless
answer **exactly** (23,157 against 23,157 on acme.so), because a
date is not a thing that can be anonymised. Every window figure on the route is
therefore summed from `gsc_days` on the read, and no window total is stored
anywhere to go stale.

**Positions are impression-weighted and null rather than zero.** An average
position is a mean over impressions, so a day with four impressions must not
move a property's rank as far as a day with four thousand. Google answers `0.0`
for a property nobody saw; that is the absence of a rank, not a rank of zero,
and it is stored and served as `null`.

**Five calls per property, on a six-hour clock.** The daily series over ninety
days costs exactly what twenty-eight would — one request returns a row per day —
so the wider window is free and is what makes a chart worth drawing on the first
collection. The other four are the window's total, the two ranked breakdowns and
the sitemaps list. At the ordinary half-hourly cadence, nineteen properties
would be 4,560 requests a day spent redrawing days Google had already finalised;
on this clock it is 384. Four properties are asked at once, which turns 12.8
seconds of sequential calls into a few.

**Failure is per property, one level below per account.** A property that 403s
keeps every day it has already earned, stamps its own error, and costs the other
eighteen nothing — the trade GitHub makes for a repo without push access.
Sitemaps degrade further still: a property that refuses that endpoint keeps its
traffic, and `sitemap_state` has **three** values, because "has submitted
nothing" and "the call was refused" are different findings and only one of them
is a thing to go and fix.

**What it cannot answer**, on the wire in a `cannot` block: anything about the
last three days; a true top-queries list; how many pages are indexed — that is
the Index Coverage report, which has no API at all, so the sitemap figures are
what was *submitted*, which is a different claim; and why a position moved.

### Bing: four answers, one of which nothing else on the box can give

**One free key**, from Bing Webmaster Tools → Settings → API access, scoped to
the **user** rather than a site — one key covers everything that account has
## Meta, and the Instagram account that is not there

`GET /api/meta` is one route for the Pages and the ads, the way `/api/mobile`
is one route for both app stores: one token reaches both, the previous
system's two collectors read the same credential file, and a page that had to
fetch two
documents and join them is a page that eventually joins them wrongly.
**Instagram is in this document and has no route of its own**, because
Instagram is not an API this box talks to — an Instagram Business account is a
FIELD on a Facebook Page, read in the same call, with the same token.

### Two credential entries, both of them comment-annotated files

`meta-token` and `meta-app` — the names the previous system's own vault uses,
which makes moving them a copy. Over there both are files with a `#` note
above the secret,
and **sealing one whole and sending it as a bearer token produces
`OAuthException 190 "Bad signature"`** — which is indistinguishable from a
revoked credential and sends you to mint a replacement for a token that was
never wrong. The comment lines come out at the registry on the way in *and* in
the provider on the way out of the vault, because the ordinary way these
arrive is copied verbatim from the Pi.

**`meta-app` is not an app id**, despite the field once being labelled one. It
is `app_id:app_secret` — a sixteen-digit id and a thirty-two-character hex
secret joined by a colon, the shape the previous system's own social collector
partitions on. So it is
a secret, and what it buys is `appsecret_proof`: an HMAC-SHA256 of the access
token under the app secret, sent with every call and verified by Meta (a wrong
one comes back as "Invalid appsecret_proof provided in the API argument"). It
is **optional** — the token reads everything without it — so an account stored
with only a token connects, works, and says on the wire that its calls are
unproofed. A non-empty value that is *not* a pair is refused rather than
ignored: storing a bare app id would leave the owner believing the calls are
proofed while every one goes out unsigned.

The token is a **system user token with `expires_at: 0`** — Meta for never — so
the sixty-day exchange the previous system's own social collector performs is
something this side never does, and it therefore never writes to the vault.

### What it read, and what it could not, probed 2026-09-04

```
GET /me                                200, system user "pi-collector"
GET /me/accounts                       200, 3 Pages: Free LLM API (1 follower),
                                       Acme (9), Beacon (350)
GET /me/adaccounts                     200, ONE account, EUR, active
GET /act_…/insights last_30d           200, spend, impressions, clicks, reach,
                                       frequency, actions, cost per action
GET /act_…/insights maximum            200, €189.03 lifetime since Aug 2023
GET /act_…/campaigns                   200, 14 campaigns, every one PAUSED
GET /act_…/insights time_increment=1   200, 12 days — 5 to 16 August

GET /me/accounts?fields=access_token   403 (#200) page role cannot mint one
{page}/insights page_impressions_unique 400 (#100) not a valid metric
{page}/insights page_views_total        400 (#190) needs a Page Access Token
GET /{page}/posts, /published_posts     403 (#210) needs a Page Access Token
GET /me/businesses                      400 (#100) Missing Permission
purchase_roas, action_values            absent from every row
```

**Page reach is gone twice over, and the two reasons are different.**
`page_impressions_unique` — the metric a "Page reach" card is built on — was
retired with the whole impressions family on 15 November 2025 and now answers
"not a valid insights metric" in v21.0, as do `page_impressions` and
`page_fans`. The Page metrics that *are* still valid names answer "(#190) This
method must be called with a Page Access Token", and **this token cannot mint
one**: asking `/me/accounts` for the `access_token` field is refused 403 (#200)
even though `debug_token` lists `pages_read_engagement` among the scopes — the
scope is granted and the system user's *role* on the Pages is not, and only the
second decides. A card that said "reach unavailable" without separating those
would send somebody to fix the wrong one, so both are in the `cannot` block,
dated, written as the exchange rather than as a conclusion.

So a Page here is a **follower count and nothing else**, and that is the whole
of what is measurable. `meta.followers` is the one Page reading, summed across
Pages because a follower follows exactly one Page and the counts genuinely add.

### There is no ROAS, and the reason is the account rather than the API

`purchase_roas` is asked for on every insights call and this account has never
returned it, because **ROAS is revenue over spend and this account buys
lead-form submissions** — there is no purchase event, no `action_values`, and
therefore no revenue figure for Meta to divide by. `roas` is `null` on the wire
and stays null; it is not `0×` and it is not a verdict on the campaigns. The
column exists and fills itself the day a purchase campaign runs.

What the account *does* buy is counted instead: 12 leads over the window at
€5.16 each, Meta's own cost-per-action rather than our division. Meta reports
the same lead under several names (`onsite_conversion.lead_grouped`, `lead`,
`offsite_complete_registration_add_meta_leads` all read 12), so **one is counted
and the rest ignored** — adding them would treble the only outcome there is.
`null` means the actions field never answered; `0` means the row delivered and
produced none, which is the single most actionable fact this integration has.

**The attribution window is requested explicitly and named on the wire**
(`7d_click,1d_view`). The same twelve leads are a different number at a
different window, Meta will answer either without saying which it used, and the
account default is whatever somebody last chose in Ads Manager. A conversion
count whose window is not stated is not a measurement.

### Reach, and the one place a stored total is right

Everything else on this box is summed on the read. **Reach and frequency cannot
be**: Meta de-duplicates them over each row's own window, so two campaigns that
both reached the same person each count them once and adding the two counts that
person twice — and averaging two frequencies does the same thing in reverse.
Thirty daily reaches are not a thirty-day reach and no arithmetic recovers one.
So Meta's own window figures are stored, **with `window_from` and `window_to`
beside them**, and every card that draws one is captioned with the dates rather
than with "30d". Spend, impressions, clicks and leads are summed from
`meta_ad_days` on the read as usual, and they agree with Meta's window total to
the cent.

**A day with no row is a day nothing was spent, not a day measured at zero.**
Meta returns a row only for a day that delivered — twelve of the thirty here —
and no zero rows are invented, because "the account stopped on the 16th" and "it
spent nothing on the 17th" are the same fact only if you already know the
second. The daily card says how many days of the window carried delivery.

### Currency

The ad account bills in **EUR**; this dashboard's other money is EUR and USD.
Nothing is added across them. `currency.combined` is `null` with the reason
attached and `spendByCurrency` reports per currency — the same contract
`/api/costs` keeps between Hetzner's euro and OpenAI's dollars, and
`/api/mobile` keeps across ten. The `meta.spend` reading is recorded **only when
every active ad account shares one currency**, and the currency travels with it:
a series that quietly became a sum of euro and dollars is worse than no series.

### Instagram: connected, and there is nothing to read

This is the finding, and it is a **third state**. The credential is not missing
and it is not refused — it is a live system user token that lists three Pages by
name — and **every one of those three Pages reports no linked Instagram Business
account**. Reported as "0 followers" that is a measurement of an audience nobody
measured; reported as an error it sends somebody to re-paste a token that works
perfectly. The `instagram` block on the wire says which of four states it is in
(`no-plugin`, `no-pages`, `none-linked`, `linked`), `followers` is `null` rather
than `0`, and `fix` carries the one step that changes it — link an Instagram
Business or Creator account to a Page in Meta Business Suite, after which the
same token reads it on the next collection with nothing re-pasted.

`ig_checked` sits beside `ig_id` in the table for exactly this: without it,
"this Page has no Instagram account" and "nobody asked this Page" are the same
row. And `ig_linked` sits beside `pages_checked`, because "0 of 0" and "0 of 3"
are completely different sentences and only the second is this state.

### Collected every six hours

`SOCIAL_EVERY_HOURS` is 6, for the reason `CLOUDFLARE_EVERY_HOURS` and
`SEARCH_EVERY_HOURS` are: Meta aggregates ad insights into whole days and
revises the recent ones, and a Page's follower count moves a few times a month.
On this clock today's still-settling day is refreshed four times before it
closes. A skipped run says `Meta not due — read 4h ago`.

**Nothing here sends anything but GET.** The token carries `pages_manage_posts`,
which can write; the provider has one HTTP entry point and it takes no method
but GET, so "this cannot post to a Page" is a property of the code rather than a
promise in a comment. The token also goes in an `Authorization: Bearer` header
rather than the `?access_token=` query string Meta's own examples use, which is
how a credential ends up in an error message and then in a `runs` row the
interface displays.

## Demand: the three sources that measure somebody else

`GET /api/demand` is one route for Reddit, Hacker News and the SearXNG node,
and it is the only part of this box that measures something the owner does not
own. Everything else here answers "how is it doing" about a fleet, a
portfolio, a book of subscriptions. These answer the question that comes
before that one — what do people actually want built — and that answer only
exists outside, in threads nobody on this account wrote.

The rules are lifted from the demand collector in the system this replaces,
which is the version that has actually been run against these endpoints.

**One route rather than three, and it passes the test the search engines
fail.** Google's impressions and Bing's may never be added, so they are two
routes. Here there is a figure that legitimately spans the sources: a THREAD is
a thread, and "is anybody talking about this at all" is a question about both
sites at once. So the thread count spans them and it is the only thing that
does — **upvotes are never added across them**, because a Reddit upvote and a
Hacker News point are two crowds' currencies with no exchange rate, and the
document says so where a reader would otherwise have to infer it. SearXNG is in
the same document because it is not a fourth opinion: it is the tier that
answers a Reddit query the Atom feed refuses.

### The watch list is one list with two doors

Nothing on this box knows which phrases matter, and the two ways to invent them
are both wrong — seeding from Search Console's queries asks who is talking
about what we already rank for, which is the question these sources exist *not*
to answer, and a matrix generated from product names would put a watch list on
the owner's dashboard that the owner never wrote. So it is `plugin_config`, it
reads back, and it is capped at twenty because each phrase costs a request per
source per collection.

It is registered on **both** the Reddit and the Hacker News plugin and a write
to either is mirrored onto the other, because a phrase is the same phrase
whichever site somebody said it on. Two independent lists would be two places
for it to drift and "why is Hacker News missing the phrase I added" would be a
question with no visible answer. A save collects the sibling too, for the
reason this route collects at all: a card blank for six hours after a save
reads as a setting that did not save.

For both plugins, **connected means "there is a list"** — npm's rule, including
for Reddit, which *can* hold a credential. Its feed token only lifts a
throttle; the feed answers without one.

### Reddit: three tiers, and which one answered is part of the measurement

There is no key to be had. Self-serve app registration closed on 2025-11-11 and
the anonymous `.json` endpoints answer 403 — measured on the previous system
from a residential connection with the exact user agent Reddit's rules ask for, which
rules out both usual explanations at once. What is still open is the Atom search
feed. Probed from this box on 2026-09-04:

```
GET /search.rss?q=…&sort=relevance&t=year        200, atom+xml, 10 entries
                x-ratelimit-remaining: 0.0, x-ratelimit-reset: 27
the same with ?user=…&feed=…                     200, and no rate-limit
                                                 headers at all
GET arctic-shift …/api/posts/ids?ids=t3_…        200 in 248ms, score,
                                                 num_comments, created_utc
```

`sort=relevance` is load-bearing: logged out, `sort=new` ignores the query and
returns the sitewide firehose, which answers 200 and looks exactly like data.

**The credential is optional and it buys wall clock.** Reddit issues every
account a personal RSS token at reddit.com/prefs/feeds — the thing you paste
into a feed reader — and a search URL carrying its `user` and `feed` parameters
is served without the anonymous counter. No app, no approval queue. It is
stored as a **secret** despite looking like a URL, because it is a bearer
credential for one account's own feeds.

**What cannot be verified is that the token is yours**, and the measurement
says so plainly: on 2026-09-04 `search.rss` served a MADE-UP `user`/`feed` pair
exactly as it served the real one — 200, no throttle counter, three queries
five seconds apart all answered. Carrying the parameters is what puts a request
on the un-throttled path; Reddit does not appear to check them on this
endpoint. So `verify` claims only what it measured: the feed answers and the
counter is gone. A 200 that still carries the counter means the parameters were
ignored, and *that* is refused — storing it would leave the owner believing a
throttle had lifted that is still there.

**The 62-second pacing is not ported, and that is deliberate.** Over on the Pi
this is a systemd timer with eighty minutes to spend, so it paces at a minute a
query and takes most of an hour. Here a collection runs inside the HTTP request
that saved the setting, and a route that holds a browser open for forty minutes
is not a route. So the LIST is spread across runs instead of the run being
stretched across the list: each collection asks the phrases whose answers are
stalest until the next request would not fit in a 24-second budget, and the
rest are recorded `skipped` — by name, with the reason, first in line next
time. Anonymously that is one phrase a collection; with the feed token it is
four, which is the whole list for any sane list.

A `skipped` row **counts as never asked** when the next run picks its order,
and it bypasses the six-hour clock. Without both of those the same first phrase
would be asked every run forever while the tail was never asked at all.

**The third tier is SearXNG**, and every row it produces says so: a web index
knows a thread's title and URL and nothing about when it was posted or how many
people agreed, so those rows carry a null date and a null score and are in no
window at all. It fires on a refusal and never on a skip — a phrase this run
chose not to ask is not a phrase Reddit would not answer, and routing it to the
unscored tier would downgrade the list for a reason that was ours.

**The Atom feed has nowhere to put an upvote count** — not "Reddit withholds
it", the format has no field — so the counts come from the Arctic Shift
archive in one batched lookup per query, read only by id and never searched.
Inside about a day and a half of a post being made the archive still reports
the placeholder it filed on sight (score 1, no comments), so inside that window
its figures are dropped and the row is published unscored rather than published
wrong.

### Hacker News: free, and the only source that serves comments

`hn.algolia.com/api/v1/search` needs no credential at all, so this plugin is a
watch list and nothing else. `tags=(story,comment)` asks for both, and the
comments are the reason it is here: they are where somebody writes what they
wish existed. **The index publishes no score for a comment**, so those rows
carry a null and sort among the unmeasured — inventing a zero would put the one
uncounted number on the page beside counted ones.

Every phrase is asked every collection, unlike Reddit: there is no throttle to
spread the list across runs for, and a phrase asked at a different hour from
its neighbour would make "which of these is growing" a comparison across two
different windows.

### Null is "we could not ask" and zero is "nobody said anything"

`demand_queries` holds four statuses per phrase per source because four things
happen and only one of them is about demand: `ok` (the source answered, and
`items: 0` is a real finding), `throttled`, `failed`, `skipped`. This is
`bing_keyword_state`'s rule, arrived at independently by the previous system's
own demand collector for the same reason — an empty answer and a refused question are
indistinguishable in the response body, so the difference has to be carried
outside it.

### SearXNG: a header key, a URL that is a setting, and a card that had to change

The key goes in an **`x-api-key` header**. Probed 2026-09-04: the same key as a
`?key=` parameter is 401, no key is 401, and every path on the node is behind
it — `/healthz` included. The header is also the better door, because a key in
a URL is a key in an access log.

The URL is a **setting** (`plugin_config`, read back on the plugin page) and
not a constant: the node is self-hosted on the owner's own box and its hostname
carries that box's IP (`searxng.203-0-113-10.sslip.io`, say), so a constant in the source
is a dashboard that quietly stops searching the day the box moves. The default
is where it lives today. The registry reads the setting on its way past, so a
key is verified against the endpoint it will later collect from.

**The catalog promised a number that does not exist.** `searxng.queries` was
"Agent searches · 24h · 186", and nothing publishes it: `/stats` is HTML only
(the `format` parameter is ignored), it counts ENGINES rather than queries, and
a search response carries no total either — `number_of_results` is absent. This
box is also not the only thing that searches through the node, so counting our
own calls would answer a smaller question under a bigger name. The card kept
its key and became the node's own health.

**And the probe asks the query this box actually depends on.** It is a
`site:reddit.com` search — what Reddit's fallback tier asks — because "the node
answered" and "the node answered the question" turned out to be different facts
on the day this was written: ten links came back and **not one was on
reddit.com**, since the single engine still serving had ignored the site
restriction and the query with it. A results count reads that as perfect
health. So the state row carries `on_site` beside `results`, the run note leads
with it, and the fallback tier treats "results, none of them a Reddit thread"
as a failure rather than as an answer of nothing — which is the one place that
distinction could have been quietly lost.

Which turns out to be the better card. A search returns `unresponsive_engines`
with the node's own words, and on the probe that built this: brave "Suspended:
too many requests", duckduckgo "CAPTCHA", qwant "Suspended: access denied" — so
every one of those ten results came from Bing alone. **A metasearch node down
to one engine still answers ten links and still looks healthy**, and nothing
else on this box could see it.

Two figures are recorded as readings — the round trip and the number of engines
that answered — because each is a single fact about the node as it stands and
the series is the only way to watch it degrade. The results count is not: it is
a property of whichever phrase the probe spent itself on.

### Connecting it: `scripts/connect-searxng.mjs`

```bash
ssh you@the-box 'print-the-searxng-key' \
  | node scripts/connect-searxng.mjs                      # the default node
  | node scripts/connect-searxng.mjs https://host/search  # or another one
```

The key arrives on **stdin** and leaves on a socket, and it is never anything
else in between — not an argument (`ps` shows those to every user on the box,
and the shell writes them to a history file), not a file somebody has to
remember to delete, not a log line. Everything it prints is about the outcome,
and the one place a key could still surface — an error echoing the request — is
scrubbed on the way out.

It takes the URL as an argument or `SEARXNG_URL`, defaulting to the current
host, and **writes the URL before the key** so the API verifies the credential
against the endpoint it will collect from. It verifies twice on purpose: once
here, straight against the node, so "the box is down" and "the dashboard is
down" are different sentences at half past eleven at night; and once inside the
API, which refuses to seal a credential it has not seen work. A default URL is
deliberately NOT written to the settings — a setting holding the same string as
the fallback stops being the fallback the day the default changes.

Run on 2026-09-04 it printed 30 results in 1450ms, `bing, brave` answering and
`duckduckgo (CAPTCHA), qwant (access denied)` refusing, then `verified and
stored · connected: true · vault entries: searxng-key`.

### Two kinds of instance, and the second one this box installs itself

Everything above is the REMOTE node. There is now a second way to have one:
**`POST /api/searxng/instance/install`** clones SearXNG into
`DATA_DIR/searxng/`, builds it into its own virtualenv with `uv`, writes a
settings file and runs it as a child of this process on **127.0.0.1:8888**.

**The 401 that shaped this integration is not SearXNG.** SearXNG has no key
auth and never has — the key belongs to the reverse proxy in front of the
owner's public node, which is what makes a public node possible at all.
Measured on 2026-09-05 against a locally installed instance: `/healthz` is 200
and two bytes with no key, `/stats` is 200, a search answers. So the managed
mode sends **no `x-api-key` header at all**, and A LOOPBACK BIND IS THE AUTH:
nothing off this machine can open that port, and a key checked by this process
against a value this process generated would be a password on a door in a
locked room.

**Which mode is in force is derived from the endpoint, never typed.**
`plugin_config` holds `mode` beside `url`, the settings form rewrites it on
every save, and the provider insists on BOTH — managed *and* loopback — before
it drops the header. A mode row that had drifted from the URL would otherwise
be a bug with two symptoms: a key sent to an instance that ignores it, or a
call to somebody's public host with the credential stripped off. Pointing the
endpoint back at the remote node is the whole of "stop using the local one":
the key is still sealed in the vault, the next search uses it, and no restart
or re-paste is involved.

**Auto-connect writes no credential.** On the first healthy run the installer
writes the URL and the mode, marks the existing account connected — creating
one only if the plugin has never held anything — and probes. It never touches
the vault, which is exactly what makes switching back a one-field change.

**What it cost here, measured.** On an arm64 Mac with `uv` already present:
**67 seconds** from the button to `installed`, pinned to commit
`23e7e4da008fdc9ac5b27b2625faa9144d46f208`, on **CPython 3.12.13** (3.14 is on
this machine and is too new for the compiled dependencies — `lxml`, `msgspec`
and `curl_cffi` all had arm64 wheels for 3.12 and none was built from source).
It answers `/healthz` about three seconds after the process starts. Two engines
— `ahmia` and `torch` — fail to register at boot, which is upstream's onion
engines finding no Tor proxy, and is not a fault.

**And the local instance searches better than the remote one**, which was not
the expected result. The same probe, minutes apart: the Hetzner node returned
30 links and **0 of them on reddit.com** with duckduckgo answering CAPTCHA and
qwant "access denied"; the local one returned **36 links, all 36 on
reddit.com**, with brave, google and duckduckgo all answering and only
`startpage` refusing (a parsing error). That is the datacentre-versus-home-IP
difference, and it is the reason the `on_site` column exists.

**The process is never orphaned.** The instance is spawned by the API and:

- SIGTERM on `SIGINT`/`SIGTERM`, then SIGKILL after five seconds — a shutdown
  that can be refused is not a shutdown;
- SIGKILL from the `exit` handler, which is the last resort and can only do
  synchronous work;
- restarted with exponential backoff if it dies while it is meant to be
  running, and given up on after five starts that never reached health — an
  instance that HAS worked is worth bringing back, one that never has is
  failing for a reason the fifth attempt will not change;
- started again at boot if it was running when the API last stopped, which is
  the owner's own instruction in `plugin_config` and not a guess about what
  was running;
- and **reaped** at boot when the API was `kill -9`'d: the child's pid is
  written to `searxng.pid`, and a start that finds the port busy kills a
  process it can prove is its own and refuses one it cannot.

### The tool surface: `GET /api/search`

```
GET /api/search?q=self+hosted+search+engine
GET /api/search?q=nixos+flakes&engines=duckduckgo&language=de&page=2
GET /api/search?q=planning+permission&categories=news
```

```json
{
  "query": "self hosted search engine",
  "results": [
    {
      "title": "…", "url": "https://…", "content": "…",
      "engine": "brave", "score": 4.5, "publishedDate": null
    }
  ],
  "engines": {
    "answered": [{ "engine": "brave", "results": 20 }],
    "refused":  [{ "engine": "startpage", "reason": "parsing error" }]
  },
  "ms": 1361,
  "instance": "managed"
}
```

**This is the one route on this box that a caller ACTS on rather than reads.**
Everything else here reports what a service already did; this performs a search
and hands back links.

**It is not the `/api/search` this README argues against.** That argument is
about a *report* over Google's and Bing's figures — two populations that must
never be added, which is why `/api/gsc` and `/api/bing` are two routes — and it
stands. Nothing on this route is a measurement, so there is nothing on it to
add up wrongly.

**GET-only, no body, no key.** An agent that can fetch a URL can use it, with
no client, no SDK and no schema; and a GET can be tried by hand in a terminal,
which is how anybody debugs an agent that says it searched and came back with
nothing. It needs no credential because the API binds to 127.0.0.1 and this
route is behind that bind like every other one — a token here would be a
credential for a service already unreachable from anywhere it would matter. On
the LAN it is reachable only if the owner deliberately binds the API wider,
which is a decision made in one place and not here.

**The caller never learns which instance answered except as a fact on the
answer.** `instance` is `"managed"` or `"remote"` and is there because "why are
these results different from yesterday's" is usually answered by it. Switching
instances changes nothing about how anything asks.

**`publishedDate` is `null` when the engine did not say so**, and never today's
date; `engine` is the engine that carried the result; `refused` is reported even
on a perfectly successful search, because a metasearch node down to one engine
still answers ten links and looks healthy.

**A managed instance that is not running is a 503 with a sentence**, never an
empty result set. Zero links means the engines found nothing; this means nobody
asked them, and an agent handed the first when the second is true will report
that the web is empty on the subject. An upstream failure is 502 with the node's
own words, scrubbed of the key.

**How an agent is pointed at it.** There is no tool-registration hook here and
this deliberately does not invent one: `providers/hermes.ts` and
`providers/openclaw.ts` are chat adapters that send messages and read replies,
and neither Hermes' OpenAI-compatible proxy nor OpenClaw's gateway takes a tool
definition from this side of the wire. What both DO take is a system prompt or
an agent configuration held on their own side — so an agent is pointed at this
by being told the URL:

> To search the web, GET `http://127.0.0.1:8787/api/search?q=<url-encoded
> query>` and read `results[].title`, `.url` and `.content`. No key. Optional:
> `categories`, `engines`, `language`, `page`.

That is the whole integration, and it is the same sentence for a sub-agent
running on this box, for a shell script, and for `curl`.

### Collected every six hours

`DEMAND_EVERY_HOURS` is 6, for the reason `SEARCH_EVERY_HOURS` and
`SOCIAL_EVERY_HOURS` are, with a harder floor under it: a thread is posted once
and its score matures over a day, the window being searched is a year wide, and
these are two free endpoints nobody is obliged to serve us. A phrase newly
typed is asked immediately regardless, and so is one the last run deferred.

**And the clock does not apply across a change of instance** — the same
correction `MAIL_EVERY_HOURS` needed for an account it had never read. The
endpoint can move from the remote node to a locally installed one in a single
click, and a probe that called itself "not due" would leave the latency, the
engine list and the on-site count describing a node the box had stopped
searching, for up to six hours, with nothing on the page able to say so. The
state row records the URL it probed; a different one is always due.

### What is deliberately not here

**No classifier and no convergence fold.** The previous system's own demand
collector labels each item feature-request / complaint / question from
keyword cues and merges
near-identical titles across platforms. Both are ranking machinery for a page
that ranks, and both make a claim about somebody's sentence that a card here
has no room to show its working for. These cards rank by engagement and
recency, which are figures the sources published themselves.

**No GitHub issue search**, which is a third source for the previous system's
own demand collector. It
needs the GitHub plugin's token and its own rate budget, and it is a different
plugin's collector rather than a silent omission of this one.

**No body text.** A card shows a title and a link and the thread is one click
away, so a copy of somebody else's prose would be weight with no reader — and
this is the only data on the box that arrives from strangers.

## Telegram: the one integration that is a door rather than a measurement

Everything else here asks a service what happened. This one hands a stranger's
message to an agent that can act, and that difference decides the whole design.

**One bot token per account**, `telegram-token` — the name the system this
replaces uses for its own notifier on the Pi. `getMe` is the entire verification available:
a bot token carries no scopes, and the chat it will serve does not exist until
a human sends it a message. So "connected" is only half the answer here, and
`GET /api/telegram` reports the other half — whether the loop is actually
running.

### The lock, which is the whole security model

Telegram lets **any person on earth** open a chat with any bot, and there is no
setting that prevents it. So the bridge pairs with exactly ONE chat — the first
that messages it, which is what the catalog has always promised — writes that
id to `plugin_config` under `chatId`, and from then on a message from any other
chat is dropped **before** it reaches the agent, costs no tokens, and is
answered with *nothing at all*.

Not "you are not authorised": nothing. A refusal confirms the bot is live and
tells a stranger there is something here worth knocking at. The dropped ones
are **counted**, because "somebody else found this bot" is a fact the owner
should be able to read off the page — and only the count is kept, never the
chat it came from.

Clearing `chatId` un-pairs the bot and the next message from anywhere pairs it
again; the conversation is forgotten with the pairing, because un-pairing is
what somebody does to hand the bot to a different chat. With several bots the
first holds `chatId` and the rest hold `chatId#<account id>` — the same suffix
rule the vault's entry names follow, for the same reason — and
`DELETE /api/telegram/lock/<account id>` is the door that can name one.

**A backlog cannot pair a bot.** Telegram holds undelivered updates for 24
hours, so a token that has been sitting in a drawer can arrive with somebody
else's message at the front of the queue. An update that predates the moment
the credential was stored is acknowledged and dropped while nothing is paired.
Once a chat *is* paired the rule is off: a message sent while the box was
rebooting is a real question and gets a late answer rather than none.

### The poller

`getUpdates` long polling, `timeout: 50`, **inside the API process**. A webhook
would need a public HTTPS URL, and this server binds to loopback on purpose; a
second service would need the vault key, the database and the chat backend,
which is to say it would be this process under another name. An idle poll is
one outbound request a minute and nothing blocks — every wait is an awaited
fetch or an `unref`'d timer.

**Telegram allows exactly one `getUpdates` per token.** A second caller gets
409, and whichever wins takes the update — so two loops would each answer half
the messages. There is one loop per account, guarded by a map, and `conflict`
is its own reported state rather than a kind of failure, because its fix is on
another machine: some other process is holding this token. It keeps retrying,
so the moment that process stops, this one recovers.

A ten-second reconciler compares the accounts that should be polling with the
loops that are: connecting a bot starts one without a restart, disconnecting
stops it, and replacing a token restarts the loop around the new one. It reads
two tables and no credentials, so it costs nothing and does not write a
`secret_access` row every few seconds. Backoff is exponential to a minute, and
Telegram's own `retry_after` wins whenever it sends one.

**The offset is stored**, because it is Telegram's acknowledgement mechanism
and an unacknowledged update is redelivered. It is written *after* the update
has been dealt with: a crash mid-answer then costs a duplicate reply, which the
owner can read, rather than a lost one, which they cannot.

### What the bridge sends

The agent's reply goes out with **no `parse_mode`**. Telegram refuses a message
whose markup does not balance rather than degrading it, and an agent's markdown
contains a stray asterisk sooner or later — sent as Markdown that reply is not
delivered at all. A visible asterisk is a blemish; a missing reply is a broken
bot, and from a phone the two are indistinguishable. Only messages this app
composes itself ask for HTML, with every interpolated value escaped, and a 400
mentioning entities is retried once as plain text. Replies over Telegram's
4096-character cap are split on paragraph, line and word boundaries, and never
inside an escaped entity.

**Every failure ends in a sentence.** `NoBackendError` is sent verbatim — it is
written to be read by a person and it names what to connect. Any other failure
gets one honest line. Silence is the one outcome that is not allowed.

The conversation lives in `chat_messages` under the session id
`telegram:<chat id>` — the same table the Chat page writes to, so the same
agent has the same memory whichever door you came in by. The last ten turns go
with each message. A failed exchange is not stored, because a question with no
answer beside it would be replayed to the agent as one it had already answered.

`notify(text)` is exported for the rest of the server to call and **nothing
calls it yet**, which is deliberate: what is worth waking somebody for is a
decision, and inventing alerts here would put messages on the owner's phone
that the owner never asked for. It sends only to a paired chat and returns
`{ sent: false }` with a reason rather than throwing, because an alert path
that can crash the thing raising the alert is worse than a missed alert.

### The token is never written down

Telegram puts the credential **in the request path**, so every ordinary habit —
log the endpoint that failed, put the URL in the error — would print a live bot
token into a `runs` row the interface displays. Nothing in the provider logs a
URL, and every message that leaves it is scrubbed of both halves of the token.
Nothing anywhere logs a person: no name, no username, no word of a message,
on the wire or in the console. Chat ids and counts, and that is all.

## Mail: one route over what arrives and what leaves

`GET /api/mail` is one document for Gmail and Resend, the way `/api/mobile` is
one document for both app stores. The Email page asks one question — "what is
my mail doing" — of two services at opposite ends of the same pipe, and a page
that had to fetch two documents and join them is a page that eventually joins
them wrongly.

**It is deliberately not the split the two search engines take**, and the
difference is worth stating because the reasoning looks alike. `/api/gsc` and
`/api/bing` are two routes because Google's impressions and Bing's count the
same KIND of thing about different populations, and one document holding both
would be one field away from a card that adds them. Nothing here is that shape:
an inbox thread waiting on a reply and a transactional password reset are not
the same kind of thing, and there is no arithmetic anybody would be tempted to
perform across them. The temptation is the test, and it fails in the other
direction. Two `connected` flags, two blocks, and no figure that spans them.

### Privacy is enforced by the schema, not by a careful SELECT

An inbox is the most sensitive thing this dashboard has ever been pointed at, so
the rule is stricter than "do not print anything private": **there is no column
in `015_mail` that can hold a subject, a message body, a recipient, or the name
or address of anybody but the mailbox owner.** A route cannot leak what the
tables cannot store.

On the way in, three things enforce it. Every Gmail request carries an explicit
`fields` mask, so Gmail is asked for label ids, counters and timestamps and is
never given the chance to return a subject — `snippet` is 200 characters of
message body that rides along on responses nobody asked to trim, and the mask is
what stops it (verified live: with the mask on, the key is absent from the JSON
entirely). Thread reads add `format=minimal` on top of that. And the one call
that reads headers at all asks for `To` and `Cc` on your OWN sent mail and turns
each address into an HMAC before it leaves the provider.

This is the contract the previous system's own inbox collector keeps ("this
file lands in dist/, so it carries counts and only counts"), tightened by one
step. Its contacts collector deliberately publishes real names and addresses
because a contacts *page*
without them is not a contacts page; this dashboard has a number on a card
rather than a contacts page, so it takes the cheaper trade and keeps the
identities out entirely. The HMAC's salt is a `randomblob(32)` the migration
generates, so a fingerprint is meaningless outside this install — a plain
SHA-256 of an email address is reversible with a word list.

### Gmail: a token that can write, held by code that cannot

The refresh token in the vault was minted by the previous system's own OAuth
script with **`gmail.modify`** and `calendar.readonly`. `gmail.modify` is a WRITE scope: it
can archive a thread, move a label, trash a message. Google offers no way to
narrow a token after the fact and a `gmail.readonly` one needs a human at a
consent screen, so the credential this dashboard holds is, and will stay, more
powerful than the dashboard.

The answer is the one `providers/stripe.ts` and `providers/meta.ts` give, and it
is structural rather than a promise: there is exactly **one** function in
`providers/gmail.ts` that talks to Gmail, it hard-codes `method: "GET"`, and it
takes no body parameter — there is no argument you could pass it that would make
it write. Everything else in the file goes through it, and the only non-GET
request in it is the OAuth refresh, which is a POST to `oauth2.googleapis.com`
and not to Gmail at all. So "this cannot archive your mail" is a property of the
code. Refusing the credential was the alternative and buys nothing: it would
mean no mailbox on the board, in exchange for a risk the file's shape has
already removed. The scopes are on the wire and on a card, read off the refresh
response rather than off the file — the file's own `scopes` list is what
somebody wrote down; the grant is what it actually is.

**Three fields rather than two JSON documents.** The previous system keeps
`gmail-client.json` and `gmail-token.json`; the second already contains the
first (`client_id`, `client_secret`, `refresh_token`, plus `scopes`, `address`
and `obtained`), so the client file is the same pair written down twice. One
document is enough to connect, and it is split into `gmail-client-id`,
`gmail-client-secret` and `gmail-refresh-token` for AdSense's reason: a JSON blob
in a secret is a document that has to be parsed before anything can be checked,
and a typo inside it fails as "the grant was refused" rather than as "the client
secret is missing".

### What Gmail can and cannot be asked

**The unread count is Gmail's own and is exact.** `labels.get` answers with
`messagesTotal`, `messagesUnread`, `threadsTotal` and `threadsUnread` for one
quota unit. The obvious alternative — a search for `is:unread in:inbox` — comes
back with a `resultSizeEstimate`, and on this mailbox that estimate said **201
against a true 263**. No estimate is used anywhere behind these numbers; the
daily volume line counts the message ids a `fields` mask returns, which is exact
up to the page size and reported as a floor past it.

**"Needing a reply" is an approximation and the definition travels with it.** A
thread counts when its LAST message carries neither `SENT` nor `DRAFT` — they
wrote last and you have neither replied nor started to — computed from label ids
alone, which is both cheap and the reason no address has to be fetched to
produce it. It over-reports rather than under: a thread answered by phone, or
from another mailbox, still reads as waiting. Threads whose last message sits in
Gmail's **Promotions, Social or Forums** are excluded — 24,901 of the 83,299
messages in this inbox are promotions, and counting them is how "263 waiting"
stops meaning anything. `CATEGORY_UPDATES` is deliberately **not** excluded:
receipts, alerts and "your build failed" are real work, which is the call the
previous system's own inbox collector makes and it is not this file's place to
overturn it. The
exclusion happens **in the query** rather than after the fetch, which is the one
place this improves on the collector it is modelled on — the previous system
fetches a promotion, discovers it is a promotion, and has already spent the
request.

**The queue is a floor when the budget bites, and says so.** The per-thread read
is the only way to learn who wrote last, so `MAX_THREAD_FETCH` is a whole-run
budget of 250 spent INBOX-first; a label that ran out reports no count at all
rather than a zero, and a scanned label carries its own denominator. A queue
quietly capped at 250 is a queue somebody stops trusting the day they find out.

**"New contacts · 30d — first-time senders" was deleted as a measurement and
replaced with one that exists.** "First-time" is a claim about every sender the
mailbox has ever had — 97,472 messages of history — and counting senders at all
makes a mailing-list census out of an inbox that is a third promotions, the
exact failure the previous system's own contacts collector refuses with its
two-way test. Sent mail
answers the neighbouring question cleanly and for a hundredth of the requests:
nobody was ever subscribed to a newsletter by writing to it. It is 141 sent
messages over ninety days here, against 1,343 received in thirty. `first_at` accumulates
across runs and the rest are window figures, which is what makes "new" mean
something — and the card names the date the sent-mail history actually reaches
back to, because a "new contact" count is only as good as what it is new
against.

### Gmail's ceiling is per second, and it was measured

The first live collection spent about 3,600 quota units against a daily
allowance of a billion and still came back with `403 Quota exceeded for quota
metric 'Total Query Cost' and limit 'Units per minute per user'` — with the
outreach scan refused and thirty days of the volume line empty. The limit that
bites is the moving per-user rate, and six concurrent `threads.get` at ten units
each is ~200 units a second on its own.

Sixty `threads.get` against this project, paced three ways on 2026-09-05:

```
180 units/s   60 of 60 answered
 90 units/s   60 of 60 answered
250 units/s   45 answered, 15 refused 403 "Units per minute per user"
```

So every call declares what it costs and passes through a gate that spaces
request starts at **140 units a second** — the measured ceiling with room,
because pacing exactly at a moving average is how a run that passed all week
fails on the day a request is slow. Rate-limit refusals additionally retry twice
with backoff; a 401 or a 404 does not, because retrying either spends a request
to be told the same thing.

**One more Gmail quirk, and it looked exactly like a broken collector.** With a
`fields` mask, Gmail omits the response body entirely when nothing it selects is
present — a day on which no mail was sent answers **200 with zero bytes** rather
than with `{}`. Handed straight to `res.json()` that is "Unexpected end of JSON
input", which is how eleven days of the volume line first arrived as unreadable:
they were days with no sent mail, the most ordinary thing a mailbox can do. An
empty body now reads as an empty document. Dropping the mask would also have
fixed it, and would have handed Gmail permission to return message snippets.

### Resend: eleven keys, ten accounts, and the eleventh is the finding

The previous system keeps this as ONE vault entry, `resend-keys.json`, holding
a JSON object of eleven domain→key pairs. That is precisely the shape `accounts.ts`
exists to undo: a blob has no per-key label, no per-key state and no per-key
error, so one revoked key shows up as a warning on the plugin rather than as
"acme.ie stopped answering". Here each key is an **account**, labelled with
its domain — the same split `005_accounts_split` performed on the Hetzner token
blob.

It is not tidiness. **A Resend key is scoped to its domain**: probed on
2026-09-05, the acme.so key's `GET /domains` returns acme.so and
nothing else, and its `GET /emails` returns acme.so's mail and nothing else.
No key on this account sees all eleven, so one account row could not have covered
them even in principle. The entry stem is `resend-key` rather than
`resend-keys.json` — the one place the "use the name the previous system uses"
rule is broken on purpose, because that name describes a document holding eleven keys
and an entry here holds one.

**Ten of the eleven connected. The eleventh is a Sending-access key** and it is
refused at the door: `acme.example`'s key answers `401 "This API key is
restricted to only send emails"` to every endpoint this reads, deterministically,
on every attempt. Such a key can POST an email and read nothing at all, so
storing it would produce a permanently empty sending domain — the most expensive
shape of failure here, because it looks like an answer. It is refused with
Resend's own sentence and the fix, exactly as a Stripe test key and an OpenRouter
inference key are. The consequence is honest and worth stating: **acme.example is
not on the board, because nothing here can read it.**

### What Resend will and will not say, probed 2026-09-05

```
GET /domains          200  status, region, created_at, capabilities,
                           open_tracking / click_tracking
GET /domains/{id}     200  the DNS records, each with its OWN status
GET /emails?limit=…   200  a real list endpoint — id, created_at, from, to,
                           subject, last_event. Pages with after=<uuid>, 1–100
GET /api-keys         200  the keys on the account and when each was last used
GET /webhooks         200  empty on this account
GET /usage            404
GET /account · /metrics · /stats · /v1/usage    405 Method not allowed
```

**Send volume is answerable, and that was not a given.** Resend's docs are
mostly about sending, and a plausible reading of the API was that only individual
emails could be fetched by id — in which case there would be no volume figure at
all and the two catalog cards promising one would have had to say so. `/emails`
exists, pages with a cursor, and carries `last_event`, so delivered and bounced
are counted from real rows. Over thirty days on this account that is 955 sends
across ten domains.

Paged with `after=<id>` rather than an offset. Both work — `?page=` and
`?offset=` are accepted — but an offset over a list growing at the head re-reads
or skips rows as mail arrives mid-walk, and a cursor cannot.

**Rows are keyed by Resend's own email id and REPLACED, because `last_event`
moves.** An email delivered this morning can be bounced this afternoon, so a row
written once would be wrong in the direction that flatters: a bounce rate that
only ever counts the bounces it saw on the first pass is a bounce rate that goes
down on its own. Everything else follows from that — no rate is stored anywhere,
and `/api/mail` counts them on every read.

**The bounce rate's denominator is named because there are three defensible
ones.** It is over mail that actually reached a mail server — delivered +
bounced + complained — and NOT over everything sent. `suppressed` is Resend
declining to send at all, to an address already on its own suppression list: it
never reached a server, so counting it in the denominator would make a domain's
bounce rate FALL every time Resend refused to try. It gets its own line, and it
is the more actionable number: a suppression is a list to clean.

**There is no open rate and there cannot be one.** `open_tracking` and
`click_tracking` are `false` on every domain on this account, so Resend never
writes an `opened` or `clicked` event for them. An open rate here would be a
measurement of a feature nobody switched on, and it is in the `cannot` block
with the exchange rather than left off.

**The DNS card exists because the listing cannot show it.** `GET /domains` says
a domain is "verified"; only `GET /domains/{id}` carries the records, each with
its own status. A domain reading verified while one of its three records has
gone pending is a domain about to stop sending, and that is invisible everywhere
else. Thirty records across ten domains, all verified, at the time of writing.

**Nothing here sends.** One HTTP entry point, `method: "GET"` hard-coded, no
body parameter — so `POST /emails` is unreachable from the module by any
argument. Every one of these keys can send mail from a domain real people trust,
which makes that worth being a property of the code. Requests are paced 250ms
apart because Resend rate-limits at two a second and answers 429 past it.

### Collected every two hours

`MAIL_EVERY_HOURS` is 2 — the shortest slow clock on this box, which is
backwards from every other one here and is the point. Cloudflare, the app stores
and Search Console are on six because the figures they report move once a day;
an inbox moves while you are looking at it, and "there are four things waiting"
read at breakfast is worth nothing by eleven. The same is true of a bounce:
`last_event` changes within minutes of a send. It is not the half-hourly default
either, because a full Gmail pass is a few hundred requests and redrawing a
triage queue forty-eight times a day would spend an order of magnitude more of
Google's budget than the answer moves. Two hours is what the previous system's
own inbox collector settled on over the same mailbox.

**The clock also notices an account it has never read**, which no other
collector here does and Resend is what forced it. Eleven keys are added one at a
time and each add kicks off a collection; with a plain "was anything read in the
last two hours" guard, the first key would collect and the other ten would be
told the provider was not due — leaving ten sending domains blank until the
timer came round, for a reason nothing on the page could state. A clock that
exists to avoid REDUNDANT work does not get to call an account it has never read
redundant.

A finished Gmail day is asked about once and the newest three are re-read every
run, because a day is still gaining mail until it is over — the same "never
re-fetch a day already answered, bar the ones still moving" rule the app stores
keep. In steady state that is six day queries a run rather than sixty.

## Model providers: who completes, and how many at once

Two layers, and the distinction is the whole design. An **agent** — Hermes,
OpenClaw — thinks: tools, memory, multi-step work, and exactly one of them
answers the Chat page. A **provider** — a local model, OpenAI, OpenRouter,
FreeLLMAPI — completes: turns in, text out, over an OpenAI-shaped wire, and
exactly one is the DEFAULT that every agent is pointed at. `src/models/provider.ts`
is the contract and the limiter; `src/routes/models.ts` owns the settings and
hands the contract its choice reader, exactly as `routes/chat.ts` does for the
agent seam.

So "which model" is decided once, in one place, and switching it takes effect
on the next completion rather than the next restart — the factory is called on
every `activeProvider()`, so a rotated key, a changed URL or a switched policy
is picked up with no bounce.

**The default may be unset, and that is the shipping state.** Nothing picks a
provider on the owner's behalf. Quietly defaulting to whichever happens to be
connected is a dashboard that starts spending somebody's OpenRouter credits
because a key was in the vault.

### The policy lives with the provider, not the caller

A local model on one GPU wants calls in **series** — two at once halves the
speed of both and can run the card out of memory. A hosted API wants them in
**parallel** up to some ceiling. Two local boxes want the calls **spread**.
Those are facts about the service, so they are settings on it
(`plugin_config`, under `policy.mode`, `policy.concurrency`, `policy.balance`
and `policy.timeoutMs`), and every caller gets the right behaviour without
knowing why. The limiter enforces them in-process; it is not a promise the
callers keep.

| | mode | at once | balance | timeout | why |
| --- | --- | --- | --- | --- | --- |
| `local` | series | 1 | round-robin | 120s | one GPU. The model already loaded is the fast one |
| `openai` | parallel | 6 | least-busy | 120s | not about OpenAI's limits — about a runaway loop here not spending six ways before anybody notices |
| `openrouter` | parallel | 4 | least-busy | 180s | it is a router; the request waits on whichever upstream it picked, and the free-tier ones are slow |
| `freellmapi` | parallel | 4 | round-robin | 120s | argued in its own section below |

Every one is overridable per provider and every write is validated: mode is
`series` or `parallel`, concurrency is a whole number 1–64, balance is
`round-robin` or `least-busy`, and the timeout is 5s–10min. The bounds are not
limits of this box — 64 is the point past which a number is a typo, and below
five seconds no real completion finishes.

**The limiter is proved rather than asserted.** `scripts/limiter-proof.mjs`
fires four concurrent completions under each policy against whatever `local`
endpoints are connected, and reads back what happened from figures the server
reports. Under `series` it measures an observed concurrency of 1.00 with
`queuedMs` climbing 0 → 310 → 683 → 1226; under `parallel/4` every call's
`queuedMs` is zero. Four simultaneous calls alternate across two endpoints
under *both* balance rules, so the script also runs the uneven load that tells
them apart — one long call left running, one short call completed elsewhere,
then a third — where round-robin hands the third call to the endpoint still
busy (1115ms) and least-busy hands it to the free one (51ms).

### `local`: one plugin for every OpenAI-compatible server

Ollama, LM Studio, vLLM, llama.cpp's server and a hand-rolled FastAPI all
answer `GET /v1/models` and `POST /v1/chat/completions`, and the differences
between them are in what they RUN rather than in how they are asked. A plugin
per product would be six plugins holding one adapter and a seventh the day
somebody ships a new runner. So there is one, its credential is a URL, and the
product's name is what the owner types in the account's label.

**This is the one plugin where several accounts mean throughput.** Everywhere
else a second account is a second thing to read — another Hetzner project,
another mailbox. Two local endpoints are two machines that can each take a
completion, and the limiter spreads across them. It is also the opposite of
the agents, where several accounts exist and exactly one answers: asking two
agents one question is two answers to reconcile; asking two endpoints two
questions is twice the throughput.

**The key is optional, which no other credential here is.** Ollama and LM
Studio ship with no auth and bind to loopback, which IS the access control —
the same argument SearXNG's managed instance makes. But an empty key against a
host that is NOT on the owner's own network is refused with a sentence, and a
key is never sent in the clear over plain `http` to such a host. Both rules are
in the provider rather than only in the verify, so a hand-edited row cannot
walk around them.

An endpoint whose `/models` answers and lists **nothing** is refused at the
door. A runner with nothing pulled connects perfectly and then fails every
completion with "model not found", which is the connect-happily-then-be-empty
failure this codebase keeps catching early — and it is the likeliest way this
integration is first tried.

### OpenAI and OpenRouter hold two keys, and neither can do the other's job

This was probed rather than assumed, on 2026-09-05, with the keys already in
this vault. Verbatim, scrubbed:

```
openai   sk-admin-…  GET  /v1/models
         403 "…Missing scopes: api.model.read…"
                     POST /v1/chat/completions
         401 "…Missing scopes: model.request."   code missing_scope

openrouter  management key  POST /api/v1/chat/completions
         401 {"error":{"message":"User not found.","code":401}}
```

So the key that reads the bill cannot ask the model a question, on both
services, for two unrelated reasons — and `src/providers/openrouter.ts` had
already established the reverse, that an inference key is refused by
`/activity` and `/keys`. Each plugin therefore gains a second, **optional**
field, `chat-key`: a project key on OpenAI, an ordinary inference key on
OpenRouter. The cost collectors are untouched and read `key` as they always
did; an owner who only wants their spend chart pastes one key and is never
nagged for another.

The entry names are `openai-chat-key` and `openrouter-chat-key`, not
`openai-admin-key-key`. A plugin that grows a second field late would otherwise
flip the naming derivation and rename the first field's entry for every new
account, breaking the promise this file makes about where to look — so the
second field is written under its own stem and the first keeps the name it has
always had.

**One probe here looks like evidence and is not.** OpenRouter's
`GET /api/v1/models` answers 200 to the management key — and to no key at all,
which was checked. Its catalog is public, so a verify built on it would pass
every string ever typed into the box. The inference key is verified against
`/api/v1/key`, which says `is_management_key` about itself, and a key whose own
spend limit is exhausted is refused there too: it answers `/key` perfectly and
402s every completion.

**Neither of the two keys in this vault can complete**, so no completion has
ever been made through OpenAI or OpenRouter here. That gap is stated rather
than papered over; the wiring is exercised by the refusals above, which are
real round trips to both services.

### The chat fallback: a model with nothing in front of it

`POST /api/chat` used to answer 503 when no agent was live. It now falls
through to `complete()` when a provider is, and stamps the assistant row
`provider:<id>` rather than with an agent's name. Reading a transcript six
weeks later, "Hermes" and "Local model, direct" are two different claims about
what that answer was capable of being.

The order is **agent first, always**. An agent that is live is what the owner
chose and is strictly more capable; falling through to a raw model while one
was running would answer a question with the worse of two available answers.
And the fallback goes through `complete()` rather than round the side of it, so
a chat message queues behind the provider's policy exactly as an agent's turn
would — a chat that jumped the limiter would be the one caller able to put two
completions on a single GPU at once.

`ChatBackendId` is unchanged and still means the two agents; the widening
happens once, on the stored MESSAGE, as `MessageBackendId`. Neither adapter has
to know the provider layer exists and neither can accidentally claim to be one.

## FreeLLMAPI: the second thing this box can install rather than connect to

FreeLLMAPI is an OpenAI-compatible **gateway**: it holds keys for the ~34
providers that publish a free tier, aggregates their catalogs into one
`/v1/models`, and routes each completion to whichever of them can serve the
model right now, failing over when one is throttled. It is the owner's own
open-source project (`github.com/acme-org/freellmapi`).

**There is no hosted FreeLLMAPI, and establishing that shaped the whole
integration.** Probed on 2026-09-05: `freellmapi.co` is a static site on
Cloudflare Pages — every path under `/v1` answers 404 as HTML, and a POST to
one is 405, because static hosting has no POST. `api.freellmapi.co` is a
different service again: the **catalog and licence** API (`/v1/latest`,
`/v1/license`, `/v1/account`, `/v1/checkout`), which sells the same-day model
catalog to a `$19/yr` licence and completes nothing. The catalog entry that
described this plugin as "the in-house catalog API" was describing that second
thing, and has been corrected.

So an instance is always somebody's own, the base URL is a **field**, and there
are two ways to have one. Both end up as accounts of the same plugin, because
they are the same software and the same wire — which is what makes switching
which one answers a click rather than a re-paste.

| | |
| --- | --- |
| **hosted** | an instance running elsewhere. The owner's is on a rented box at an address like `https://freellm.example.test/v1` — the same endpoint the previous system's own completion client completes against, which is where that placeholder comes from. Its key is the `freellmapi-key` already in the Pi's vault |
| **managed** | cloned into `data/freellmapi/`, built, and run as a child of this process on `127.0.0.1:3001`. Nothing is pasted: it mints its own key |

### Three facts that are constantly confused, and are kept apart

`installed` is something on disk. `running` is a child process answering on
3001. **`inUse` is which endpoint a completion would actually go to** — and it
is a third thing, because a running local instance beside a deliberately chosen
hosted account is a legitimate state. With no explicit choice the local one
wins **while it is healthy**, because a completion served on this machine costs
nobody's free-tier allowance and cannot be taken away by a box rebooting; the
hosted one answers when it is not. A choice made by hand overrules that and is
never quietly ignored — but it is also never allowed to point at an account
that has been deleted, because an id left behind would otherwise mean "no
provider" with nothing on the page able to say why.

A fourth, one layer up: whether FreeLLMAPI is the **default provider** at all
(`PUT /api/models/provider`). A perfectly connected gateway with a local model
chosen over it completes nothing, and the panel says so rather than showing a
green dot beside silence.

### The key is minted headlessly, and that was the open question

The documented route to a key is "open the dashboard, go to Keys, copy it",
which no process can do. It turns out not to be where the key comes from.
Reading the repo at commit `1edb8d5`: the unified key is **inserted by the
baseline migration** the first time the database is created — `freellmapi-`
plus 24 random bytes as hex, into `settings.unified_api_key`, in plaintext,
before any account exists. The dashboard's Keys page reads that row; it does
not create it.

So the install runs the migration itself (`npm run db:migration:up -w server`,
with `FREEAPI_DB_PATH` pointing inside `data/freellmapi/`) and then reads one
row out of the resulting file with `node:sqlite` — the reader this runtime
already has for `opc.db`. **No account, no browser, and nothing on port 5173 at
any point.** The value goes from that row into the vault and is never logged,
returned or passed as an argument.

Two working routes were rejected:

- **The HTTP one.** `POST /api/auth/setup` is open without a setup code from a
  loopback socket, so this process could claim the dashboard with an invented
  email and password and read the key from `GET /api/settings/api-key`. It
  would also permanently claim the owner's dashboard with a password only this
  process knows — locking them out of the page where provider keys are added —
  to obtain a value already sitting in a file. The owner claims it themselves,
  from a browser on this machine, with no code needed.
- **Scraping the boot log.** The migration writes the key straight to stdout,
  deliberately past the gateway's own redaction, because for a person
  installing by hand that line *is* the delivery. Parsing it would make the
  key's arrival depend on a log format — and that line is exactly why
  `instance.ts` scrubs every line it writes down: `freellmapi-…` and `sk-cp-…`
  are replaced whole before anything reaches the log file or the panel.

### What the install actually does

Clone shallow and record the commit; `npm ci` at the repo root (it is an npm
workspace — installing inside `server/` produces a tree that cannot see
`@freellmapi/shared`); check that `better-sqlite3` really has its prebuilt
binary, because it is an **optional** dependency whose absence npm reports as
success and the gateway discovers on its first query; `npm run build -w server`
into `server/dist/`; `npm run build -w client`, whose failure is **not** the
install's failure — the API works without the bundle and only the browser page
would not render; then the migration above.

It is refused before the clone if this API's own Node is outside the gateway's
`engines` (`>=20.18.0 <25.0.0`), because finding that out at `npm ci` is a
wasted clone and a confusing error about a dependency.

Three environment variables carry the whole configuration, and one is
load-bearing: **`HOST=127.0.0.1`**. The gateway binds `::` by default — every
interface, dual stack — which for a service guarded by a single bearer token on
a laptop that joins café wifi is not a default anybody chose. `FREEAPI_DB_PATH`
puts the database (and the `.encryption-key` it generates beside it) under
`data/freellmapi/data/`, so a reinstall of the checkout does not throw away the
provider keys the owner added. `NODE_ENV` is deliberately **unset**: at
`production` the gateway refuses to start without an `ENCRYPTION_KEY`, at
`development` it refuses to run its own migrations, and unset is the one value
that self-migrates and generates its own key.

### A fresh gateway routes to nothing, and the smallest honest fix

Installed and started with nothing in it, the gateway's catalog is real — 250
models on this machine — and **every candidate fails**: `no enabled+healthy key
for platform`, because a model is only reachable through a provider the owner
has given a key for. "Install here" would end with a running process, a
connected account, and a completion that fails in a paragraph.

Two of the providers need no key: Kilo's gateway serves its `:free` routes
anonymously and OVH's AI Endpoints have an anonymous tier, and the repo
registers both `keyless: true` — the adapter sends no `Authorization` header
and the stored "key" is a sentinel row saying the provider is on. The **first
start** switches those two on through the gateway's own declarative-config
mechanism, and records it on the install marker.

**Once, and never again**, which is why it is not simply an environment
variable left in place: the gateway applies that config idempotently on every
boot and reads a missing `enabled` as *enabled*, so a config left in the
environment would switch these two back on every time the owner turned them
off. Seeded once, the dashboard's own switches are the last word. Nothing else
is seeded — no routing strategy, no model list, no fallback order, because
those are opinions about somebody else's gateway.

### The policy: parallel, four at a time

`series` is right for a single local model because two calls at once halve the
speed of both — the contention is *ours*. Nothing here is contended by our own
concurrency: every completion runs on somebody else's machine, and this is a
router with a failover loop, not a GPU. Unbounded is wrong for the opposite
reason: the scarce thing is upstream free-tier allowance, counted per minute
and spent by failover retries as well as by answers, and the gateway
rate-limits its own proxy surface at 120 requests a minute per client IP by
default. Four in flight, at the five-to-thirty seconds a free provider actually
takes, is comfortably inside that.

The timeout is two minutes rather than the wire's sixty seconds, because the
gateway's own failover budget is 45 seconds and its per-provider ceilings run
to 180: a turn that fails over twice is legitimately slow, and cutting it at
sixty would report a timeout for a request that was about to answer. All four
numbers are overridable per provider from the models page.

`defaultModel` is `null` unless the owner pins one, and here that is a real
answer rather than a shrug: this gateway's catalog **begins with its own
routing aliases** — `auto` first, measured on both instances — so "whatever the
endpoint lists first" is the router saying "let me choose". The model that
actually answered is on every reply, because it routes elsewhere constantly:
the two probes below were answered by two different models neither of which was
asked for.

### Measured on 2026-09-05

```
GET  /v1/models            hosted: 200, 631 ids     managed: 200, 250 ids
GET  /v1/models  no key    401 — the key is auth, not decoration
POST /v1/chat/completions  hosted:  dots-studio/dots-3-note-preview:free, 2.9s
                           managed: openrouter/free (Kilo, anonymous), 5.9s
```

Both replies carry `_routed_via` naming the platform and model that served
them, and `reasoning_content` beside `content` — which `chat/wire.ts` already
reads in the right order, content first.

### No orphans

Every exit path of this API sends `SIGTERM` and then `SIGKILL` after a grace,
the pid is written to `data/freellmapi/freellmapi.pid` before the child is
adopted, and boot reaps a pid left behind by a `kill -9` that ran none of that.
The child is spawned as `node server/dist/index.js` rather than `npm start`
deliberately: `npm` would sit between this process and the thing holding the
port, so `SIGTERM` would land on the wrong process and the grandchild would be
exactly the orphan this arrangement exists to prevent. A port that is busy and
not ours is a sentence naming it, never a takeover.

## Spawning an agent here: Hermes and OpenClaw as child processes

Both agent plugins already worked, and the shape of "working" was the problem.
`providers/hermes.ts` and `providers/openclaw.ts` connect an agent that is
**already running somewhere**: paste a base URL and a bearer, the adapter
verifies it, chat works. That is the right answer when there is one — a Hermes
on the Pi, a gateway on a work laptop — and it is unchanged. What it left was
the ordinary case: a form asking for the address of a thing that does not
exist. `src/agents/instance.ts` is the other door. Install it here, configure
it here, run it here, connect it here.

It is the third managed child on this box, after the SearXNG node and the
FreeLLMAPI gateway, and it keeps their contract exactly: a background install
with a step and a log tail, a marker file that answers "which version is this",
a singleton child with a health probe and backoff, auto-start at boot only if
it was running when the API last stopped, and `SIGTERM` then `SIGKILL` on every
exit path so nothing is orphaned on 8642 or 18789.

### Two things everybody knows about these agents, both wrong

Both were installed and run for real on this Mac on 2026-09-05, and the two
facts the catalog and the adapters carried turned out to be false. They are
written down in the module's own header as well, because the next person will
otherwise spend the same hour.

**Hermes' OpenAI door is the API server on 8642, not `hermes proxy` on 8645.**
`hermes proxy start` reads as the obvious candidate and is not one:
`hermes_cli/proxy/cli.py` takes `--provider nous|xai`, calls
`adapter.is_authenticated()`, and exits 2 with `Not logged into Nous Portal`
when it is not. There is no code path in it that reaches a custom endpoint — so
no amount of provider configuration makes it start, and if it did start it
would forward to a **model** rather than run the **agent**. The real door is in
the checkout's own docs at `website/docs/user-guide/features/api-server.md`:
`API_SERVER_ENABLED=true` and `API_SERVER_KEY` in `$HERMES_HOME/.env`, then
`hermes gateway run`, and an OpenAI-compatible server appears on
127.0.0.1:8642 whose `/v1/models` lists exactly one model — `hermes-agent` —
and whose `/v1/chat/completions` runs the agent with its tools. **It needs no
Nous login of any kind.** (`hermes serve` on 9119 is JSON-RPC over WebSocket
and does not speak this API; that part was right.)

**OpenClaw's provider lives under top-level `models.providers`, not under the
agent.** `openclaw config schema` is the authority: a provider is
`models.providers.<id>` with `baseUrl`, `apiKey`, `api` and its own `models`
list, and the agent selects it with `agents.defaults.model.primary` spelled
`<provider>/<model>`. The 500 an earlier attempt got from a bare gateway was
the **harness**, not the wire — `agentRuntime.id: "openclaw"` pins the built-in
one so the gateway cannot go looking for `codex`.

### Containment: a HOME of its own, which is the whole trick

Neither installer takes a "put everything here" flag, and both spread
themselves across `$HOME`. Hermes' script resolves `HERMES_HOME` to
`$HOME/.hermes`, puts the checkout under it, links the `hermes` command into
`$HOME/.local/bin` — and, on this machine, decided the system npm was in a bad
band and installed a **managed Node 26** beside it. Given the owner's real home
that is three surprises for one agent.

So the child and the installer are given `HOME=DATA_DIR/<agent>/home`.
Everything lands inside it: `data/hermes/home/.hermes/hermes-agent` (the
checkout and its virtualenv), `data/hermes/home/.hermes/node` (that managed
Node), `data/hermes/home/.local/bin/hermes` (the command). `~/.hermes`,
`~/.openclaw` and `~/.local/bin` on this machine are untouched, which was
checked. OpenClaw takes the same shape through `OPENCLAW_HOME`, which is a HOME
replacement rather than a config path — the config lands at
`$OPENCLAW_HOME/.openclaw/openclaw.json`, and `openclaw config file` says so —
and the package itself is an `npm install --prefix` into `data/openclaw/`
rather than a `-g` that would put a second `openclaw` on the owner's PATH.

One cost, named because it is visible in the log: the path is deep, and Hermes'
shutdown watchdog wants a unix socket under it. `AF_UNIX path too long` is what
that produces. It costs a liveness witness inside Hermes and nothing this app
uses.

### What gets written, and the two secrets in it

`activeProvider()` is read once per configure, and the result is written into
the agent's own config **whole**. For Hermes that is two files at mode 0600:

```yaml
# $HERMES_HOME/config.yaml
model:
  provider: "custom"
  base_url: "…/v1"
  api_key: "…"
  default: "…"
```

```
# $HERMES_HOME/.env
API_SERVER_ENABLED=true
API_SERVER_KEY=…
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

and for OpenClaw one JSON document at mode 0600 carrying
`models.providers.opc` (baseUrl, apiKey, `api: "openai-completions"`,
`agentRuntime.id: "openclaw"`, one model), `agents.defaults.model.primary`,
`gateway` (port, `bind: loopback`, `auth.mode: token`,
`http.endpoints.chatCompletions.enabled: true`) and **`discovery.mdns.mode:
"off"`** — left alone the gateway advertises itself on the LAN over Bonjour,
which was observed, and announcing a loopback-bound agent to the network is the
same decision made backwards.

Hermes' `config.yaml` is written whole rather than edited. Upstream ships a
1,600-line commented example; every key in it has a default in code, so a short
file saying only what this app decided is both complete and readable, and a
surgical edit of a document this app does not own is a merge conflict waiting
for the next release. OpenClaw's file cannot even carry a note saying who wrote
it: the gateway validates against a closed schema and exits 78 on
`<root>: Unrecognized key: "_comment"`, then trips its own restart-loop breaker
after three tries. That was learned the expensive way.

**Two secrets, neither ever printed.** The provider's key comes from
`activeProvider()`; the **door key** — the bearer this app uses to talk to the
agent — is 24 random bytes generated once into `data/<agent>/door.key` at mode
0600. Both go into config files and nowhere else: not into a log line, not into
a route's answer, and never into an argument list, because `ps` is readable by
every process on this machine. `AgentReport` has no field that could hold
either.

### Connecting: the same `verify()` a pasted credential goes through

The first healthy probe runs the **remote adapter's own** `verify()` against the
managed URL and the door key, and only then writes the credential set. A managed
connect therefore proves exactly what a pasted one proves — the address is a
server, it speaks this API, it accepts this bearer, and it lists something to
ask — with the same code, so the two paths cannot drift into disagreeing about
what "connected" means.

It gets **its own account** and never overwrites a pasted one, which is new and
is the reason both adapters grew a `mode` check. A plugin can now hold two
perfectly good credentials — a Hermes on another box and the one spawned here —
and "the first connected account" cannot decide between them: whichever it
picked would be an accident of insertion order. So `plugin_config` carries
`mode` (`managed` or `remote`) and `managedAccount` (the row this app created),
`answering()` in each adapter prefers the managed row when the mode says so,
and anything else leaves the old rule exactly as it was.

### Only one is live, and only one runs

`chat.backend` already names the single agent that answers, and that rule is not
re-implemented here: `POST /api/agents/:id/make-live` writes that setting and
nothing else, so a managed agent and a remote one compete for the same slot on
the same terms. What this adds is the cheaper half — **it refuses to start the
second managed agent while the first is running**, with a sentence naming the
one that is up. Two agents thinking on one laptop is two model bills and two
several-hundred-megabyte runtimes, and only one of them is reachable anyway.
Boot resumes at most one, for the same reason.

### Following the provider, without thrashing

Neither agent re-reads its config file, so a changed default provider means a
rewrite and a restart. A fifteen-second watcher compares the active provider
against the fingerprint the running child was configured from — the base URL,
the model, and a **digest** of the key, so a rotated key counts as a change
without a copy of it being kept to compare against.

It waits a minute before acting, and that debounce is not a nicety. Without it,
an owner trying three providers in a minute restarts the agent three times, and
a restart that lands mid-turn ends that turn: the reply that came back said
`Operation interrupted: waiting for model response (8.2s elapsed)`, which is a
true sentence about a thing this file did to itself. A flip-flop back to the
running configuration cancels the pending change entirely and the agent never
notices. `POST /api/agents/:id/reconfigure` is the impatient version.

### Measured on 2026-09-05

| | |
| --- | --- |
| Hermes, cold install (nothing cached) | ~5 minutes |
| Hermes, through the route with uv/Node caches warm | **18 s** — clone 4 s, venv and dependencies the rest |
| Hermes on disk | 852 MB checkout + venv, 495 MB of toolchain under its home |
| Hermes version | `Hermes Agent v0.21.0 (2026.8.31)`, commit `f159e581c7af` |
| OpenClaw install | **10 s** cold, `openclaw@2026.9.1` pinned in source |
| Hermes cold start to healthy | ~20 s (tool registry, skills index, model catalogue) |
| OpenClaw cold start to healthy | ~5 s |

Two real round trips through `POST /api/chat`, both against FreeLLMAPI as the
default provider:

```
hermes    · hermes-agent     · 4,741 ms
  "I am Hermes Agent, built by Nous Research."

openclaw  · openclaw/default · 3,985 ms
  "I'm your OpenClaw assistant — a fresh agent that just woke up in this
   workspace, still unnamed, ready to figure out who I am alongside you."
```

And one refusal worth keeping, because it is a real constraint rather than a
bug: pointed at the local Ollama provider serving `qwen2.5:0.5b`, Hermes
answers `Model qwen2.5:0.5b has a context window of 32,768 tokens, which is
below the minimum 64,000 required by Hermes Agent`. Neither model on that
endpoint clears the bar. Nothing here papers over it by writing a
`model.context_length` this box cannot vouch for — an invented context window
is a made-up number in exactly the sense the rest of this document refuses.

### Telegram needed no change, and here is the proof

The bridge already calls `ask()`, so an agent spawned here is reachable from a
phone the moment it is made live. With the managed OpenClaw live, `handleUpdate`
fed a `/status` command over a **copy** of the live database (the harness shape
`src/telegram/bridge.test.ts` establishes) answers:

```
<b>Agent</b> OpenClaw · Managed instance (OpenClaw here)
```

`GET /api/telegram` reports an `agent.label` too — with the caveat that its
`agent()` helper names the first **connected** backend rather than the live one,
which never showed before because two agents were rarely connected at once and
now routinely are. Its own comment says as much ("Which one actually answers is
the chat backend's own choice"). It is left alone here rather than quietly
corrected, and it is the one thing on this page that is known to be imprecise.

## Skills: the same data, in a shape an agent can learn

The dashboard already answers "what is my MRR" in twenty-six routes. An agent
could call them — but then the thing it has to learn is twenty-six paths, four
parameter names, and which of them take a `days` clamped to 400 against an
`hours` clamped to 720. That is a list a model gets wrong at the tail, and the
way it gets it wrong is not a 404: it is a confident figure with the wrong
window printed beside it.

So there is one more surface, and it holds no data of its own.

### The registry is code, and that is the whole argument

`src/skills/registry.ts` has one entry per data integration — eighteen of them —
and each entry carries four things: the route(s) it reads and what their
parameters mean **in the units the route actually clamps to**, a description
written for an agent rather than for a person, one or two questions it really
answers, and the **honesty rules lifted out of that route's own header**.

Those rules are the point of the file. Every route on this server spends
paragraphs establishing why a figure is null rather than zero, why two numbers
that look alike may not be added, and which of two similar figures is the one
that may be called revenue. A tool handed to a model without them is worse than
no tool at all, because a model with a tool will use it:

| skill | the rule it must carry forward |
| --- | --- |
| `stripe` | MRR is a normalisation this app computes, not a figure Stripe publishes — an annual plan counts as a twelfth a month; trials, past-due and one-off payments are never in it. Attempts and settlement are two measurements. Only `fees` may produce a processing rate |
| `hetzner` | EUR net of VAT, never added to a dollar. CPU is already divided by cores; the fleet line is a mean and never a sum. There is no memory or disk-capacity figure and there cannot be |
| `domains` | countdowns computed on the read; `autoRenewUnknown` is not `autoRenewOff`; `lapsed` is in none of the expiring windows |
| `costs` | USD and EUR side by side, **no blended total and you must not make one**. OpenAI has no per-model cut. Replicate's `cost` is null and stays null |
| `mobile` | the estimate and the payout are different things — never added, never substituted. Only a payout may be called revenue. Ten currencies, no total |
| `mail` | nothing spans the two halves; received and sent are never added; there is no subject, body or recipient in this data and there cannot be |
| `github` | views add up and **uniques do not** — not across days, not across repos. `partial` days are off the line |
| `npm` | downloads, never installs. ISO weeks; a partial week is never drawn beside a complete one |
| `gsc` | the query rows carry ~19% of impressions and **must never be summed into a total**; the window ends three days back; positions are impression-weighted and null rather than zero |
| `bing` | never added to a Google figure. `void` is unmeasured, `na` is "Bing reported none", neither is zero. No referring-domain figure exists |
| `cloudflare` | the window ends yesterday; uniques do not add; `traffic: null` is "not measured" and a zero is a measurement; alignment has five states and is not a boolean |
| `meta` | reach and frequency cannot be summed or averaged and carry their own dates; a day with no row did not deliver; ROAS is null because this account buys leads |
| `adsense` | every figure is an estimate and is never added to a Stripe one; not-authorised is a state, not a failure |
| `demand` | the thread count spans the sources and is the only thing that does — **upvotes are never added across Reddit and Hacker News**; an undated row is in no window |
| `stock` | it measures a constraint, not a result — there is no "clips used" figure and none can be produced |
| `telegram` | it is a door, not a measurement |
| `board` | these rows are the owner's own words, and this skill is **read only** |
| `search` | a tool, not a report — the one skill here that reaches off this machine |

Plus four rules that are true of every document and therefore live in one place:
money is never added across currencies; a figure the source de-duplicated cannot
be summed; `null` means asked and not told; quote the window and the units.

`skills()` returns only the entries whose plugins are connected **right now**,
and `plugins` is an ANY-OF — the domain portfolio answers with one registrar or
with two, and mail answers with Gmail alone.

**What is deliberately not in it.** `/api/mailbox` reads live Gmail — subjects,
bodies, correspondents — and is the one route here whose whole design is that
nothing is stored and nothing is logged. Handing an agent a tool onto it would
widen a surface that was narrowed on purpose, and none of the questions this
exists to answer need it.

### Three routes

`GET /api/skills` is the catalog: every connected entry with its parameters,
its rules and its example questions — **and a `disconnected` block naming what
is not there and which plugin would change that**, because "there is no AdSense
figure" and "nobody connected AdSense" are different sentences.

`GET /api/skills/:id?<params>` is a **GET-only proxy** onto that entry's route,
so an agent needs one base URL and one shape. `?view=` picks between an entry's
cuts (`hetzner` has `default`, `servers`, `volumes` and `load`). An unknown id
answers **404 with the list of ids**; a known but disconnected one answers
**409** saying the credential is missing and not to report it as zero; an
unknown parameter is **refused rather than forwarded**, because a silently
ignored `month=august` is how an agent captions a 30-day window as August.

The document is passed through **verbatim, including the status code**. Wrapping
it in an envelope of this file's own was the obvious move and is wrong twice: it
would put a second shape between the agent and the route's contract, and it
would leave every honesty rule describing a field at a path it is no longer at.

`GET /api/skills/prompt` is the whole thing compressed to about 1,300
characters: the base URL, one line per connected id with its parameters, and the
four universal rules. The lines are ids rather than descriptions on purpose — a
name the agent has never seen is a question it will answer out of its own head,
while a name without a description is one `GET /api/skills` away from the full
explanation. The rules are never trimmed.

Nothing on these routes writes. `routes/skills.ts` registers no `post`, `put`,
`patch` or `delete` and its one outbound call sends no method but GET, so "an
agent cannot write to the board through here" is a property of the code rather
than a promise in a comment — the same claim `providers/stripe.ts` makes about
its own outbound half.

### The `opc` command

`src/cli/opc.ts` is the door for an agent with a terminal, which is to say for
Hermes. Zero dependencies, a client of `/api/skills`, no registry and no
database handle of its own:

```
opc                          what is connected, one line each — and what is not
opc help <id>                one skill: its views, its actions, their flags, its rules
opc <id> [view] [--p v …]    read a document (a GET; changes nothing)
opc <id> <action> --p v …    change something (a POST; only what the skill allows)
opc present                  how to draw cards, charts and tables in the chat
```

**The word after the id is looked up, never guessed.** A view key is a read,
an action key is a write, and anything else is refused with the list of both —
because an agent that typed `opc board create_card` and had it treated as a
read would believe it wrote something. A flag the skill does not have is
refused rather than dropped, for the proxy's reason. A parameter the catalog
calls a number goes out as a number. The document comes back **verbatim,
status code and all**, indented unless `--raw`; an error lands on stderr with
exit code 2, a usage mistake with exit code 1.

**Why a command rather than a tool.** The packs used to say `curl -s
"http://127.0.0.1:8787/api/skills/stripe?days=30"` and `config.yaml` registered
one MCP subprocess per integration beside them. Both put a second thing between
the agent and the figure: a URL to assemble and a base to misquote, or a child
process to keep alive and a tool list the gateway caches for the life of the
process, under a second vocabulary (`opc_stripe`) beside the packs' own
(`stripe`). A terminal is for commands. `opc stripe --days 30` is the one token
the pack showed, the shell finds it, and the error when it is wrong is a
sentence.

`skills/cli.ts` writes the two-line wrapper that makes it a word:
`data/hermes/bin/opc`, which execs this process's own `node` on the script with
`OPC_API` set — and `agents/instance.ts` starts the gateway's `PATH` with that
directory. Hermes' terminal tool inherits the gateway's environment (its
`local.py` rewrites `PATH` only to prepend its own install dir), so the agent
types `opc` and gets this. Every pack also names the absolute path, for a shell
that somehow cannot.

### Rich answers: cards, charts, bars, meters and tables

An answer that carries figures can draw them. The chat page renders five
fenced blocks — ```` ```cards ````, ```` ```chart ````, ```` ```bars ````,
```` ```meters ````, ```` ```table ```` — each holding one JSON object, as live
widgets; everywhere else they are the fenced code they look like. The contract
is `src/skills/present.ts`, one text served through three doors so the agent
learns one syntax: the `rich-answers` Hermes pack (always present — there is no
plugin whose absence makes a chart wrong), the tail of the remote preamble,
and `opc present`. The client half is `client/src/components/RichBlock.tsx`,
which parses exactly what the guide promises and **falls back to a code block
when the JSON does not parse** — the normal case mid-stream, and the honest
case when the agent got a comma wrong.

The guide picks the form by the data's job (headline figures → cards, over
time → chart, categories → bars, against a limit → meters, many rows → table)
and repeats the honesty rules a widget makes easy to break: every number from
a document read this turn, the title names the window and the unit, one
currency per block, nothing de-duplicated is summed, `null` is left out and
never drawn as zero, at most three blocks. The Telegram bridge sends
`plainRich(text)` — each block as lines of its figures — and stores the answer
as written, so the same session opened on the Chat page draws it.

### The MCP server

`src/skills/mcp.ts` is OpenClaw's door, and no longer Hermes' — see above. A
**zero-dependency stdio JSON-RPC 2.0 server**:
`initialize`, `ping`, `tools/list`, `tools/call`. One tool per connected skill,
named `opc_<id>`, with an input schema built from the route's parameters and
**the honesty rules in the tool description** — which is the only text an MCP
client is guaranteed to put in front of the model, and therefore the only place
a rule is certain to arrive before the numbers do.

It is a **client of `/api/skills`** and holds no registry of its own, so a
plugin connected while an agent is running appears on the next `tools/list`
without this process being restarted. It has no database handle and will not be
given one. The API being unreachable is an **error** rather than an empty tool
list, because an empty list is indistinguishable from "nothing is connected" and
an agent told that will answer out of its own head.

Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`. `openWorldHint` is the one that is not uniform and is
why the registry carries a flag for it: `search` performs a live web search and
everything else reads a document a collector already wrote to a file on this
machine. Declaring the search tool closed-world to save a field would be a false
statement in exactly the field a client trusts when it decides whether to ask
first. Without the annotations OpenClaw's own probe reports "tools have no
safety annotations; calls require approval" and every read of the fleet becomes
a prompt somebody has to answer.

Point any MCP-capable agent at it:

```json
{ "command": "node",
  "args": ["--experimental-strip-types", "<repo>/server/src/skills/mcp.ts"],
  "env": { "OPC_API": "http://127.0.0.1:8787" } }
```

or drive it by hand — it is newline-delimited JSON on stdin:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | OPC_API=http://127.0.0.1:8787 node --experimental-strip-types src/skills/mcp.ts
```

### What is installed where

**Hermes gets the command and the packs.** `configureHermes` writes the `opc`
wrapper, then one `SKILL.md` per connected integration plus `rich-answers`,
filed by subject (`finance/stripe-revenue`, `infrastructure/hetzner-fleet`,
`communication/rich-answers`) beside Hermes' own skills, each carrying a
`.opc-generated` marker so the prune can tell ours from anyone else's. The
packs are what the agent **sees** — one line each in its system prompt, which is
how it knows the data exists at all — and every one says `opc <id> …` and
nothing else. `config.yaml` carries no `mcp_servers` block, on purpose.

The `github` pack keeps a suffix (`github-traffic`) because Hermes ships a
bundled skill of that name and `_locate_skill` refuses an ambiguous one —
"Ambiguous skill name: 2 skills match" — which would stop **both** from loading.
Hermes' index renders `frontmatter.name` while its lookup collects candidates by
**directory** name, so the two are always equal.

**OpenClaw gets only the MCP server, because it has only one door.** Probed
against `openclaw config schema`: there is no key for a skills directory and no
raw-HTTP tool to hand a URL to. So `configureOpenClaw` writes `mcp.servers.opc`
plus `tools.sandbox.tools.alsoAllow: ["bundle-mcp"]` — and that second line is
what lets the agent actually **call** them. Without it the server connects,
lists its tools and is never invoked, which is a failure with no error in it. It
is `alsoAllow` rather than `allow` because the two cannot both be set in one
scope and `allow` replaces the built-in tool set: the agent would gain this
dashboard and lose its shell.

**A conversation with no venture selected gets the roster.** The first
question in a session — "can you run academic research for beacon?" —
was asked with no venture selected, and the agent, which knew of a pack called
`ventures` it had not opened, asked what Beacon was. So `withVenture`
now gives an unscoped conversation with a live agent one line per venture:
name, slug, stage and host, twenty short lines, plus the one command that
reads any of them in full. A business's name is then a word the agent
recognises. The Telegram bridge composes its turns through the same
`composeTurns` as the web routes, so the agent on the phone is the agent on
the page.

**Documents are sized for a terminal.** The `ventures` default view is
`/api/ventures?brief=1` — the list without the brand blobs, 7 KB rather than
135 KB — because Hermes' terminal tool truncates long output and an agent that
read the first dozen ventures reported the rest as not existing. A view path
may carry a fixed query of its own; the caller's parameters are appended after
it. `opc` prints a note on stderr for any document past 24 KB, naming the way
out (`--raw | jq`), and never calls `process.exit` after writing — on macOS a
piped stdout is asynchronous and an exit right after a write dropped everything
past 64 KB, which is how a 135 KB document ended mid-string at exactly 65,536
bytes. `ventures one --key` also accepts the name or the host, case
insensitively, so "Beacon" is an address and not a slug to guess at.

**A dispatch files itself under the conversation that made it.** The
sub-agents skill takes a `parentSessionId`, the system turn names the id, and
the agent — asked to research a venture — wrote "Parent session: s-0jk8q6"
INTO THE BRIEF and dispatched without the flag. The run then appeared nowhere
near the chat. So `chat/inflight.ts` keeps the fact the agent kept dropping:
every chat turn registers its session for as long as the backend is answering
it (the `ask` wrapper and the stream route), a run's own `run:<id>` turns are
excluded, and a dispatch with no parent while exactly one conversation is in
flight is filed under it — reported as `parentSessionInferred: true`. The
explicit flag still wins, and the pack's example now carries it (`exampled`
on the parameter). The same run failed a second later for a second reason:
the Paper Writer's brief is its literature-search query, and a paragraph of
instructions returns no papers. The pack says so now, and `searchSubject` in
the executor condenses a long brief to a phrase before the scout, naming the
phrase on the step.

**A dispatch shows in the rail at once, and its result comes back to the
chat.** Two more things the owner asked for after the first paper. While an
answer is streaming, a run filed under its session is pushed down the same
stream as a `child` event (`inflight.notify`, subscribed per session in the
stream route), and the page re-reads the rail on it rather than when the turn
ends. When a run with a parent finishes — done, failed or cancelled —
`reportToParent` in `runs/executor.ts` writes one assistant turn into that
session on channel `run`: what finished and how long it took, the report's
opening from its first section heading, a link to the run page, and for a
paper its title, thesis, PDF and Typst source. The page polls the rail every
five seconds while any child is live and re-reads the open transcript when
that chat's live children shrink, which is the moment the report has landed.

**A remote agent gets the preamble instead.** When the live backend's mode is
`remote`, `routes/chat.ts` prepends `GET /api/skills/prompt` as a system turn —
the HTTP shape, since a pasted remote agent has no `opc`, with the rich-answer
syntax at its tail. A managed agent gets nothing of the kind, and the asymmetry
is deliberate: it already has the packs, carrying the full rules, and putting a
summary in front of it as well is two sets of instructions about one subject.
The failure mode of that is not redundancy — it is a model reading the short
one, deciding it now knows how to fetch Stripe, never loading the pack, and
answering without the rules. The provider fallback gets nothing either: a raw
model has no way to fetch a URL, and one told to fetch something it cannot fetch
does not say so, it writes down what the answer would probably have been.

### Keeping it in step, and the restart

The set is regenerated on `reconfigure()`, before every spawn (configure runs
first, so a fresh start always has current packs), and by a **watcher** in
`agents/instance.ts` on the same fifteen-second poll and sixty-second settle
window the provider watcher uses — for the same measured reason, which is that
an owner connecting three integrations in a minute would otherwise restart the
agent three times and a restart that lands mid-turn ends that turn.

**A poll rather than a callback on `upsertPlugin`, and that is not laziness — a
callback would be wrong for three of these plugins.** npm, Reddit and Hacker
News have no credential at all: "connected" for them means "there is a list in
`plugin_config`", written by a route that never touches the plugins table.
Hooking the credential door would keep the packs in step for twenty-four
integrations and silently miss the three whose connection is a setting.

**Removal is the half that matters.** A stale App Store pack on a box with no
App Store credential invites the agent to report a revenue of zero for an
integration nobody set up, which is the single worst failure this feature can
have, because it looks exactly like an answer. The sync deletes packs whose
integration has gone — and only ever directories carrying the `.opc-generated`
marker, so the fifty-seven bundled skills and anything the agent wrote for
itself are untouched.

**A running Hermes does need a restart when the SET changes, and this was
measured rather than assumed.** Hermes builds the `## Skills` block of its
system prompt once and caches it in `_SKILLS_PROMPT_CACHE`
(`agent/prompt_builder.py`), keyed on the skills directory, the tool list and
the platform. The disk snapshot beside it *is* invalidated correctly by a file
manifest, and the `skills_list` **tool** re-scans every thirty seconds — but the
in-process prompt cache has no key that a new file changes, so a running gateway
goes on advertising the set it started with for the life of the process. The
agent would still find a new pack if it thought to call `skills_list`; it has no
reason to, because nothing in its prompt says the pack exists. So the watcher
bounces the child when the set actually moved, and never for a sync that wrote
nothing. Packs are compared against what is on disk before being written, so an
ordinary reconfigure leaves every mtime alone and costs no restart.

**OpenClaw is never restarted for this and needs no equivalent**, because its
door is the MCP server, whose tool list is built by asking `/api/skills` on
every `tools/list`.

### What it answered

Asked through `POST /api/chat` on a fresh session — *"Run `opc costs --days 7`
in your terminal and show me the USD and EUR totals as a cards block, then list
the OpenRouter spend by model as a bars block."* — the live Hermes ran the
command in its terminal and answered in 22 seconds with two blocks the page
draws:

> Total LLM spend across OpenAI and OpenRouter for the last 7 days, with the EUR
> figure from Hetzner unavailable in this output.
>
> ```cards
> {"title": "LLM spend, last 7 days (USD and EUR)", "cards": [{"label": "USD total", "value": 28.15, "unit": "USD", "note": "OpenAI $7.82 + OpenRouter $20.33; Replicate cost unavailable"}, {"label": "EUR total", "value": "n/a", "note": "Hetzner section not returned by opc"}]}
> ```
>
> ```bars
> {"title": "OpenRouter spend by model, last 7 days (USD)", "unit": "USD", "bars": [{"label": "openai/gpt-4.1-mini", "value": 13.8469}, {"label": "google/gemini-3.7-flash", "value": 3.3069}, …]}
> ```

Every figure is from the document, the window and the currency are in each
title, the missing EUR figure is a note rather than a zero, and the summed USD
is one currency — the rules, kept, by a model that read them in a pack and
typed one command.

## LinkedIn and TikTok are registered, unset, and not built

`linkedin-client-id`, `linkedin-client-secret`, `tiktok-client-key` and
`tiktok-client-secret` are **declared names in the previous system's own list
of known secrets, with no value ever stored** — checked on the Pi on
2026-09-04. The catalog said
"Credentials stored, flow not shipped"; the first half was false, and it now
says what is true, the same correction the AdSense entry took before it.

There is no provider, no collector and no registry entry for either, and that
is a decision rather than a backlog item. Both are **posting** APIs: the useful
scopes are behind a three-legged OAuth flow a human has to complete in a browser
as the page's admin, and on the other side of it there is no read surface worth
collecting. A registry entry would mean either a `verify` that cannot be
exercised — storing a credential unchecked, which is the one thing the closed
registry exists to prevent — or a stub that lies about having tried.

**This is now half out of date and the correction is the Publishing section
below.** `linkedin` and `tiktok` ARE registry entries as of 2026-09-06, with
`verify` functions that make a real call. What did not change is the paragraph
above about OAuth: there is still no three-legged flow here, because the
redirect URI has to be reachable from the internet and this server binds to
loopback. The token is PASTED, it expires, and both plugins say so on their own
help text rather than offering a sign-in button that cannot work. There is
still no collector for either — nothing about them is a measurement — and
LinkedIn's read surface is used only to probe what the credential can post as.

## Activity: who signed up, what happened, and what is on the floor

Three things in one area — `server/src/integrations/activity/` — because they
are one question asked at three distances. **Users** asks the products
themselves who is using them. **Activity** merges every source already being
collected into one timeline. **Today** asks the Stripe tables what was tried
and not collected. They share a page at `/activity` with a tab each, and they
are three skills rather than one because their honesty rules are different: a
population's trap is double counting a window, a timeline's is quoting an
invented moment, and money's is a total that spans two units.

### Users: the one population no vendor can be asked about

Stripe knows who paid and Umami knows who visited. Neither knows who **signed
up**, because a signup happens inside an application and no third party is told
about it. So the application publishes it, at a URL, and this reads it — one
account per product, the account's label being the product's name, exactly the
shape `product-stats` has one integration over and for the same reason.

**The contract has two forms, and the second one is the point.**

```
{ "users": [ { "id": "u_1", "createdAt": "2026-08-01T09:00:00Z",
               "email": "…", "plan": "pro", "paid": true,
               "lastSeenAt": "…", "country": "IE" } ],
  "total": 4873, "generatedAt": "…" }
```

```
{ "counts": { "total": 158, "new": { "days": 7, "n": 12 } }, "generatedAt": "…" }
```

`{"users": []}` is a product saying it has no users. `{"counts": {"total":
158}}` is a product saying it has 158 and cannot name them. Those are opposite
facts, and a schema that could only express the first would have made the
second invisible — which is the mistake the previous system's users page was
built around avoiding, where counting one product's local table would have
reported **1 user** for what was its largest customer base.

**Addresses are hashed and the salt is per install.** `activity_users` stores
`sha256(salt + ":" + lowercased address)` and the mail domain, and nothing
else about the address. The domain is in the clear because "gmail.com"
identifies nobody and is the one part worth a chart; the hash exists for
identity across collections and for nothing else. The salt lives in
`activity_salt` rather than in `plugin_config` for one reason: `plugin_config`
is read back by a route, so a salt kept there would be published to the browser
beside the settings it sat with. **There is no route, no filter and no query
parameter here that takes an address** — `q` on the list matches the product's
own id, the plan, the country and the domain, and a lookup by address is the
capability being declined rather than a feature not yet written.

**A document that fails validation changes nothing.** The rows the last good
one produced stay exactly as they were, dated, beside a sentence naming the
field that is wrong. A product ships a bad deploy more often than it deletes
its users, and a collector that let a malformed document truncate the table
would turn one bad minute into a page with nobody on it. **One bad row in four
thousand is skipped rather than fatal**, because refusing the lot would lose
3,999 good ones over one typo — the document is accepted with `problems` on it,
and the difference between "some rows skipped" and "the whole document refused"
is `reachable`.

**Every problem is its own sentence and names the field.** Verification at
connect time runs the same validator, which is the one moment the owner is
standing at the form with the endpoint's code open. Against a deliberately
broken document:

```
$ curl -XPOST .../api/plugins/users/accounts -d '{"fields":{"url":".../broken.json"}}'
{"error":"It answered and the shape is right, but: total is \"lots\", which is
 not a count. Leave it out rather than send a string. users[0].createdAt is
 missing, which is not an ISO 8601 timestamp — \"2026-08-01T09:00:00Z\" or
 \"2026-08-01\". users[2] is \"nope\", and every item of users has to be an
 object.", "verified": false}
```

**`total` from the product beats a count of the rows held here**, which is a
floor: nothing in `activity_users` is ever deleted and no endpoint promises to
list everybody. Where the two disagree `partialList` is true and both are on
the wire — "137 users by the product's own count · 120 of them listed here" —
rather than the smaller figure being reported as if the base had shrunk.

**`new7d` and `new30d` are never summed.** The seven is inside the thirty. A
counts-only product has **null** for both, because it publishes no rows to
bucket, and its own window travels separately in `newWindow` with the number of
days it chose. `summary.windowsMissing` says how many products are absent from
the portfolio windows for that reason — absent, not zero.

**`paid` is three-valued.** A product that does not publish the field has an
unknown paid count and `paidUnknown` says how many, so nothing divides by a
denominator that is partly guesswork.

Tables: `activity_users` (one row per person per product, upserted, never
deleted), `activity_user_days` (signups per day from the rows, rebuilt on every
collection; `total` instead for a counts-only product, which has no rows —
`source` says which kind of row it is and the two columns are never added),
`activity_user_docs` (the last document with every address stripped out before
storage, plus `problems`), `activity_salt`.

Routes: `GET /api/users`, `GET /api/users/:product` (filtered and paged; **409**
for a counts-only product, which has no list), `GET /api/users/:product/document`,
`GET /api/users/entities`. The venture a product belongs to is resolved three
ways in order — the `ventures` setting (a decision), a `venture_links` row (the
same decision made on the map), then the endpoint's hostname against the
ventures' own (a guess, reported as `matchedBy: "host"`).

### Activity: the one surface on the time axis

Every other page here is a set of current readings. `/activity` is a list of
things that happened, merged from six sources already being collected, written
into `activity_events` by a pass on the collectors' cadence. It is a pass and
not an integration: it owns no credential, no account and no collector, and
every row it writes is derived from a table something else filled.

**Half of these timestamps are the source's own and half are computed, and every
event says which.** `exact: true` is a moment the source published — a signup's
`createdAt`, a run's `finished_at`, a card's `done_at`, GitHub's `pushed_at`,
an alert's own stamp. `exact: false` is a source that publishes a **UTC day**:
`stripe_charge_days` and `stripe_ledger_days` are one row per day per currency,
so the best that can be said of a refund is which day it settled on. Those
carry a ts at the start of their day and the page prints "Sep 3 · day" where an
exact event gets a clock. **Nothing fabricates a timestamp**: an
active-subscription count going up is real and is not here, because Stripe
reports it as a level and the moment it moved was never recorded.

**The dedupe key is the primary key**, so the pass is idempotent by
construction: it re-derives its window every time and inserts what is not
already there. A Stripe day that is later revised — a refund landing in
September against a July charge — updates that day's event in place. The day is
the event and there is one of it.

**Charge, refund, dispute and `payment_failed` events have no venture and cannot
get one.** Stripe's day tables are per account and per currency, not per
product. `?venture=` therefore excludes every one of them, and the document says
so in `filter.note` rather than leaving a filtered feed looking broken.

**A `payment_failed` event counts declines only.** Radar blocks travel in the
detail beside it and are never added to it — a block is card testing stopped
before a bank saw it, which is the system working.

**The day counts are counts of events, never of money.** Four refunds is four
bars' worth whether they were four dollars or four thousand; a chart that scaled
with currency would be a revenue chart with the currencies added together.

**The alerts source is optional and reads a table it does not own.**
`alert_events` may not exist; if it does, its columns are read off
`sqlite_master` and mapped by the names actually present. If no timestamp or
title column can be found the source is skipped **with a note saying so**,
because guessing which column is the time is how invented moments get onto a
timeline.

A first pass only derives back `WINDOW_DAYS` (90). That is not retention —
events already written are kept — it is the boundary on what a first run may
create, so the first collection of a product with five years of users does not
put five thousand signups on the feed at once.

Route: `GET /api/activity?days=&venture=&kind=&limit=`, plus
`POST /api/activity/refresh`, which is the page's Collect button for a
derivation whose collector is not a plugin.

### Today: money on the floor, with the arithmetic printed under it

Computed from the Stripe tables on every read and **stored nowhere**, for the
reason the uptime route computes availability on read: a stored "money on the
floor: $9,271" is wrong ten minutes later and badly wrong after a week of failed
collections, which is the week somebody looks at it.

Every bucket carries the sentence that produced it — which table, which columns,
which window — because a figure like this gets quoted, and a quoted figure whose
derivation lives only in a server file is one nobody can check.

Four rules decide every figure:

- **Per currency, and no blended total.** `combined` is null at both levels.
- **Attempts are not settlement.** Declines come from `stripe_charge_days`,
  which is attempts; refunds and disputes from `stripe_ledger_days`, which is
  money that moved. They are dated differently and no total spans them.
- **Declined and blocked are never added.** On this account over 30 days that is
  112 declines against 125 Radar blocks; reporting 240 as a payment failure rate
  would be an alarm about card testing rather than about the business.
- **A window figure and a per-month rate are not summed.** `totals.window` is
  money that left in the window (refunds + disputes + dispute fees, all from the
  ledger). `totals.perMonth` is past-due MRR plus the recurring coupon discount
  — dollars per month for as long as they last. Two numbers, with their units.

**Two buckets carry `amount: null` and it is not zero.** A decline has no amount
because the charge-day table records attempts as counts; an abandoned checkout
has none because nothing was ever invoiced. While `noAmount` is non-empty every
total is a floor, and the page draws an em dash where a `$0` would have read as
"cost us nothing".

**`wrongFigures` names what the route refuses to produce**, said out loud rather
than left as an absence somebody fills in with a division of their own. First
among them is **the dispute rate**: Stripe measures disputes against lifetime
successful transactions, this box holds neither a lifetime charge count nor a
dispute-level table, and any ratio buildable here has the wrong denominator —
and is exactly the figure a risk reviewer would be quoted. So it is not computed
at all. The other three are the payment failure rate, a single number for money
on the floor, and the value of an abandoned checkout (`listedIfBilled` is on the
document as a hypothetical and in no total).

Route: `GET /api/leakage?days=`.

## The Chief of Staff: goals, memory, rounds and outcomes

Every other section of this file describes something that is **measured**. This
one describes the four documents that make the measurements mean anything, and
not one of them is collected from anywhere.

- **Goals** — what the owner is trying to do, in their own words. Without it
  "traffic is down 12%" is a fact with no significance.
- **Memory** — what the assistant has learned and can be held to, dated.
  Without it, every conversation starts from nothing.
- **Rounds** — a reason for work to happen on a Tuesday when nobody opened the
  dashboard.
- **Outcomes** — whether anything that was done changed a number.

They are one area (`integrations/chief/`) and not four, because they are one
feature: a round reads the goals to write its briefs, an outcome measures what a
round produced, and the memory is where what was learned from either ends up.
The area holds **no credential and no collector** — three of the four documents
are somebody's writing, and the fourth reads other areas' documents through the
skills surface at the moment a reading is due. There is one `config` entry, the
pseudo-plugin `rounds`, for the reason `workspace`, `chat` and `backups` are
pseudo-plugins: `plugin_config` points at plugins, a setting has to hang off
something, and a schedule is a decision rather than a secret.

### Goals: two text fields, deliberately

`chief_goals` holds one row per scope: `('global','')` and `('venture', <id>)`,
with `PRIMARY KEY (scope, venture_id)`. `venture_id` is `''` and never NULL for
the global row — SQLite treats NULLs as distinct in a unique index, so a NULL
global row would permit **two** global goals and then answer with whichever one
the planner reached first. `chief_goal_history` keeps the text as it was before
every edit, with who made it (`owner` from the page, `agent` through the skill);
an identical save writes no version, so the history is edits rather than blurs.

The temptation with a goals feature is a hierarchy — objectives, key results,
quarters, progress bars — and it is refused. That is a project-management
product, and its failure mode on a one-person box is that the structure outlives
the intention: a tree of OKRs nobody has edited since March that the agent is
still faithfully steering by. Two markdown boxes are small enough to actually
rewrite.

**"What to tailor advice to" is derived, not typed.** Every venture already
carries a STAGE the owner picked off a form that explained it, so `tailorTo` is
composed from that stage rather than asked for a second time — two fields saying
the same thing would eventually disagree.

`GET /api/goals` answers the global text, every venture's **including the blank
ones** (the list that needs writing is the one that matters), and each venture's
`tailorTo`. `GET /api/goals/:key` is one venture; `GET /api/goals/history` is the
previous wordings. `PUT` **and** `PATCH` write, with one handler: the write is a
whole-document replace either way, and a skill action may name only POST, PATCH
or DELETE — so the agent's door is PATCH while the page's stays the PUT a replace
deserves.

### Memory: a dated belief, not a fact

`chief_memory` carries `text`, `scope`, `venture_id`, `source` (`agent` |
`owner`), `created_at` and `last_confirmed_at`. Both dates are on the wire and
both are rendered into the prompt in words — "I noticed … confirmed 4 months
ago" — because a belief quoted without its age is a belief presented as current,
which is how an assistant becomes confidently wrong.

**A restatement is a confirmation and not a duplicate.** The same sentence
arriving again moves `last_confirmed_at` forward instead of inserting a second
row, which is what makes "still true in September" expressible at all and what
stops an eager agent filling the memory with forty copies of one fact.

**The numbers gate.** The commonest bad note an assistant writes is a
measurement — "MRR is €412" — which is true for a day, wrong for ever after, and
already one skill call away. A note the AGENT writes that reads as a metrics
snapshot is refused with a refusal that says what to save instead. An owner
writing the same sentence is not refused: it is their memory.

**The weekly consolidation pass** (`POST /api/memory/consolidate`, and an hourly
timer that fires once per ISO week) hands the whole set to a model and asks for
two things: merges, and drops. What the model returns is then **enforced here**:
an id it invented changes nothing, a merged sentence longer than a note may be
changes nothing, and a note whose `source` is `owner` is untouchable — the owner
typed it or corrected it, and an assistant deciding which of the things it was
told are still worth knowing would be editing the owner's mind on a timer. A
failed pass is still recorded against the week, so a provider that is down is
retried next week rather than every hour for a week.

**And it is reversible by construction.** Before the pass touches anything, the
entire note table is serialised into `chief_memory_versions`; `POST
/api/memory/undo` puts the newest un-restored snapshot back, and snapshots the
current set on its way out so undoing an undo is possible. Storing a diff would
be smaller and would require this code to be right about what a merge is;
storing the set requires it to be right about nothing. "The model was quite
confident" is not an undo.

**This is not Hermes' memory.** The managed agent keeps its own `MEMORY.md` and
`USER.md` in its own directory, and those go with that backend. This table is
the DASHBOARD's: it is injected into the system turns of every backend — managed
agent, remote agent, raw provider — so what the assistant knows about the owner
does not change when the owner changes which model is answering.

### Both go into the chat, in one system turn

`withGoals()` in `routes/chat.ts` prepends ONE system turn carrying the global
goals, the venture's goals when the conversation is filed under one, and the
newest 30 relevant notes. One turn rather than two, because a model reading two
adjacent system turns treats the second as a correction of the first. It goes to
**everybody**, the raw provider fallback included, on `withVenture`'s argument
rather than `withSkills`'s: this is not an instruction about a tool that some
backends lack, it is the subject. Notes past the cap are **counted rather than
hidden**, so an agent shown 30 of 40 knows to read the rest through the skill
instead of assuming it has seen the memory. Nothing is written when both are
empty — a turn saying "the owner has written no goals" would be an instruction
to go and ask for some.

The venture's goals are also prepended to every sub-agent brief, in
`subagents/routes.ts`, in front of the standing instructions and labelled as
context rather than as orders — so a worker doing a demand study at six in the
morning knows what "good" means for that business.

### Rounds: queued work, one slot, and a ledger of decisions

At the configured hour, `runRound()` walks `ventureRows()` and, for each venture
that is due, dispatches the configured roles by calling `dispatch()` in
`subagents/routes.ts` **directly**. Not a loopback POST, which would put an HTTP
hop inside a timer, and not an INSERT of its own, which would skip the
switched-off check, the standing instructions and the session filing that live
there.

Three things it will not do, each a setting because a different owner wants a
different answer: it will not work a venture at a **quiet stage** (an idea-stage
venture has nothing for an analyst to read), it will not work the same venture
twice inside its **cadence**, and it will not exceed **max runs per round**. And
one that is not a setting: it will never dispatch a role that is already running
or queued for that venture — a second copy of the same job does not arrive
sooner, it delays everything behind it and bills twice for one report.

`chief_rounds` records what the walk considered and decided; `chief_joblog`
records **every job, including the ones that became nothing**. That is the whole
point of the table: `agent_runs` has no row for a venture that was skipped, so
"why did nothing happen last night" is a question it cannot answer. `skipped`
covers a quiet stage, a cadence, a spent cap and a busy worker; `refused` is a
worker the owner switched off. Neither is a fault and neither is drawn as one.

The work is filed under a fixed chat session, `rounds`, so the runs nest under
one **Rounds** row in the rail rather than making a new conversation every
morning. The round writes two short assistant turns into it — what it dispatched,
and what it skipped and why — and never pastes a report: each run posts its own
when it finishes. That session is the one conversation on this box whose title
no transcript could derive (nobody typed into it), so `GET /api/chat/sessions`
names it, rather than letting the rail draw the estate's nightly work as
"Untitled chat".

Settings live at `PUT /api/plugins/rounds/config` — `enabled`, `hour`,
`timezone`, `roles`, `max`, `days`, `quiet` — and there is deliberately **no
second door** on `/api/rounds`: one registry, one set of refusals.
`GET /api/rounds/schedule` reads them back with the next run computed, which is
the half the config route cannot answer. The hour is an hour **in a place**: the
next run is found by walking forward hour by hour through an `Intl` formatter
rather than by arithmetic, because "06:00 in Europe/Dublin" is not a fixed offset
from now and a day with a DST transition in it is 23 or 25 hours long.

### Outcomes: correlation, said every time

An outcome links an **action** — a board card, a run's report, or a dated note —
to a **metric addressed the way everything on this box is addressed**: a skill,
a view, its params and a dotted path into the answer. That is what makes it
generic: a metric another area ships next month is trackable the day it ships,
with no edit here.

The baseline is read **synchronously by the POST**, because a link made without
a before is a link with no before, and "we will read it on the next tick" makes
an outcome created at 09:58 and one created at 10:02 an hour apart for no reason
anybody can see. Readings follow at **7, 14 and 30 days after the action** — not
after the link; the action's own date is the anchor, and a future one is refused.

`chief_outcome_readings.value` is nullable and that is the point. A disconnected
plugin, a moved field, a document that reports `null` — each records a row with
a null value and its own sentence saying which, because "the figure is null" is
three different findings. A zero would put a cliff in the chart that the owner
would read as a collapse in the business. The page draws a **gap in the line**,
never a floor.

Before, after, delta, percentage and verdict are computed on read. `pct` is
**null when the baseline was zero** — a percentage of nothing is not a
percentage — and the delta stands beside it. The verdict band is ±10% and is
coarse on purpose: a small site's numbers move that much between Tuesdays, and a
band narrower than the noise reports weather as consequence. There is no verdict
at all (`pending`) until a reading has been taken after the action, and
`unreadable` is its own bucket rather than folded into `flat` — a metric nobody
could read is not a metric that did not move. Every document carries the window
in words and the caveat in full: **this is correlation, not causation; nothing
here controls for anything else that happened.**

### The skills, and what their rules forbid

`goals`, `memory` (pack `agent-memory`), `rounds` (pack `rounds-and-schedule`)
and `outcomes`, all `plugins: []` and therefore always live. Three of them write,
which is why their rules are longer than most:

- `goals.set` exists — an owner saying "change my goal for X to Y" should not
  have to go and type it — but the rules forbid the thing an eager assistant
  does otherwise: tidying the wording, merging two goals, or "updating" one to
  match what it has just measured. A goal quietly rewritten to match reality is
  no longer a goal.
- `memory.remember` is gated against measurements; `memory.forget` is marked
  `destructive`, because the consolidation undo restores a whole pass and not a
  note the agent deleted on purpose.
- `rounds.start_now` says in its own text that it spends the single slot and
  real tokens, and there is **no action that writes the schedule** — an
  assistant that could widen its own schedule has no schedule.
- `outcomes` repeats the correlation caveat as its first rule and the
  null-is-not-zero rule as its second.

### Three timers, all idle until configured

`onStart` arms the rounds walk (ten minutes, returns immediately unless rounds
are on and the hour matches and no round has run today **in the owner's zone**),
the consolidation pass (hourly, returns unless a week has passed and there are at
least three notes) and the outcome readings (hourly, returns unless something is
due). Every watermark is asked of a TABLE rather than of a variable, because
`node --watch` restarts this process dozens of times a day. On a fresh install
all three are no-ops for ever, which is the correct behaviour for a feature
nobody has configured.

### The page

`/workflows` — one rail row, four tabs: Rounds (schedule, next run, the last
walk, the whole job ledger), Goals (an editor per scope), Memory (the notes with
edit and delete, consolidate and undo side by side), Outcomes (before/after with
a gapped sparkline, and a form that picks the metric out of the **live** skills
catalogue rather than a hard-coded list that would be stale the first time an
area shipped a route).

## Mailflow: what needs you this morning, and what you are going to say

`/api/mail` measures the mailbox and `/api/mailbox` reads it. Neither answers
the two questions a person actually has at nine in the morning — which of these
need me, and what do I say — so `integrations/mailflow/` adds the two halves
that do. Triage sorts what arrived. The outbox holds what this box has WRITTEN
and, until somebody presses a button, has not sent.

Both halves use the GMAIL plugin's existing accounts through
`providers/gmail.ts`'s own `open()`. There is no second Google credential here
and there must not be: a second copy of a refresh token is a second thing to
revoke.

### Triage

The pass lists the inbox over a short window — three days by default, up to
fourteen — with `format=metadata`, so it gets headers and Gmail's own snippet
and never a body. It takes the threads whose score is missing or whose
last-message time has moved, sends them to the model ten at a time with the
venture roster, and stores what comes back.

`mailflow_triage` is keyed `(account_id, thread_id)`, because Gmail issues
thread ids per mailbox and two connected accounts can hand out the same one. It
has columns for a category, a one-line reason, an urgency, a venture guess, the
thread's last-message time, and the owner's two verbs. **It has no column for a
subject, a sender or a snippet**, and that absence is the privacy claim: what
is stored is the judgement about the mail, never the mail. Everything the page
shows — subject, sender, snippet, time — is fetched live from Gmail on the read
and joined by thread id, exactly as `routes/mailbox.ts` does.

Four categories: `needs_reply`, `waiting_on_them`, `fyi`, `noise`. The fifth
group on the page is `unscored`, and it is the one the whole design is arranged
around: **a thread the model has not read is not noise**. Too new for the last
pass, or a pass with no provider behind it — either way it comes back counted,
in its own group, with the reason. A page that folded those into the bottom of
the list would be hiding mail because nobody had looked at it. `score` is
nullable in the schema for the same reason: the owner can mark a thread done
before anything has read it, and giving that row a category to satisfy a NOT
NULL would be the schema inventing the model's opinion.

A venture matched by domain (`ventureBy: "host"`) is a fact; one the model
named (`"model"`) is a guess, and the page prints "guess" beside it. The match
is on the venture's own `host`, whole-label — `mail.acme.ie` matches,
`notacme.ie` does not.

`stale: true` means a reply has arrived since the score was made. The category
is still shown, because it is the last thing anybody read, and it is flagged.

`done` and `snooze` change this list and **nothing in Gmail**. A thread marked
done is still in the inbox, still unread if it was. A reply arriving clears
both, because a new message is new work.

There is no registered collector, deliberately: `manifestCollectors()` merges
each area's map OVER `collector.ts`'s built-ins by plugin id, so an entry under
`gmail` here would silently replace the mail collector and take `/api/mail`
down with it. The pass runs on this area's own half-hour timer (`onStart`) and
keeps a one-row-per-mailbox ledger in `mailflow_triage_runs`, which is what the
page's "last scored" line reads.

Routes: `GET /api/triage` (`days`, `max`, `account`),
`POST /api/triage/:threadId/done`, `POST /api/triage/:threadId/snooze`,
`POST /api/triage/run`. The read costs a `threads.get` per row, so it fetches
fifty by default and says so; the scan's own cap is 200, about fourteen seconds
through the provider's rate gate.

### The outbox

`mailflow_outbox` is one row per message this box has written: recipient,
subject, markdown body, an optional `in_reply_to` thread id, venture, status,
who wrote it, and — once it has gone — `sent_at` and Gmail's own `message_id`.
Status is `draft | approved | sent | dismissed | failed`. Only `sent` has left,
and only a row with a message id has proof of it. `failed` is terminal: it was
approved, attempted, and refused, with the reason in `error`; nothing retries
it, because whether a copy arrived is Google's answer rather than this table's.

**Nothing sends without an explicit approve, and it is enforced by shape.**

1. `sendMessage` lives in `integrations/mailflow/gmail-send.ts` and is imported
   in exactly one place — `outbox.ts`'s `sendApproved`. `grep -rn sendMessage
   src/` returns the definition and one call site.
2. `sendApproved` refuses any row that is not `approved`. There is no
   approve-all and no send-all, because a send-all is an approve-all wearing a
   different word.
3. The `outbox` SKILL publishes `draft`, `edit` and `dismiss` and **no approve
   and no send**. The skills proxy composes no URL a registry entry does not
   name, so those two routes are unreachable from an agent. As a second wall,
   `routes/skills.ts` now stamps every action it forwards with
   `x-opc-via: skills`, and both routes reject it with a 403 — so adding the
   action to the registry by accident is a refusal rather than a sent email.
4. There is no timer in the outbox. The triage timer is this area's only
   scheduled work and has no import of the outbox at all.

The send is in its own file rather than in `providers/gmail.ts` so that file's
long-standing claim stays literally true — `get` hard-codes GET, `modify`
reaches nothing but the UNREAD label — and its header now names this file
rather than leaving the reader to grep for the hole. The token could always do
this: the refresh token carries `gmail.modify`, which is Google's "everything
but permanent delete". Nothing here widens the credential; it exercises a power
the box has held since the token was minted, in one function, behind a button.

The message goes out as `text/plain` carrying the approved markdown verbatim,
with the signature setting under it. Rendering it to HTML on the way out would
mean the message that arrives is not the document that was approved. The page
draws `preview` (body + signature) for the same reason. Replies are threaded at
SEND time — Gmail's `threadId` plus `In-Reply-To` and `References` read off the
thread's last message — because a conversation can gain three messages between
writing and pressing the button.

Two floors, both settings on the config-only `outbox` plugin:

- **Days between mails to one address**, default 14. A second draft to the same
  address inside the window is refused, and so is a send. **Every row counts,
  including dismissed ones** — a dismissal is "not this person, not now", and
  re-offering the same address two days later is how a queue teaches somebody
  to stop reading it.
- **Messages a day**, default 20, counted across every recipient over messages
  that actually left. A circuit breaker rather than a policy.

Plus **Signature** and **Drafts require approval**. The last is yes unless the
owner types otherwise — anything unrecognised reads as yes, because this
setting must fail towards a person pressing a button — and it governs one thing
only: whether the owner's own Send may approve on the way past. It changes
nothing for the agent at any value, and no route an agent can reach writes
settings.

Routes: `GET /api/outbox`, `POST /api/outbox` (draft), `PATCH /api/outbox/:id`
(edit; an approved row returns to `draft`, because the approval was of the
previous wording), `POST /api/outbox/:id/approve`, `POST /api/outbox/:id/send`,
`POST /api/outbox/:id/dismiss`.

### Apps and skills

Two tabs under Apps beside Email: **Triage** (the five groups, each row with
its reason, urgency and venture tag, Done and Snooze) and **Outbox** (the queue
by status, the draft rendered as markdown, edit, approve, send, dismiss, and a
composer for writing one by hand). Two skills: `triage` (pack `inbox-triage`)
with `done`, `snooze` and `run`; `outbox` (pack `outbox`) with `draft`, `edit`
and `dismiss` and nothing else.

## Video: the one thing this box makes that is not a document

Everything else here writes words. This writes an mp4, and the difference runs
all the way through the area: the run's `output` is a NOTE ABOUT a file the way
a paper run's is a note about its PDF, the artefact lives on disk under
`data/video/<run id>/`, and the honesty problem is not "is this figure real"
but "does this video have something in it that it does not have the right to".

Two formats, both vertical, both a run of kind `video`.

**faceless** — a brief becomes a script (a hook, some beats, a call to action,
each shot with its on-screen caption and two to four stock search terms), each
shot gets footage from the Pexels video API, the captions are burned in in the
venture's own colour and font, and it ends on a card with the venture's name
and address. `data/video/<run id>/` holds `final.mp4`, `script.json`,
`assets.json` and the caption cards; the downloaded footage and the per-shot
segments are swept unless the `keep` setting says otherwise.

**shorts** — a long video is downloaded with yt-dlp and cut into two to four
vertical clips. The whole value of that is choosing the right two, so three
quarters of `shorts.ts` is about getting a transcript: the site's own subtitles
first, the voice plugin's transcription endpoint second, and — where there is
neither — even intervals, which is cutting rather than choosing and is recorded
as such on every clip row. The downloaded source is deleted as soon as the
clips are cut: this box does not keep a library of other people's video.

### What it measures, and what it refuses to claim

Nothing here is a metric, because nothing here publishes anything. There is no
credential for any video platform in the vault and no route that would upload
one, so there is no view count, no watch time and no engagement, and there
never will be. What is recorded is what was MADE: the duration and byte size
read off the finished file with ffprobe (null when it could not be probed —
never a zero-length video), which machine drew the captions, whether there was
narration, and every piece of footage with its photographer.

Three columns exist to stop a page claiming something this box did not do:

- `captions` is `typst`, `drawtext` or `none`. This machine's own ffmpeg —
  Homebrew's 9.0.1 — is built without libfreetype and without libass, so it has
  **no `drawtext` filter and no `subtitles` filter at all**. Captions are
  therefore set by typst as transparent RGBA pages and composited with
  `overlay`; `drawtext` is used where a build has it, and `none` means neither
  was available and the video has no words on it.
- `narration` is `tts` or `none`, and `none` is the ordinary case: speech is
  off by default in the voice plugin and **nothing copyrighted is bundled with
  this dashboard**, so a video made here is usually silent.
- `chosen_by` on a clip is `transcript`, `speech` or `spacing`. The third one
  means no transcript existed and the source was cut at even intervals. A page
  that drew that as a chosen highlight would be the one lie this area exists to
  prevent, so it is a column rather than an inference.

`assets` is the footage manifest and it is a CREDIT rather than metadata. The
Pexels licence permits commercial use and asks for the photographer to be
named; the only moment their name is knowable is when the search result is in
hand, so it is written then — id, page, author, author's page, licence, and the
search term that found it — and it is drawn open under the player rather than
behind a disclosure, because a credit nobody copies out is not a credit.

### The autopilot

Off until it is turned on, like the nightly backup and for the same reason: it
spends Replicate credit and Pexels quota. When it is on it wakes every ten
minutes, does nothing until the configured local hour in the configured zone,
and then makes one pass: for each venture that is not at a quiet stage, queue a
Studio post and a video run up to a cadence set per venture per week.

**It queues work and it never posts anything anywhere.** A post lands in the
Studio gallery and a video lands on its run page. Three brakes, each for a
different failure: the per-venture cadence, counted over a ROLLING seven days
so nineteen ventures do not all fire on Monday; a per-day cap across every
venture, without which switching this on would queue thirty-eight pieces of
work onto a queue with one slot; and a check on the run queue, so the autopilot
never pushes work the owner started by hand down the line.

Every decision is logged INCLUDING THE DECISIONS TO DO NOTHING. A log that held
only successes answers "why was there no video this week" with silence, and
silence sends somebody looking for a bug in a feature that is obeying its
settings. `queued`, `skipped` and `failed` are three different words and are
never folded into two.

Topics are derived rather than typed: the model is given the venture record and
the last few things this box actually ran and made for it, and asked for one
line. Posts go through the Studio's own route handler (`studioRoutes.request()`
— a direct in-process call, not a network hop) so a post the autopilot made and
one the owner made are the same row; videos go through the sub-agent dispatch,
so a venture whose Video Producer the owner switched off gets nothing, which is
what that switch is for.

### Tables

- `video_jobs` — one row per run: format, aspect, the script as JSON, the
  footage manifest, duration, bytes, path, and which machine did the captions
  and the narration.
- `video_clips` — one row per clip a shorts job cut: the window, the model's
  own sentence for choosing it, and `chosen_by`.
- `video_autopilot_log` — every decision of every pass, skips included.

### Routes

- `GET /api/video` — every video, newest first, plus a readiness block with the
  five things a video needs (an encoder, a model, Pexels, a caption renderer, a
  speech endpoint) each reported separately with the sentence that says what to
  do about it. One boolean would have to pick one of the five to be wrong about.
- `GET /api/video/:runId` — one job in full.
- `GET /api/video/:runId/file` and `/clips/:index/file` — the mp4s, inline,
  with real byte-range support (a `<video>` element seeks by asking for ranges;
  a server that always answers 200 with the whole file gives a player that
  cannot scrub). No path ever comes from the caller.
- `GET /api/autopilot` — the schedule as it resolves, the next instant it would
  wake (null means OFF, not unknown), each venture's cadence and how much of it
  is used, and the log.
- `POST /api/autopilot/now` — run the pass now, under exactly the same brakes.

### Settings

Two config-only plugins and no credential, because everything needing a key is
keyed elsewhere: footage is the `pexels` plugin's key, the script is the chosen
model provider's, narration and transcription are the `voice` plugin's.

`video` holds the machine facts — paths for ffmpeg, ffprobe, yt-dlp and typst
(blank probes `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`,
`/snap/bin` and then PATH, because these differ per machine), which caption
renderer to force, the longest source a shorts job may download, extra yt-dlp
arguments (what a video site demands of a downloader changes every few months
and the fix is always a flag), and whether to keep the working files.

`autopilot` holds the policy — the switch, posts and videos per venture per
week, the hour, the time zone, which stages are quiet, which formats it may
queue, and the day's cap.

### Skills

`video` reads what was made and has no actions: starting one is already
published by the `runs` skill, and a second door would be a second set of
parameter descriptions to keep in step. `autopilot` reads the schedule and has
one action, `run_now`, which is not destructive — it queues work that can be
cancelled and obeys every limit the clock does. Their rules are the three
columns above plus the one that matters most: never tell the owner something
was posted, because nothing here can post.

## Alerts and the briefing: the half of this box that speaks first

Everything else here answers a question you thought to ask. You open a page,
you ask the agent, you run `opc stripe`. That is the right shape for almost all
of it and it has exactly one failure mode, which is the only one that costs
money: **the thing you did not think to look at.** A certificate that expired on
a Sunday, a disk that filled overnight, a payment provider that started
declining, a traffic collapse three days old by the time anybody opened the
page.

So: two pieces, which are the same idea at two cadences.

### A rule is a comparison you wrote down, and nothing more

A rule names a **skill**, a **view**, that view's **parameters**, a **dot path**
into the JSON that view returns, an **operator** and a **threshold**. That is
the whole vocabulary. It is the same catalogue `GET /api/skills` publishes to an
agent, and the engine reads the document over **loopback HTTP** — byte for byte
the request `opc` makes.

That last sentence is the design and not an implementation detail. **The rule
engine has no private knowledge of any table on this box.** It does not import a
collector, does not open a provider's rows, and does not know what Stripe is. The
consequences are the two things that make the feature worth having:

- a rule can be written against an integration that did not exist when the
  engine was written, and
- a rule reads *exactly* the document you would read. If the page says failed
  payments are 27 and the rule says 27, they cannot have got there by different
  routes.

The cost is one HTTP request per rule per cycle, to ourselves. Rules that read
the same skill, view and parameters share one read per pass; nothing is cached
*between* passes, because a figure held over is a figure that has stopped being
the present.

Paths are `charges[0].failed`, `[0]` for an array index, `@count(domains)` for
the length of a list — deliberately the same syntax the product-endpoint metric
mapping uses, because asking somebody to learn two path languages in one product
is asking twice.

Operators are `<  <=  >  >=  ==  !=`, plus three that need a memory:
`changed` (against the previous reading), and `dropped_by_pct` / `rose_by_pct`
(against the reading this box recorded `windowMinutes` ago — **not** against a
figure the source computed). A windowed rule with no reading old enough says so
and does not trip.

### A document that cannot be read is never a trip

This is the rule the whole area turns on, and it is why `alert_events.kind` has
three values rather than one:

| kind | what it means |
| --- | --- |
| `trip` | the comparison the owner configured came out true |
| `unreadable` | the document could not be read, or the path resolved to nothing |
| `test` | somebody pressed Test. Never acknowledged, never an alert |

A Stripe outage must not read as "revenue fell to zero"; a renamed field must
not read as "the count dropped to nothing". Both are `unreadable`, carrying the
skills proxy's own sentence — which already distinguishes "there is no such
skill" from "the credential is missing" from "that view takes no such
parameter", and each of those is a better message than anything this area could
compose from a status code. The page draws them in their own colour with their
own word, and the rail's badge counts them beside the trips, because a watchdog
that has stopped watching is the failure the feature exists to prevent.

A **trip is a comparison, not a judgement.** Nothing here has a severity, a
priority or a learned baseline. Anything cleverer would be this box forming an
opinion about a business it has never been told the shape of, and presenting
that opinion in the same list as the facts.

### Five suggested rules, for connected plugins only, all deletable

An alerting page that opens empty asks you to invent, from nothing, both the
figure worth watching and the number it should cross. Almost nobody does, so the
feature sits at zero rules forever. `seed.ts` writes five worked examples on
first start — failed Stripe payments today, a host not answering, the fullest
disk over 85%, a domain expiring within 30 days, portfolio pageviews down 50%
against last week — **only for skills that are connected**, because a rule
against a disconnected plugin is an `unreadable` event every half hour.

Every one is marked `seeded: true`, which changes nothing about how it behaves
and exists so the page can say "this box suggested this" rather than let you
believe you configured a watch you never saw. Deleting one is you saying no, and
the seeder does not put it back: the fact that a skill was offered its defaults
is recorded in `alert_seeds`, separately from the rules it created. Connect
Stripe in March and you get Stripe's suggestion in March.

The one real judgement in the set is 85% disk, and it sits between the fleet
document's own `warn` (80) and `critical` (90) — quoted rather than invented.
Nothing in that file names a venture, a host, a domain or a product.

### Narration: three sentences that may only cite what was read

A trip on its own says "failed payments are 27, and your rule trips over 10".
True, and not enough to act on; the next question is always "compared with what,
and what else moved this morning". Answering it by hand means opening six pages.

So on every evaluation the engine stores a **snapshot** of up to six connected
skills' summary documents. When a rule trips, the narrator diffs the newest
snapshot against the previous one — every numeric leaf, by path — ranks what
moved, and hands the model the rule, its reading, its comparison and those
movements, with an instruction that no other number may appear.

That is a mitigation and not a guarantee, and it is worth saying so plainly: a
model can still write a wrong sentence about right numbers. What the design buys
is that the numbers are **checkable** — the event carries `observed` and
`previous`, the snapshots are on disk for seven days, and the page shows the
movements beside the prose. **If no model provider is configured, `narration` is
null and `narration_note` says why.** Nothing writes a plausible paragraph in
the absence of a model.

Two kinds of skill are never snapshotted: anything marked `openWorld` (a
background timer must not make a web search every half hour) and `mailbox`,
whose own rules promise nothing is stored — a snapshot table full of subject
lines would break that promise on this area's behalf.

### The briefing: facts assembled, then written up, and both kept

Once a day at an hour you set in your own time zone, `briefing.ts` assembles:
alerts raised since the last briefing, figures that moved over 24 hours, agent
runs that finished, board cards overdue and due within three days, and a line per
venture. Everything but the alerts is read over loopback from `/api/skills/…`;
nothing is a direct table read.

**Movement is the snapshot diff, not a hand-written list of headlines.** That is
what lets "revenue and traffic" need no list of which field in which document is
revenue: whatever moved, moved, and the paths name themselves. On a box
installed this morning there is no 24-hour-old snapshot and the section says so
instead of showing zeroes.

The model writes the prose. **The facts are stored in the same row**, and the
page draws both — this is the whole point of the table. A daily digest written
by a language model is the easiest place in a product like this to end up with
confident paragraphs nobody can check; keeping the facts means every sentence
has something behind it, and a sentence with nothing behind it is visible as
such. A box with no provider still produces a real briefing — the facts — with
one line saying nobody was available to write them up.

The day, in the configured zone, is the primary key, which is what makes the
schedule idempotent across restarts: building today twice is one upsert. The
timer wakes every ten minutes rather than sleeping until the hour, the same
shape the nightly backup uses and for the same reason — a laptop shut at seven
builds the morning's briefing when it wakes rather than skipping the day.

Delivery is two doors. The briefing is appended as an assistant message to the
chat session `briefing` (channel `briefing`), so it sits in the same transcript
every other conversation lives in and the agent can be asked about it. And, when
`Push to Telegram` is switched on **and a bot is paired**, it goes to that chat
through `notify()` — the function that cannot send to the wrong person — with
rich blocks flattened by `plainRich`. It is off by default: a message arriving
on your phone every morning because a default said so is a surprise.

### The timer runs a minute behind the collector

`COLLECT_MINUTES` after the port opens, index.ts starts collecting; a minute
after that, this area evaluates. Evaluating *during* a collection would read
documents that are half-written — some plugins refreshed, some not — and produce
trips that no longer hold sixty seconds later. With the scheduler off
(`OPC_COLLECT_MINUTES=0`) the evaluator does not arm at all, because there would
be nothing fresh to read, and the page's **Check now** is the only way rules run.

### Tables

| table | what it holds |
| --- | --- |
| `alert_rules` | the comparison: skill, view, params, path, op, threshold, window, venture, cooldown, enabled, seeded, and the last value read with its error |
| `alert_events` | trips, unreadables and tests, with the observed and compared figures **as read at the time**, the message, the narration and the acknowledgement |
| `alert_observations` | one reading per rule per pass, 30 days — what the two percentage operators compare against. Re-deriving "pageviews a week ago" would work for the few routes carrying history and fail silently for the many that do not |
| `alert_snapshots` | the whole document per snapshotted skill per pass, 7 days. Stored whole rather than summarised, because a summary here would be this file deciding which figures matter for integrations nobody has written |
| `alert_seeds` | which skills have been offered their defaults. Separate from the rules so that deleting a suggestion is not undone by the next restart |
| `briefings` | one row per local day: the prose, the facts, the model, and where it was delivered |

### Routes

| route | answers |
| --- | --- |
| `GET /api/alerts` | counts: rules total and enabled, open trips and unreadables, when a rule was last evaluated |
| `GET /api/alerts/rules` | every rule, plus the operator vocabulary with what each one needs |
| `GET /api/alerts/rules/:id` | one rule, its readings and its recent events |
| `POST /api/alerts/rules` | create. Validated against the live catalogue: an unknown view or a parameter the view does not take is refused with the sentence the editor would have shown |
| `PATCH /api/alerts/rules/:id` | change. A field left out is untouched; a field sent as null is cleared |
| `DELETE /api/alerts/rules/:id` | remove the rule **and every event it raised**. Disable it instead to keep the history |
| `POST /api/alerts/rules/:id/test` | read it now: the value, the URL used, and whether it would trip. Raises no alert |
| `POST /api/alerts/preview` | the same read for a rule that does not exist yet — what the editor's path field shows as you type. Records nothing |
| `POST /api/alerts/evaluate` | run the whole pass now. The same function the timer calls, so there is no second code path |
| `GET /api/alerts/events` | the ledger: `days`, `limit`, `open=1`, `kind` |
| `POST /api/alerts/events/:id/ack` | mark one as seen. It does **not** silence the rule |
| `GET /api/briefing/latest` | the newest briefing, its facts, its model and its delivery |
| `GET /api/briefing?days=` | recent briefings, newest first |
| `GET /api/briefing/settings` | the hour, the zone, the Telegram switch and which sections are on |
| `POST /api/briefing/now` | build today now and deliver it. Rebuilds today rather than making a second one |

A rule against a **disconnected** skill is refused, and refused with its own
sentence — the catalogue publishes no views for a skill that cannot answer, so
there is no document shape to check the path against, and a rule stored without
that check is a typo nobody caught. The message names the plugins to connect.

### Settings

Under Integrations → Briefing (`plugin_config`, id `briefing`; no credential,
no account, no collector): **Hour** (0–23, default 7), **Time zone** (IANA,
defaults to this machine's), **Push to Telegram** (off until switched on), and
one on/off per section — alerts, what moved, agent runs, board cards, per-venture
lines. A section switched off is left out of the facts entirely and the model is
told not to mention it: it is not empty, nobody asked.

### Skills

`alerts` (pack `alert-rules`, productivity) — views `rules`, `events`,
`summary`; actions `create_rule`, `update_rule`, `delete_rule` (destructive —
it takes the event history) and `ack`. Its rules say the two things that matter:
**a trip is a comparison the owner configured, not a judgement**, and
**`unreadable` is not a trip and must never be reported as a figure falling to
zero**.

`briefing` (pack `daily-briefing`, productivity) — views `latest`, `history`,
`settings`; action `send_now`. Its first rule is that **the facts and the prose
are different things and the facts are the real one**: where they disagree, the
facts are right.

Both have `plugins: []` — always live, because neither needs a credential. An
owner with nothing connected gets an empty rules list and a briefing whose every
section had nothing in it, which is the true state of that box.

Telegram gains `/briefing` (today's, built now if it does not exist yet) and
`/alerts` (what is open, with trips and unreadables listed separately and
labelled). Their copy lives in `integrations/proactive/telegram.ts` rather than
in the bridge, which is a security-critical file and not a place for product
prose.

## Growth: what the pages above us have, and where the funnel leaks

Six readings that share one question — *is anybody finding this, and do they do
anything when they arrive* — and share no data. Every one of them reads rows
some other collector already wrote: Search Console, Bing, the backlink sources,
the site audit, the app stores, Meta, Umami, Stripe and the product endpoints.
Nothing here collects on a schedule and nothing here has a credential, which is
why the area has exactly one plugin and it is a settings page.

**SERP teardown** (`serp`, a run kind) is the thing this box could never do:
say what a page that outranks it actually looks like. The audit is a crawl of
the owner's own sites, so every SEO recommendation was measured against a
checklist rather than against the competition, and the most common instruction
it could produce was a version of "add an H1". A teardown is per QUERY, because
ranking is per query. It searches through the SearXNG node, drops our own host
and one page per registrable domain, fetches the rest and reads them IN CODE —
title, heading tree, word count, internal and external links, images,
schema.org types from JSON-LD and microdata, whether there is a `<table>`, an
FAQ or comparison framing — then computes the MEDIAN of those pages against our
own page. Only then is a model asked for anything, and what it is asked for is
prose: the figures are already on the page above its answer and it is told, in
terms, that it may not recompute them.

Two positions, never one, and this is the distinction the whole feature turns
on. `ourRank` is where our host came in the SearXNG result list on ONE request
from whichever engines answered it; `gscPosition` is Google's own average over
Search Console's own window. They measure different things on different days,
they are stored in different columns, and nothing merges them.

The self-check gates every conclusion. A metasearch node asked a long-tail
question frequently answers a different one, and ten results is not ten
answers — so the share of the query's own words appearing in the titles and
snippets is measured, and under 0.3 the query is marked `degraded` and NO gap
list is drawn from it. A one-word query is a third state, `unmeasurable`:
over one word the check has only two possible answers and measures nothing.

Queries come from the form, else from Search Console's striking-distance rows
(position 5 to 20, at least 3 impressions, most impressions first), else are
derived mechanically from the venture's description — and the origin is stored,
because a derived query is not evidence that anybody searches for it.

**Authority** (`GET /api/growth/authority/:host`) is a self-declared estimate
with its arithmetic printed, computed on every read and stored nowhere. It is
NOT a Domain Rating and not Domain Authority: those come from link indexes this
box does not have and will never buy, the field is called `estimate`, and the
disclaimer travels with every answer. Three parts, each log-scaled to 0–100 —
referring domains (the best single source, NAMED, never the sum of two indexes
that overlap by an unknown amount), how much site there is from the audit's
sitemap or crawl, and Search Console impressions. The estimate is the mean of
the parts that could be read; a missing part is dropped, never zeroed, because
zero is a real band with a real ceiling on it. The ceiling — under 15 → KD 10,
under 30 → 20, under 45 → 35, under 60 → 50, nothing above — is the only reason
the number exists: it is a bound on what to suggest, not a claim about the site.
The route lists hosts and deliberately does not sort them, because an estimate
over `pages + demand` and one over `links + pages` are two different
measurements wearing one word.

**CRO** (`GET /api/growth/cro/:ventureId`) is a static, hand-written library of
51 experiments in seven funnel stages — hypothesis, the one change that would
settle it, how to measure it in figures the owner already has, and roughly what
it costs — hung off the stage that measurably leaks. The stage is read from the
product endpoint's own funnel counters where one is connected, else from Umami's
named events and Stripe subscriptions whose PRODUCT NAME contains the venture's
name, else it is not claimed at all and the owner is asked. Counters are never
summed within a stage (a site firing `checkout-started` and `checkout-requested`
has two names for one step), a negative event like `subscription-ended` is not a
funnel step at all, and a transition with fewer than 30 at the top is not
computed. The leak is a TRANSITION and the stage reported is its later half: the
step people failed to reach is the one whose page is worth changing. `POST
.../start` and `.../finish` keep the ledger, and `dropped` is not `done` — an
experiment abandoned before it had a result is not a finding.

**Indexing** (`POST /api/growth/indexing/submit`, `GET .../:host`) is IndexNow
and an honest account of what sitemap submission still does. The key is
generated for the owner and written back into the settings so it stays the same
tomorrow — the key file on the site is named after it. Every submission checks
that `https://<host>/<key>.txt` is actually there first; where it is not, the
batch is recorded as `dry-run` with the exact one-line instruction, because a
submission that looked accepted while the file was missing would leave the owner
believing something happened. A 200 or 202 means RECEIVED, not indexed, and
nothing on this box may say otherwise. Google is not part of IndexNow and never
has been; its sitemap ping endpoint was retired in 2023 and this box does not
call it; Search Console's API could submit a sitemap but the credential here is
minted `webmasters.readonly` on purpose and Google refuses a submit to that
scope — so the honest instruction is robots.txt and one submission by hand. What
gets submitted is either what the owner named, or the URLs the last two audits
show as new or changed (changed meaning the title, description or word count
moved — that is what the audit records, and it is not a content hash), or the
URLs in the sitemap. With auto-submit on, a pass every fifteen minutes does the
audit delta for any host whose newest crawl has not been submitted yet.

**ASO** (`aso`, a run kind) audits the store listing as a shopper reads it.
Apple's comes from the public iTunes lookup — the same document the store page
renders from. Play's title comes from its store page and NOTHING ELSE does: that
HTML carries a dozen other apps' names, ratings and thumbnails with nothing
attributing a figure to this one, so the screenshot count, the descriptions and
the update date are null with that reason, and the rating comes from the Play
Console export instead. Apple's subtitle and its 100-BYTE keyword field are not
fetched by this box at all and are never scored as empty. Play indexes the full
description and Apple does not, so the same advice is wrong on one of them and
each check says which store it is talking about. The score is a weighted rubric
— visuals 25, title 25, ratings 20, description 20, freshness 10 — where a
check that could not be answered is out of the denominator, a dimension under
40% coverage is refused, and a listing with fewer than three scorable dimensions
gets no grade at all.

**Ads health** (`GET /api/growth/ads/:accountId`) scores each Meta ad account on
read from the account, campaign and daily rows the collector already wrote:
frequency, the week-on-week CTR and CPM trends, campaigns under the account's
own median CTR, whether leads report at all, spend past three times the target
with nothing to show, daily budgets against five times the target, and
objectives that do not match what the account buys. Severity weights 5/3/1.5/0.5
inside category weights of creative 30, tracking 30, structure 20, audience 20;
N/A out of the denominator; a category under 40% coverage refused. The target
cost per lead is THIS ACCOUNT'S OWN and no benchmark is ever substituted. The
kill table gates every verdict: 7 days and 20 clicks before anything is judged,
1,000 impressions before anything is called dead. Three of the things a paid
audit is expected to check cannot be seen from here and say so as null checks
rather than passing by silence — there is no ad set row, so a learning-limited
set is invisible; no ad row, so a disapproved ad is invisible; no audience
specification, so overlap is inferred from frequency and named as an inference.

### The tables

- `growth_serp` — one row per (run, query): the origin of the query, Google's
  position beside our place in the search results, our page's structure, the
  competitors' structures as JSON, the relevance ratio and the degraded flag,
  and the computed gap list.
- `growth_cro` — one row per (venture, experiment): status, stage, when it
  started and finished, the result in the owner's words.
- `growth_indexing` — one row per URL per submission: the endpoint, the HTTP
  status, the outcome (`received`, `accepted`, `refused`, `unreachable`,
  `dry-run`) and why the URL was in the batch.
- `growth_aso` — one row per (run, store, app): the listing as it was read, the
  checks, the dimensions, the score and the refusal when there is one.

### The skills

`serp`, `authority`, `cro` (with `start` and `finish`), `indexing` (with
`submit`), `aso` and `adshealth`. Their rules are the point: two positions are
never merged; a degraded query proves nothing; an estimate is never called a DA
and two hosts on different bases are never compared; a stage nothing could
measure is never guessed; a 200 from IndexNow means received; a null check is
not a pass; and no ad figure crosses two accounts.

## People: who you correspond with, and what you said you would do

Everything else on this box measures a *thing* — a site, a repo, a bill. This
measures a *correspondence*, and it does it out of mail headers alone.

**The promise it is under, first, because everything below depends on it.** The
contacts collector asks Gmail for `format=metadata` with an explicit
`metadataHeaders` list (From, To, Cc, Date, Subject, List-Unsubscribe,
Precedence) and a `fields` mask that selects the envelope. Three separate
refusals of content, so one typo in any of them is not enough to put a message
body in this area. No subject, snippet or body is stored anywhere in
`people_contacts` or `people_days`. Subject lines are looked at once, in memory,
to see whether a venture's host is mentioned, and are thrown away. So a leak of
this database is a leak of "he writes to jane@acme.io about twice a month", not
of anything either of them said — and the pages, the routes and both skills all
say so in those words.

**No credential of its own.** The Gmail credential is already in the vault,
already verified and already refreshed by `providers/gmail.ts`; `gmail.open()`
mints the token and nothing here reads a secret. `people` is a plugin id
carrying five settings and a collector — the `backups` shape, one step further —
and "connected" means THERE IS A MAILBOX TO READ, derived from the Gmail
accounts at boot, every ten minutes and on every collection. It is deliberately
not registered as a collector under `gmail`: the collectors map is one object
keyed by plugin id, and an entry there would REPLACE the mail collector rather
than run beside it.

**Staleness is measured against each pair's own rhythm.** `cadence` is the
MEDIAN gap between DAYS on which mail passed either way — days rather than
messages, because a fourteen-message thread on one Tuesday is one contact; a
median rather than a mean, because one four-month silence in a weekly
correspondence drags a mean far enough that the person can never be reported as
cooling again. Then `quiet ÷ cadence`: cooling at 1.75×, cold at 3.0×, and
nothing is called cooling before 7 days whatever the ratio says. Under four
measurable gaps — five separate days of contact — `temperature` is **null** with
the reason beside it. Null is "no rhythm, no claim"; it is not cold. Somebody
written to every August is not cold in September, and that is the whole reason
the arithmetic is not a fixed number of days.

`stale` is a second and simpler question, and it is the owner's own: no mail
either way for the stale-after setting. Cold is relative to the relationship,
stale is relative to the calendar, and the page keeps the two words apart.

**Tables.** `people_contacts` — one row per (mailbox, address): name, domain,
first seen, last received, last sent, counts each way, threads, and the window
those counts are over. Two connected Google accounts are two relationships with
the same human, side by side and never summed. `people_days` — one row per
person per calendar day, written only for contacts that met the
minimum-each-way rule (a year of a newsletter is 365 rows about a robot).
`people_briefs` — one row per ISO week. `people_commitments` — one row per
promise, keyed on a hash of mailbox + thread + normalised sentence.

Nothing derived is stored. Cadence, temperature, staleness, the ratio and the
venture link are computed on every read, for the reason the uptime table
computes availability that way: a stored "cold" is wrong the morning after it
was written, and it survives a collector that has stopped running — which is
the one condition the page exists to reveal.

**Floors, said out loud.** The scan has a message cap per direction (inbound is
the `max-received` setting, default 2500; outbound has its own budget of 1500
and no setting, because "who have I stopped writing to" is the question this
area exists for and a knob that could starve the sent scan would make every
answer to it a statement about the budget). Gmail lists newest first, so a cap
that bites keeps the most RECENT part of the window — "last written to" stays
true and the counts become floors. `scanFrom` is the oldest message actually
reached and `floors: true` says the cap bit; the page draws it in the warning
colour rather than leaving it to be worked out.

**Who is not a contact.** Addresses at a connected mailbox's own domain, at any
other connected mailbox, and at the domains typed into `self-domains` — get that
setting wrong and you arrive at the top of your own contacts list with a perfect
two-way cadence. Senders that declare themselves a mailing list (a
List-Unsubscribe header, or a Precedence of bulk/list/junk on half their mail)
and a short list of local parts that cannot be a person. The list is
deliberately short: "info", "hello" and "team" are real founders writing from
the address on their own website.

**The venture link is a guess and is labelled one.** The contact's domain
matches a venture's host; the link carries `derived: true`, a reason in words,
and a badge that reads "· by domain". Somebody at a venture's domain is usually
connected to it and sometimes is a stranger who bought a mailbox there.

**The weekly brief.** `onStart` checks every six hours and writes at most one
row per ISO week — the week is the primary key and that is the whole idempotence
mechanism, so a laptop shut on Monday writes Monday's brief when it opens rather
than skipping the week. The SKELETON is arithmetic in TypeScript: the counts,
who has written to you more recently than you wrote to them, who crossed into
cooling since the last brief, who is new, and the widest breaks against their
own rhythm. The PROSE is one `complete()` handed that arithmetic and nothing
else, and it is thrown away whole if a validator finds a number, an address or a
capitalised word the figures do not carry. A refused paragraph is not repaired —
the brief is then the skeleton, which is a real brief and says so. The diff is
against the previous brief's own stored snapshot of every temperature, so
`firstBrief: true` means there was no last week and NOBODY is reported as newly
cooled; a missing snapshot must never read as "everybody cooled".

**Commitments.** The one thing here that reads message BODIES, and it is a
button rather than a timer for exactly that reason. Only `in:sent` is ever
listed — the SENT label is a parameter of the request, not a string a caller can
displace — so nothing anybody else promised can appear and nothing you were
asked to do can either. Bodies are fetched, cleaned, scanned and gone when the
function returns; four things reach disk: your own sentence (≤200 chars), the
recipient, the subject you wrote, and the date.

Two stages, and the model is never the only gate. A deterministic pass finds
first-person future sentences — an "I'll"/"we will"/"let me" marker, a doing
verb after it, no negation inside the next 48 characters, no question mark, and
not one of the closing pleasantries that are furniture. That pass alone can put
a row on the page (`by: "pattern"`). The model is then shown ONLY those
sentences — never the body, the subject or the recipient — and asked for the
shortest CONTIGUOUS SPAN of each. Anything it returns that is not a literal
substring of the message is thrown away and the raw sentence used instead, and
every failure path (unparseable JSON, missing item, reworded promise, no
provider connected) ends at the raw candidate. The recipient and the date come
from headers, which cannot hallucinate. `dueText` is your own words, held to the
same verbatim test; `due` is a date only where those words resolve
unambiguously — a weekday, today, tomorrow — and is null otherwise. "End of the
week" stays as words, because deciding which Friday you meant is not this
dashboard's decision. Nothing is deleted: done and dismissed are decisions, and
a rescan of the same fortnight finds the same promises by hash and leaves them.

**Rate limiting, learned the hard way.** `providers/gmail.ts` paces itself at
140 quota units a second and its spacer is module-private. The first live
collection here came back `403 Quota exceeded for quota metric 'Total Query
Cost'` on its very first call, because two areas were reading the same grant at
once. So `gmail-get.ts` paces at 60, a throttle pushes the SHARED spacer forward
rather than backing off one request, and every call retries five times with
5s/20s/45s/80s of wait. The failure being guarded against is a half-scanned
window, which reads exactly like a quiet mailbox.

**Routes.** `GET /api/people` (filters: `stale`, `domain`, `venture`, `q`,
`all`, `limit`), `GET /api/people/:address` (per mailbox, with the day series),
`GET /api/people/brief` and `POST /api/people/brief?force=1`,
`GET /api/commitments`, `POST /api/commitments/:id/done|dismiss|reopen`,
`POST /api/commitments/scan`.

**Settings** (plugin id `people`, edited from the People page's Settings
button — there is no catalog card because there is no credential): window days
(365), minimum messages each way (2), your own domains, received messages to
scan (2500), stale after (90).

**Skills.** `people` (pack `people-and-relations`) with views default, contact,
stale and brief, and no actions — there is nothing here to change. Its rules:
this is metadata and cannot say what anybody talked about; temperature is
relative to the pair; `null` is no rhythm and not cold; `stale` and `cold` are
different words for different questions; counts are per contact and per window
and must never be summed into mail volume; `floors: true` makes every count a
floor; a venture link is a guess; `weight` orders a list and measures nothing;
where the brief carries no paragraph the figures ARE the brief. `commitments`
(pack `commitments`) with the `open` view and three actions — `mark_done`,
`dismiss`, `scan`, none destructive. Its rules: always show the quoted sentence;
`by: "pattern"` means no model touched it; never invent a deadline and an
undated promise is not overdue; these are promises you made, not a to-do list
somebody gave you.

## Agent runtime: the turn is the server's, and a tool answer has a ceiling

Two facts about the agent, and neither of them is a measurement. The area is
`src/integrations/agentcore/` with the run engine in `src/chat/runs.ts`.

**A chat turn is a RUN this process owns.** It used to belong to the HTTP
response: `POST /chat/stream` passed the request's own `AbortSignal` down to
the agent, so closing the tab stopped the answer and a reload could not get
back to it — the Chat page said so in its header, honestly, and what a refresh
showed was the partial row labelled cut off. Now the route composes the turn,
starts a run, and subscribes to it like anybody else. The run has an id, its own
`AbortController`, and a buffer of events stamped with dense one-based sequence
numbers; it finishes and writes its assistant row whether or not a browser is
still there.

- `chat_runs` (migration `200_chat_jobs`) — id, session, status
  (`queued|running|done|failed|cancelled`), channel, venture, backend, the two
  message ids, the error, `last_seq`, started and finished. **The events are not
  in it**, deliberately: a reasoning model emits thousands of deltas a turn and
  a synchronous disk write per token would buy a replay window measured in
  minutes. The words live in `chat_messages` as they always did; this row
  answers "was a turn started, and did it finish".
- `GET /api/chat/runs/:id/events?since=N` — reattach. `since=0` replays the turn
  from its first frame (a page that has just loaded has no words on screen);
  `since=N` hands back only the tail. `Last-Event-ID` is honoured, because every
  frame carries its seq as the SSE `id`. A run past its two-minute retention
  window answers one `run` frame with the stored status and closes — the
  transcript is the record by then, and replaying over rows that already contain
  the answer would draw it twice.
- `POST /api/chat/runs/:id/cancel` — the stop button's other end. What was said
  is written as a partial row before the run reports itself cancelled, and the
  final `error` frame carries `cancelled: true` so a page does not draw a red
  banner under a button its owner pressed. 409 for a run that has already ended,
  404 for one that never existed.
- `GET /api/chat/runs` — which conversations are being answered right now, for
  the rail after a reload.
- `GET /api/chat/:sessionId/messages` now also carries `run` — the run state, in
  the same fetch as the transcript, so a reload does not flicker between "cut
  off" and "still writing".
- One run per conversation, on BOTH doors. A second question on a transcript
  already being answered is a 409 naming the run and where to watch it; two
  answers would read the same history and write two interleaved assistant rows.
  The check is `sessionBusy`, which consults the runs AND the sessions
  `chat/inflight.ts` registers for the length of an `ask()` — so a phone and a
  browser on one session are covered, not just two browsers.
- The tail of a run is inside a `try/finally` and the background task has a
  `.catch`. A throw from the assistant-row write or from a caller's `shape`
  fails the turn; it does not end the process, and it never leaves the
  conversation marked busy with a subscriber waiting on a promise that will not
  resolve.
- The event buffer is capped in BYTES as well as frames (8 MB / 40,000), and the
  terminal `done`/`error` is always delivered whatever the caps say — a reader
  that is cut off is told `incomplete: true` rather than left with a socket that
  closed silently.
- Cancelling answers `stopping`, not `cancelled`: the run still has a partial
  row to write and the terminal frame is the authority. A cancel that arrives
  after the agent's last token is refused rather than mis-reported.
- `chat_runs` is deleted with its conversation and swept of finished rows older
  than thirty days at start-up.
- A restart is the one thing a run cannot survive, and `failInterruptedChatRuns`
  says so at start-up: a row still marked running is a claim nothing can make
  good on, and it is marked `failed` with the restart named rather than left
  waiting for a stream that will never open.
- `POST /chat` (Telegram's door) and the background sub-agent run queue are
  untouched.

**A tool answer is bounded, and bounded is not truncated.** `skills/mcp.ts` and
`cli/opc.ts` both forwarded a skill document whole. Most are two kilobytes; a
few — the org, a mailbox page, the activity ledger — are tens or hundreds, and a
hundred-kilobyte tool result either eats the context the answer needed or is cut
by the client at a byte boundary. A JSON document ending mid-string is read as
far as it parses and reported as complete, which is how the last venture in a
list comes to be reported as not existing.

- `integrations/agentcore/bound.ts` is pure and imports nothing, so the MCP
  child and the CLI — neither of which has a database handle — share one
  implementation. Over budget it sacrifices in order: the longest lists lose
  rows (chosen by serialised cost, not row count), then long strings are
  abridged as string VALUES, then — only when nothing else is left — fields go
  from the END of the document. Each shortened list ends with
  `{"truncated":true,"shown":N,"total":T}` where `T` is counted; an object that
  lost fields carries `"_omitted": n`. How to ask for the rest is written ONCE,
  on `_bounded` at the root and in the note, because a marker that carried the
  whole sentence cost more than the rows it replaced — a document of many small
  lists then could not be fitted at all, and the first cut of this bailed out
  with no data. The output is always valid JSON when the input was, and the
  answer is always data rather than a refusal unless one single value is bigger
  than the whole budget. A body that is not JSON is cut on a character boundary
  — never inside a UTF-8 sequence or a surrogate pair — with a line saying how
  much was dropped.
- Common optional parameters: `limit` and `offset` are passed through where the
  view declares them; `fields` is a comma-separated list of TOP-LEVEL keys and
  is consumed by the proxy layer rather than forwarded (the skills route refuses
  a parameter a view does not have, rightly) — unless a view declares `fields`
  ITSELF, in which case the view owns the name and the value goes to the route
  like any other. An `error` key is never filtered away. Field names the
  document does not have are named back, and a `fields` asked of a document with
  no top-level keys says so rather than claiming a subset.
- The ceiling is a setting: `agentcore.response_bytes`, default 24 KB — the
  number `opc` already warned at. Under 1024 the default stands. The MCP child
  and the CLI read it from `GET /api/agentcore/limits` and cache it for a
  minute, so lowering it takes effect on the next tool call rather than on the
  next restart of a process the owner did not start; `OPC_RESPONSE_BYTES`
  overrides it for one command.
- `composeTurns` adds six lines telling the agent to report `total` and not
  `shown`, what `_omitted` means, and how to page. It goes to every live backend, managed or remote,
  and not to the raw-provider fallback, which has no tools to call.

## Finance: what the operation owes, and what each business keeps

Every other money route here reports what a provider said. This one is a
MODEL — a rate card joined against what is actually running — and the whole
area is shaped by that one difference. `/api/costs` answers "what did OpenAI
bill me", `/api/stripe` answers "what settled". Neither of them answers "what
does it cost to run Acme", because nothing on this box previously wrote
down the €7.09 control-plane box, the domain that renews in ninety days, or
the accountant. The ledger is where those live, and the P&L is what happens
when you subtract them from the revenue routes.

**THE LEDGER IS SEEDED, NOT TYPED.** This box already knows about seven Hetzner
servers, a block volume and twenty-three domain renewals. Asking the owner to
retype those into a rate card would be asking them to maintain a second copy of
a list that changes without them, so `finance_expenses` is populated by a
collector that reads `hetzner_servers`, `hetzner_volumes` and `domains` and
writes one row each, marked with the `source` that measured it. A server that
leaves the account is ARCHIVED on the next pass rather than deleted, and
archiving stamps `ends_on` — the flag takes it out of the ledger's current
state and the DATE takes it out of the months after it stopped being owed, so
it is still the cost a closed month's margin was computed from. The month
readers deliberately start from every row, archived included, and let
`starts_on`/`ends_on` decide; only the current-state views (the ledger table,
the renewals, the allocation editor) filter on the flag.

A source that answers with NOTHING archives nothing, which is a guard rather
than an oversight: `domains` and `hetzner_servers` cascade on a
`plugin_accounts` delete, so disconnecting a registrar empties the table this
seeder reads, and a pass that took that literally would archive all
twenty-three domain rows half an hour later and take the prices the owner typed
with them.

**AND THE OWNER'S EDITS SURVIVE THE SEED.** A seeded row is not finished:
Hetzner quotes a plan price net of VAT and says nothing about add-ons, and
neither registrar's API publishes a renewal PRICE at all. So every column the
owner corrects by hand joins that row's `owner_fields`, and every subsequent
refresh rewrites the other columns and skips exactly those — `notes` included,
so "cancel this after the migration" written on a server survives the next
price change. Without that pair, a re-collect either destroys the corrections
every half hour or lets a dead server bill forever.

**`amount` IS NULLABLE AND NULL IS NOT ZERO.** Twenty-three domains seed with a
renewal date and no money on them, which is the honest row: the date is
measured and the price is not. They are excluded from every total and counted
in `unpriced`, so a monthly figure with `unpriced: 23` is a FLOOR on what the
operation costs and says so.

### The tables

- `finance_expenses` — the ledger. One currency per row, a period
  (`monthly`/`yearly`/`once`), an optional `venture_id` where NULL means SHARED,
  `renewal_on` and `renewal_decision`, `source`/`source_ref` for the seeded
  rows, `owner_fields` for the corrected columns, `confidence` for rows whose
  amount depends on observed usage, and `archived` for things that have gone.
- `finance_allocations` — how a shared cost is split: `(expense_id, venture_id)`
  → a share between 0 and 1 and the `basis` it was arrived at
  (`equal`/`manual`/`revenue`/`traffic`). The shares of one expense may sum to
  LESS than one; the remainder is unallocated overhead, which is a real answer.
  More than one is refused — that is double counting, and it would make the
  portfolio's margin better than the portfolio's.
- `finance_power_profiles` — optional, empty by default: a machine's idle and
  busy wattage, its own price per kWh if it has one, and whether it never
  sleeps.

### The arithmetic, and the three ways it could be wrong

**A PERIOD IS NOT A NUMBER.** A yearly bill contributes a twelfth to a monthly
run rate and its EXACT price to a yearly one — never twelve roundings of a
twelfth. A one-off contributes NOTHING to either: a fee paid once is not a
rate, and amortising it invents a commitment that never stops being owed.

**MONEY IS NEVER ADDED ACROSS CURRENCIES.** Every total this area produces is a
list keyed by currency code with `combined: null` on it, the same contract
`/api/costs` keeps between euro and dollars. There is exactly one converted
figure on the whole area, at `/api/finance/converted`; it exists only when the
owner has typed a display currency AND a rate for every currency present, it
refuses outright when one is missing rather than quietly dropping it, and it
carries `approximate: true` with the rate and the date the owner typed.

**ACTUAL AND PROJECTED ARE NEVER THE SAME FIELD.** A closed month carries
`actual: true` and nothing else. The month in progress carries the measured
part AND a `projected` block naming its method — the daily average of what has
been measured, times the length of the month. It is applied to REVENUE and
MODEL SPEND only: recurring costs are not prorated, because a monthly bill is
owed in full on the third, and prorating it would make every margin look
wonderful until the 28th. `projected.costs` says so in words rather than
leaving it to be inferred from an absent field.

### Whose revenue is whose

The join is `venture_links` and nothing else — a Stripe product, an App Store
app id, a Play package. Nothing matches on a similar-looking name: `acme.ie` and
`acme.so` are two businesses in this database.

- **App stores** answer per app per report month per currency. Measured,
  settled, dated.
- **AdSense** answers per site per month, and the site is matched to a
  venture's own `host` — AdSense publishes no entity the venture map links, so
  this is the one hostname match in the area and every row it produces carries
  `basis: "host"`.
- **Stripe is the interesting one.** Subscriptions carry a product name, so a
  venture's MRR is knowable — but MRR is a run rate this app normalises, not
  money that arrived in a month, and it is reported as `subscriptionRunRate`
  and never added to `revenue.net`. The SETTLED ledger, which is dated money,
  has no product dimension at all: `stripe_ledger_days` is per account per day
  per currency. So a per-venture settled figure is NOT a measurement and is not
  offered by default; `revenue.unavailable` carries the sentence explaining
  why. Setting `stripe_split` to `mrr-share` apportions the portfolio's settled
  net by each venture's share of live MRR in that currency, and stamps every
  figure it produces `estimated: true` with the share it was computed from.

**Model spend per venture** is read off `budget_usage`, which the runtime
writes one row per model call with the venture it ran for — the only
per-venture model figure on this box. Its dollars are tokens × the
`usdPerMillion` run-budget setting; where that setting is zero (its default)
every stored dollar is structurally zero, so `usd` is NULL with the reason and
the measured TOKEN count stands on its own.

Since 22 Sep 2026 no row is written with a null venture. A call inside a run
is filed under the run's venture; a call outside one names its venture
(`CompleteOptions.venture`) — a caption for a venture, a synthesis pass, an
alert rule's narration — and what genuinely spans the roster is filed under a
pseudo-venture: `portfolio` (pipeline stages that walk every venture, mail
triage, people, the model probe and test page) or `chief` (a chat with no
venture open, the chief's memory tidy, the briefing). `/api/costs` publishes
the split as `ventures.list` beside the provider invoices, and says in
`ventures.unattributed` what stays portfolio-wide: OpenAI bills one project for
every product and Replicate bills nothing readable, so the products' own
spend on the shared keys cannot be split from here; an OpenRouter key named
for a product is the one bridge and is shown under that venture.

### Electricity, so local inference is not free

A model call to a provider arrives with a price on it; the same call on the
GPU under the desk arrives with nothing, so a dashboard that adds up provider
spend and calls it "model cost" is systematically wrong in the direction of
"run it locally".

The WATTS are always typed in and there is no default: ssh can ask nvidia-smi
what a GPU draws, and cannot ask what the machine draws at the wall, which is
what the bill charges for. The HOURS come from the workstation collector's own
`workstation_state` samples — no new logging was added to the security area,
because the transitions are already recoverable from the samples and a second
writer to the same fact is a second thing that can disagree. A span belongs to
the sample that OPENED it, is clamped to two hours so one sample before a
week-long shutdown cannot claim the week, and counts as busy only when that
sample's GPU utilisation was at or above the threshold — a sample where
nvidia-smi did not answer is never busy, because that is a fact about ssh.
Awake seconds draw idle watts and the busy fraction draws the difference on
top.

`confidence` is about the HOURS: `metered` means they were observed,
`estimated` means the machine is marked always-on and the month was modelled.
The wattage is an estimate either way, and every line says so. A machine with a
profile, no samples and no always-on flag gets `amount: null` and the reason —
not a zero. Where the deploy area's `job_leases` table exists, a machine's
`workstation:<accountId>` leases are used as a fallback source of busy hours;
the lookup is defensive (table and columns are checked, everything is caught)
and its absence is the ordinary case.

### Routes

`GET /api/finance` — counts, the monthly and annual run rate per currency,
renewals due, unallocated shared cost, the FX settings and their errors.
`GET /api/finance/expenses` — every row with its allocations, filtered by
venture (or the literal `shared`) or category.
`POST /api/finance/expenses`, `PATCH /api/finance/expenses/:id`,
`DELETE /api/finance/expenses/:id` — the manual half. A delete removes a manual
row and ARCHIVES a seeded one, because deleting a seeded row only means the
next collection puts it back.
`POST /api/finance/expenses/:id/renewal` — record a keep/cancel/undecided
decision. It records a decision and cancels nothing at the provider, and the
route's note says so.
`GET /api/finance/renewals?days=` — what renews soonest, with a negative
`inDays` for one already past.
`GET /api/finance/allocations`, `GET /api/finance/unallocated`,
`PUT /api/finance/allocations/:expenseId`,
`POST /api/finance/allocations/:expenseId/auto?basis=` — the split. The
computed bases (`equal`, `revenue`, `traffic`) run the arithmetic ONCE against
dated evidence and STORE the shares; they do not install a rule that
re-evaluates, so a margin computed in March stays computed that way in June.
A venture the basis cannot weigh — no measured revenue, no linked Cloudflare
zone — is SKIPPED and named rather than given a nought share, because a nought
share means "consumes none of the shared infrastructure". `manual` is refused
here by name: it is a set of shares you send to the `PUT`, not something to
compute.

THE REVENUE BASIS OBEYS THE CURRENCY RULE, and it is the one place in this area
that could quietly break it. It used to weigh each venture by its largest
currency amount and sum those numbers into a denominator — ¥120,000 and $1,200
adding to 121,200, and the yen venture written a 99% share. Now: one currency
across the portfolio and it is a plain ratio; more than one and it converts
every venture's whole revenue at the rates the owner typed, says so and at
which rates in the explanation, and REFUSES outright — naming the currencies —
when there is no display currency or a rate is missing, pointing at the traffic
basis, which counts requests and needs no rate at all.

`PUT /power/:machineId` only accepts an id that names a workstation account (or
an existing profile whose account has since been deleted, so an orphan can be
removed); anything else is a 404 listing the machines that can have one.
`GET /api/finance/profit/:venture?month=`, `GET /api/finance/profit/portfolio?month=`
— the P&L.
`GET /api/finance/power?month=`, `PUT /api/finance/power/:machineId`,
`DELETE /api/finance/power/:machineId` — the profiles and the priced lines.
`POST /api/finance/refresh` — re-seed now. Additive: it cannot touch a manual
row or a corrected column.
`GET /api/finance/converted` — the one figure that spans currencies, on its own
endpoint so nothing can quote it without having asked for it.

### The plugin, which holds no credential

`finance` is a pseudo-plugin like `backups`: no secret, no provider, nothing to
verify. What it has is settings, and settings belong in the one registry that
checks a value before storing it — `display_currency`, `fx`,
`default_allocation`, `stripe_split`, `kwh_rate`, `kwh_currency`,
`busy_gpu_percent`. It is marked connected at boot, because "connected" here
means what it means for `uptime`: there is something to do. The collector is
the seed refresh, it touches no network, and an area that had to be switched on
would silently hold a stale rate card.

### The skills

`ledger` and `profit`, both always live — the ledger holds rows no credential
produced, and it has to answer on a box with nothing connected, which is the
state somebody is in when they first type their costs in.

`ledger` has four writes (`add_expense`, `update_expense`, `set_renewal`,
`refresh`) and its rules carry the currency rule, the null-is-not-zero rule,
the period rule, the `ownerFields` contract, and the sentence that a renewal
decision cancels nothing at the provider. `profit` has NO actions and will not
get any: every figure in it is computed from tables somebody else owns, and the
only way to change a margin is to change a cost or earn some money. Its rules
carry the four ways a profit figure is most easily got wrong — adding
currencies, reading a part-month as a month, treating a run rate as a receipt,
and quoting an allocated share of a shared server as a measurement of usage.

### The page

`/finance`, with five tabs — Ledger, Renewals, Allocation, Profit, Power —
reached from the Dashboards tab strip rather than from a rail row of its own:
the cost cards already live on a dashboard, and this is that subject one level
deeper. The ledger table edits in place, because the common task is typing a
price into a row a registrar could not supply, twenty-three times.

## Customers: who is leaving, who went to their bank, and who was told

Three things this box could measure about a business but not about the people
paying for it. `/api/stripe` knew how many subscriptions were cancelling and
`/api/leakage` knew how much had gone to disputes; neither could name a
person, and neither had a deadline on it. An aggregate cannot say "this
customer, by Thursday", and both halves of that sentence are what somebody
acts on.

**No credential.** Everything reads through the STRIPE plugin's accounts with
the same vault reader every other collector uses. A second Stripe key would be
a second thing to rotate, and this integration would then be reading with
different permissions from the one the revenue figures came from — exactly the
confusion the disputes document exists to prevent. The `customers` plugin id
holds SETTINGS only, the way `backups` and `outbox` do, and its "connected"
flag is derived from Stripe's rather than from accounts of its own.

**The collector is registered under `customers` and never under `stripe`.**
`manifestCollectors()` merges each area's map OVER `collector.ts`'s built-ins
by plugin id; an entry under `stripe` would have replaced the revenue
collector and taken MRR, the ledger and the balance off every page. The pass
also runs on its own ten-minute timer, because the point of an event feed is
that it is not a digest.

**Four reads were added to `providers/stripe.ts` rather than to a file of
their own**, so `get()` — GET, no body, by construction — stays the only HTTP
call in the integration: `/v1/disputes` (rewalked ninety days plus any case
still open), `/v1/invoices?status=open`, `/v1/events` with `types[]` filtered
server-side, and single fetches of a customer and a subscription for an
address. None of them runs inside `collect()`: a key that cannot read disputes
must not be able to take MRR off the page.

**Three tables, five migrations (250–254).** `stripe_disputes` is one row per CASE — Stripe's own status
kept verbatim, the reason, the disputed amount, `evidence_due_by`, and
won/lost once it closes. `closed_at` is the first moment THIS box saw a
terminal status, because Stripe publishes no closed timestamp and inventing
one would be a date somebody quotes. `customer_cases` is one row per thing
that can still be acted on, keyed `<kind>:<stripe object id>` so the queue can
be rebuilt on any pass without losing a decision: facts are rewritten every
time, `status`, `resolution` and `outbox_id` never are, and a dismissed case is
left entirely alone. `business_events` is one row per Stripe event id — that
is the whole dedupe, which is why the walk may overlap its window freely.

**Addresses follow `activity/users.ts`'s policy and this area does not get to
re-open it.** Salted hash and domain always; a plain address only while the
documented `customers.contact-access` setting is on, which is OFF by default,
nulled on the first pass after it is turned off, and never published by a
route that reads the setting as off. Three columns rather than one because "we
know who this is", "we may show who this is" and "we may write to them" are
three different permissions.

**Preparing a follow-up writes a draft and nothing leaves.** `POST
/api/recovery/:id/prepare` composes from the case's own fields — the enumerated
list is in `customers/draft.ts` — and inserts a row into `mailflow_outbox`
with status `draft`, linking the outbox id back onto the case. It re-checks
the outbox's per-address floor before writing, so a case is never left
pointing at a draft that could not be created. There is no approve and no send
here, and there is none on the skill either. Two rules are enforced in code
rather than asked for: no sentence may claim a charge, a refund, a discount or
any change to the customer's account, because this integration cannot write to
Stripe; and a PRICE is quoted only for a plan that bills monthly, because every
amount on a case is `monthly_usd` — a normalisation this dashboard performs
that an annual subscriber has never seen. The first real draft this area
produced said "billing at USD 10.21 per year" for a plan whose invoice was ten
times that; the regression test is in `customers.test.ts`.

**Cases close by themselves, from Stripe's state rather than from a timer.** A
churn case resolves when the subscription is active again with no cancellation
scheduled; a payment case when the invoice is no longer open — and it says
"paid" only when an `invoice.paid` event was actually seen, because an invoice
can also be voided; a dispute on its outcome, with `warning_closed` reported as
neither won nor lost; a trial when it converts or ends. A case that stops being
derived at all and matches no rule — a trial whose end moved out of the
window, a cancellation un-scheduled while the subscription is still trialing —
is closed as "no longer matches anything Stripe reports" rather than sitting
open forever behind a dead deadline. `resolutionFor` is a pure function over
rows and is tested against fixtures. `stripe_disputes.closed_at` is stamped on
the TRANSITION out of open and nowhere else: computed from "is terminal now"
it dated the account's whole settled history to the day the integration was
installed.

**The event cursor is a timestamp and the dedupe is the primary key.**
`created[gt]` cannot express "everything after this exact event" — two events
can share a second — so the walk overlaps and `INSERT OR IGNORE` makes the
overlap free. It advances only when the walk was COMPLETE: `/v1/events` answers
newest-first and pages backwards in time, so a capped walk keeps the newest
rows and drops the older ones, and advancing past one would step over the
middle of a window Stripe only keeps for thirty days. A truncated walk holds
the cursor and says so in the run's warnings. The same threading protects the
open-invoice walk, where a short answer is a WRONG one rather than a small
one: the resolution step reads absence from that list as "Stripe no longer
lists this invoice as open", so an account whose invoice walk was capped has
its payment cases skipped entirely that pass. The first walk reaches back one day and records everything
`suppressed_by: "first collection"`: real events, never announced, because
nobody asked to be told about last night on Tuesday. Four things stop a
message and each writes its own sentence: that backlog, `collapsed into <id>`
(the first failure for a customer opens a sixty-minute window and the survivor
says how many it stands for), `alert N (<rule>)` (an aggregate alert from a
`stripe` or `leakage` rule already covered the class in the same window), and
`type muted`. Two more fences exist because a notifier's worst failure is a
burst: while pushing is off every pending event is written down as suppressed
AT THE TIME, so switching the setting on tells you what happens next rather
than working through months of "Invoice paid" at ten a pass; and anything that
has been eligible for more than twenty-four hours is suppressed as too stale
to interrupt somebody with. That age is measured from when the ROW became
eligible, not from the event's timestamp, so quiet hours cannot starve a
message they were holding. Quiet hours are a deferral rather than a drop,
found by stepping in quarter-hours through the owner's own zone — every IANA
offset is a whole number of quarter hours, so the first non-quiet quarter-hour
IS the end of the window, exactly, in Kolkata as in Dublin. Nothing pierces
them: there is no event in the watched list whose value decays inside eight
hours. The sixty-minute collapse window is seeded with failures already
delivered inside it, so it is a property of the feed rather than of one pass.
Delivery goes through `telegram/bridge.ts`'s `notify`, which only ever sends to
a LOCKED chat; the import is deferred to call time because that module's graph
reaches `routes/pluginConfig.ts` and a manifest importing it at load time is a
cycle the server will not boot through.

**These quiet hours are the box's, not this area's.** `quietDeferral` is
exported and the pipeline's overnight result asks it before pushing — through a
guarded dynamic import, so a box without this area still gets its summary. That
matters most for the pipeline, whose default start hour is 02:00, inside any
plausible quiet window: before the two were joined, a box configured for silence
was buzzed at two in the morning by the pipeline and by nothing else. Anything
else that learns to push a phone should ask the same function rather than parse
the window again; two owners for one rule is two rules.

**`/api/leakage` now reports disputes twice and labels which is which.** Its
`disputes` bucket kept the ledger's money — settlement, dated by the balance
posting, fee included — and gained a `disputeCases` block beside it with
open-now, needs-response, the next evidence deadline, and won/lost in the
window. The bucket's own `count` is NULL, and `Bucket.count` is nullable for
that one row: its amount comes from the ledger, which has no notion of a case
to count, and putting a case count there would invite exactly one arithmetic —
amount ÷ count, a "mean chargeback" — that is wrong in both directions at
once. The old comment saying "the COUNT is 0
because there is no dispute-level table on this box" is gone; the refusal to
compute a dispute RATE is not, because there is still no honest denominator.

**The queue keeps its own promises about the Outbox.** Every pass reconciles
the drafts it is pointing at: a case whose draft has been SENT becomes `sent`
— the status migration 251 promised and nothing used to write — and a case
whose draft was deleted or dismissed is un-linked and goes back to `open`, so
`prepare` can write a new one instead of refusing forever with a 409 naming a
row that is not there.

Routes: `/api/recovery` (queue, one case, prepare, resolve, dismiss),
`/api/disputes`, `/api/business-events` (recent, undelivered, mute, unmute,
resend). Skills `recovery`, `disputes` and `events`, packs `recovery-queue`,
`dispute-cases` and `business-events`. Page at `/customers` with three tabs.

253 adds the `(object_id, type)` index the resolution step's "was this
invoice ever paid" lookup actually asks for — 252's three indexes could not
serve it, so it was a scan per open case per pass — and 254 clears a
`closed_at` column that the pre-transition writer had filled with install
dates.

## Mobile health: what the apps DO, beside what they earn

`/api/mobile` reads two credentials for money and headline units, and its own
header says why it stops there: Google's report bucket is reached with
`devstorage.read_only` and NOTHING ELSE, because the Android Publisher API and
the Play Developer Reporting API are separate enablements on the Cloud project
and separate grants in the Play Console, either of which can be missing on its
own. An integration that asked for all three would go dark on installs the day
somebody forgot to switch on an API nobody was using.

`/api/mobilehealth` is the other side of that line, and it keeps the same
promise the same way: ONE TOKEN PER SCOPE, minted separately, each failing on
its own. On the App Store side the same argument holds per REPORT rather than
per credential — probed live on 2026-09-06, four of the six analytics reports
this area wants had zero instances while two had eleven and twelve, with the
same key and the same permission.

Nothing here is a plugin. It reads the `playstore` and `appstore` accounts out
of the vault the way their own providers do, because a second copy of a
service-account key is a second thing to revoke. And nothing here registers a
collector: `manifestCollectors()` merges an area's map OVER `collector.ts`'s
built-ins by plugin id, so an entry under `playstore` would silently REPLACE
the collector that reads the payouts. The pass runs on this area's own
six-hour timer and on `POST /api/mobilehealth/collect`.

**The tables.** `mobile_dimensions` is one row per (store, app, day,
dimension, value, metric) with the METRIC's own unit and kind stored beside
the number — Google's install slices count DEVICES, the user columns beside
them count USERS, and Apple's download report counts privacy-thresholded
EVENTS, and three integers in a column called `installs` is the exact mistake
the column exists to stop. The unit is per metric and not per report, because
one Apple report carries both a count of events and a count of the distinct
devices behind them; and a metric that is a LEVEL — Apple's unique counts and
paying users are distinct within a day, as Play's active devices and ratings
are — is never summed over days, because thirty of them added counts one
device thirty times. `mobile_store_performance` holds store listing visitors and
acquisitions per slice; `mobile_retention` holds the retained-installer curve,
and on this account it stays empty because the bucket has no such folder at
all. `mobile_report_state` is the table that keeps an absence apart from a
zero — one row per report with nine possible states (`present absent empty
not_requested processing available delayed unauthorized error`) and the
provider's own sentence in `detail` — and `mobile_health_probes` is the same idea for the
CREDENTIAL rather than the data. `mobile_stability` holds crash and ANR
figures with the source named on every row, because a count from the bucket
and a rate from the Reporting API are two measurements of two different
things. `mobile_reviews` holds the review texts for both stores;
`mobile_review_cards` records which reviews were filed onto the board so the
same complaint does not become five identical cards. `mobile_versions` is one
row per (app, version, DAY OBSERVED) — Apple publishes a state and never a
history, so the history is what this box wrote down each day it looked, and a
gap is a day nobody collected. `mobile_analytics_instances` remembers which of
Apple's daily instances have been downloaded, so the pipeline costs one listing
per report after the first run.

**The routes**, all under `/api/mobilehealth`: `/segments` (ranked slices per
app per dimension per metric, with the remainder named and `metricKind` saying
whether a series may be summed at all), `/conversion` (listing visitors,
acquisitions and the window's conversion rate — acquisitions over visitors for
the window, never the mean of Google's daily rates), `/retention`,
`/stability`, `/reviews` and `/reviews/trend`, `/versions`, `/readiness`, and
three writes: `POST /collect`, `POST /reviews/triage` (files one board card
through the board's own route, carrying the review ids) and `POST
/ios/request` (an ONGOING analyticsReportRequest — the only thing on this box
that writes to a store, deliberately not made by a timer).

**Four skills, because they are four questions with four different honesty
problems.** `android` is about units — devices against users against events,
and a level that must never be summed over days. `stability` is about a count
that must never be read as a rate and a rate whose window ends at the metric
set's own freshness several days back, not today. `reviews` is about a
seven-day API window that looks like an all-time total: `reviews.list` returns
the last seven days and cannot page further back, so the Android rows are an
ACCUMULATOR and every count says so, while Apple's page back to the first
review. `ios` is about a pipeline with five readiness states where only
`available` means there are numbers. Replying to a review is out of scope and
is said in the rules: there is no route on this box that could be proxied into
one. `reviews/trend` asks a model to group the recent texts into themes and
DROPS ANY REVIEW ID THE MODEL INVENTED before publishing — a theme left with
no real citation is not published at all.

One seeded alert rule joins the existing mechanism: "Crash rate rose against
last week" watches `alerting.worstCrashRate` on the `stability` skill with
`rose_by_pct` over a seven-day window. That scalar exists precisely so a rule
does not name a figure that moves when a ranking does, and it is null — which
the engine records as `unreadable` rather than as a rate of zero — whenever no
report answered.

## Nurture: a schedule that writes, a packet that justifies it, and a return address

The outbox next door could hold a draft and could not produce one. Everything
about it assumed a person had already decided who to write to and what was true
about them; "automated nurture" was a thing the owner did by opening the
composer on the right morning. This area is the four pieces that were missing,
and the property every one of them preserves is the outbox's own: **nothing
here can send a message.** `sequences.ts` has no import of `sendMessage`, of
`resendSend` or of `sendApproved`, the daily pass writes the literal string
`draft` into a status column and stops, and the `sequences` skill publishes no
approve and no send action for the proxy to compose a URL from.

**A SCHEDULE.** `nurture_sequences` holds a name, a venture, a list of steps
(`[{ dayOffset, purpose, hint }]`), an enrolment rule, the stop conditions it
subscribes to, a per-day draft cap and the identity it writes from.
`nurture_enrollments` holds one person's progress: which step, when the next is
due, `active | stopped | done`, the reason if it stopped, and an append-only
history. `dayOffset` is measured from ENROLMENT rather than from the previous
step, so a step inserted in the middle does not shove the rest forward for
people already enrolled and an edited offset moves their date — which is what
an owner editing a sequence means. A daily pass stops first, enrols second and
drafts third, in that order: checking after drafting would mean the pass that
discovers somebody replied has already written them another note.
`nurture_passes` has the local calendar day as its primary key and the row is
CLAIMED with an `INSERT OR IGNORE` before any work rather than recorded after
it — reading at the top and inserting at the bottom is not a claim at all, and a
pass that outlives the ten-minute tick would otherwise run beside itself. An
in-process flag serialises a forced pass against a running one, which the day
row cannot. Together those two are the whole of the "once a day" guarantee, and
the timer's arithmetic is no part of it. The timer
checks every ten minutes whether the configured hour has arrived, because this
server restarts on every file save and a `setTimeout` armed for eight hours
would be cancelled a hundred times a day and never fire.

The three automatic enrolment kinds — `signup`, `trial`, `churned` — are
answered ONLY from a product's own users document (the `users` plugin). With
none connected they enrol nobody and the sequence's `problems` list says so.
They are never approximated from mail headers: "this address wrote to me" is
not "this person signed up". The candidate addresses come from
`people_contacts`, which holds real ones; `activity_users` holds a salted hash
and no address at all, so each candidate is hashed with the same install salt
and looked up by hash. Nothing is decrypted and no capability is widened — the
direction that was declined (turning a hash back into a person) is still
declined. `churned` is narrower than the word suggests and the enrolment's own
reason says so: this box holds no cancellation event and no email address
against a Stripe customer, so it means exactly "the product reports them as not
paying and has not seen them for longer than the quiet window" — a lapse
reading, not an observed cancellation.

A HOLD IS NOT A GO. If a stop condition could not be checked — Gmail refused,
no account is connected, or nothing on this install publishes a users document
and the sequence stops on a purchase — the enrolment holds with the reason on it
and drafts NOTHING. The purchase question has two kinds of silence and only one
is safe to carry on from: "this address is not in a connected product's users
document" is a fact about the person; "no product here publishes one at all" is
the question being unanswerable. "The check failed so carry on" is exactly how somebody gets a fourth
note after answering the third. The reply check is one Gmail query,
`from:<address> after:<day>`, ids only, with the same `fields` mask
`people/` uses: it needs to know THAT they wrote, never what they said.

**A REASON.** `planner.ts` decides who, why now, which venture and which
identity, in plain code over rows this box already holds — no model runs.
`facts.ts` assembles a packet of `{ key, value, unit, source, observed_at }`
rows out of `people_contacts`, `people_commitments`, this box's own outbox
history, the ventures table, the product's users document and — through a
dynamic import guarded by try/catch, because that area may not exist on an
install — `integrations/knowledge`'s evidence-tiered facts. `observed_at` is
when the SOURCE observed it, not when the draft was written. The packet also
carries `cannotSay`: what nothing here measured, so the letter must not mention
it — the contents of anybody's mail (no subject, snippet or body is stored
anywhere on this box), what they did inside a product, and anything about their
payments.

**A GATE.** `wording.ts` hands the model the plan and the packet and nothing
else and asks for sentences. What comes back is read by `validate.ts`'s
`ungrounded()` token by token — addresses whole and lower-cased, links by HOST
whether or not they carry a scheme (a new path on a known host passes; a new
host does not), money as currency AND amount together (`€29` and `$29` are two
different claims), dates in both the ISO and the spelled form, then every number
left after those four are stripped — and REFUSED if the packet does not carry
it. WHAT THAT IS AND IS NOT, because it is easy to overstate and every surface
here quotes it: apart from money, the number check is membership of ONE POOLED,
UNIT-BLIND SET — every figure anywhere in the packet, including the day, month
and year of every date, joins it — so a packet carrying "31 days quiet" licenses
"31% growth". It is a floor on fabrication, not a proof that a figure belongs
where it was used, and the card, the skill rules and the route notes say it that
way. The money regex is built out of the currency codes themselves rather than
`[A-Za-z]{3}`: matching any three letters beside a number and discarding the
non-currencies afterwards stripped every `<number> <three letters>` from the
text before the date and number checks ran, which in ordinary prose meant "We
saved you 500 per month" and "the trial ends 12 Sep" passed an empty packet. Refused, not repaired: repairing
would mean this code deciding which invented figure was close enough to a real
one. Two attempts, the first refusal shown to the model with the token it
invented, then a deterministic template built from the same packet, which is
run through the same gate. The row records `by: model | template` and the
sentence naming what was refused, and the Outbox card prints it — a gate nobody
can see working is a gate nobody can tell is broken. It costs something real: a
count written as a digit is refused, which is why the prompt asks for counts
spelled as words.

**A RETURN ADDRESS.** `nurture_send_identities` says which domain a message may
claim to be from and which transport is entitled to make that claim: `gmail`
(the account's own address, because Google refuses any other From) or `resend`
(one key per sending domain, so the key IS the authorisation). `transportFor`
is the one place the rule is applied and it REFUSES rather than falling back — a
quiet fallback to Gmail would send a message claiming a product domain Gmail is
not authorised for, which lands in spam if it lands at all and looks from here
like a success. `verified` holds Resend's own word from `GET /domains` —
"verified", "pending", "failed" — never reduced to a boolean, and NULL means
nobody has asked, which is not "unverified". `transportFor` deliberately does
NOT read that word: a domain mid-propagation must still be draftable and a stale
"failed" must not block one the owner has since fixed. It is a WARNING instead,
carried onto the sequence's `problems` and the outbox card's own `fromWarning`
field, so the owner reads it while he is reading the draft rather than as a 4xx
after he has pressed Send — and `fromError`, which is a refusal and freezes the
send, stays separate from it. The send adapter is
`nurture/resend-send.ts`, outside `providers/resend.ts` for the reason
`mailflow/gmail-send.ts` lives outside `providers/gmail.ts`: that module's
header promises it cannot POST, and adding a send would falsify a paragraph
people have read. Its idempotency key is the draft's own approved document
hashed, so a retry after a lost response returns the first message's id rather
than sending a second copy. `approvalContent` now names the identity, the From
line and the transport alongside the words, so an approval is of "this message,
from this address, by this door" and re-pointing an identity after approval
fails the check at send time instead of quietly sending the same words out of a
different domain.

**THE VOICE**, opt-in and off by default. A draft the machine wrote that the
owner EDITS and then APPROVES is kept as a before/after pair in `nurture_edits`;
the pairs are read once by a model into at most ten short rules about wording.
A rule carrying a digit, an address, a link, a domain or anybody's name is
REFUSED rather than stripped — a sanitised rule is a rule nobody wrote — and the
refusals are stored and shown. The rules go into the wording prompt and nowhere
else; the fact validator still reads every finished body against the packet
afterwards, so a rule that got through could not put a fact in an email. A
dismissed draft teaches nothing on purpose: a dismissal is "not this person, not
now", and reading it as a verdict on the prose would learn the wrong lesson from
the one signal here that is definitely not about wording. "Forget the voice"
empties the rules, the refusals and every stored pair. No route ever publishes a
pair's text, only how many there are — but reading a voice out of writing means
showing the writing, so up to twelve pairs DO go to the connected model provider
on each derivation, and the setting's own hint says so. On an opt-in feature
about the owner's own mail, "we keep the pairs private" would be a half-truth
while a remote endpoint is being shown them.

Tables: `nurture_send_identities`, `nurture_sequences`, `nurture_enrollments`,
`nurture_optouts`, `nurture_passes`, `nurture_edits`, `nurture_style_rules`,
`nurture_style_refusals`, and eight columns added to `mailflow_outbox` (`plan`,
`facts`, `validation`, `generated_body`, `identity_id`, `sent_via`,
`delivery_event`, `delivery_read_at`, `sequence_id`, `sequence_step`).
Migrations 280–284. Routes on `/api/nurture`: the document, `enrollments`,
`sequences/:id/candidates`, `prepare`, `drafts/:id`, `run`, `optout`,
`sequences/:id/enrol`, `enrollments/:id/stop`, and — behind `requireOwner`,
because an identity is "which domain may this box claim to be" and a sequence is
"who gets written to automatically, forever" — the sequence writes, the identity
writes and the voice. Settings on the `nurture` plugin: the hour the pass runs
(default 8), how many people may be in sequences at once (50), how many drafts
one pass may write (8, a READING limit — the outbox's own daily cap is what
governs how much mail can leave and is unchanged by anything here), and style
learning (off).

One skill, `sequences`, pack `nurture-sequences`. Its rules carry the four
sentences that matter: you cannot send mail and neither can this schedule; a
draft's words are bounded by its facts and `validation.by: "template"` means the
model's wording was refused; `blocked` is not `stopped` and a blocked enrolment
had nothing written for it; `churned` is a lapse reading and not an observed
cancellation.

## Pipeline: one schedule for everything that runs on its own, and one pass that decides what to do next

Before this area there were fourteen timers armed across nine `onStart` hooks,
and nothing anywhere listed them. Each was correct on its own terms and none of
them knew about the others: no order between them, no way to switch one off
without going to find its settings, no dollar cap on the whole night, and no
answer at all to "what did the estate do while I was asleep" that did not
involve opening nine pages. `integrations/pipeline/` is the answer to that, and
to the second half of the same problem — that nothing on this box ever looked
at revenue, traffic, alerts, the board, the goals, the memory and last week's
runs AT THE SAME TIME and said what to do next about one business.

### The stage registry, and the two kinds of stage

A STAGE is one recurring piece of work with an id, an area, its dependencies,
whether it is on, how often it is due, and a budget. Two kinds live in the
registry and the difference is the most important thing on the page:

- **Called stages** have a `run`. The nightly walk is their scheduler: it
  decides they are due, starts them, times them, prices them and records the
  outcome. Nothing else starts them. There are two — `rounds` and `synthesis`.
- **Self-scheduled stages** have no `run` and a `lastRun` instead. They keep
  their own timers, exactly as before, and appear here so the schedule is
  COMPLETE rather than only complete about the parts that were rewritten.
  There are thirteen: `collect`, `alerts`, `snapshots`, `queue`, `triage`,
  `activity-feed`, `indexing`, `capture`, `autopilot`, `people-brief`,
  `consolidate`, `outcome-readings`, `briefing`.

**The registry never duplicates work.** A piece of work becomes a called stage
only when its own timer has been made to stand down. That is true of exactly
one existing feature today: `chief/rounds.ts`'s timer now returns immediately
when `pipelineOwnsRounds()` is true (the pipeline is on, the `rounds` stage is
enabled, and rounds are on in their own settings). One predicate, read by both
sides, so they cannot disagree about who is driving. Everything else is
listed and never called. An area that later wants the pipeline as its scheduler
calls `registerStage` with a `run` and deletes its timer; nothing in this area
changes.

**A self-scheduled stage's `lastRun` is not a log of its timer.** There is no
table anywhere recording "the timer woke and decided to do nothing", so the
honest reading is the newest row that area WRITES, and every row carries
`lastRunMeans` saying which row that is. A pass that ran and found nothing to
do therefore reads as older than it is. That limitation is published rather
than hidden behind a timestamp that looks authoritative.

### The night

`runNight()` walks the stages in dependency order (Kahn, ready set in
registration order so two nights are comparable; a cycle is reported in
`cycle` and its members skipped rather than throwing) and records one of four
outcomes per stage. They are not interchangeable: `completed` ran;
`skipped` is a DECISION — off, not due, inside a blackout, self-scheduled, or a
dependency that failed; `failed` is a fault with the error; `over-budget` is
the night's clock or dollars running out before its turn. A skip is never drawn
or described as a failure.

Three rules about dependencies, each of which was a bug before it was a rule:

- A dependency on a **self-scheduled** stage never blocks — it is ADVISORY.
  Such a stage cannot "complete tonight", because the pipeline never starts it;
  a freshness test replaced that and was worse. `rounds` depends on `collect`,
  and on a box with `OPC_COLLECT_MINUTES=0`, with nothing connected, or after a
  day's outage there is no recent `collect` row — so the pipeline skipped the
  rounds while their own timer had already stood down for the pipeline, and the
  estate silently stopped being walked, for ever, with one skip row a night to
  show for it. The freshness reading survives as a NOTE on the stage result
  ("worth knowing: collect last ran …"), which is what it always was.
- A dependency that was **skipped** does not block. Cascading a decision turns
  one switch into a silent kill for everything behind it: with rounds off, the
  synthesis pass would never run again for a reason nobody would connect to the
  switch they flipped.
- A dependency that **failed or ran out of budget** does block, because the
  stage behind it would read missing or half-written output.

**The hand-over is only taken while both sides mean the same thing by
"tonight".** `pipelineOwnsRounds()` — the one predicate the rounds timer and the
walk both read — requires the pipeline on, the stage enabled, rounds on in their
own settings, AND the stage still on a *daily* cadence. A stage moved to weekly
does not get to replace a nightly timer. The stage also writes
`rounds-last-due` after a real walk, so switching the pipeline off later the
same day cannot make the rounds' own timer walk a second time.

**"Skip tonight" stores the night's day, not today's.** A night that starts at
02:00 belongs to tomorrow's date; the first version stored the 6th when pressed
at nine in the evening and the timer, at two in the morning, asked about the 7th
and ran anyway, after a page that had said all evening that it would not.
`dueNight()` is the mirror of `dueDay()` and both the store and the page read
it. **The cadence check is in the owner's zone on both sides** too — it used to
turn `lastAt` into a UTC date and compare it with a zone-local `today`, which in
a negative-offset zone with a late start hour reported every daily stage "not
due" and would have run the estate every second night.

**The watermark is claimed before the walk, not after it.** A night the process
died inside — routine under `node --watch` — was otherwise started again from
the top at the next tick, and a stage killed mid-flight (the rounds, after some
dispatches) dispatched twice. The cost is that a night crashing in its first
second is not retried until tomorrow, which is the better of the two.

**The budget is spent before a stage, never during it.** `spend()` refuses to
START a stage when the night's minutes or dollars are gone, or when the stage's
own minute budget would not fit in what is left; a stage already running is
never killed by an accountant. Per-call limits are still `runtime/budgets.ts`'s
job — the two are different questions and having both is the point. **Cost is
measured, not estimated**: each called stage runs inside its own `runContext`
(`pipeline:<run>:<stage>`), so its model calls land in `budget_usage` and are
summed back. With no `usdPerMillion` configured, cost is `null` — unknown, not
zero — and a night's figure counts only what its stages spent themselves; work
a stage QUEUED (a sub-agent run) is billed to that run.

**Rehearsing is a DIFFERENT ROUTE, not a flag.** `POST /api/pipeline/plan` and
`POST /api/synthesis/plan` hard-code `dry: true` and read nothing about it from
the request; `POST /api/pipeline/run` and `POST /api/synthesis/run` always run
and answer 400 to the word `dry`, naming the route that rehearses. The skills
proxy sends every parameter as a STRING, so a route testing `body.dry === true`
reads `"true"` as false — that is how a wave-1 area published a real Facebook
post, and it is what `opc pipeline run_stage --dry true` did here until a review
caught it. With two routes there is no boolean anywhere near the decision that
spends money. Every other boolean on these routes (`cancel`, `enabled`,
`proposals`) goes through `readBool` in `pipeline/params.ts`, which accepts
`true`/`false`, `"true"`/`"false"`, `"yes"`/`"no"`, `"on"`/`"off"`, `"1"`/`"0"`
and (where a third state is legal) `"null"`, and REFUSES anything else with a
400 rather than reading it as false.

**A planned night spends nothing.** It walks the same graph with the same
enablement, cadence, blackout and dependency rules and calls each stage with
`dry: true` so the stage says what it WOULD do. Its row is filed beside the real
ones with `dry = 1`, and a dry stage result never counts as that stage's last
successful pass, so planning at noon cannot make tonight's cadence think the
work was done.

**Blackout windows** are typed into one settings box, one per line:
`22:00-23:30`, or `09:00-17:00 stages=synthesis days=1,2,3,4,5`. Days are 0
(Sunday) to 6. A window MAY wrap past midnight — unlike the nightly start hour
it settles no watermark, it only answers "is now inside". Malformed lines are
returned as errors from the settings check rather than silently dropped.

The overnight result is one piece of prose, written into the ordinary chat
transcript under the `pipeline` session (so it is a row in the rail the owner
can reply in) and pushed to Telegram through `notify` when a phone is paired. A
planned night is never pushed to a phone — and neither is one that finishes
inside the owner's quiet hours. **Those quiet hours belong to the customers
area**, which already parses the window and defers deliveries through the same
`notify`; this stage asks its `quietDeferral` through a guarded dynamic import
rather than parsing the setting a second time. It matters here more than
anywhere: the default start hour is 02:00, inside any plausible quiet window. A
box without the customers area gets the push, which is the honest fallback —
nothing there has said to be quiet. The night is not deferred and re-sent; there
is no delivery queue here, and a summary arriving at eight would be read beside
the briefing that already covered it, so inside quiet hours the transcript is
the whole delivery and the answer says so.

### The synthesis pass

For one venture it builds an EVIDENCE PACKET of seven sections — revenue,
traffic, alerts, tasks, goals, memory, runs — each either a measured figure with
its window stated, or `null` with the reason. Nothing is hard-coded to a
business: which Stripe products and which Umami website belong to a venture is
read from `venture_links`, so a venture with no links gets nulls and a sentence
naming the link that would fix it.

- **revenue** — monthly recurring USD summed over the subscriptions whose
  product is one the venture is linked to, now against thirty days ago. The past
  figure is reconstructed from subscription start and end dates, so it sees
  subscriptions that started or stopped and cannot see a price that changed; the
  packet says so. Dollars only — the collector normalised each plan once and
  nothing here converts a second time.
- **traffic** — the linked Umami websites' own window against the window
  immediately before it, read over the loopback so the "visitors do not add"
  rule has one author.
- **alerts** — open trips and unreadable readings in the last 7 days for rules
  that name this venture. `null` when no rule names it: nothing is being watched.
- **tasks** — the venture's open board cards. An EMPTY board is measured, not
  missing.
- **goals**, **memory**, **runs** — the chief's documents and the last 7 days of
  finished sub-agent runs with a 400-character headline each (a headline, not
  the report: seven reports would be the whole context window spent on last
  week's reading).

When nothing SUBSTANTIVE is known the pass asks the model nothing — there is no
honest question to ask — and records that. "Substantive" is the measured keys
minus an empty board: `tasks` is measured even with no cards, deliberately,
because "nothing is on the list for this venture" is a fact an action may rest
on, but it is not on its own a reason to spend a model call. The first version
tested "all seven null", which `tasks` made unreachable, so the short-circuit
never once fired.

**The model ranks; the code decides.** `gate()` is pure, exported and tested
without a provider, a network or a clock. Five refusals in order: an action too
short to be an instruction; an action resting on an evidence key that is not
measured for this venture (this is the rule the whole packet exists to make
enforceable); an action already on the venture's own board; an action proposed
in the last `repeat-days` whether it was filed or dropped then; and the caps,
per venture and per night. Comparison is Jaccard ≥ 0.6 over normalised titles
with figures stripped, so "reply to 12 reviews" and "reply to 40 reviews" are
the same job. A sixth rule catches the same action twice inside one answer.

The gate reads the venture's WHOLE open board, not the recent slice the packet
showed the model: the packet is capped for prompt size, but a card the owner
cannot see at the top of his board is exactly the one he has forgotten and would
be most annoyed to be offered again.

**Every refusal is recorded with its reason.** `synthesis_proposals` holds the
dropped rows beside the filed ones and both are a first-class view, because a
pass whose rejections are invisible is one the owner cannot calibrate: he cannot
tell whether it considered the obvious thing and refused it, or never thought of
it. Survivors become ordinary board cards in Backlog with the evidence line in
the body and the sentence "It is a PROPOSAL: nothing has been done". The whole
packet is stored on the proposal, because the figure that justified an action on
Tuesday is a different figure on Friday — but it is NOT returned by the
proposals list, which carries the evidence line and a `packetOmitted` flag
instead. Each packet is kilobytes and the venture page asks for several rows on
every render; `?packet=full` is the opt-in.

**Coverage rotates.** Least-recently-covered first, `ventures-per-night` a night
(default 3, so nineteen ventures are covered in about a week), and a venture that
produced NOTHING still counts as covered — deriving coverage from the proposals
would put the quiet ones straight back at the front of the queue. Proposals can
be switched off per venture, and those are dropped from the rotation rather than
picked and then refused.

### Tables

`pipeline_runs` (one row per night, `dry` a column so a plan is filed beside the
real ones), `pipeline_stage_results` (every stage the night considered, with
`reason` and `error` as two columns because a decision is not a fault),
`pipeline_stage_prefs` (the owner's overrides only — a stage nobody has touched
has no row, which is what lets a release change a default), `pipeline_skips`
("not tonight", one row, expiring by itself), `synthesis_proposals`,
`synthesis_coverage`, `synthesis_venture_prefs`. Migrations 220–226.

### Routes

`GET /api/pipeline` (schedule + stage graph + ledger), `/stages`,
`PATCH /stages/:id` (enable, cadence, budgets; `null` restores the default),
`/schedule`, `/runs`, `/runs/:id`, `GET /plan` (what tonight would do against
the clock now, writing nothing), `POST /plan` (the full rehearsal — every stage
asked what it would do, spending nothing), `POST /run` (the real thing; `{stage}`
only, and `dry` is refused), `POST /skip-tonight`. And `GET /api/synthesis`
(proposals filed and dropped, rotation, coverage; `?packet=full` for the stored
evidence), `/evidence/:key` (the packet with nothing asked of a model — free),
`POST /plan` and `POST /run` (`{ventureId}`), `PATCH /ventures/:key`
(`{proposals}`). `PATCH /pipeline/stages/:id` takes `enabled`, `cadence`,
`window`, `maxUsd`, `maxMinutes`, each accepting `"null"` to restore the stage's
own default.

The night's settings are settings: `PUT /api/plugins/pipeline/config` (on, hour,
zone, blackouts, max-minutes, max-usd) and `PUT /api/plugins/synthesis/config`
(ventures-per-night, per-venture, per-night, repeat-days, model). Two
pseudo-plugins, no credentials.

### Skills

`pipeline` — views `schedule`, `stages`, `runs`, `run`, `plan`; actions
`plan_night` (rehearses, cannot execute), `run_stage` (always executes, takes no
flag that could stop it), `skip_tonight`, `set_stage`. Its rules: read
`scheduledBy` first,
because switching off a self-scheduled stage here does NOT stop it; `lastRun`
means two different things and `lastRunMeans` says which; the four outcomes are
not interchangeable and a skip is not a failure; `usd` null is unknown, never
zero, and a night's cost must never be summed with the runs it queued; a `dry`
run is a plan and never work done.

`synthesis` — views `proposals`, `evidence`; actions `plan_for_venture` (free),
`run_for_venture` (one model call), `set_proposals`. Its rules: a filed proposal
is a suggestion, never work done;
a refusal for unmeasured evidence is the feature working; the stored packet is a
snapshot and never today's number; NOT MEASURED is never zero; check `coverage`
before concluding nothing was worth proposing.

### Page

Workflows gained a **Pipeline** tab (`/workflows/pipeline`): the stage list
indented by dependency depth, each row labelled `pipeline` or `own timer` with a
switch only on the ones a switch would change, the settings form including the
blackout box, "Plan tonight" (spends nothing) beside "Run the night now" (says
what it costs) and "Skip tonight", last night's prose result, the ledger with
per-stage expansion, and the proposals with a toggle for the refused ones, and the five synthesis dials.
Those dials live here rather than under Integrations because the `synthesis`
pseudo-plugin holds no credential and so has no entry in the catalog that page
draws from; putting them beside the proposals they govern is where somebody
changing them is already looking. The
venture page's overview gained a **Proposed actions** section with a "Look at
this venture now" button; it renders nothing at all when the synthesis document
cannot be read.

## Migration: coming from somewhere else, and taking the products with you

Two halves of one afternoon. The DATA has to arrive once, and it has to be
possible to change your mind. The PRODUCTS have to keep publishing afterwards,
which means somebody has to write an adapter for each one and find out whether
it works before four in the morning.

**Nothing here starts an import from a route.** `POST /api/migrate/…` cannot
begin one and there is no button on the page. An import reads a directory off
this machine's filesystem and writes to eleven tables in one transaction, and
the only correct answer to "which directory may this application read" is "the
one somebody typed into a shell on the box" — a path arriving over the network
and handed to `readFileSync` is a file-read primitive with a JSON wrapper. So
it is `npm run import-workdash`, the same argument `cli/restore.ts` makes.
Rollback IS a route, because it takes no path and no input a caller could
invent: only a batch id this database already holds.

### The users contract grew two fields, and both default to the old meaning

`population` is one of `customer`, `participant`, `admin`, `trial`, `internal`,
and a document that omits it means `customer` — which is what the contract
always implied, so every endpoint written against the older version is still
valid and still means the same thing. It exists because a portfolio whose
products each mean something different by "user" produces a headline true of
nothing: one product's table holds people who pay, another's holds everyone who
was ever invited into somebody else's session, a third's holds two operator
logins because the real customers are Stripe subscribers. A value the contract
does not know is a REFUSED ROW rather than a quiet fallback — "subscriber"
arriving where "customer" was meant is a mapping somebody can fix in a minute
if they are told, and a coercion is a portfolio-wide miscount nobody ever finds.

`contactPermitted` is `false` unless the document says the literal `true`. Only
a boolean is accepted — a `"true"` in quotes is refused — because this is the
one field where a lenient parse turns a type error into permission to write to
somebody. Nothing infers it and there is deliberately no way to add an
inference: "we hold an address" is not consent. It is stored beside the salted
hash `130_activity_users` describes, and there is still no route here that
returns an address; what the flag is for is COUNTING, so a recovery campaign can
be sized before anybody decides to run it and then sent from the product that
holds the consent.

### The adapter templates live outside this tree

`deploy/adapters/` runs on the PRODUCT's host, so it has no dependencies at all
— not "few": a template whose first instruction is `npm install` is a template
that does not get installed on the mail server. `sql-adapter.mjs` runs a SELECT
on a cron and writes the users document; `http-adapter.mjs` serves the same
document live behind a required bearer token, on `127.0.0.1` by default.

**The document is every customer's raw address, and where it is put is part of
the template.** This box hashes addresses on arrival; the file on the product's
disk does not. So it is written `0640`, no worked example puts it under a
`public/` or `www/` directory, and the checklist makes the owner tick which of
four answers they chose — behind the admin API's own auth (preferred), not
served over HTTP at all, the HTTP adapter instead, or an unguessable path
(weakest) — and then fetch it from a machine that should not be able to see it.
A static file cannot check the bearer token this box is perfectly willing to
send, which is the whole reason the HTTP adapter exists. Database passwords go in
`source.password` and reach the client through `PGPASSWORD`/`MYSQL_PWD` rather
than inside `source.dsn`, which `psql` and `mysql` take as an argument and every
`ps` on both machines can read.
Drivers are `postgres`, `mysql`, `sqlite` and `command`, each shelling out to
the client that is already on a box with that database and asking it for JSON.
`lib/config.mjs` reads a deliberate YAML subset (or JSON) and names the line it
cannot read. `CHECKLIST.md` is the per-product order of work, and its step 3 —
"what does *user* mean in THIS product" — is the one that decides whether the
portfolio total means anything. `examples/` has one worked mapping per shape of
source the predecessor probed: Postgres over SSH with a role column splitting a
two-sided market, SQLite over SSH with a local-time timestamp fixed in the query
and a soft delete, and an HTTP admin endpoint reshaped into the counts-only
form. That third example also says the thing worth saying loudest: the
product-stats half of an admin endpoint needs **no adapter at all**, only an
account and two mapping lines, because that contract resolves at read time.

`POST /api/migrate/adapters/validate` closes the feedback loop. It calls
`activity/users.ts`'s own `validate()` — not a copy — so the sentences it
returns are the sentences the collector would store, and it adds the population
breakdown and the contactable count, which are the two numbers a mapping gets
wrong silently. Passing `{ endpoint, payload }` keeps the result; only the
counts and the problems are kept, never the rows, the addresses or the document.
A validation whose label matches no account is still shown, marked "validated,
not connected yet", because that is the normal state halfway through setting an
adapter up.

### Every metric series is provenance, and each one says why

The rule was: history moves into its real table only where the units AND the
windows match. Applied honestly to the predecessor's eighteen exported series,
**none qualify**, for two independent reasons either of which is fatal alone.

The KEY: `stripe_charge_days`, `umami_days`, `play_sales`, `play_stats` and
`appstore_sales` are all keyed by `account_id REFERENCES plugin_accounts`,
because a figure means something only beside the credential that fetched it.
Imported history has no such account, and attaching eighteen months of somebody
else's arithmetic to a live Stripe key so an INSERT would succeed is a forgery
with a foreign key.

The WINDOW: `gsc_days` is the one daily table NOT keyed by an account — it is
keyed by `property` — and it still does not qualify, because the predecessor's
`search` rows are Google's ROLLING 28-DAY totals sampled hourly and `gsc_days.
clicks` is one day's clicks. Writing the first into the second multiplies every
figure on the search page by about twenty-eight, and nothing downstream could
ever tell.

So everything lands in `migrate_history`, tagged, dated, carrying its own
sentence, joined into no chart. `readings` was considered as an alternative home
and rejected: it is a real table with real readers, and a metric name nothing
reads is a row that looks live and is not. The `SERIES` table in `mapper.ts`
keeps the reasoning one line per series so a source that later gains a matching
target is an edit rather than an argument had again. Each row carries a `window`
— `day`, `rolling`, `level`, `cumulative` — because those are not
interchangeable and two `rolling` rows a day apart overlap. A NULL figure is
dropped, never stored as 0: half those columns carry a documented "not measured"
null, and a zero for any of them is a measurement that never happened.

### The id map is the whole mechanism

`migrate_id_map` says "the predecessor's project `acme.ie` became venture
`v-a1b2c3`, in batch `b-…`, and this batch CREATED it". Three things fall out of
that one row: the import is idempotent, because a second run finds the mapping
and updates; it is referential, because a card naming a project resolves through
the map; and it is reversible, because undo is "delete the target rows this
batch created", in an order that respects the foreign keys. `created = 0` is the
load-bearing part — an import that finds a venture the owner typed months ago
maps ONTO it and says so, and a rollback leaves it alone. Without that column,
undoing an import would delete a business because a folder in another
application happened to share its name.

Provenance is in the row where the table has a column for it —
`board_cards.origin` is `workdash:card:<id>` and its UNIQUE index makes a second
import a database-level refusal rather than a remembered check;
`chief_memory.source` is `workdash`; `chat_messages.backend` is `workdash` — and
in the id map where it does not.

**Files are the part a transaction cannot cover, so they are handled around it.**
`copyFileSync` is not undone by `ROLLBACK` and neither is the `migrate_files`
row that would have named it, so a failure after the copies would roll the
records back and leave the bytes in `data/studio` — invisible to any rollback,
while the CLI printed "NOTHING was written". The copies are made first into a
local list, that list becomes the `migrate_files` rows as the last write inside
the COMMIT, and any failure unlinks them before rethrowing. A file NAME out of
`studio.json` is one path segment or it is refused: `"../../../etc/hosts"` would
otherwise have been copied into `data/studio` and served by
`GET /api/studio/posts/:id/image`.

**A venture slug is deduped in the plan, not at the insert.** A WorkDash project
slug is a domain and the venture slug is its first label, so `foo.ie` and
`foo.app` — one brand on two TLDs — both want `foo`, and `ventures.slug` is
UNIQUE. The plan keeps its own set of minted slugs, suffixes the second one, and
REPORTS the rename; without that the dry run said "2 imported" and the real run
took a backup and then died on a constraint.

**No credential is ever opened.** The deny list in `migrate/workdash.ts` is a
deliberate SUPERSET of the predecessor's own backup deny list, because that list
has known gaps — `adsense-token.json` does not match `*-token`, and
`reddit-app.json` and `*-secret` match nothing in it — and a migration is
exactly the moment a gap becomes a plaintext key living in a second
application's data directory forever. What comes back instead is a list of
plugins to reconnect by hand, derived from the files that were found and not
opened, so an install that never connected Meta is not told to reconnect Meta.

### What is honestly not carried across

Said out loud by the dry run rather than discovered later. Chat TITLES: this box
keeps session labels in the browser's workspace preferences, not the database
the importer writes to. Individual message TIMESTAMPS: the source timestamps a
conversation and not the messages in it, so every imported message carries its
chat's start — spreading them evenly would draw a conversation that never
happened. The memory BRIEF: up to 8,000 characters of the owner's standing
context, where a note here caps at 600 and the global goal at 4,000, and
choosing which to cut it into is not an importer's decision. The board PROMPT,
domain ALIASES, and studio REFS and LOGOS: no column and no table here, and the
files stay where they are. Outbox drafts when no Gmail account is connected,
because `mailflow_outbox` is keyed by the mailbox a mail would be sent FROM. An
APPROVAL, which here is not a flag but the exact bytes that were agreed to — a
row inserted `approved` with no `approved_at`/`approved_content` can neither be
sent (the send re-checks the body against them) nor re-approved (that takes only
`draft|failed`), so it would sit in the queue forever; WorkDash's approved drafts
arrive as drafts and the problems list says why. And LAUNCH STAGE, which the
source does not record at all — so `--stage` is a
documented setting defaulting to `pre-launch`, and every venture it creates is
named in the problems.

### Tables, routes, skill

Migrations `290`–`295`: `population` and `contact_permitted` added to
`activity_users`; `migrate_batches`, `migrate_id_map`, `migrate_history`,
`migrate_files`, `migrate_validations`.

`GET /api/migrate/batches` and `/batches/:id` (the whole id map, the files, the
history summary), `POST /api/migrate/batches/:id/rollback` (destructive),
`GET /api/migrate/history` (the series held, plus the `plan` of reasoning for
every series whether or not any rows arrived), `GET /api/migrate/adapters`, and
`POST /api/migrate/adapters/validate`.

The `migrate` skill has FOUR VIEWS AND NO ACTIONS. Two of the three things this
area can do are things an agent must not initiate — an import moves somebody's
whole history, a rollback removes it — and the third takes a product's real user
list including its addresses as a parameter, which is not a thing to make
possible in a chat transcript. Its rules carry the window semantics, the
counts-versus-created distinction, and the two sentences about what a mapping
error and an unstated population actually mean.

Settings → Migration lists the batches with what each one created and a rollback
button whose confirm names the row count rather than asking "are you sure", and
every product endpoint with its last collection, its last validated sample, its
population breakdown and which mapped paths currently resolve.

## Knowledge: what each product IS, with the evidence beside every sentence

Every other section of this file describes something this box MEASURES. This one
is the exception, and the exception is the point.

Ask the chat agent "does Beacon support webhooks" and, before this existed,
it had three things to reason from: a one-line description the owner typed when
he created the venture, a palette measured off the home page by
`ventures/enrich.ts`, and whatever the model remembers about the word. None of
those is the product. The product is a repository, a Stripe catalogue and a set
of things the owner knows and has never written down. So an agent asked about a
capability either said it did not know or — the failure this area exists to stop
— reasoned from the marketing page and stated a capability the code does not
have.

### Four tiers, and the order between them is the feature

| tier | what it is | how it gets there |
|---|---|---|
| `owner` | the owner typed it | the Knowledge tab, or confirming a proposal |
| `repo` | read out of the product's own source, with a file and a line | the extractor below |
| `measured` | derived by code from a connected account | the derivers below |
| `proposed` | an agent suggested it; nobody has confirmed it | the `knowledge` skill |

Two precedence rules rather than one, because the two questions have different
best answers. **For what the product IS**: owner beats repo beats measured — the
owner's sentence is the only source that is not a reading of something else, the
repository is what the code does, and a Stripe product is a configuration that
can describe a plan nobody shipped. **For a NUMBER**: measured beats everything —
a price in a constants file is what a developer typed once; a live Stripe price
is what customers are charged.

`proposed` is not knowledge. It never reaches a prompt: `factsForPrompt` excludes
it by construction rather than by the caller filtering it, because a block of
context handed to a model comes back as assertion and there is no wording that
survives that trip. Every surface that draws one draws the word UNCONFIRMED.

### The citation gate

An extraction fetches a bounded set of files — README, package manifests, the
env example, CHANGELOG, files whose name says they hold prices, and the file
tree, which is itself citable because a path is evidence that a file exists —
renders them with a LINE NUMBER on every line, and asks a model for facts each
citing `path:line`.

Every citation is then CHECKED, in code, against the material that was actually
fetched. A fact citing a file that was not sent, or a line outside the range that
was sent (including a line the size budget trimmed away), is REJECTED — not
downgraded, not flagged, dropped, with the reason counted in the extraction
report. A model asked for citations produces citations whether or not it read
anything; the only useful question is whether the thing it cited exists, and that
question has a mechanical answer. A second gate drops any statement carrying a
figure that is not in the material, and a third refuses `audience` facts from a
repository entirely: `/teachers` existing does not mean teachers use it.

Nothing from a repository is ever executed. No clone, no install, no build, no
hook. GitHub is read through the contents API; a local path is read with
`readFileSync` and one `git rev-parse` invoked through `execFile` with an
argument array, so a directory name cannot be a command.

### The tables

- `knowledge_facts` — id, venture, kind (capability, pricing, audience,
  integration, limitation, metric, claim), statement, tier, source type/ref/
  commit, `observed_at`, confidence, status (active, corrected, retired),
  `corrected_by`, `created_by`, `refresh_after`, `fingerprint`. Nothing is ever
  deleted: there is no DELETE statement against this table anywhere in the tree.
  A correction files a NEW owner fact and marks the old one `corrected` pointing
  at its replacement, so the disagreement stays on the record. `fingerprint`
  replaces digit runs with a marker, which is why "4,100 installs" and "4,180
  installs" are one fact read twice rather than two facts.
- `knowledge_repos` — which repository is this venture's, `github` or `local`,
  the commit the stored facts were read at, when, and the last error. It is a
  table and not a `plugin_config` key because it is one value PER VENTURE.
  It defaults to the venture's `github` link and `source` records which of the
  two it was, so the page never reports a repository as the owner's choice when
  nobody chose it. `source` arrived in migration 232 with a default of `owner`,
  which was wrong for every row already there; 233 runs immediately after it and
  sets `link` where the repository is exactly a `github` link the owner had
  accepted for that venture, which at that instant is a fact rather than a guess
  because every row in the table predates the column.

### Refresh

A repo fact is re-read when the repository's HEAD moves or when its
`refresh_after` (30 days) passes, whichever is first; a HEAD that has not moved
and nothing expired answers `skipped` and spends nothing.

A fact that was there last time and is not now is RETIRED — its `status`
changes; there is no `retired_at` column and `observed_at` keeps the date the
fact was last actually observed, which is the honest reading of it. **A reader
only retires what it is responsible for, and only when it ran.** There are three
readers here and they fail independently: the deterministic file walk, the model,
and each measured deriver. A repository read where the provider 502s retires
nothing the model had filed; a measured pass where the Stripe deriver throws
retires no Stripe fact, while one where it ran and found no products does retire
them — "there are none any more" and "the deriver said nothing" are different
answers and only the first may remove a fact. Measured rows carry their deriver's
key prefix, which is what makes that question answerable at all.

Measured facts are rewritten in place by a deterministic pass over the live
plugin tables: a half-hour timer, `POST /api/knowledge/derive`, and every
repository refresh. **The GET does not derive.** It used to, so that a reader
never saw a superseded figure — but a read that rewrites the thing being read is
not a read, and every page load and every `opc knowledge` call was writing rows.
Every measured fact carries `observed_at` and `stale` instead, so how old a
figure is remains visible without the act of looking changing it.

### The routes

`GET /api/knowledge` (filter by venture, kind, tier, status),
`GET /api/knowledge/history` (including corrected and retired),
`GET /api/knowledge/contradictions`, `GET /api/knowledge/coverage`,
`POST /api/knowledge/facts` (the owner's own), `POST /api/knowledge/proposals`
(an agent's, `basis` required), `POST /api/knowledge/facts/:id/correct`,
`/retire`, `/confirm`, `PUT /api/knowledge/repo`, `POST /api/knowledge/refresh`,
`POST /api/knowledge/derive`.

### The skill

`knowledge` — views `facts`, `contradictions`, `coverage`, `history`; actions
`propose_fact` and `request_refresh`. It writes into exactly one tier and there
is no parameter that could put a proposal anywhere else: an agent cannot promote
its own suggestion, correct an owner fact or retire anything. Its rules carry the
two precedence sentences, "never state a proposed fact as true", "cite the tier
and the date", "a `claim` is what the product says about itself and is never
evidence that it is true", and "absence is not a limitation".

### Where the facts go

- The chat system turn, through `knowledgeLines` in `withGoals` — at most 25
  lines, only for the venture in hand, silent when nothing is known.
- `ventures/studio.ts`'s caption brief, capability/pricing/integration/limitation
  only, capped at 900 characters. A caption is published, and a proposal turned
  into a marketing sentence is a claim made to a customer.
- The research run's context blocks, first, because every other block in that
  brief is about the world around a product this one defines.
- Anything else, through `factsForPrompt(ventureId, kinds, maxChars)`.

### No model setting

Extraction is sent to the one model this box is configured with on the Models
page, like everything else. The first real extraction here was routed by the
gateway to a reasoning model, which spent its whole output allowance writing "We
need to produce a JSON with at most 12 facts…" and was cut off before it emitted
any; the answer to that is not a second model but the salvage parser (a
truncated answer is read object by object, each still going through the same
citation gate) and the extraction report quoting the first line of whatever came
back, so the failure is legible.

## Publishing: the one place on this box that shows something to strangers

`server/src/integrations/publishing/` is where a Studio draft becomes a post.
Everything else in this app reads; this writes to somebody else's network, in
front of somebody else's audience, and every decision in the area follows from
that one asymmetry.

**Nothing is published that the owner did not approve.** An item is created as
a `draft` — by the Studio's "Send to publishing" button, by the Autopilot, or
by a campaign — and the ONLY door out of that state is `approve()`, reachable
from the queue page and from a skill action marked destructive. `schedule()`
refuses an item that is not approved; the scheduler reads only `scheduled`
rows. **An edit unapproves**: changing the caption or the destination of an
approved or scheduled item returns it to `draft` and clears its date, because
the approval was of a document and the document is now a different one — the
same rule `mailflow/outbox-routes.ts` keeps, for the same reason.

**And the two routes that actually send are browser-only.** They carry
`requireBrowser` from `security/gate.ts`, which refuses a service key of either
scope, the skills proxy's `x-opc-via: skills`, and any Origin that is not this
workspace — while still working on a box with no password, the shipped state.
So the walls are three and they are different kinds: the registry names no
action pointing at either route, so the proxy has no URL to compose;
`requireBrowser` turns an accidentally-added action into a 403 rather than a
post; and `publishItem` refuses anything the owner has not approved, which is
the wall that does not care where the request came from. The middle one is a
heuristic and the gate says so — anything that can open a socket can set a
header. `/api/publishing` is deliberately NOT in `OWNER_SURFACE`: that is a
prefix list which refuses the proxy outright, and it would kill queueing,
approving, scheduling, probing and asset import, none of which sends anything.
What an agent CAN do is queue, approve, schedule and cancel — and approving is
marked destructive precisely because of what it authorises.

**A destination is discovered, not typed.** `POST /api/publishing/destinations/
probe` walks every connected social credential for one venture and writes a row
per account it can reach, with what that account could actually DO. That is the
product: "Meta is connected" is not the question, "can this box put a photo on
that Page" is. On the account this was written against the answer came back
YES — `/me/accounts?fields=access_token` minted a Page token for all three Pages
— which contradicts the dated CANNOT note in `providers/meta.ts` from
2026-09-04, when the same call answered 403 (#200). Both readings are kept: the
note is what was true then, the probe is what is true now, and the probe is
dated for exactly that reason. A destination is attached to the venture the
probe was run for, and the owner moves it (`PATCH .../destinations/:id` with a
`ventureId`) — Meta knows which Pages exist and only the owner knows which
business each one is for.

**Idempotence is three rules, and the third is the one that matters.** A unique
`idempotency_key` of (venture, source artefact, destination) means asking twice
returns the row that already exists rather than making a second one. A check on
`external_id` means an item that HAS been submitted is never submitted again,
whatever its status says — that covers a re-press and a retried HTTP request.
Neither covers the worst case: a call that succeeded and whose answer was lost.
`external_id` is written only from a response this process read, so it is null
in exactly that case, and none of these four APIs offers an idempotency key
this code could send. So the third rule is a refusal: **an ambiguous outcome is
never retried.** A `fetch` that threw is recorded by the transport with
`status: null`, and both the retry decision in `publish.ts` and
`scheduler.reclaim()` turn that into `failed`, with the date cleared so no
timer can pick it up and an error naming the account to go and look at. Both
paths used to retry it, and both of them would have posted twice.

**The limits are checked before a socket is opened.** `publishing/limits.ts` is
a pure file with no imports, so every claim about somebody else's API can be
asserted against in a test rather than discovered in production. Caption
ceilings, media types, byte caps, and the one that is otherwise invisible:
Instagram's container endpoint takes JPEG only, the Studio renders PNG, and an
IG container handed a PNG fails at Meta's fetcher minutes later. `problems` on
an item is computed on every read and never stored — a caption edited to fit is
a different answer — and an item with problems cannot be approved.

**A rehearsal and a submission are two routes, not one route with a flag.**
`POST /items/:id/rehearse` runs the entire pipeline — the same checks, the same
credential resolution, the same composed request bodies — against a mock
transport that answers from a table and opens no socket, and it CANNOT publish.
`POST /items/:id/publish` always can. They were one endpoint with a `dry` flag
until, during this area's own testing, the skills proxy sent `"true"` where
`true` was compared, the flag read false, and a rehearsal put a real post on a
real Facebook Page. Nobody typed anything wrong; the endpoint was the wrong
shape. The publish route now also refuses a `dry` it cannot read rather than
falling through to the side that posts, and three tests hold both rules.

**Which networks, and what each can actually take.** Facebook Pages: caption,
photo and video, all as uploaded bytes. Instagram: a photo only, fetched by
Meta from a public URL, JPEG only — Reels are not implemented. LinkedIn: text
and image posts as an explicit author URN, with the Images API's mandatory
readiness poll; video is NOT implemented, and the limits file says "not
supported for this destination" rather than failing. TikTok: video only,
pulled from a public URL, with the privacy level read off `creator_info` and
reported — an unaudited client may only post SELF_ONLY, and a post the owner
believes is public and TikTok made private is the failure that reporting
prevents.

**Instagram and TikTok cannot publish without `publicBaseUrl`, and this box
cannot test that setting from inside itself.** Both fetch their own media; this
server binds to loopback. The readiness view says which of three states applies
— no base URL, a base URL behind this dashboard's own password (so Meta's
fetcher will be refused too), or a base URL whose reachability is somebody
else's to confirm.

**The scheduler holds nothing in memory.** It wakes every minute, publishes at
most ONE due item, and everything it needs is a row: what is due is a query,
that an item is in flight is `status = 'publishing'`, a retry's backoff is
`next_attempt_at`. A process killed mid-call leaves a row in `publishing`; the
next start completes it as `published` if it carries an `external_id` — that id
can only have come from a response this process read — and otherwise moves it
to **`failed` with `scheduled_for` cleared**. Never back onto the calendar:
`reclaim()` runs at the top of `tick()` with the due query immediately after
it, so returning a stuck row to `scheduled` re-posted it inside the same call.
A blackout window HOLDS due items; it does not skip them, and it is inclusive
of its closing minute.

**A campaign is a run kind, not a loop.** One goal becomes a small number of
non-overlapping CONCEPTS from the model, then each concept is written once per
channel, concept-major so a cancel leaves whole arguments finished. It is a run
because nine variants is nine model calls and nine image renders: queued,
cancellable, reported, and surviving the tab closing. Every variant becomes a
Studio draft and a DRAFT publish item; a campaign publishes nothing. A campaign
whose run died reports `stalled: true` beside the run's real status rather than
saying "producing" for ever.

**The asset library is what makes brand consistency more than a hex code.** A
logo, a reference or a screenshot is stored once and reused, and whether it can
be handed to the image model at all is MEASURED rather than assumed: the model
endpoint's own OpenAPI input schema is read and searched for a file-typed
image field. Three-valued — supported with a field name, not supported, or NOT
CHECKED because Replicate is not connected. The default `flux-schnell` has no
image input, so a selected reference is DESCRIBED IN WORDS in the prompt
instead and the post's `error` says so; `flux-kontext-pro` takes one in
`input_image`, read live off its schema.

Tables: `publish_destinations`, `publish_items`, `publish_attempts`,
`campaigns`, `campaign_concepts`, `campaign_variants`, `venture_assets`
(migrations 270–274).

Routes, all under `/api/publishing`: the readiness document at `/`;
`/destinations` and `/destinations/probe`; `/items` with `approve`, `schedule`,
`unschedule`, `cancel`, `rehearse`, `publish`, `retry` and `/media`;
`/calendar`; `/tick`; `/campaigns` with `/suggestions`; `/assets` with a
multipart upload, a URL import and `/file`.

Plugins: `linkedin` (token + author URN) and `tiktok` (token + optional open
id), both with a `verify` that makes a real call. Facebook and Instagram reuse
the existing `meta` credential — Instagram is a field on a Page, not an API of
its own. Settings live under the `publishing` pseudo-plugin: `publicBaseUrl`,
`timezone`, `maxAttempts`, `blackout` and `autoSchedule`.

Skills: `publish` (readiness, destinations, queue, item, calendar; actions
queue, approve — destructive, schedule, unschedule, cancel, rehearse, retry —
destructive, probe), `campaigns` (`start_campaign` is destructive: five
concepts across four channels is twenty model calls and twenty Replicate
renders from one call) and `assets`. All three are `openWorld: true` — they
reach Meta, LinkedIn, TikTok and Replicate, and a false there is a claim a
client may act on without asking. There is no skill action anywhere that
submits a draft, and the two routes that send refuse the proxy's own header.

`import_asset` fetches a URL, so it resolves the host first and refuses
loopback, link-local, private and carrier-grade-NAT addresses — following
redirects by hand so a public host cannot bounce the fetch onto a private one.
It is a non-destructive action an agent may call freely, which is exactly why
it cannot be used to scan this network.

## Journal: the work that leaves no trace anywhere else

Every other table on this box exists because a service publishes something and
a collector can fetch it. The half of a one-person company that publishes
nothing is the half a person does with their hands — a call taken, a landing
page rewritten in a text editor, a post put on a forum with no API, a decision
made on a walk. None of it leaves a row anywhere, so three months later the
operating history says the week was empty, which is false. `journal_entries` is
where that goes.

**A row is testimony, not a measurement, and every response says so.** Nothing
in this table was collected, derived or inferred: somebody typed it. So no
count over it is evidence that anything worked — it is evidence that a sentence
was written — and the skill's rules forbid presenting entry counts beside
collected figures as if they were the same kind of number.

**The table.** `journal_entries` (migration `350_journal_entries`): `id`,
`venture_id` (NULLABLE — a tax return and a conference belong to no venture,
and forcing them into the nearest one would be a worse record than none),
`kind` (`did`, `shipped`, `posted`, `met`, `decided`, `other` — coarse on
purpose; a taxonomy nobody fills in the same way twice measures the taxonomy),
`text`, `url`, `at`, `result`, `outcome_id`, `source`, `created_at`.

**`at` is a LOCAL DAY and not an instant.** "I shipped the pricing page" is a
fact about a Tuesday; asking somebody to pick a minute gets either a lie or no
entry at all. `created_at` keeps the instant the row was written, so a
back-dated entry is visibly back-dated (`backdated: true`) and the streak below
cannot be moved without it showing.

**Three doors, one gate.** The Journal page, a Telegram `/did`, and the agent's
`add_entry` all reach `entries.ts::addEntry`, which is where every rule about
what an entry may be is enforced — a kind this table does not have and a date
that is not one are REFUSED, a long sentence is TRIMMED (losing the last few
words of a note is a smaller failure than losing the record that the work
happened), and a URL that is not `http(s)` is refused rather than repaired.
Each door stamps its own `source` and **no door can name another's**: the
agent's route is a separate path (`POST /api/journal/agent`) that hard-codes
`source: "agent"`, so an agent cannot file its own work as the owner's.

**The streak** is consecutive days with at least one entry, computed on read
from the days themselves rather than stored, so a back-dated entry mends a gap
the moment it is written. Today being empty does not end the run — it is
counted back from today if today has an entry and from yesterday if it does
not, and `today` says which. There is no grace for weekends: a weekend rule
would be this box deciding what a working week is for somebody whose whole
arrangement is that nobody decides that for them. It measures LOGGING, not
work, and every surface that draws it says so.

**The join to outcomes.** A `shipped` or `posted` entry WITH a link can be
handed to the outcomes engine: `POST /api/journal/:id/outcome` takes a metric
address the owner chose (`skill` + optional `view`/`params` + `path`), calls
`chief/outcomes.ts::createOutcomeWithBaseline` — a thin wrapper over the
`createOutcome` the SEO follow-up sweep uses, which adds the synchronous
baseline that a journal entry needs and that sweep does not — and stores the
outcome id on the entry so readings accrue at 7, 14 and 30 days. **Nothing
guesses the address**: a default one would take a baseline against a figure
nobody picked and hand back a verdict about it a month later. Only those two
kinds are offered, because they are the only ones where something exists in the
world for a metric to have moved. That is correlation and never cause, and the
response says so.

**Routes.** `GET /api/journal` (entries newest first, per-kind counts for the
window, the streak over the whole history rather than over the window),
`GET /api/journal/streak`, `GET /api/journal/export?format=csv|json` (the whole
table, unpaginated — a journal somebody cannot take away is a journal held
hostage), `GET /api/journal/:id`, `POST /api/journal` (source `ui`),
`POST /api/journal/agent` (source `agent`), `PATCH /api/journal/:id` (the
`result` and nothing else), `DELETE /api/journal/:id`,
`POST /api/journal/:id/outcome`. Deleting an entry does NOT delete the outcome
it created: those readings are a record of what a metric did and stand on their
own, and the response says so.

**Telegram.** `/did <text>` files from a phone, which is where this work
actually happens. The grammar is one word and a sentence: an optional leading
kind (`/did shipped …`), an optional leading venture (`/did acme shipped
…`) or `none`, a link anywhere in the sentence becoming the entry's URL. The
venture is otherwise inferred from a venture's name or slug appearing as a word
in the sentence, or taken automatically on a box with one venture. **It is
never guessed**: two names in one sentence, or none, gets a question back with
the exact lines to send and files nothing — attributing work to the wrong
business is a quiet error nobody catches for a month.

The leading word is matched EXACTLY (`resolveVentureExact`), never by prefix. The
prefix rule is for the API's explicit `venture` parameter, where the caller has
said "this is a venture name" by putting it in that field; applied to the first
word of a sentence it eats ordinary English — a box with a venture called
"Postal" read `/did post the update` as "post" naming Postal, stripped the word,
and filed "the update" against a business it had nothing to do with. The
ambiguity check does not help: "post" matches exactly one venture, confidently
and wrongly.

The copy lives in `integrations/journal/telegram.ts`; `telegram/bridge.ts` gains
one command entry and one branch.

**The feed.** Entries appear on the activity timeline as a sixth source, DERIVED
(`exact: 0`, at the start of their day) for an unusual reason: every other
derived source is derived because the service publishes a day, this one because
the PERSON does. The detail carries `typed: true`, which door it came in by, and
a sentence that BRANCHES on that door — an agent-filed row says so rather than
claiming to be the owner's own hand, which is what a constant note underneath
`filedBy: "agent"` was doing. The dedupe key is the entry id and the pass updates
in place, so filing yesterday's work this morning moves the event rather than
leaving two; and the DELETE route removes the event by that key, because the pass
cannot notice a row that has gone.

**The skill** is `journal`, always live (`plugins: []` — a box with nothing
connected can still keep this). Views: entries, streak, one entry. Actions:
`add_entry`, `set_result`. Its first rule is a prohibition — **never file your
own work here** — because an agent with a write onto a log of the owner's work
will, unprompted, log its own, and a streak read as the owner's when half of it
is the agent's is a lie in the one table whose entire value is that a person
vouched for every row.

## Appearance: eight palettes over one light/dark choice

Light or dark is a fact about the room somebody is sitting in; a palette is a
fact about what they want the thing to look like. The two are now separate
axes and they never collapse: `.dark` keeps choosing between the two blocks in
`index.css`, and a palette replaces the values INSIDE whichever block won, so
somebody on Moss who moves into a dark office at six gets dark Moss.

They are stored in different places for the same reason. The mode stays in the
browser's `localStorage` — a phone in the sun and a desktop at night want
different answers, and syncing it would fight the OS. The palette rides the
workspace preferences (`shared/workspace.ts` gained one optional `palette`
field, validated by SHAPE rather than against a list, because `shared/` must not
import a client module and a document written by a newer client with one more
palette in it is not an invalid document), so it follows the owner to every
browser.

`client/src/lib/palettes.ts` holds all eight — Paper (the default), Moss, Azure,
Coral, Linen, Slate, Violet, Mono — as data rather than as CSS, for two reasons.
A settings tile has to DRAW the palette it is offering, and a stylesheet block
that is not applied cannot be drawn. And the contrast test has to test what
ships. `palettes.test.ts` computes the WCAG ratio of every ink against every
surface, in both modes, from the same numbers the browser is handed, and fails
the build under 4.5:1 **for the seven palettes this area authored**.

Paper is treated differently and deliberately: it is the design this app already
had and is not this area's to restyle, so it is PARSED OUT OF `index.css` and
MEASURED rather than gated. Its body and button text are asserted at AA; the four
quiet greys that land between 3.8:1 and 4.4:1 are written down as a ledger the
test fails on if the set changes in either direction — a new shortfall, or one of
these fixed and the note left stale. (Two of the four are `faint` on `muted`, a
pair nothing in `src` actually draws — there is no `text-faint` class — because
the sweep asks every combination rather than only today's.) The same parse
asserts that `swatch()`'s hard-coded Paper hexes still match the stylesheet,
which is the only thing that could notice the default's own tile going stale.

**Paper defines no tokens at all** — choosing it removes every custom property
rather than restating `index.css`, so the default cannot drift from the
stylesheet. A palette owns colour only: never the radius,
the type scale or the fonts.

The chart plot now takes its ink from `--chart-1` rather than inheriting the
page's foreground. `--chart-1` IS the foreground in the default palette, so
nothing about the existing charts changed; it just stops the plot being the one
colour on the page a palette cannot reach. The rest of the chart ramp stays
grey on purpose — see `components/charts.tsx` on why a brand hue climbing a load
chart says "something is wrong" before anybody has read the axis.


## Agent tools and jobs: a model with tools, and the runtime's own clock

Two absences, one subject: what the thing behind chat actually is.

**A model key alone used to give you a chat that could talk and not look
anything up.** When no agent (Hermes, OpenClaw) is live, a message goes
straight to the model provider chosen under Settings → Models — and that path
was text-only by design. `routes/chat.ts` says why at length: a model told to
fetch something it cannot fetch does not say so, it writes down what the answer
would probably have been. That argument is about a model with no tools. Given
one that can call a function, the skills registry is already a list of typed,
documented, rule-carrying calls, so `integrations/runtime/loop.ts` gives it
them.

**And the agent's own scheduler ran in the dark.** Both managed runtimes
schedule work of their own, both are firing it (the gateway process is the
ticker), and nothing on this side could say what they had done — nor could
their results reach a phone, because the Telegram token deliberately does not
live inside an agent's home. So delivery is inverted, exactly as it was
inverted in the system this replaces: the runtime writes results where it
writes them, and this side, which holds the pairing, reads and pushes.

### The tool loop

`directTurn()` is an `AsyncGenerator<ChatStreamEvent>` — the same contract a
chat backend's `stream()` has — so it is handed to `startChatRun` as a turn's
`open()`. Reattach after a reload, the stop button, the partial row and the
tool lines with their offsets are all `chat/runs.ts`'s and none of them is
reimplemented. Both fallback paths use it: the streaming route and `POST
/api/chat`, which is the Telegram bridge's door, because a question asked from
a phone is the same question.

One turn is bounded five ways, and every bound is a setting:

| Bound | Setting | Default | What happens at it |
|---|---|---|---|
| Tool calls | `max_tool_calls` | 12 | Tools are removed and the model is asked to answer with what it has and say what it could not check |
| Wall clock | `tool_seconds` | 180 | The same |
| Dollars | `turn_usd` | 0 (off) | The same. Read back out of `budget_usage` — and **inert until a model price per million tokens is set** under Settings → Usage limits, because without one every call is costed at zero |
| Bytes per tool answer | agentcore's `response_bytes` | 24 KB | Scalars kept, rows shortened with a marker carrying the real total. **Every** answer: reads, writes, refusals and the catalog alike |
| Writes | `actions` | off | Actions are not published as tools at all, and with it on only the allow-list below is |

Every round of a turn reserves against **one** run id, so the existing per-run
call and dollar ceilings under Settings → Usage limits bound the whole loop
rather than each of its rounds. The run context is passed to `runContext.run`
around each model call rather than wrapped around the generator, because
AsyncLocalStorage does not survive a generator's suspension.

**Writing is an ALLOW-LIST, not a deny-list, and that is the second half of the
fix.** The first version refused `destructive: true` and let everything else
through — and `destructive` had correctly meant "there is no undo for this
ROW", which is not the set an owner means when they switch writing on to let
chat file a card. A briefing that sends itself to a phone, a pipeline stage
that dispatches sub-agent runs, an image model billed per picture and an ssh
that puts a desktop to sleep are all perfectly reversible as records. So:

- The flag's meaning is widened to **"cannot be undone, or spends money, or
  sends a message, or reaches a machine that is not this one"** — which is what
  a client asking "should I check with a person" actually wants to know — and
  `proactive.send_now`, `socialfeed.start`/`deliver`, `pipeline.run_stage`/
  `run_for_venture`, `security.wake`/`sleep`, `snapshots.take_now`,
  `mailflow.run` and `people.scan` are marked accordingly in their own
  registries.
- `actionGate()` then requires all three of: not marked destructive; the skill
  is not `openWorld`; and the action's name is not a **doing verb** (`send`,
  `run`, `start`, `deliver`, `dispatch`, `submit`, `publish`, `render`,
  `refresh`, `wake`, `sleep`, `shutdown`). The third is the belt to the flags'
  braces — an area that adds an action and forgets the flag must not thereby
  hand a model a button that spends, and dumping the gate's verdict over the
  whole live registry found two that did: `subagents.dispatch` ("this spends
  the single run slot and real tokens on the owner's account") and
  `growth.submit` (posts URLs to IndexNow), neither of which carried a flag.
  Over the live registry the gate allows 51 actions — create/update/move/
  archive a card, set a goal, remember a note, add a ledger expense, draft an
  email, link a venture — and refuses 52.
- Only allowed actions are **published** as tools, and every call is
  **re-checked** against the same gate, because the index surface's `opc_act`
  takes an action name rather than choosing from a list.
- A refusal is a sentence the model passes on: it names the action, says in one
  clause why this door will not press it, and says where the owner can. A
  connected Hermes or OpenClaw is unaffected — it still reaches everything the
  registry publishes through MCP.

**Nothing is confirmed, because there is nowhere to confirm it.** The right
shape is a `confirm` event that pauses the run, but `chat/runs.ts` has no
pause/resume (a run is one forward pass with a cancel) and the chat page has no
affordance to answer with, so building one would be a run that hangs until its
wall clock kills it.

**A gateway that refuses the `tools` field falls back to text rather than
failing the turn.** Three of the four providers route, so the capability is
cached against the key the owner set (`auto`, here) and not against the model
the router picks this minute. The first tooled round is guarded: a 4xx that
`verdictFor` reads as a verdict about the field re-writes the capability to
`text` and the same round runs again without tools. A 401, a 502 or a timeout
is left to throw — answering from memory after a network error is the one
outcome this area exists to prevent.

**The mode is measured, never declared.** `POST /api/runtime/tools/probe` sends
one trivial tool with one trivial question and reads what comes back:
`tools` (a call arrived), `text` (prose while holding a tool it was told to
call, or a 4xx refusing the field), or `error` — which is *not* a verdict, it
means the measurement could not be taken. Cached per provider+model for seven
days in `runtime_tool_capability`. The chat path READS that cache and never
probes; a miss means text, which is the behaviour this app has always had.
Settings → Models prints the answer, when it was taken, and the bounds.

**The parser reads three dialects on one wire.** Every provider here speaks the
OpenAI request shape, so that is what goes out — but FreeLLMAPI and OpenRouter
both route to Anthropic and Gemini models behind an OpenAI-shaped door, and a
shim that forgets to translate leaks `tool_use` blocks or `functionCall` parts
into `content`. A parser that only knew `tool_calls` would read those as an
empty answer. `tools.ts` renders and reads all three and says which it found.

### The jobs reader

Read-only, and it creates, edits and fires nothing. Where each runtime keeps
it, measured on this box rather than taken from documentation:

- **Hermes** — `$HOME/.hermes/cron/jobs.json` (`{"jobs":[…]}`; a bare list and
  an id-keyed map are also legal and are read), `cron/executions.db` (which has
  **no output column**, which is why results come from the files), and
  `cron/output/<job>/<YYYY-MM-DD_HH-MM-SS>.md` — one markdown envelope per run,
  written atomically for successes and failures alike, and the only place a
  run's text exists.
- **OpenClaw** — `$HOME/.openclaw/state/openclaw.sqlite`, tables `cron_jobs`
  (schedule and last-run state as JSON in `job_json`/`state_json`) and
  `cron_run_receipts` (`running|ok|error|skipped|interrupted|superseded`).
  There is **no output text at all**: a scheduled turn's answer goes into
  OpenClaw's own session. So its results say what happened, and say so.

Both databases are opened read-only and closed in a `finally` — they belong to
a running process. A store that is missing, locked or unreadable produces a
stated reason with the path it looked in; the panel says "not readable for this
runtime" and never "no jobs".

The Hermes envelope is parsed the way `cron/scheduler.py` writes it, including
its **silence sentinel**: `[SILENT]` is what a scheduled agent is instructed to
answer when a tick found nothing worth a person's attention, and the file is
still saved. A relay that did not know the word would push the literal string
to a phone every time a watchdog worked correctly.

### The relay

`runtime_job_results` is one row per run seen, keyed by the run's own identity
in the runtime's store — Hermes' output filename, OpenClaw's receipt id — so a
re-read of the directory cannot re-send and a clock skew cannot either. The
first pass for a runtime marks everything already on disk as seen and sends
nothing; `runtime_cursor` is the watermark whose absence means "never run
here". Silent runs are recorded and suppressed; failed runs are forwarded,
once. Off until switched on.

**What was reused from the customers area rather than rebuilt:**
`quietDeferral()` from `customers/events.ts` with the window and timezone from
`customers/store.ts`, so the owner types quiet hours in **one** field and both
relays honour it; the same five-attempt ceiling and the same `attempts` /
`delivery_error` / `deferred_until` shape, so "you were not told, and here is
why" reads the same on both queues; and `telegram/bridge.ts`'s `notify()`
through a guarded dynamic import, for the reason `customers/collect.ts` uses
one — bridge.ts reaches `routes/pluginConfig.ts`, and a static import from a
manifest stops the server booting.

### Tables, routes, skill, settings

Tables: `runtime_tool_capability`, `runtime_job_results`, `runtime_cursor`
(migrations 300–302).

Routes: `GET /api/runtime/tools`, `POST /api/runtime/tools/probe`,
`GET /api/runtime/jobs`, `GET /api/runtime/results`,
`POST /api/runtime/jobs/refresh`.

Skill `jobs` (pack `agent-jobs`) — views `jobs` and `results`, **no actions**,
because scheduling belongs to the runtime that fires it. Its rules say that in
so many words, and say that a runtime whose store could not be read is not an
empty schedule, that a silent result is a watchdog working, and that
`deliveredAt: null` with a `deliveryError` means the owner was not told.

Settings live on a config-only pseudo-plugin `runtime` under Integrations:
`tools`, `actions`, `max_tool_calls`, `tool_seconds`, `turn_usd`, `relay`,
`jobs_per_pass`, `jobs_body_chars`.

Pages: the mode line under Settings → Models, and a Scheduled jobs panel on
each agent's plugin page beneath the install/start panel.

## Social feed: what went out, what not to make again, and one product shot

Three gaps against the system this replaces, in one area because they are one loop. Something
is made (the autopilot), it is published (the publishing area), and until now
nothing on this box could see how it did — so nothing could decide what to make
next except by asking a model to remember. `integrations/socialfeed/` closes the
circle.

**What it measures.** The Facebook Page posts, and any linked Instagram media,
of the Pages the owner has mapped to a venture under Publishing. Only mapped
Pages are read: a Meta token can administer Pages belonging to businesses this
box has never heard of, and reading those would be collecting somebody else's
data. Every figure is stored under META'S OWN metric name — there is no `reach`
column and there will not be one, because Facebook's surviving
`post_media_view` counts RENDERS and Instagram's `reach` counts UNIQUE
ACCOUNTS, and a shared column would assert they are the same number. A metric
that did not come back is simply not a key; nothing here writes a zero because
a field was missing.

Probed live on 2026-09-06 against three connected Pages, on `v21.0`, with Page
tokens minted through `publishablePages`:

| asked | answered |
| --- | --- |
| `GET /{page}/posts?fields=…` | 200 — the edge works with a Page token |
| `insights.metric(post_impressions)` | 400 (#100) — not a valid metric |
| `insights.metric(post_impressions_unique)` | 400 (#100) — not a valid metric |
| `insights.metric(post_impressions_organic)` | 400 (#100) — not a valid metric |
| `insights.metric(post_engaged_users)` | 400 (#100) — not a valid metric |
| `insights.metric(post_activity)` | 400 (#100) — not a valid metric |
| `insights.metric(post_negative_feedback)` | 400 (#100) — not a valid metric |
| `insights.metric(post_media_view)` | 200, period `lifetime` |
| `insights.metric(post_clicks)` | 200, period `lifetime` |
| `insights.metric(post_video_views)` | 200, `lifetime` and `day` |
| `reactions/comments .summary(total_count)` | 200, and needs no insights permission |
| `shares` | absent when the count is zero — normal, not a gap |
| `instagram_business_account` on all three Pages | null — no IG account is linked on this install |

The whole `impressions` family died on 15 November 2025 and a request naming
one does not get a null: it gets a 400 that takes the WHOLE PAGE OF POSTS with
it. So the metric list in `providers/meta.ts` is a measured constant, anything
added to it has to be probed first — and, because Meta will retire something
else eventually, a 400 whose message names a metric is RETRIED ONCE with the
insights clause removed. The posts survive, `insightsError` carries Meta's own
sentence, and the alternative (which this had for a day) was a Page that
silently stopped updating. A permission refusal is not retried: it would fail
identically without insights and a second request is a second request against
somebody's rate limit. The Page token travels in an `Authorization: Bearer`
header and never in the query string, which is the rule the rest of that file
keeps and for its reasons — a credential in a URL is a credential in an access
log, a `Referer` and every error message that echoes the request. The `CANNOT` block higher up that
file records a 403 (#210) on this same edge from 2026-09-04, when no Page token
could be minted; the system user has a Page role now, and both facts are true
of their own dates.

A post is joined to the draft that produced it ON META'S OWN POST ID, which the
publishing area writes onto `publish_items.external_id` when it sends. The join
is exact rather than a guess by caption or timestamp; a post made in the
Facebook app has no publish item and the join finds none, which is correct.

**The novelty gate.** Before the autopilot generates anything, the derived topic
goes through `socialfeed/novelty.ts`. The comparison is on a NORMALISED
FINGERPRINT — lower case, URLs removed whole, punctuation to spaces, stop words
and short words dropped, five-character stems, de-duplicated and sorted — and
the overlap is ASYMMETRIC: the share of the NEW topic's tokens the old one
already had, so a short brief entirely contained in a longer old one scores 1.0
and is refused. A topic is compared over a WINDOW (a setting; zero switches that
half off). A source video is compared by ID and FOREVER — but PER VENTURE, so
two businesses in the same niche can both cut the same public talk; one
venture's ledger is not a rule about another.

The fingerprint is UNICODE-AWARE, and that is not a nicety: stripping
everything outside `a-z0-9` does not mean "remove punctuation", it means
"remove every letter that is not English", and a Russian or Japanese topic
fingerprinted to the empty string — which the gate reads as "this is not a
brief" and refuses. So NFKD, then the Latin/Greek/Cyrillic combining block only
(taking every combining mark would turn ピ into ヒ, a different word), then NFC,
then `\p{L}\p{N}`. And the stem strips ONE inflection before truncating rather
than truncating at five characters, which was wrong in both directions at once:
it failed to collapse `exams`/`exam` — the example this area's own settings
hint, header and README all promise — while silently collapsing
`marketing`/`marker` and `customer`/`custom`, so a genuinely new topic could be
refused at 1.0.

Overruling the gate ARCHIVES a history row and does not delete it. That door is
reachable by an agent, and an agent that has just been refused can read its own
rules, find it and walk through it to get the job done — which, with a DELETE
behind it, destroyed the record of what had already been made with nothing to
restore from. Now `archived_at` is set, the gate stops counting the row, every
list still shows it flagged, and `restore` puts it back. The action is marked
`destructive` anyway: the reason to ask a person is not "can this be undone",
it is "should an agent be doing this at all". Every verdict is written down,
allows included: a gate that only recorded refusals cannot be told apart from a
gate that is not running.

**Source discovery.** `integrations/video/autopilot.ts` used to say, in its own
settings hint, that a `shorts` job needs a URL the autopilot has no way to
invent. It can now: `socialfeed/sourcing.ts` queries the owner's own SearXNG
node in its VIDEO category (its own transport, because the shared `ask()` drops
the two fields this needs — the engine's `length` and `author`), reads the REAL
duration and upload date of the top few with `yt-dlp --skip-download
--dump-single-json` (metadata only; nothing is downloaded), and ranks by
duration fit, recency where a date exists, and how many engines carried the
link. The rank is arithmetic and no model chose anything. Refused candidates are
KEPT with their reason, checked cheapest-first — not a usable address, then
already used, then outside the duration band — because somebody reading "already
used" wants that before "and also too short".

**UGC.** An optional `video` format. Reference pictures from `venture_assets`
→ a product-in-scene still from the Studio's image model (with the publishing
area's MEASURED image-input capability: a model with no image input gets the
references described in words and the job says so) → an animation from a
Replicate image-to-video model NAMED IN A SETTING WITH NO DEFAULT → a caption
burned on with the video area's own captioner → a DRAFT in the publishing queue.
With no model named the animation step is skipped, the job finishes with a still
and a sentence, and nothing is spent on video. That is deliberate:
image-to-video costs dollars a clip and prices differ by a hundredfold between
models, so a default would be a button that charges you the first time you press
it.

**Delivery.** A sweep every five minutes finds finished video runs THE AUTOPILOT
QUEUED that have no delivery row, files each as a draft and announces it on the
paired Telegram chat — or on nothing, when `deliverTo` is `off`, which switches
off the MESSAGE only because the draft is the half that makes an asset usable
and it is silent. One sweep at a time: the delivery row is written after the
message is sent, so the timer firing while the agent's own `deliver` action is
in flight would send the same message twice. A sweep rather than a completion hook in the executor:
idempotent by construction, survives a restart, and does not put a line in a
file four other areas are editing. A video the owner started by hand is one they
are already watching and is not delivered.

Tables (migrations 340–347): `social_posts` (platform + external id, the
metrics JSON keyed by Meta's names, `fetched_at`), `social_accounts` (per Page:
`last_ok_at` and `last_try_at` as two columns, because a failing Page keeps the
date it last worked, plus `error` and `insights_error` verbatim),
`source_candidates`, `content_history` (with `archived_at` — a row the owner
set aside, which the gate skips and every list still shows),
`novelty_checks`, `ugc_jobs`, `socialfeed_deliveries`.

`content_history.fingerprint` is a CACHE of a pure function of the topic, so
`onStart` re-derives any row that disagrees with the current algorithm — a
stale fingerprint is one the gate can never match, which would let a real
repeat through.

Routes: `GET /api/socialfeed/posts`, `POST /api/socialfeed/collect`,
`GET /api/socialfeed/sourcing`, `POST /api/socialfeed/discover`,
`POST /api/socialfeed/forget`, `POST /api/socialfeed/restore`,
`POST /api/socialfeed/deliver`,
`GET /api/socialfeed/ugc`, `POST /api/socialfeed/ugc/start`. The autopilot's own
document grew a `novelty` and a `sources` block, because "why was nothing
queued" is the question that page exists to answer.

Skills: `social-posts` (the metric names are the platform's; a metric that is
not a key was not reported; only mapped Pages are read; no Instagram account is
linked on this install, which is "not linked" and not "no posts"), `sourcing`
(a refusal is the feature working and is not a failure; a topic is compared over
a window and a source forever, both per venture; an archived entry is set aside
and not deleted; `durationFrom` decides how much a duration is worth), `ugc`
(the animation model has no default; starting a job spends money every time;
`imageField: null` means the references were words, not pictures). Three actions
are marked `destructive` — `ugc.start` because it spends and nothing refunds a
prediction, `sourcing.deliver` because it puts a message on somebody's phone,
and `sourcing.forget_topic` because it changes what the gate will let through.
All three entries declare `openWorld`: every action on them reaches Meta,
SearXNG and the video hosts, or Replicate.

Settings live on a config-only pseudo-plugin `socialfeed` under Integrations:
`posts`, `noveltyDays`, `repeatLimit`, `minMinutes`, `maxMinutes`, `probe`,
`channels` (one `slug = url` line per venture naming that business's own video
channel), `deliverTo` (`telegram` or `off`), `ugcVideoModel` (blank by default
and blank means the animation is skipped), `ugcSeconds`. No credential and no collector entry: every key this
needs is already in the vault under `meta`, `searxng` and `replicate`, and a
collector entry under `meta` would silently replace the one that reads the ad
spend.

Pages: Social media → Posts; Sources and History tabs on the Autopilot page; a
"Make a UGC clip instead" button on the Studio, which appears only for a venture
that has reference pictures.

## Web analytics: which audience changed, what they did, and which advertisement is spent

`/api/umami` publishes a site's five figures, a daily line and three top
twenties; `/api/meta` publishes an ad account's window and its campaigns. Both
are correct and neither can answer the question that follows the headline. This
area is that question, in four parts, and it adds no credential of its own — it
reads the ones the Umami and Meta plugins already hold.

**It is its own plugin id for three reasons, each of which is a trap this
codebase has already fallen into.** Collectors merge by plugin id, so an entry
under `umami` would silently replace the collector that keeps the headline
figures current and an entry under `meta` would replace the one that reads the
money. Settings merge by plugin id too. And the rotation needs a switch of its
own: a full read of one website is about fifty requests against somebody's own
analytics server, so the number of sites read per pass is a decision the owner
makes rather than a consequence of how many sites they have. `connected` means
"a Umami or a Meta account exists", derived on start and after every save.

**What the Umami HTTP API actually answers**, probed live on 2026-09-06 against
a self-hosted 2.x instance, because none of it is documented in one place and
two of the answers are traps:

    /metrics?type=…   country device browser os language screen city region
                      path title referrer query event tag      200
                      host url                                  400
    /events?event=<name>       raw rows; `count` is the OCCURRENCES
    /sessions?event=<name>     session rows; `count` is the PARTICIPANTS
    /event-data/fields         property names, types and totals
    /event-data/events?event=  per-event property VALUES with their totals
    /event-data/stats          how many events and properties exist at all
    /stats?event=<name>        200 WITH FIVE ZEROS — the filter is not honoured
                               on this build, and nothing here calls it

And what each `y` counts is not one thing. Summing every row of a metric and
comparing with `/stats` on three live sites: country, device, browser, os,
language and screen sum to the window's VISITORS (543/527, 1167/1164,
1883/1883 — the shortfall is sessions Umami dropped for a null field, published
as `unattributed`); referrer and query count VIEWS on a pageview-keyed metric,
which is not the window's pageview total. Every stored row carries the
population it counted, in words, and nothing adds the two.

Tables (migrations 310–316): `web_dimensions` and `web_site_windows` — seven
dimensions over three windows (30 complete days, the last 7, and the 7 before
those) with the site figures that are their denominators; `web_bot_findings` —
when a heuristic first saw a fingerprint, which is the one thing a read cannot
recompute; `web_events` and `web_event_props`; `web_utm`; `ad_sets`,
`ad_creatives`, `ad_days` and `ad_windows`; `campaign_ventures`; `web_clocks`.

**Bot diagnostics: four named heuristics, and nothing is ever subtracted.** The
adjusted figure is published beside the raw one, always, carrying the heuristic
id, the excluded population and the date this box first saw that fingerprint;
`/api/umami` still reports exactly what Umami said, and no stored row has been
reduced. The heuristics are `headless-screen` (a screen that is a known
headless default or square-ish, above a share and a volume bar, on a site
averaging at most 1.3 pageviews a visit), `country-surge` and `referrer-surge`
(five times the same value's previous week, past an absolute and a share bar,
excluding only the EXCESS), and `flat-single-view`, which excludes nothing at
all by design. Each publishes how it can be wrong. They are deliberately weaker
than the previous system's, and the reason is written into the code: the
previous system reads Umami's Postgres directly and can cross-tab a screen
against a session's pageviews and against a
country; this API answers one dimension at a time, so the pages-per-visit gate
is site-wide and says so in its own evidence. **Exclusions are never added.**
The populations overlap by an amount this API cannot measure, so the adjusted
figure subtracts the largest single finding and is stated as a floor on the
reduction.

**Events: participants beside occurrences.** On the connected instance
`checkout-started` fired 5,978 times in 4,434 sessions — a document publishing
the first as though it were people overstates that step by a third. The two come
from two endpoints and the one that answered is stored. A participant is a
SESSION IDENTITY, not a person: Umami hashes the site, the address and the user
agent. Numeric event properties get an exact count, sum, mean and range,
computed from Umami's complete value list as Σ(value × occurrences) — not the
mean of the distinct values, which would be a different and wrong number — and
refused outright rather than published short when a value will not parse. A
property's UNIT comes from a setting; `null` is published as "the unit was never
stated" and never as a currency somebody guessed.

**Campaign → site → venture, with each arrow named.** Spend, impressions and
clicks are joined BY CAMPAIGN ID and are exact sums of daily rows Meta issued.
Site traffic is joined BY NAME — the campaign's name against the `utm_campaign`
text the site saw, because Umami has never heard of a Meta campaign id — and it
is as good as the tagging was; a campaign with spend and no tagged views means
the links were not tagged, not that nobody arrived. Conversions are the events
the owner named for that venture. Revenue is VENTURE-LEVEL, from
`finance/attribution.ts` through a guarded dynamic import, over a calendar month
that does not line up with the ad window — so the ratio is labelled BLENDED
EFFICIENCY on every document and the word ROAS appears in no answer. The
mapping itself follows `venture-links`' contract: suggestions are recomputed on
every read from URLs in the campaign, its ad sets, its advertisements and its
creatives, and nothing is filed until somebody presses something; a campaign
that matched two ventures is `contested` with nothing applied.

**Ad level: the three rows `growth/ads.ts` says out loud it does not have.**
Ad sets, advertisements with their creative text and image, and a per-ad daily
series — plus `ad_windows`, which exists because fatigue cannot be computed
without it: reach and frequency are de-duplicated over the window Meta was asked
about, so a week's frequency is not derivable from seven daily rows at any
grain. The collector therefore asks Meta twice with an explicit `time_range`.
Fatigue is ONE shape — frequency rising while click-through falls — because a
rising frequency alone is a small audience and a falling click-through alone is
an auction; under a thousand impressions in either week there is no verdict at
all, and every row carries both weeks' figures so a reader can disagree with the
rubric. **Having ad set ids licenses nothing new:** learning status needs a
delivery-insights call this token has not been asked for and audience overlap
needs the targeting specification, so neither claim is made and a high frequency
is reported as its own finding.

Settings, on the `webanalytics` plugin page: websites per collection pass;
conversion events per venture (nothing in Umami says which event matters); a
site-reported revenue property per venture; and units for numeric event
properties.

Routes: `/api/webanalytics/sites`, `/segments/:websiteId`, `/events`,
`/events/funnel-inputs`, `/campaigns`, `/campaigns/:ventureKey`,
`/campaigns/link`, `/campaigns/unlink`, `/creatives`. Skills: `segments`,
`webevents`, `attribution`, `creatives` (packs `web-audience`, `web-events`,
`campaign-attribution`, `ad-creatives`). Page: SEO & growth → Web, with tabs
Segments · Events · Campaigns · Creatives and a bot-diagnostics toggle that
shows raw and adjusted together.

## SEO ops: what happened after the work, who is listed where, what the model sees, and what a page is actually painted with

Four things a one-person company does about a website that are not writing the
website. They share an area because they are one afternoon's work; nothing on
`/api/seoops` sums across them, and a directory row and a click are not the same
kind of thing.

**Follow-ups (`seo_baselines`, `seo_baseline_readings`, `seo_diagnoses`).** When a
board card carrying the SEO tag — `#seo` by default, one setting — is marked done
and names an http(s) URL, that page's Search Console row is captured over the
trailing 28 days: clicks, impressions, CTR, average position, the whole
property's totals for the same window, and its top 25 queries. The same row is
read again at 14, 28 and 56 days and the two are subtracted.

It is a SWEEP and not a hook on the board's move route. Hooking that would mean a
second author for the board's rules and a card missed by any other path into
Done. The sweep asks the table which finished cards look like SEO work and have
no baseline yet, so it is correct after any amount of downtime, and the unique
index on `(source, source_ref, url)` means running it twice leaves one baseline.

**The reading is a FILTERED query, not the stored ranking.** `providers/gsc.ts`
collects the top 25 pages of a property by clicks, which is right for "which
pages matter" and useless for "did the page I rewrote move" — that page is
usually not in the top 25, which is often why it was rewritten. So this asks
Search Console for the page directly (`dimensionFilterGroups` naming the URL, no
dimensions), which is exact and uncapped. When there is no credential, or Google
will not answer, it falls back to the stored ranking and the reading's `source`
says `stored-capped`: a floor, over a different window. **A page absent from
either is `measured: false` with the reason, never a zero.** A zero would
manufacture a catastrophic drop out of a report that simply stopped listing.

**The verdict is arithmetic; the diagnosis may be a model's.** `verdict` — up,
down, flat, thin, unmeasured — is a 15-rule table over the deltas with a 10% flat
band, the same band `chief/outcomes.ts` uses, and no model touches it. The
`diagnosis` is one of nine closed words (discovery, demand, ranking, snippet,
intent, content, conversion, cited-no-clicks, wait) and the same numbers are put
to a model, which may choose among the nine; its answer is thrown away whole
unless it is one of the nine *and* quotes a figure it was given. `decidedBy` says
which decided. No model is asked at all when the verdict is `unmeasured` or
`thin` — those are statements about whether there is anything to judge.

Every baseline also files a `chief_outcomes` row addressed at this area's own
`seo-followup?view=metric` document, so a tracked URL appears on the Outcomes tab
with the same figure, read once.

**Listings (`listing_ledger`).** One row per venture per directory over a curated
catalogue of 22 that ships as `integrations/seoops/directories.json` and is
merged with an owner's JSON in the settings — an entry replaces one by id,
`"drop": true` removes one, anything else is added. Six states: `not_listed`,
`pending`, `submitted`, `detected`, `confirmed`, `skipped`.

**Detection may only ratchet forward.** `signals/presence` probes nine sources
daily and changes its mind: a directory behind a WAF answers blocked on Tuesday
and a listing under an unguessable slug answers absent on Wednesday. So a probe
may move a row to `detected` and to nowhere else, and only from `not_listed`,
`pending` or `detected`; a row the owner touched is left alone and reported under
`held`. `detected` is EVIDENCE and not a tick — directories carry pages for
products that never submitted — and only `confirmed` means a person looked.
`submitted_at` and `confirmed_at` are stamped once and never restamped.
`skipped` is a first-class answer, and `donePct` is computed over the rows that
are not skipped. The previous system's broad `site:` search sweep is
deliberately NOT ported: its own header records that every metasearch backend but one lost to
CAPTCHAs and the one that answered returned Polish news for a `site:github.com`
query.

**Visual QA (`shot_vision`, `model_vision_probe`).** `security/shotsqa.ts`
decodes the PNG and computes a variance; its own header said a page that renders
perfectly and says the wrong thing passes everything there, and that asking a
model needed a capability flag to exist first. That flag now exists as a PROBE:
one 1x1 PNG through `models/provider.ts` (whose turns can now carry OpenAI
content parts), cached per provider and model. Three states — `true` accepted,
`false` refused, `null` the probe did not complete, which is not a `no`.

The verdict is `{ verdict: ok|broken|unsure, issues: [{ kind, where, confidence }] }`
and is validated whole or thrown away whole: a verdict outside the three, an
issue of a kind outside the nine, a `where` that names no part of the page or
hedges or writes an address, a confidence that is not a number in [0,1] — all
dropped, and a `broken` with no surviving issue is refused outright. A verdict is
reused when the capture's bytes hash the same, which is a unique index rather
than a cache. Opt-in per venture, empty by default: a vision call is a bill.
Shots QA reads the table and shows `visual` apart from `checks` — never counted
into `failed` or `unchecked`, because a column of arithmetic must not quietly
contain an opinion.

**Rendered brand (`brand_measured`, `brand_overrides`).** `ventures/enrich.ts`
parses the HTML and its stylesheets, and says what that costs: a colour is
counted whether or not anything is painted with it, and a palette applied at
runtime is invisible. This drives the browser `capture.ts` already finds — over
the DevTools protocol, because Chrome's command line can print a document and
take a picture and cannot run a line of script — and reads COMPUTED styles: the
resolved body and heading font stacks, the colours ranked by painted AREA, the
button backgrounds, the logo candidates, `:root` custom properties. Roles are
assigned by `enrich.ts`'s own `assignRoles`, so a rendered palette and a static
one mean the same words. It never touches `ventures.brand`; the venture's Site
tab shows all three readings and every field of `effective` carries the method
that produced it (`override` > `rendered` > `static` > `none`). Opt-in per
venture; static parsing remains the fallback.

**Routes.** `/api/seoops` (the four summaries), `/followups`, `/followups/:id`,
`/followups/candidates`, `/metric`, `/sweep`, `/followups/run`,
`/followups/:id/run|close`, `/listings`, `/listings/set`, `/listings/detect`,
`/vision`, `/vision/probe`, `/vision/run`, `/brand/:venture`,
`/brand/:venture/measure`, `/brand/:venture/override`, `/entities`,
`/vocabulary`. Every boolean on a write is parsed strictly and refused with a 400
when it cannot be — the skills proxy sends every parameter as a string, and a
vision pass spent because a flag arrived as text is exactly the failure that rule
is for.

**Skills.** `seo-followup`, `listings`, `visualqa`. Settings live on a
config-only pseudo-plugin `seoops`: the tag, the offsets, the two opt-in venture
lists and the directory JSON. The nightly work registers as a pipeline stage
(`seo-ops`, after `collect`) through a guarded import, and falls back to a
six-hourly timer where no registry exists; a dry night reports the counts and
spends nothing.

## Video extras: a walkthrough reel, motion graphics without a render toolchain, and shorts that measured something

`integrations/videoplus/` adds two formats to the `video` run kind and three
measurements to the one that already existed. It is a separate area with its
own config plugin because `manifestConfig()` merges settings BY PLUGIN ID: keys
written here under `video` would have replaced the video area's own entry and
its encoder paths would have quietly stopped being settable.

**`reel` — a walkthrough of the venture's own pages.** Chrome renders each
address into one very tall picture (`reelPageHeight`, default 3600px), a model
writes a two-hander from the venture record and the pages' own text — given to
it as UNTRUSTED reference material — and ffmpeg pans a 1280×800 crop down each
picture over the length of the lines that sit on it. **The scroll is not a
recording**: there is no browser-recording API on this box and no DevTools
client in this project, so it is arithmetic, which cannot drop a frame. The
cost is on every run: a page whose layout responds to viewport HEIGHT is drawn
as it would look in a very tall window, which is not what a visitor sees. **The
addresses come from the owner's form or from the venture record and never from
the model** — a model that could choose the address could make this box fetch
anything. A reel is always letterboxed whatever the form's `fit` says, because
a centre crop of a web page throws away the outer 40% of every screen. Two
roles speak; with fewer than two names in `reelVoices` there is ONE voice and
the guest's lines are the same voice pitched down a tone by ffmpeg, which the
run says in a sentence. With speech off the reel is silent, the lines are
captions, and the shot lengths are ESTIMATED from the word count rather than
measured — also said.

**`motion` — animated typography from a scene spec, and no Remotion.** A spec is
four to eight scenes of kind `title | stat | compare | list | cta`, each with
its own seconds, stored in `motion_specs`. The templates are hand-written CSS in
one self-contained page; every animated element is `animation-play-state:
paused` with `animation-delay: calc(-1s * var(--t))`, so a frame is EXACTLY the
state the animation would have had at *t* and the same spec always draws the
same pixels. A sheet is many copies of the scene side by side at different `t`,
screenshotted in ONE browser launch and cut back into frames by ffmpeg's
`untile` — eight frames per launch, because a launch costs about 2.6 s on this
machine and a frame costs almost nothing once the page is up. The colours and
the typeface come from the venture's measured brand at render time, and the run
says whether they were measured or derived. The validator CLAMPS rather than
argues (a long heading is cut, a nine-item list becomes six, a scene past the
ceiling becomes the ceiling) and returns every change as a sentence; a scene of
an unknown kind is the ONE hard refusal, because rendering it as a different
kind would be making a different video. `GET /api/motion/:id` reports the frames
and browser launches a render would take before anything is pressed.

**`shorts`, now measuring three things it used to guess.** Word timings from a
local whisper (`whisper` + `whisperModel`; nothing here downloads a model, and
with no model there are no word timings and the run says so). Scene cuts from
`select='gt(scene,T)'` with `metadata=print`. And a crop window that FOLLOWS the
horizontal centre of measured motion — the source is sampled at 4 fps into
64×36 greyscale, consecutive frames are diffed, the centroid is smoothed and
speed-limited, and the path becomes a `crop` expression in `t`. **There is no
face detection on this box** and `videoplus_clip_framing.detector` never claims
one; a speaker who sits still while a slide changes behind them is the case it
gets wrong, and `mode: fixed` carries its own limitation on the page. A model's
windows are now snapped at most 1.5 s onto the nearest cut and word boundary and
trimmed to the last word that finished inside them. `chosen_by` has six values
in descending order of what was known — `transcript`, `words`, `speech`,
`density`, `scenes`, `spacing` — and the last three are cuts rather than
highlights.

**Tables.** `motion_specs` (330) — one row per saved scene list, with its scene
count and length as columns so a list of thirty is not thirty JSON parses. No
colours are stored: they come from the venture at render time.
`videoplus_clip_framing` (331) — how each shorts clip was framed, what measured
it, over how many samples, and how far the crop travelled.

**Routes.** `GET /api/motion` (specs + a three-capability readiness block),
`/templates`, `/:id` (with the render's cost), `/:id/preview` (draws the first
frame of every scene in one browser launch, at a third of the size, with the
real renderer), `/:id/preview/:index/image`. `POST /api/motion` saves,
`/draft` asks the model for one, `/:id` updates, `/:id/render` queues a `video`
run, `/:id/delete` removes it.

**Skill.** `motion` — views `default`, `templates`, `one`, `preview`; actions
`draft`, `save`, `render`, `delete`. Its rules say that a spec's `seconds` is a
plan and never a measurement, that a stat card is a claim in 200-point type that
this box cannot check, that `problems` is a list of what was CHANGED, and that
nothing here publishes anything. The `video` skill's rules gained the six
`chosen_by` values, the tracked-versus-fixed distinction, the reel's scroll
method and its one-voice case.

**Settings** live under the `videoplus` plugin: `motionFps`, `motionScenes`,
`motionSceneSeconds`, `motionSeconds`, `reelVoices`, `reelPages`,
`reelPageHeight`, `whisper`, `whisperModel`, `sceneThreshold`, `tracking`,
`visionModel`.

**Two refusals worth knowing about.** A reel's addresses are checked against
`isPrivateHost` plus link-local and `0.0.0.0`, and an address inside this network
is dropped with a sentence: everything a reel captures goes both into a prompt
sent to a model provider and into an mp4, so `http://127.0.0.1:8787/api/plugins`
would publish this box's own API responses. When every typed address is refused
the run FAILS rather than quietly substituting the venture's website. And
`video.ytdlpArgs` now refuses `--exec`, `--exec-before-download`, `--downloader`
and `--external-downloader` — at the save AND at the point of use, since a value
written before the check existed never went through it. It is a guard rail, not
a boundary, and the hint says so.

## The board: the first table here that is not a transcript

Every other route on this server is a window onto something a collector
fetched. A row in `hetzner_servers` is replaced the moment the next collection
disagrees with it, and the worst a bug can do is show a stale number. The board
is the other kind of table: **a card exists nowhere else until somebody types
it in**, and losing one is losing work. Nothing collects it, nothing overwrites
it, and there is no provider behind it.

`GET /api/board` answers with columns, each carrying its own cards in order and
its own count — and **so does every mutation**. That is the whole contract, and
it is the same one the previous system used. The reason shows up under a drag: a move changes a card's
column, its position, its `updated_at` and possibly its `done_at`, and, because
positions are shared, it can change cards nobody touched. `{ ok: true }` would
leave the page to work all of that out; "the card as it now is" would leave it
to work out the rest of the column. Handing back the document means the
client's next state is not derived from anything — it *is* the answer, applied
whole. Five columns and a few dozen cards is a few kilobytes.

### Positions are sparse integers, and that is the point of the schema

The obvious design is a dense `0..n-1` per column. It is also the one that
turns every drag into a rewrite of two columns: pulling a card out of the
middle of Backlog renumbers everything under it, and dropping it into the
middle of Doing renumbers everything under that. Twenty cards moved one place
to express one intention, every time anybody drags anything.

Cards are numbered in steps of **1000** instead. A move is one `UPDATE`: the
new position is the midpoint of the two neighbours it landed between, and the
neighbours do not move. Nothing outside the table means anything by 3000 rather
than 3 — the board is read `ORDER BY position`.

The cost is that a gap eventually closes: dropping into the same slot halves
the interval each time, and after about ten drops there is no integer left.
That column is then renumbered back to 1000, 2000, 3000 — the dense design's
cost, paid once every ten drops into one gap instead of on every drag. Floats
were the other way out and were declined: doubles run out of mantissa in the
same shape, silently and later, and an `ORDER BY` comparing
`3.0000000000000004` with `3.000000000000001` is a bug nobody will find.

**The columns themselves are dense, `0..n-1`.** There are five, they are
reordered about once, and rewriting five rows is not worth a scheme. Sparse
where the writes are, dense where they are not.

### A move names a neighbour, not an index

`{ columnId, before }` — "that column, above that card", with `before: null`
meaning the foot of it. The previous system sends `{ column, index }`; both keep the order
on the server, which is the part that matters, and the difference is what
happens when the client's copy is a few seconds old. An index of 3 means a
different slot the moment anything has been inserted, and it silently means
*something*, so a stale drop lands in the wrong place and reads as a misfired
drag. A card id either still names a card in that column or it does not, and
this route answers 409 with a sentence rather than guessing. It is also what
lets the page stay draggable while a venture filter is on — a hidden card
cannot make "above that card" mean somewhere else.

### Done is a column and a timestamp, kept in step by the move

Arriving in the `done` column stamps `done_at` if it has none; re-ordering
*within* Done leaves the stamp alone, because tidying a column is not
finishing something twice. Leaving Done clears it — a card back in Doing is not
a finished card with a date on it, and a stale stamp is exactly what a later
report would count.

### Two structural columns, five seeded, none deletable

`backlog` and `done` are structural: the first is where a card with nowhere
else to be lands, the second is the one whose name is a claim about the card.
Both can be **renamed** — a board that calls its first column "Someday" is
still a board — which is why `key` (what the code means) and `title` (what the
eye reads) are two columns. Neither can be deleted, and today nothing can:
there is no create-or-delete route for a column at all. That is a real design
decision left unmade (what happens to the cards in a deleted column), and a
stub answering 501 would be a promise this file cannot keep.

### A WIP limit is reported, never enforced

The document carries `overLimit`; no move is refused because of it. A limit is
something the owner set in order to be told about, and a board that physically
refuses a drop teaches you to drag the card somewhere dishonest instead — the
work is still started, the board just stops describing it. `null` is no limit
and `0` is a column nothing should sit in, and they are different answers.

### Ventures are not stored here

A card carries `venture_id` and nothing else. Ventures live in the browser's
own store (`client/src/lib/store.tsx`), mirrored to localStorage; this server
has never seen one, so the document cannot carry a name or a colour and does
not pretend to. There is no foreign key, and a card whose venture has since
been deleted keeps an id that resolves to nothing — the page draws it as
unfiled and says so in the dialog, which is better than a chip labelled with a
business that no longer exists.

### The seam for cards nobody typed

`board_cards.origin` is nullable, uniquely indexed, and **never written**. It is
the derivation's own id with a namespace on it — `issue:disk-dell` — and the
unique index is what would make an automatic filer idempotent: a sweep that
runs twice leaves one card rather than two. `fileCard()` in `routes/board.ts`
is the twenty lines that would use it, exported and called by nothing.

That is the entire seam. The previous system's board has a backlog filer, an issue ranking
and a gardening sweep writing into it; none of that is ported, because those
cards are derived from collectors reading other people's systems and **these
cards are the owner's**. A board that fills itself is a different product
decision, and this leaves the schema right for the day it is made rather than
making it.

## Chat streams, and a half-answer is a stored fact

`POST /api/chat` is unchanged and is not deprecated — Telegram has no growing
bubble to render into and wants one document when the answer is done.
`POST /api/chat/stream` is the other shape: SSE, one event per thing that
happened, with the contract written out in full at the bottom of
`routes/chat.ts`.

The objection that kept streaming out of this codebase was never the wire. It
was that a stream which dies half way has already put half an answer on screen
and there is no truthful way to store that as a message. That is answered in the
schema rather than avoided: `019_chat_tools` adds `partial`, and the rule is
that **exactly one assistant row is written per turn, at the end** — complete,
or flagged and honest about it. Nothing is written while the deltas are flowing,
because a row that is briefly three words long is a row the other door can read
mid-sentence.

Tool calls ride in a `tools` JSON column on the same row rather than in a
`chat_tool_calls` table. They are a rendering artefact of one message: read when
that message is read, never joined, never aggregated, and their order is
load-bearing. A table would need a sequence column to get the order back, a
foreign key onto an `AUTOINCREMENT` id, and a second write inside the turn that
must not half-succeed — three moving parts to make a query nobody runs faster.

`GET /api/chat/sessions` lists every session id that has messages, with counts,
timestamps and a title derived from the first user turn. There is still **no
`chat_sessions` table**: sessions are the client's idea, it renames them, and a
table here would make two authorities on one name. What the server is the
authority on is which ids have rows, and that is what this answers.

A stream gets two deadlines instead of `ASK_TIMEOUT_MS`, because the reason for
a sixty-second budget — a page spinning on nothing — does not apply when words
are arriving the whole time. What is actually wrong with a stream is silence, so
there is an idle timer that resets on every frame (90s) and a hard cap for a
runaway agent (10m). Both abort the same controller, and the error says which
fired.

**A keepalive comment is activity.** Hermes writes `: keepalive` every thirty
seconds while its model is still thinking, and an SSE comment is not a frame —
so a reader that only counted frames saw a long first-token wait as a dead
agent. That is exactly what happened on a 97,000-token conversation: the model
was still working at ninety seconds, the timer fired, and the answer was lost.
`readSse` now reports every chunk through `onActivity`, comment or not, and
`sse.test.ts` pins that down. Silence still means silence; thinking no longer
does.

## Security: a lock on the door, snapshots, screenshot QA and the workstation

Four things that are all about THIS BOX AND THE MACHINES AROUND IT rather than
about a business. `integrations/security/`.

### The lock, and what it is not

`/api` had no authentication at all. That is the right default for a service
bound to 127.0.0.1 and it stops being right the first time somebody puts this
behind a tunnel, a reverse proxy or a `--host` flag. So there is now an
OPTIONAL owner password, and the important property is the word optional:
`security_owner` empty means the middleware in front of `/api/*` passes every
request through untouched — not "an empty allow list", not "a check that always
passes". A box that never opens the Security tab behaves in every respect
exactly as it did before this existed, which was verified first and last.

**Running this behind a reverse proxy?** A proxy in front of the dashboard
**must forward the `Origin` header** — without it the owner cannot log in or
change the password, and there is no CLI fallback. See the repo root
`README.md`'s "Deploying behind a reverse proxy" section for the two
conditions and the recovery command (`DELETE FROM security_owner WHERE id = 1`
and a restart).

**IT IS ONE PASSWORD, ONE OWNER, AND IT IS NOT A USER SYSTEM.** No accounts, no
roles, no per-venture permissions, no record of who did what — because there is
one owner and every route here was written for that owner. It is a latch on a
front door, not a security desk in a lobby. Anything that describes it as access
control is describing something this app does not have.

- `security_owner` — one row, `id` pinned to 1 by a CHECK so the second INSERT
  fails loudly rather than letting a half-built multi-user system exist. scrypt
  from `node:crypto`, per-owner salt, N=32768. The hash sits in a database file
  the nightly backup copies to wherever the owner pointed it, which is the real
  threat model for a password on a personal box.
- `security_sessions` — one row per browser with a public ID and a separate
  random cookie token. Only the token's SHA-256 hash is stored. Revocation,
  30-day absolute expiry and seven-day idle expiry are enforced on the server.
  `last_seen_at` is touched at most once a minute. The token migration revokes
  sessions created by the old format.

Routes: `POST /api/security/password` (set, or change with the old one
required), `DELETE /api/security/password` (requires the current one),
`POST /api/security/login`, `POST /api/security/logout`,
`GET /api/security/status`, `DELETE /api/security/sessions/:id`. Changing or
removing the password takes a live session AND the password — two facts, because
a browser left open on a desk is one of them. Changing it revokes every session,
which is the only thing that makes changing a password mean anything.

The cookie is HttpOnly, SameSite=Strict, Path=/, and deliberately NOT `Secure`:
this is served over plain http on loopback and a Secure cookie there is silently
dropped, which presents as a login that succeeds and changes nothing. That flag
requires deliberate configuration if this ever goes behind TLS. Login sets the
token only in the cookie. `GET /api/security/status` returns public IDs for
revocation; those IDs cannot authenticate a request.

Open even with a password set: `GET /api/health` (a liveness probe carrying no
data about anything, which `cli/restore.ts` checks so it can refuse to overwrite
a live database), `POST /api/security/login`, `GET /api/security/status` (the
login page has to be able to ask whether there is a lock before drawing a form),
and `POST /api/security/logout`. Everything else is behind it. A preflight
OPTIONS never reaches the gate — the CORS middleware answers it — which is why
the one `app.use` line in `index.ts` is placed after CORS.

### The service key — what keeps the agent working

`server/data/service-key`, 0600, 32 random bytes as hex, minted at start-up.
Nothing on this box that reads its own API has a browser: `opc` is a shell
wrapper, the MCP server is a subprocess on a pipe, the skills proxy is this
process calling itself, a run's brief is six loopback fetches. Every one of them
would 401 the moment a password existed. So `auth.ts` exports `serviceHeaders()`
and every in-process caller sends it — unconditionally, even with no password
set, because a header added only "when auth is on" is a header whose absence is
discovered at the worst possible moment.

The call sites, all of them: `routes/skills.ts` (the view proxy and the action
proxy), `integrations/runs/context.ts`, `integrations/ventures/entities.ts`,
`integrations/proactive/catalogue.ts` (×2), `integrations/proactive/engine.ts`,
`integrations/proactive/briefing.ts`, `integrations/chief/outcomes.ts`,
`cli/opc.ts` (×3, from `OPC_KEY`), `skills/mcp.ts` (×3, from `OPC_KEY`),
`skills/spawn.ts` (puts `OPC_KEY` in every MCP child's environment) and
`skills/cli.ts` (the `opc` wrapper). The wrapper reads the file with `$(cat …)`
at EVERY invocation rather than baking the key in, so rotating the key is
replacing one file — nothing is rewritten and no agent is restarted — and the
wrapper's own text, which sits in the agent's home directory at 0755, contains
no credential. `providers/hermes.ts` needed nothing: it talks to the Hermes
gateway on 8645 and never to `/api`. The Telegram bridge needed nothing for the
same reason.

The service key grants broad API access, with explicit exceptions: mail
approval/sending/delivery resolution, owner authentication/session changes and
usage-limit changes require owner browser authority. The key cannot remove the
password. Set the password before enabling agents. Unrestricted code under the
same OS account can still read the vault key or modify the database; separate
OS isolation is required for hostile agents.

One honest limit: an agent that composes a RAW HTTP request to
`http://127.0.0.1:8787/api/skills` — which `runs/kinds.ts` tells it exists —
gets a 401 with a password set. The doors that carry the key are `opc` and the
MCP servers, which is what both managed agents actually use.

Client: `/login` (shown when `lib/api.ts`'s `call` sees a 401, once, with where
you were in `?next=` — checked to start with a single slash, because an open
redirect on a login page is a real one), and Settings → Security for the
password, the sessions and the revoke.

### Server snapshots — an instant, not a trend

`fleet_samples` is a dozen numbers per box every half hour, read as a line. That
is the wrong shape for the question asked at three in the morning: WHAT was
eating the CPU, WHAT was listening, what did the log say just before it stopped.
Sampling those on a schedule is sixty rows per box per half hour to answer a
question asked twice a year. So a snapshot is taken ON DEMAND, or when something
already went wrong, and kept whole in `security_snapshots` (account, host, ts,
reason, one JSON document, size, ok).

It reuses the fleet plugin's ssh — `ssh()`, `parseSsh()`, `writeKeyFile()`,
`sshProblem()` imported, not reimplemented — and adds no credential: it can
snapshot exactly the boxes already connected under Fleet. One POSIX sh script
per capture, printing SECTIONS rather than JSON: a snapshot is fifty lines of a
journal and a `ps` line with a whole java command in it, and one malformed byte
would lose the entire document to a parse error. It reads: the top fifteen
processes by CPU and by memory from ONE `ps` (two calls would be two instants),
listening sockets via ss/netstat/lsof, the count of established connections,
`df -Pk`, the last fifty lines of journalctl or syslog if readable, and
`docker ps`. Every section names the tool that answered it, so an empty list is
never mistaken for "nothing is listening".

Routes: `GET /api/snapshots?host=`, `POST /api/snapshots/:host/now`,
`GET /api/snapshots/:id`. A refused ssh is a 200 with `ok: false` and the reason
— "the box would not answer at 03:12" is the finding, and a 502 would lose it.

**THE AUTOMATIC TRIGGER**, an `onStart` timer every five minutes: uptime checks
that failed AND whose previous check for the same host had succeeded — the
transitions, not the ongoing outage. A failing host is mapped to boxes through
`venture_links`: a host and a box that share a VENTURE are related. That is the
owner's own statement, and it is the only join used; matching hostnames or
resolving DNS would mean ssh'ing into somebody's server because an unrelated site
went down. At most one automatic capture per box per hour. A failing host linked
to no box produces nothing and logs why.

### Screenshot QA — a run kind that asks no model

`ventures/capture.ts` photographs every venture weekly and its success test is
"did Chrome write a file", which is right for what it does and cannot tell a
homepage from a 502: Cloudflare's error page renders, and Chrome writes a
perfectly good PNG of it. `shotsqa` is a RUN KIND (`runs/kinds.ts`, one branch in
`executor.ts`) that looks at the pictures. It is a run because decoding a dozen
PNGs is seconds of CPU that must not sit inside a request, and because the queue,
the ledger and an addressed report are worth having — not because a model
answers, since none does.

Six checks with THREE verdicts each — `pass`, `fail`, `unchecked` — and
`unchecked` is never a pass: a capture exists, sensible dimensions, not a blank
rectangle, no error wording in the page title, nothing insecure in the latest
audit, recent enough to believe. The blankness check decodes the PNG in-process
with `zlib.inflateSync` and the five PNG filters (about sixty lines, no
dependency, works on a Pi with nothing installed) and computes a luminance
standard deviation and a dominant-colour share over every ninth pixel. Interlaced
files, bit depths other than 8 and palette images are reported as `unchecked`
with the reason — Chrome writes none of those, so a file that is one of them is
worth being told about. Rows go in `security_shotsqa`, one per venture per pass;
the markdown report is on the run.

**NO VISION MODEL, AND THAT WAS CHECKED RATHER THAN ASSUMED.**
`models/provider.ts` has no capability flag: a provider declares an id, a label,
endpoints and a concurrency policy, and nothing on this box says whether the
model behind it can accept an image. So nothing is sent one. That is stated in
the report, on the route and in the skill's rules rather than left for a reader
to wonder about.

### The workstation — one account, one desk machine

The plugin is `workstation`: `host` (user@host), and optionally a key, the MAC
address of the WIRED adapter, and a broadcast address. It is not a second fleet
box, and the difference is what "not answering" means: a server that is off is an
incident, a desktop that is off is a desktop. So an unreachable machine keeps its
account connected, the collection SUCCEEDS, and the panel says asleep. Verify has
the matching rule: an ssh that fails with a MAC on file is ACCEPTED with a note,
because the expected state is off; with no MAC it is refused, since at that point
nothing about the account could ever work.

Routes: `GET /api/workstation` (state read LIVE on the request — a figure from
half an hour ago is the wrong answer to "is it awake" — plus the collector's
history), `POST /api/workstation/:id/wake`, `.../sleep`, `.../shutdown`. Wake is
a magic packet over `node:dgram`: six 0xFF bytes and the MAC sixteen times, sent
three times because UDP to a broadcast has no retransmission. **Nothing
acknowledges a magic packet**, so the answer is that it was SENT and never that
the machine woke. `workstation_state` records reachability every cycle; `gpu` is
JSON from `nvidia-smi --query-gpu=…` or NULL with a reason in `gpu_note` — never
"no GPU" and never zero.

Sleep and shutdown run a command the OWNER TYPED into the plugin's settings.
There is no per-OS fallback in code: whether suspending needs sudo is that
machine's own policy, and a route composing a privileged command from a table is
one bug away from halting the wrong machine. With nothing set, the route refuses
and names the documented command (`systemctl suspend`, `pmset sleepnow`,
`acpiconf -s3`, and their shutdown counterparts) so there is something to paste.
A machine going down usually kills the ssh connection before the shell reports a
status, so a non-zero exit is not evidence of failure and the answer says so.

### Skills

`security` (pack `dashboard-security`) — the state of the lock, NO actions at
all: the skills proxy carries the service key on every call, so an action that
could remove the password would be an agent unlocking the box it is standing in.
`snapshots` (`server-snapshots`) — views `default` and `one`, action `take_now`;
the first rule is that a snapshot is an instant and two of them are two moments
with nothing measured in between. `shotsqa` (`screenshot-qa`) — the last pass,
action `run_now`; the first rule is that `unchecked` is never a pass.
`workstation` (`workstation-power`) — the live state, actions `wake` and `sleep`;
`shutdown` is a route and not a published action.

## Deploy: how this app runs when nobody is watching

Every other area in this file measures a business. This one is about the
machine underneath: whether the process is supervised, whether it is healthy,
how often each source is collected, how separated the agent is from the
credentials this process holds, and who is using a shared GPU.

It closes three gaps from the comparison against the system this replaces — unattended installation and
service supervision (#42), OS isolation for agents (#1), and shared GPU/power
ownership across jobs (#45). It has **no credential and no collector**: nothing
here talks to a vendor, so there is nobody to hold a key for.

### The service

`server/src/integrations/deploy/service.ts` generates supervision for the
platform it is running on and installs it into the CURRENT user's account —
never root, never `/etc`, never `/Library`.

- **macOS**: a launchd user agent at `~/Library/LaunchAgents/com.opc.server.plist`,
  `RunAtLoad`, `KeepAlive: { SuccessfulExit: false }` and `ThrottleInterval 30`.
  `KeepAlive` is a dictionary and not `true` on purpose: `true` restarts the
  process whatever happened, including a deliberate stop and including a config
  error that exits immediately, which launchd then retries forever.
- **Linux**: a systemd user service at `~/.config/systemd/user/opc.service`,
  `Restart=on-failure`, `RestartSec=30`, `StartLimitIntervalSec=600` and
  `StartLimitBurst=4`. The predecessor's units learned that the burst counts
  every start; with one long-lived unit rather than nine oneshots the arithmetic
  is simpler, and a unit that has failed four times in ten minutes is left
  failed rather than looped.

Both log to `server/data/logs/opc.{out,err}.log` and read `deploy/opc.env`
through `OPC_ENV_FILE`. That file is created once and **never overwritten** — it
is settings, and settings a person wrote are not something a tool replaces. It
holds paths and numbers; no credential goes in it, and a test asserts that.

Two platform limits are documented rather than worked around: a launchd *agent*
runs only while the user is logged in (a LaunchDaemon is root and a different
conversation), and a systemd *user* service stops at logout without
`loginctl enable-linger`.

`server/src/cli/install.ts` is `npm run install-service` /
`uninstall-service` / `service-status`. Its default is a **dry run** —
the unit and the env template into `deploy/out/`, printed, nothing installed —
and `--install` is the second, explicit decision. The CLI and the route call the
same generator, so the file somebody reads is byte-for-byte the one either door
installs.

### Health

`GET /api/health` kept every field it had (`ok`, `now`, `collectors`,
`collectEveryMinutes`) because `cli/restore.ts` fetches it to refuse to
overwrite a live database, and the owner gate lets it through with no
credential for that reason. `ok` therefore still means only "this process
answered". The verdict is the new `status`, over five checks:

| check | what it reads | fails when |
|---|---|---|
| `database` | one query plus `PRAGMA quick_check` | the file will not open or the check does not say `ok` |
| `migrations` | the `migrations` table against `INTEGRATION_MIGRATIONS` | the build is newer than its database |
| `collectors` | the `runs` table against each source's own cadence | a connected source has not started for 3× its cadence (never-run is a `warn`) |
| `gateway` | `agents/instance.ts`, dynamically imported to avoid a cycle | an agent set to autostart is not running |
| `disk` | `statfs` on the data directory | under 1 GB free; `warn` under 5 GB |

Every threshold used is in the check's own `measured` object as well as in its
sentence, so a reader can disagree with the verdict.

THE DETAIL IS BEHIND THE LOCK AND THE LIVENESS IS NOT. `/api/health` is on the
gate's `OPEN` list because `cli/restore.ts` uses it to refuse to overwrite a
live database. That was fine when the document was four fields; it now carries
absolute paths, the database's size, free and total disk, missing migration
names and the gateway's verbatim last error — a description of the machine,
served to anything that can reach the port. So once a password is set, an
unauthenticated caller gets `ok`, the time and `status: null` ("not run for
you", not "passed"). With no password nothing is withheld, which is the shipped
state and what the doctor and the dashboard see.

### The collection schedule

The collection scheduler lives in `deploy/scheduler.ts` as a plain interval
rather than cron, because a missed tick while the laptop was asleep is then
the next tick and not a backlog. The timer fires every **minute**, and each source is
collected on **its own cadence** — `collect_interval_minutes`, one setting added
to every plugin that has a collector, from one line in `routes/pluginConfig.ts`.
Empty means the box default (`OPC_COLLECT_MINUTES`); `0` means never on a
schedule and the Collect button still works. A box that sets none of them
behaves exactly as it did. "Last run" is read from the `runs` table rather than
kept in memory, because this process restarts on every source edit and an
in-memory copy would re-collect everything at once after each one.

### Agent isolation

`deploy/isolation.ts` reports a **measured** level and never an intended one.

- `same-user` — the shipped state. The gateway gets a built environment (a
  PATH, a HOME inside `DATA_DIR`, a locale, nothing else), an empty working
  directory of its own at `server/data/agent-home/<agent>/` rather than the
  agent's install root, and only the scoped key. The API boundary holds; the
  filesystem one does not, and the page says so in those words.
- `separate-user` — with `OPC_AGENT_USER` set (environment wins over the
  setting) `agents/instance.ts` spawns through `sudo -n -u <user> -H env …`.
  `-n` rather than a prompt: this process has no terminal, and sudo's own error
  in the agent log is the right failure. `deploy/agent-user.sh` is the one-time
  setup and prints its whole plan before `--apply`.
There is no third level, and that is deliberate. A container is genuinely
stronger — `deploy/agent.Dockerfile` and `deploy/agent-compose.yml`: only the
gateway, nothing mounted — but nothing here builds it, starts it or looks to see
whether the gateway is a child of this process, so there is no measurement to
report and `container` was removed from the union rather than left as a value
no code path produces. It is reported as `containerPath`, whose `observed` is
typed `false`. That path also needs the API reachable from a container, which it
is not: `index.ts` binds `127.0.0.1` on purpose, and the compose file's header
sets out the two real options and what each costs.

`deploy/agent-user.sh` grants exactly two commands with exactly their arguments
(`hermes gateway run`, `openclaw gateway run`) through a `visudo`-checked
sudoers file, with `env_keep` for six named variables. An earlier version
granted `/usr/bin/env` — which, with unconstrained arguments, is "run anything
as that user" — because the spawn prefixed the command with `env`; the spawn now
invokes the gateway directly so sudo can be held to it. The script also leaves
the scoped key **owned by you** and group-readable, rather than chowning it to
the agent: the API has to be able to rewrite that file and the agent only has to
read it.

**The owner surface** is the half that works at both levels. `auth.ts` mints a
second key file, `agent-home/service-key.agent` (0640 — the API writes it, the
agent's `opc` wrapper reads it, and at `separate-user` those are two uids), and
`keyScope()` tells the two apart in constant time against both.
`integrations/security/gate.ts` then refuses a small set of prefixes —
`/api/plugins` writes, all of `/api/backups`, and writes to `/api/security`,
`/api/agents`, `/api/models`, `/api/freellmapi`, `/api/searxng`,
`/api/workspace`, `/api/setup` — **unless the caller can show it is the
owner's**: the owner key, a live session, or a browser-shaped request (a
loopback `Origin`, or `Sec-Fetch-Site: same-origin`).

**The inversion matters.** The first version refused a caller that *presented the agent key*, which left
the case the boundary exists for wide open: an agent with a shell simply omits
the header, and on a passwordless box — the shipped state — walked through. So
the question is now "prove you are the owner" rather than "did you volunteer a
key you did not have to". A request carrying `x-opc-via: skills` fails that test
whatever key it holds, which closes the other hole: the skills proxy re-issues
an agent's call with the OWNER key, so a skill entry pointed at an owner-surface
path would otherwise have laundered it.

The browser test is a **heuristic** and the code says so where it is defined:
anything that can open a socket can set those headers. It raises the bar from
"send nothing" to "deliberately impersonate a browser", and at `separate-user`
the process on the other side of that bar also cannot read the owner key. The
check runs **before** the password check, because it is about what a child
process may do and is true on a box with no password.

`skills/cli.ts` and `skills/spawn.ts` hand out the scoped key; every in-process
loopback call still uses `serviceHeaders()` and is unaffected. `agentKey()`
cannot throw — `keyScope()` calls it on every credentialled request, so an
EACCES there would turn one wrong `chown` into every keyed request answering
500; it falls back to a process-local secret, which locks the agent out (the
safe direction) and reports itself as `agentKeyProblem` on the isolation report.
It is a deny list rather than an allow list because the allow list already
exists in `skills/registry.ts`; this is the second lock for the case that
registry cannot cover, which is that an agent has a shell and a shell can curl.

### Leases: who is using a shared machine

`deploy/leases.ts` redoes the previous system's own session-lease tracker as a
table rather than a Map, because this process restarts several times an afternoon and an in-memory busy
flag would be cleared under a forty-minute render. The price is that a lease
**expires**: every one carries a deadline, a long job pushes it forward with a
heartbeat, and a crashed job stops holding the machine after at most the TTL
(10 minutes by default, 240 maximum). Nothing has to fire for a lapsed lease to
stop counting, which means nothing can fail to fire.

A lease is **not a lock and not a queue**. `acquire` never refuses; two live
leases on one resource mean two jobs are sharing it. The single thing a live
lease blocks is putting that machine to sleep.

`wake_ownership` is one row per resource and keeps the predecessor's rule: we
power off exactly what we powered on. `POST /api/workstation/:id/wake` reads the
machine's state **before** it sends the packet, because ownership is decided by
what was true at that moment and asking afterwards could not tell the two apart.

UNREACHABLE IS NOT ASLEEP. `readState` now classifies a failed ssh as `silence`
(a SYN nothing answered — timeout, no route, host down, which is what a sleeping
machine looks like) or `refused-or-broken` (a rotated key, a changed host key, a
name that does not resolve, an sshd that answered with RST — every one of which
is compatible with a machine that is wide awake and busy). Only `silence`
becomes `asleep` and claims ownership; the rest is `unknown` and owns nothing.
Reading them all as sleep is how this app came to believe it could power off a
machine it never woke.

A CLAIM ALSO EXPIRES. `WAKE_OWNERSHIP_HOURS` is twelve: a desk machine woken at
nine and still up at nine is up for whatever has been done on it since, and a
row from a fortnight ago asserting otherwise is the same failure by a slower
route. Nothing fires at twelve hours — the row is simply read as expired, which
is the argument the lease TTL makes. Ownership is also released after a
**successful** sleep or shutdown, which is weaker than it sounds and the code
says so: a machine going down usually kills the ssh channel before the shell
answers, so most successful sleeps do not clear it and the expiry catches the
rest.

`sleepCheck()` refuses for two reasons in four different sentences — `busy`
(wait, or release the lease), and `not-ours` in three flavours (already awake /
state unknown / the wake has aged out), because telling somebody their machine
"was already awake" when what happened is that ssh failed is exactly the
confident wrong answer this codebase spends its comments avoiding. Both sleep
and shutdown on `/api/workstation` consult it and answer 409 with the holders
named.

A LEASE WHOSE HOLDER IS STILL BEATING CANNOT BE RELEASED CASUALLY, and that is
enforcement rather than a rule in prose. `release()` refuses a lease whose last
heartbeat is inside `ALIVE_WITHIN_MS` (two minutes, against a sixty-second
heartbeat) with a 409 naming the job; `force` lifts it, is parsed as a real
boolean (`body.force === true`), and is refused to the agent key and to anything
the skills proxy re-issued. The `leases` skill's `release` action is marked
`destructive` — not out of caution but because releasing the wrong lease permits
a sleep, and a machine slept under a forty-minute render destroys work no action
here can put back. The page asks a second time before forcing.

`integrations/video/execute.ts` takes a `video` lease on `local` around the
whole run, heartbeats it every minute and releases it in a `finally` — the two
ways a render ends that are not a return, a thrown `StepError` and a cancel, are
the two that matter. It uses `releaseOwn`, which is the holder's own release:
exempt from the beating refusal (the caller *is* the thing the heartbeat was
evidence of) and unable to throw out of a `finally` and mask the run's error.
The heartbeat interval catches its own errors for the same reason — an uncaught
`SQLITE_BUSY` in a bare interval callback ends the process, killing the render
the lease exists to protect.

### Tables

- `job_leases` — id, kind (`video|inference|studio|shotsqa|manual|other`),
  resource (`local`, `workstation:<accountId>`), venture, note, acquired,
  heartbeat, expires, released, release reason. Rows are kept after release
  (60 days) because "what was holding the GPU when the machine slept" is the
  question asked afterwards.
- `wake_ownership` — resource, when, by what, the state found, whether this app
  owes the shutdown.

No foreign key to `ventures`: a lease outliving a deleted venture is a true
record of what ran.

### Routes

`/api/deploy/status` (service + health + isolation + schedule + leases, one
document), `/health`, `/schedule`, `/isolation`, `/logs?which=out|err&lines=`,
`/plan`, `POST /plan/write`, `POST /service/install`, `POST /service/uninstall`,
`/leases`, `POST /leases`, `POST /leases/:id/heartbeat`,
`POST /leases/:id/release`, `POST /leases/release-stale`, `/wake`,
`POST /wake/:resource/release`, `/sleep-check/:resource`.

The three service writes carry `requireBrowser`: installing a supervised process
into the owner's login session is not something a chat message does. The lease
writes deliberately do not — releasing a stale lease is reversible tidying and
the skill publishes it.

### Skills

- **`deploy`** (pack `service-deployment`), no actions — there is nothing here
  an agent may write. Views: default, `health`, `schedule`, `isolation`, `logs`.
  Its rules say that `ok: true` is not a health verdict, that `installed` and
  `running` legitimately disagree, that a `pid` differing from
  `thisProcessPid` explains "I changed a setting and nothing happened", that
  `everyMinutes: null` is deliberate rather than broken, and that `same-user`
  must never be described as isolation.
- **`leases`** (pack `machine-leases`), two actions: `release` and
  `release_stale`. Its rules say a lease is not a lock, a lapsed lease is not a
  running job, a machine must never be offered a sleep without a `sleep-check`
  first, that `owns: false` means somebody else's machine, that a lease is
  evidence of a claim and never a measurement of GPU utilisation, and that
  releasing a live lease does not stop the job.

### Settings

- `collect_interval_minutes` on every collectable plugin's own page.
- `agent_user` on the `deploy` pseudo-plugin (Settings → Deployment), checked
  against a POSIX user name, overridden by `OPC_AGENT_USER`.

### Page

Settings → Deployment (`client/src/areas/deploy/DeploymentSettings.tsx`): the
service and its buttons, the unit file before the button, the five checks, the
per-source schedule table, the measured isolation level with the file modes it
read, and the live and lapsed leases with wake ownership.

### Not done

- The container path is documented and scripted but not driven by the app, and
  is deliberately NOT a reportable level: nothing here builds, starts or detects
  a container. It also needs the API reachable from one, which it is not —
  `index.ts` binds loopback, and `deploy/agent-compose.yml` says what the two
  real options cost rather than pretending otherwise.
- `separate-user` was not exercised end to end on this machine — creating an OS
  account, a group and a sudoers rule changes the developer's laptop. The spawn
  path, the setting, the report and the script are in and the script's dry run
  was read; the `sudo -n -u` call itself and the `env_keep`/`!secure_path`
  sudoers stanza are untested against a real account.
- Nothing here rotates the two keys. Replacing either file rotates it for the
  children at their next invocation and for this process at the next restart,
  which is what `auth.ts` already documented.
