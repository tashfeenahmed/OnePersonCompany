# server

Start with the [root README](../README.md) for current setup, production startup, recovery and job controls. The [fix matrix](../FIX_PROGRESS.md) records the September 2026 review changes.

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
WorkDash does today, and its own collectors document the pain: `seo.json` is
988K, and a document that has to be read whole to answer a question about one
row is a document that eventually will not fit in the thing reading it.

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
`dynadot-key`, `spaceship-secret` — which are the names workdash's own vault
uses and the ones this file tells you to look for. Every account after it is
suffixed with its own row id: `hetzner-token#4`. Not with its label and not
with its position, because the entry name is the ciphertext's associated data
and has to be stable for the life of the row; a label can be renamed and a
position moves the moment an earlier account is deleted. Renaming an account
therefore does **not** rename its vault entry.

## Credentials at rest

`src/vault.ts` mirrors WorkDash's `agent/secrets.js`: AES-256-GCM, a 12-byte IV,
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
the reason WorkDash's is closed: a route that can write any name into the vault
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
there — which is what WorkDash's own collectors are.

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
came from in order to read it. The rules are lifted from workdash's
`collect_domains.py`, which is the version that has actually been run against
these two accounts.

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
`spaceship-key` and `spaceship-secret`: the same names workdash's own vault
uses, which makes moving the credentials across a copy rather than a migration.
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
workdash's own vault uses, which makes moving a credential across a copy.

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
workdash they are called by `faceless-worker/materials.py` to search for b-roll,
Pexels first and Pixabay as the fallback. Nothing over there records what came
back, and neither service keeps an account history you can ask for later.

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

`pixabay-key` is declared in workdash's `KNOWN_SECRETS` but **no value was ever
stored** for it, on the Pi or here. The provider, the registry entry and the
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
expired before their first payment. workdash reported $415 of a $430 monthly
churn from exactly this mistake — revenue that had never existed. Whether a
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
workdash backfills the whole account on its first run, which is right for a
systemd timer and wrong here, because the first collection happens inside the
HTTP request that stores the credential. So history is filled BACKWARDS,
`HISTORY_CHUNK_DAYS` at a time, and the run that finds nothing older marks the
account complete and stops asking. Connecting costs one window; the year arrives
over the next few collections, and `history.from` says how far back the figures
actually reach so a wide window is read as a floor rather than as a total.

### AdSense is built and unauthorised

**There is no credential and there never has been.** No `adsense-token` in the
vault on the Pi, no `adsense-token.json` beside workdash's collectors, no
consent ever granted. The catalog said "Connected"; that was a mock value
presented as a measurement, and it now says what is true.

Minting a refresh token needs a human approving a Google consent screen as the
AdSense account owner, which no process can do. So everything on the other side
of that consent is built — provider, registry entry, collector, route, widgets —
and it works on the next collection after three fields are pasted:
`adsense-client-id`, `adsense-client-secret`, `adsense-refresh-token`. Three
entries rather than workdash's one `adsense-token.json`, because this vault
stores fields: a JSON blob in a secret is a document that has to be parsed
before anything can be checked, and a typo inside it fails as "the grant was
refused" rather than as "the client secret is missing".

**Not authorised is a state, not a failure.** `collect_adsense.py` writes
`{"error": "not-authorised", …}` and exits ZERO, because a daily timer must not
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

The shape is lifted from workdash's `collect_domains.py`, which is the version
that has actually been run against this account.

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
entry name is `gsc-key.json`, which is what workdash's own vault calls it.

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
example-app-1.example.test, where two hundred rows out of a long tail is a rounding error, and
19% across the portfolio. So the property's total is asked for **separately**,
as a dimensionless query, `queryCoverage` states the fraction per property, and
no card anywhere sums the query column into a headline.

The daily rows are the happy exception, and they are what makes the totals
cheap: summed over the same window they matched Google's own dimensionless
answer **exactly** (23,157 against 23,157 on example-app-3.example.test), because a
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
is one route for both app stores: one token reaches both, workdash's two
collectors read the same credential file, and a page that had to fetch two
documents and join them is a page that eventually joins them wrongly.
**Instagram is in this document and has no route of its own**, because
Instagram is not an API this box talks to — an Instagram Business account is a
FIELD on a Facebook Page, read in the same call, with the same token.

### Two credential entries, both of them comment-annotated files

`meta-token` and `meta-app` — the names workdash's own vault uses, which makes
moving them a copy. Over there both are files with a `#` note above the secret,
and **sealing one whole and sending it as a bearer token produces
`OAuthException 190 "Bad signature"`** — which is indistinguishable from a
revoked credential and sends you to mint a replacement for a token that was
never wrong. The comment lines come out at the registry on the way in *and* in
the provider on the way out of the vault, because the ordinary way these
arrive is copied verbatim from the Pi.

**`meta-app` is not an app id**, despite the field once being labelled one. It
is `app_id:app_secret` — a sixteen-digit id and a thirty-two-character hex
secret joined by a colon, the shape `collect_social.py` partitions on. So it is
a secret, and what it buys is `appsecret_proof`: an HMAC-SHA256 of the access
token under the app secret, sent with every call and verified by Meta (a wrong
one comes back as "Invalid appsecret_proof provided in the API argument"). It
is **optional** — the token reads everything without it — so an account stored
with only a token connects, works, and says on the wire that its calls are
unproofed. A non-empty value that is *not* a pair is refused rather than
ignored: storing a bare app id would leave the owner believing the calls are
proofed while every one goes out unsigned.

The token is a **system user token with `expires_at: 0`** — Meta for never — so
the sixty-day exchange `collect_social.py` performs is something this side never
does, and it therefore never writes to the vault.

### What it read, and what it could not, probed 2026-09-04

```
GET /me                                200, system user "pi-collector"
GET /me/accounts                       200, 3 Pages: Free LLM API (1 follower),
                                       Example App 4.io (9), Example App 3 (350)
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

The rules are lifted from workdash's `collect_demand.py`, which is the version
that has actually been run against these endpoints.

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
the anonymous `.json` endpoints answer 403 — measured over in workdash from a
residential connection with the exact user agent Reddit's rules ask for, which
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
`bing_keyword_state`'s rule, arrived at independently by `collect_demand.py`
for the same reason — an empty answer and a refused question are
indistinguishable in the response body, so the difference has to be carried
outside it.

### SearXNG: a header key, a URL that is a setting, and a card that had to change

The key goes in an **`x-api-key` header**. Probed 2026-09-04: the same key as a
`?key=` parameter is 401, no key is 401, and every path on the node is behind
it — `/healthz` included. The header is also the better door, because a key in
a URL is a key in an access log.

The URL is a **setting** (`plugin_config`, read back on the plugin page) and
not a constant: the node is self-hosted on the owner's own box and its hostname
carries that box's IP (`178-105-187-189.sslip.io`), so a constant in the source
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
ssh pi@192.0.2.17 'cd /opt/workdash && node agent/secrets.js get searxng-key' \
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

**No classifier and no convergence fold.** `collect_demand.py` labels each
item feature-request / complaint / question from keyword cues and merges
near-identical titles across platforms. Both are ranking machinery for a page
that ranks, and both make a claim about somebody's sentence that a card here
has no room to show its working for. These cards rank by engagement and
recency, which are figures the sources published themselves.

**No GitHub issue search**, which is `collect_demand.py`'s third source. It
needs the GitHub plugin's token and its own rate budget, and it is a different
plugin's collector rather than a silent omission of this one.

**No body text.** A card shows a title and a link and the thread is one click
away, so a copy of somebody else's prose would be weight with no reader — and
this is the only data on the box that arrives from strangers.

## Telegram: the one integration that is a door rather than a measurement

Everything else here asks a service what happened. This one hands a stranger's
message to an agent that can act, and that difference decides the whole design.

**One bot token per account**, `telegram-token` — the name workdash's own vault
uses for the notifier on the Pi. `getMe` is the entire verification available:
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

This is the contract `collect_inbox.py` keeps ("this file lands in dist/, so it
carries counts and only counts"), tightened by one step. `collect_contacts.py`
deliberately publishes real names and addresses because a contacts *page*
without them is not a contacts page; this dashboard has a number on a card
rather than a contacts page, so it takes the cheaper trade and keeps the
identities out entirely. The HMAC's salt is a `randomblob(32)` the migration
generates, so a fingerprint is meaningless outside this install — a plain
SHA-256 of an email address is reversible with a word list.

### Gmail: a token that can write, held by code that cannot

The refresh token in the vault was minted by workdash's `gmail_auth.py` with
**`gmail.modify`** and `calendar.readonly`. `gmail.modify` is a WRITE scope: it
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

**Three fields rather than two JSON documents.** workdash keeps
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
receipts, alerts and "your build failed" are real work, which is the call
`collect_inbox.py` makes and it is not this file's place to overturn it. The
exclusion happens **in the query** rather than after the fetch, which is the one
place this improves on the collector it is modelled on — workdash fetches a
promotion, discovers it is a promotion, and has already spent the request.

**The queue is a floor when the budget bites, and says so.** The per-thread read
is the only way to learn who wrote last, so `MAX_THREAD_FETCH` is a whole-run
budget of 250 spent INBOX-first; a label that ran out reports no count at all
rather than a zero, and a scanned label carries its own denominator. A queue
quietly capped at 250 is a queue somebody stops trusting the day they find out.

**"New contacts · 30d — first-time senders" was deleted as a measurement and
replaced with one that exists.** "First-time" is a claim about every sender the
mailbox has ever had — 97,472 messages of history — and counting senders at all
makes a mailing-list census out of an inbox that is a third promotions, the
exact failure `collect_contacts.py` refuses with its two-way test. Sent mail
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

workdash keeps this as ONE vault entry, `resend-keys.json`, holding a JSON
object of eleven domain→key pairs. That is precisely the shape `accounts.ts`
exists to undo: a blob has no per-key label, no per-key state and no per-key
error, so one revoked key shows up as a warning on the plugin rather than as
"example-app-1.example.test stopped answering". Here each key is an **account**, labelled with
its domain — the same split `005_accounts_split` performed on the Hetzner token
blob.

It is not tidiness. **A Resend key is scoped to its domain**: probed on
2026-09-05, the example-app-4.example.test key's `GET /domains` returns example-app-4.example.test and
nothing else, and its `GET /emails` returns example-app-4.example.test's mail and nothing else.
No key on this account sees all eleven, so one account row could not have covered
them even in principle. The entry stem is `resend-key` rather than
`resend-keys.json` — the one place the "use the name workdash uses" rule is
broken on purpose, because that name describes a document holding eleven keys
and an entry here holds one.

**Ten of the eleven connected. The eleventh is a Sending-access key** and it is
refused at the door: `example-app-12.example.test`'s key answers `401 "This API key is
restricted to only send emails"` to every endpoint this reads, deterministically,
on every attempt. Such a key can POST an email and read nothing at all, so
storing it would produce a permanently empty sending domain — the most expensive
shape of failure here, because it looks like an answer. It is refused with
Resend's own sentence and the fix, exactly as a Stripe test key and an OpenRouter
inference key are. The consequence is honest and worth stating: **example-app-12.example.test is
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
Google's budget than the answer moves. Two hours is what `collect_inbox.py`
settled on over the same mailbox.

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
open-source project (`github.com/tashfeenahmed/freellmapi`).

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
| **hosted** | an instance running elsewhere. The owner's is on the Hetzner box at `https://freellm.178-105-187-189.sslip.io/v1` — the same endpoint workdash's `agent/llmprovider.js` completes against, which is where that placeholder comes from. Its key is the `freellmapi-key` already in the Pi's vault |
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
question in a session — "can you run academic research for overbrilliant?" —
was asked with no venture selected, and the agent, which knew of a pack called
`ventures` it had not opened, asked what Overbrilliant was. So `withVenture`
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
insensitively, so "Overbrilliant" is an address and not a slug to guess at.

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
`tiktok-client-secret` are **declared names in workdash's `KNOWN_SECRETS` with
no value ever stored** — checked on the Pi on 2026-09-04. The catalog said
"Credentials stored, flow not shipped"; the first half was false, and it now
says what is true, the same correction the AdSense entry took before it.

There is no provider, no collector and no registry entry for either, and that
is a decision rather than a backlog item. Both are **posting** APIs: the useful
scopes are behind a three-legged OAuth flow a human has to complete in a browser
as the page's admin, and on the other side of it there is no read surface worth
collecting. A registry entry would mean either a `verify` that cannot be
exercised — storing a credential unchecked, which is the one thing the closed
registry exists to prevent — or a stub that lies about having tried.

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
second invisible — which is the mistake workdash's users page was built around
avoiding, where counting one product's local table would have reported **1
user** for what was its largest customer base.

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
is on the venture's own `host`, whole-label — `mail.example-app-1.example.test` matches,
`notexample-app-1.example.test` does not.

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

## The board: the first table here that is not a transcript

Every other route on this server is a window onto something a collector
fetched. A row in `hetzner_servers` is replaced the moment the next collection
disagrees with it, and the worst a bug can do is show a stale number. The board
is the other kind of table: **a card exists nowhere else until somebody types
it in**, and losing one is losing work. Nothing collects it, nothing overwrites
it, and there is no provider behind it.

`GET /api/board` answers with columns, each carrying its own cards in order and
its own count — and **so does every mutation**. That is the whole contract, and
it is workdash's own. The reason shows up under a drag: a move changes a card's
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
meaning the foot of it. Workdash sends `{ column, index }`; both keep the order
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

That is the entire seam. Workdash's board has a backlog filer, an issue ranking
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

