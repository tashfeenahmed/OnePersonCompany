# server

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
| `GET /api/metrics/:metric?days=30` | one series, for a widget |

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

### Collected every six hours

`DEMAND_EVERY_HOURS` is 6, for the reason `SEARCH_EVERY_HOURS` and
`SOCIAL_EVERY_HOURS` are, with a harder floor under it: a thread is posted once
and its score matures over a day, the window being searched is a year wide, and
these are two free endpoints nobody is obliged to serve us. A phrase newly
typed is asked immediately regardless, and so is one the last run deferred.

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
