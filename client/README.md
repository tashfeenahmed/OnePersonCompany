# client

Vite + React + TypeScript, shadcn/ui (radix base, `neutral`, Nova preset), Tailwind v4,
lucide-react icons. It is the `../design` prototype rebuilt as a real app — same
palette, same five screens.

```bash
npm run dev      # localhost:5173
npm run build    # tsc -b && vite build
npm run preview
npm run lint
```

## Screens

| route         | what it is                                                          |
| ------------- | ------------------------------------------------------------------- |
| `/`           | New chat: empty state, four openers, composer with a project picker |
| `/ventures`   | Venture grid, create/edit/delete                                    |
| `/subagents`  | The queue's standing workers, split by lane                         |
| `/plugins`    | The integration store, with the setup drawer                        |
| `/dashboards` | Redirects to the first board — the bare path is a way in, not a page |
| `/dashboards/:slug` | One board: widget palette, drag to reorder, width cycling      |

## Layout

```
src/
  data/          generated from workdash + Simple Icons — see below
  lib/
    store.tsx    projects, sessions, dashboards; mirrored to localStorage
    theme.tsx    light/dark, remembered, otherwise follows the OS
  components/
    AppSidebar   the rail every screen shares
    BrandTile    a service glyph on a tint of its own brand colour
    WidgetCard   one dashboard widget: metric, bars, rows, statuses,
                 chart, meters, table or runway
    ui/          shadcn
  pages/
```

## Where the data comes from

Nothing under `src/data` is invented:

- **`plugins.ts`** — the 28 integrations WorkDash actually has, read off
  `agent/integrations.js`, `KNOWN_SECRETS` in `agent/secrets.js`, and each
  `collectors/collect_*.py`. Vault entry names and the "read by" lists are real.
- **`subagents.ts`** — the 13 queue kinds from `src/data/useSubagents.ts`, with the
  two-lane rule intact: the eight `ai:` kinds share one lane and run one at a
  time, the five media kinds are laneless.
- **`widgets.ts`** — 107 metrics across 26 sources. Sample values are fixed so a
  reload does not repaint the board with different numbers, and a widget wearing
  the live dot is one whose builder could actually answer with what arrived —
  never one showing its sample.
- **`brandIcons.ts`** — Simple Icons paths, inlined with their brand colour.
  Source SVGs are in `src/assets/brand`. LinkedIn, Bing and OpenAI were pulled
  from current Simple Icons over trademark claims, so those three come from the
  pinned v11 release.

Theme tokens live in `src/index.css`: shadcn's own variable names carrying the
design's palette, plus `--faint`, `--line-soft`, `--line-strong`, `--ok`,
`--ok-bg` and `--warn`, which are exposed to Tailwind as `text-faint`,
`border-line-strong`, `bg-ok-bg` and so on.

## Dashboards have addresses

A board lives at `/dashboards/<slug>`, and the URL **is** the selection — there
is no "which tab is open" state beside the address to fall out of step with it.
That is what makes a board linkable, bookmarkable and reachable with the back
button, and it is why the tabs across the top are links rather than buttons: each
one can be middle-clicked into a new tab or copied out of the bar.

The slug is set once, at creation, and a rename does **not** move it. A dashboard
is a thing you come back to — from a bookmark, from a second window, from the
browser's own history — and renaming "Morning check" to "Daily" should not
quietly break every one of those. The rename dialog says where the board lives so
that is not a surprise.

A slug that names nothing gets told so, with the boards that do exist offered as
links. It is not redirected to the first board: showing a different dashboard's
numbers under the URL somebody asked for is the worst answer available.

These are **real paths, not a hash** — `BrowserRouter`, so the address is
`/dashboards/servers` and not `/#/dashboards/servers`. A fragment is not part of
what a browser sends, so nothing upstream can ever route on it, and it is not a
URL anybody wants to paste. The cost is one deployment requirement: whatever
serves the built files must fall back to `index.html` for unknown paths. `npm run
dev` and `npm run preview` both do this already; a static host needs the rule
written down (Caddy `try_files {path} /index.html`, nginx `try_files $uri
/index.html`, Cloudflare Pages a `_redirects` line). `/api` is proxied to the
server and never hits the router.

## A plugin's page shows accounts, not a key

A plugin backed by the API holds a list of accounts — a Hetzner token covers
one project, a registrar key covers one login — and `PluginDetail` draws one
row each: whether it is connected, **failing**, or not connected; when the
credential was stored and when it last actually worked; the provider's own last
error; and the vault entries it owns, by name. Add another, replace one's
credentials, or disconnect one, without touching the others.

Three states rather than two, because "connected" over two accounts where one
token has been revoked is true and useless. Two dates rather than one, because
a key pasted five minutes ago that has never answered is not a key that
answered five minutes ago. And never a value: no route returns one, and there
is nothing on the client types that could hold one.

A catalog-only plugin — one of the twenty-five with no API behind it — keeps
the single local form it always had. Showing it an accounts list would be
showing a feature it does not have.

Where a dashboard card is a total across accounts it says so ("across 2
accounts"), and the Hetzner panel breaks the monthly figure down per account
once there is more than one. A figure that quietly became a sum is a figure
that changed meaning.

## The Servers dashboard

Modelled on the fleet page in WorkDash — the four figures first, then the
fleet's own load line, then every box as a meter, then the table of numbers
behind the pictures.

The difference is what can be measured. WorkDash reads its boxes from inside,
through its own collectors, so it has CPU, memory and disk-fullness. This reads
Hetzner's API, which measures from the hypervisor: CPU, network throughput and
disk throughput, and nothing about memory or how full a filesystem is. So this
board has CPU meters and no memory meter, and the disk card is titled for
throughput rather than capacity. A meter that cannot be measured is not drawn.

Three widget kinds were added for it, and they are general rather than
Hetzner-shaped:

- **`chart`** — one or two lines over time on a shared y-axis that starts at
  zero. Two lines on two scales can show traffic in exceeding traffic out when it
  is a tenth of it; an axis that starts at its own minimum turns a fleet idling
  between 8% and 11% into a mountain range.
- **`meters`** — a reading, its track, and the two lines it is judged against.
  The fill and the track are one hue, because the unfilled part is the rest of
  the whole rather than a neutral gutter, and the hairlines are what turn a
  number into a position.
- **`table`** — headers and rows, scrolled sideways rather than wrapped. A
  six-column row folded onto three lines stops being a row.

Every CPU limit on the page comes from one place, `CPU_LIMITS` in
`lib/liveWidgets.ts`, because two cards must never disagree about when a box is
busy.

## The Domains dashboard

The portfolio as workdash's own Domains page reads it, merged across both
registrars — because "what renews next" is a question about the portfolio, and
answering it from one registrar's rows would be answering a different question.
That is why the cross-registrar widgets sit under a source called **Registrars**
rather than being filed under whichever one happens to hold the most names.

The visualisation worth having is the **renewal horizon**: every domain as a
length on one axis, with the week and the month drawn as the two lines each dot
is judged against.

- **Why a length and not a date.** "5 Dec" and "3 Feb" are two facts a reader
  has to convert into a distance before either means anything. Drawn against a
  shared axis, the fortnight and the two years are the shape of the thing rather
  than arithmetic.
- **The axis is capped.** A name bought until 2028 pushes a raw axis past six
  hundred days and collapses the two windows the chart exists to show onto the
  origin. Past the cap a row sits at the end and says `400+d`.
- **A date that has passed is drawn at zero and says "lapsed"**, not `-2d` —
  a minus sign skims as "2 days" and it is the opposite.
- **A trimmed list says what it left out**, including how many names have no
  date from their registrar at all. That is unknown, not safe.

Unlike workdash's, this one is HTML rather than SVG: every length is a
percentage of its track, so it is responsive at any card width with no
measurement, and the labels stay at the size the rest of the card uses instead
of being scaled by a viewBox.

## The Costs dashboard

"What is this whole operation costing me", answered by four providers that do
not answer it the same way — and the board's shape is that disagreement rather
than a grid of matching tiles.

**No single total, and it says so.** OpenAI, OpenRouter and Replicate bill in
US dollars; Hetzner bills in euro, net of VAT. Converting would need a real,
dated exchange rate that nothing here fetches, so the two sit side by side with
their own units and the last row of that card reads "One total across both —
not offered, two currencies". The one figure that *is* added is
`costs.llm` — OpenAI plus OpenRouter, same currency, same window — and its
subtitle names the provider it leaves out: Replicate reports no spend, and an
"LLM spend" total that quietly omitted the media bill would be exactly the sort
of confident number this board exists not to print.

**Two cards say what cannot be answered.** "What these APIs will not say" lists
one line per connected provider — OpenAI has no per-model split, OpenRouter has
no per-day-per-key figure, Replicate has no billing endpoint at all — and the
board closes on Replicate's own card, which is the evidence rather than the
verdict: the requests that were made and the answers that came back, with the
date they were checked. A reader who goes looking for a Replicate cost finds
out why there isn't one instead of assuming the collector is broken.

**Three catalog mocks were changed rather than dressed up.** `openai.models`
("Spend by model") was deleted: the Costs API groups by project or by line item
and never both, so that card could only ever have been filled with a guess —
`openai.projects` is the split that exists. `replicate.gpu` ("GPU seconds · 7d,
≈ $19 at current rates") was deleted on both counts: Replicate does not report
GPU seconds, and the "≈ $19" was invented from a price list nobody published.
It is replaced by compute time in its own unit, with a subtitle saying that no
rate exists to turn it into money. `openrouter.credits` kept its name and lost
its made-up burn rate: the runway it shows now is the balance divided by the
activity window's own average, and the card says that is the assumption.

**The daily spend charts are bars, not lines.** The `chart` kind draws a
labelled y-axis in percent or bytes, and there is no dollar axis on it — a
money series drawn there would be captioned in a unit it is not. Bars carry the
shape with the amount in each bar's own hover, and the partial bucket at the
right-hand end says "still settling" rather than reading as a quiet Tuesday.

## The Code & packages dashboard

GitHub and npm are two ends of one question — somebody reads the repo, then
installs the package — and they are the two ends of it that can actually be
measured. Nothing here joins them into a conversion rate, and nothing pretends
to: a view is a person and a download is an HTTP fetch, so they sit beside each
other as two shapes over the same weeks rather than as a numerator and a
denominator.

Three catalog widgets were samples describing measurements this API cannot
make, and a sample that can never become live is a promise the catalog has no
way to keep:

- **"Commits · 14d"** needed a call per repo against an endpoint that answers
  202 while it computes. The listing does carry when the last commit landed, so
  the card became **"Last push, by repo"** — the neighbouring question, answered
  honestly. Its key is unchanged, because a saved board points at it and
  silently dropping a card from somebody's dashboard is worse than renaming one.
- **"Open PRs"** needed the search API and its own rate limit. GitHub's listing
  carries `open_issues_count`, which counts pull requests too and cannot be
  split without a call per repo — so the card says **"Open issues & PRs"** and
  means both.
- **"Actions minutes"** is gone. Both billing endpoints answer 404 for this
  account and token and there is no other route to the figure. A card that can
  never be filled is worse than no card.

**"npm downloads · 7d"** became **"npm downloads · last full week"**, and names
the ISO week it means. npm's own rolling seven days ending yesterday would
disagree with every other weekly figure on the board by a few percent for no
reason anybody could find later — and the number is *downloads*, tarball
fetches, with CI and mirrors in among the people. Calling it installs would put
a figure on the top of a funnel that is wrong in an unknown direction.

Two things the cards say out loud because the data cannot say them alone:

- **Uniques are not addable and views are.** GitHub de-duplicates visitors per
  repo and per window, so the portfolio's unique count is per-repo counts summed
  — anybody who read two repos is in it twice. Every card carrying one says
  "summed per repo".
- **The traffic line stops at yesterday**, and starts where every repo was
  actually measured. GitHub's counts lag its own clock, and it hands back stray
  older days for quiet repos; drawn raw, both edges are cliffs that never
  happened.

The **API budget** is a card of its own. The first symptom of exhausting
GitHub's hourly limit is a board that quietly stops updating at three in the
morning, and a dashboard that cannot say why is the thing this project exists
not to be. Past its reset the figure describes an hour that is over, so the card
says the budget refilled rather than quoting a number about a limit that no
longer applies.

## The app store widgets

Not a dashboard — a set of cards, for whichever board wants them. Both stores
are wired to one endpoint (`/api/mobile`), and the five catalog mocks that
described them were changed rather than dressed up, because three of them
promised numbers no API here can produce.

**Two kinds of money per store, and every card says which one it is drawing.**
Apple's daily sales report carries its own *estimate* of developer proceeds and
its monthly finance report carries the *payout*; Google's `sales/` export
carries what buyers were charged and its `earnings/` export carries what landed.
"App Store proceeds" on a money board, read as revenue, is a number nobody was
ever paid — so `appstore.proceeds` kept its key (a saved board points at it) and
became **"Estimated proceeds · 30d"**, a row per currency with a last line
saying it is not the payout. **"App Store payout"** is the other card and is the
one that may be read as revenue. `play.revenue` and `play.charged` are the same
pair on Google's side, and `play.charged` is labelled *unsettled* because it is
the only figure that exists for a month still running.

**`appstore.installs` kept its key and lost the word "installs".** Apple counts
units in its sales report: a first download of the app, with updates and
re-downloads counted separately in the same file. Calling the first figure
installs and leaving a reader to assume the other two are inside it is how a
funnel gets a wrong number at the top. The card is **"App Store downloads · 30d"**
and its subtitle names the span Apple actually reported.

**Two rating cards that mostly say "no ratings yet", and that is the honest
answer.** Apple reports `averageUserRating: 0` for an app nobody has rated, and
the average of no ratings is not zero stars — so `appstore.rating` shows a dash
and says how many apps are on the store. Google's export carries a running
average and *no rating count*, so `play.rating` says how many packages report one
rather than implying a population it cannot weight by.

**A card the money cannot express.** Four of the six apps on this account are
not on sale — waiting for review, ready to submit, not submitted — and "no
proceeds" beside them would read as a market verdict about apps nobody could
buy. `appstore.store` is one status row per app, and `mobile.presence` is the
count.

**Both daily lines stop where the data stops.** Apple's leaves out days it has
not generated rather than drawing them as zero, and captions how many days were
real reported zeros. Google's export stopped weeks before today on this account,
so the caption is the range Google actually wrote rather than the window that
was asked for — a card captioned "30d" over seventeen days has quietly changed
meaning.

**And no total across the two.** `mobile.sideBySide` is the App Store's payout
and estimate beside Google's, each in its own currency, closing on "one total
across both stores — not offered". Ten currencies turned up in a single month
here, four orders of magnitude apart, and an estimate is not a payout: two good
reasons in one row.

## Chart units

A `chart` widget declares what its numbers ARE, and the axis and the tooltip
share that one declaration so they can never disagree — an axis reading
`25000%` over a tooltip reading `24,999 requests` is worse than either alone.

`percent` · `bytes` (drawn as a rate, `/s`) · `count` · `usd`.

`count` and `usd` were added late. `count` exists because not every series is a
proportion or a rate — a remaining request allowance is a plain quantity, and
rendering it as a percentage was a real bug caught before it shipped. `usd`
exists so a spend series can be drawn as a line rather than pushed into bars for
want of a currency axis.

## The revenue widgets

Stripe and AdSense are both filed under "revenue" and only one of them can
answer anything. No card reads both, and there is no figure anywhere that spans
them: settled card money and an ad network's estimate of what a day earned are
not addable, and a "total revenue" tile would be the exact number this board
exists not to print.

**Five Stripe samples became measurements, and two of the five had to change
what they say to become one.**

- **"Churn rate"** is now **"Revenue churn · 30d"**. "Churn rate" is four
  different figures depending on a denominator nobody named, and the card now
  carries its own: MRR the window opened with that has since gone, over the book
  it opened with. Its subtitle quotes the numerator the rate actually used — the
  part that was in the book when the window opened — and names the rest
  separately, because a subscription that arrived and left inside the window was
  never part of what the percentage is of. Printing the bigger, more quotable
  `churnedMrr` over the same denominator would put arithmetic on the card that
  contradicts the figure above it.
- **"Payout balance"** kept its name and lost `"next payout Friday"`. Stripe
  publishes no payout schedule and every payout on this account is sent by hand,
  so that date could never have been filled from the API. The card shows what is
  knowable: available now, pending beside it — never added, they answer
  different questions — and when money last actually left.

`stripe.mrr` says on its face that 359 of its 364 subscriptions are annual and
are counted as a twelfth a month, because a reader who does not know that would
read the figure as money arriving every month. `stripe.gross` is captioned as
charges rather than as MRR: it includes the one-off payments that can never be
in MRR, which is why it can be several times larger on a good day. `stripe.fees`
puts withheld sales tax on its own line *below* the total and derives the
percentage from the fee ex-tax, because folding the two together turns an 8.0%
processing cost into 14.9%. `stripe.declines` counts Radar blocks and bank
declines apart and rates only the attempts a bank actually saw — half this
account's failed attempts never reached one, and one figure covering both would
read as a business whose payments are failing rather than as card testing being
repelled.

Two cards exist only to keep the others honest. **"What is not churn · 90d"**
puts the cancelled trials and the expired checkouts beside the real losses:
neither ever collected a penny, so neither lost one, and counting them is how a
$430 monthly churn turns out to be $415 of revenue that never existed. It also
names how many cancellations have not yet had their invoices checked, because
those count as real churn until they have. **"What Stripe will not say"** is the
same card the costs board carries for its own providers — a reader who goes
looking for a per-product figure that includes one-off sales finds out why there
isn't one instead of assuming the collector is broken.

**AdSense shows samples, and one card says why.** The catalog claimed
"Connected"; nothing has ever authorised it, on this box or on the Pi. That flag
is now false, `adsense.earnings` and `adsense.rpm` return null from their
builders in every state but `authorised` — so they keep their sample values and
wear no live dot — and a third card, **"AdSense access"**, is live today: it
says which not-authorised state the integration is in, in Google's own words
where there are any, and what the first two steps to fixing it are. It is the
one reason `/api/adsense` is fetched even while the plugin is disconnected. A
card that shows the fix beats one that paraphrases the failure, and both beat a
confident `$0`.

## The Cloudflare widgets

Twenty-three zones is a lot of material, and the two catalog mocks that
described them both had to change what they claim in order to become
measurements.

**"Requests by domain · 24h"** is now **"Requests by zone · 7d"**. Cloudflare's
free analytics is `httpRequests1dGroups` — a *daily* rollup — so there is no
twenty-four-hour figure to be had that is not either today's half-written bucket
or yesterday's finished one. Seven complete days is the window that exists;
captioning it 24h would have been a unit nobody measured.

**"DNS drift"** kept its name and changed what it measures. The sample promised
`neu.so → stale A`, and a record being stale is relative to where a service
actually lives — which nothing on this box knows. What *is* knowable, and is the
more serious failure, is **delegation** drift: Cloudflare knows the nameservers
it assigned a zone, the registrars know where the domain actually points, and
neither of them knows the other. That join is the one thing this app can do that
neither provider's own console can, and when the two sides disagree the records
on every other card here are not the records the internet is being served.

The card carries **five lines rather than "clean / not clean"**, because three
of the states are neither: a registrar that would not report nameservers is
*unknown*, a zone whose domain is registered somewhere with no API here has
nothing to compare against, and a name pointed at a *different* pair of
Cloudflare nameservers is on Cloudflare and still not on this zone. On this
account it reads 16 aligned, 7 zones no connected registrar holds, and 5
registered names with no zone at all — and **"Zones and names that do not pair
up"** names them, because both of those gaps are invisible everywhere else on
the board.

**Two things the cards say out loud because the data cannot say them alone.**

- **Visitors do not add up and requests do.** Cloudflare de-duplicates visitors
  within one zone and one day and nowhere else, so `cf.visitors` is captioned
  "summed per zone — anyone who read two of these sites is in it twice". It is a
  card of its own rather than a third line on the requests chart, both because
  of that and because four hundred thousand requests and eighty thousand
  visitors on one axis is one line and a flat one.
- **The line stops at yesterday.** Cloudflare aggregates into UTC days and is
  still writing today's; drawn beside six finished days it is a cliff that never
  happened. Today is in the document, marked partial, and the caption says so
  rather than leaving a reader to wonder where it went.

**Null and zero are different on every card here.** A zone Cloudflare would not
answer for has no traffic object and prints an em dash; a zone that was measured
and served nothing prints 0. `cf.threats` returns null — and shows its sample
with no live dot — rather than under-reporting when any zone's query landed on a
thinner field set, and a cache ratio over zero requests is null rather than 0%.

**"What this token will not read"** is the card that keeps the others honest,
the same shape the costs board carries for Replicate. The token is deliberately
scoped to zone reads, so a reader looking for a Pages deployment or a WAF figure
finds the request that was made and the 403 that came back, with the date it was
checked — rather than assuming the collector is broken and re-pasting a
perfectly good credential.

## The search widgets

Not a dashboard — twenty cards, for whichever board wants them. Two sources
under two names, **Google Search Console** and **Bing Webmaster**, wired to two
endpoints, with no card anywhere reading both. Google's impressions and Bing's
count different searches by different people on different networks under
different anonymisation rules, and a total spanning them would be the exact
number this project exists not to print.

### Three sentences the cards say out loud, because the numbers cannot

**The Google line stops three days short of today.** Search Console finalises a
day over two to three days, so the collector never reads closer than that and
every card is captioned with the day its window actually ends on — "28d to 1
Sep" rather than "28d". A window whose end is not stated reads as a window
ending now, and the missing days read as a fall in traffic. `gsc.trend`'s
caption says why in as many words.

**The query rows are a sample of the impressions and never all of them.** Google
withholds queries too rare to keep a searcher anonymous and caps how many rows
it returns; across these nineteen properties the ranked rows carry 19% of the
portfolio's impressions, 2% on the busiest property and 77% on another. So
`gsc.queries` prints that fraction as its last row, and **"What the query rows
cover"** is a card of its own — the same job "What is not churn" does for the
Stripe board: two numbers that look like they should match, cannot, and the
reason set between them, including which property is thinnest.

**Bing's volumes are Bing's.** They are one engine's impressions for one market
— `us/en-US` — and the card names the market rather than letting a reader take
them for a world figure or for Google's.

### Two catalog samples changed what they claim in order to become measurements

- **"Inbound links"** was a metric reading `1,847 · new referring domains: 12`,
  and half of that cannot be produced. Bing reports inbound links two ways and
  they disagree completely here: the crawl statistics carry a real count per
  site, and the only endpoint that can *name* a linking page — and therefore
  the only route to a referring domain — answers with an empty list for every
  verified site on the account. `bing.backlinks` kept its key, because a saved
  board points at it, and is now a row per site with the count, a row saying
  Bing will name no linking page on any of them, and a row saying the
  referring-domain figure is not answerable. Filling it with something adjacent
  was the alternative.
- **"Keyword volume"** over four invented phrases became **"Search demand ·
  Bing"**. The measurement is real, free, and the one thing on this whole board
  that is *not* a rear-view mirror — it counts people searching a phrase
  whether or not anything of ours ranks for it, which Search Console
  structurally cannot answer. But it needs somebody to name the phrases, and
  nothing here can guess them: seeding from Search Console's own queries would
  ask "how much demand is there for what we already rank for", which is the
  question the endpoint exists not to answer. So the phrases are a setting on
  the plugin page, and with none configured the card says which one step fills
  it — the AdSense-access move, because a card that shows the fix beats one
  showing a sample.

**`gsc.position` kept its name and lost its delta.** A rank moves in *places*,
and the card's own delta renders a percentage; "-25%" over an average position
is a figure in no unit anybody can act on. The movement is spelled out in the
subtitle instead — "0.8 worse than the previous 28d" — which also says which
way it went, rather than leaving a sign to be interpreted.

### What nineteen properties are worth drawing

- **"Every property"** is a table rather than nineteen cards: "which of these is
  actually earning" is a question about the set. It shows twelve and closes on a
  row naming what it left out *with the figures* — four smaller properties worth
  ninety impressions between them answers "does the tail matter" where "+4 more"
  does not. The columns that cannot be summed across properties, a CTR and a
  rank, are dashes on that row rather than an average nobody asked for.
- **"Biggest movers"** has a floor of fifty impressions in the window before it,
  and says so on the card. Without one it is a list of the quietest properties
  on the account every time: eleven impressions becoming thirty-three is a 200%
  rise and is noise.
- **"Striking distance · 11-20"** is queries already visible to Google and one
  page short of the clicks — usually the cheapest win available. Its last row
  is the caveat that makes it honest: Google returns these rows ordered by
  *clicks* and offers no other order, so the zero-click, high-impression query
  this card exists to surface can be missing from it entirely.
- **"Sitemaps"** counts three states apart, the way the Domains board keeps
  auto-renew off apart from auto-renew unknown: submitted, none submitted, and
  could-not-be-read. Its last row says the number Google is actually holding is
  not knowable — the Index Coverage report has no API — so the submitted count
  is never allowed to stand in for an indexed one.

**Both trend charts draw impressions only.** Clicks run about forty times
smaller on this portfolio, and on a shared axis starting at zero that is a flat
line along the bottom impersonating a measurement. Clicks have their own metric
card with its own sparkline. Both charts are `count`, because an impression is a
quantity of times a link was shown and not a proportion of anything.

**Bing's "Pages in Bing's index" and Google's sitemap card are not each other's
answer.** One is what a crawler kept; the other is what we asked a crawler to
look at. They sit under different sources and neither is captioned as the other.


## The social widgets

Not a dashboard — nine cards, for whichever board wants them. Meta and
Instagram are two sources reading **one document** (`/api/meta`), which is the
opposite of the split the two search engines take and for the opposite reason:
Google and Bing measure two populations and one field holding both would be one
field away from a card that adds them, whereas an Instagram Business account is
literally a *field on a Facebook Page*, read in the same call with the same
token. A second fetch would only re-read something the first one already had.

Three pages and one ad account is modest material, so this is a handful of
cards that each answer something rather than a grid of tiles.

**Four catalog samples described this integration and three had to change what
they claim in order to become measurements.**

- **"Page reach · 28d"** kept its key and became **"Reached by ads · 30d"**.
  Organic Page reach is unavailable twice over: Meta retired
  `page_impressions_unique` in November 2025, and every Page metric that still
  exists needs a Page Access Token this system user's role is not permitted to
  mint. The paid figure is real — 92,416 people over Meta's own window — and the
  card is titled for the reach it draws, because ad reach and Page reach are two
  measurements of two things and a paid figure under an organic name is worse
  than no card. It carries **no sparkline**: every point of a reach series is
  de-duplicated over its own overlapping window, so successive points are not
  comparable and their shape means nothing.
- **"ROAS · 2.8× · blended, 30d"** kept its key and stopped being a number. Both
  halves were wrong. *Blended* is the one shape a ROAS may never take — it is a
  ratio of two figures that can be in different currencies and on different
  attribution windows — and there is no ROAS here to blend: `purchase_roas` is
  asked for on every call and is absent from every row, because this account
  buys lead-form submissions and there is no purchase for Meta to attach a value
  to. The card is now what was asked and what came back, with the conversion the
  account *does* buy beside it. It fills itself if a purchase campaign ever runs.
- **"Ad spend · 30d"** kept its name and lost "4 active campaigns". Fourteen
  campaigns exist and every one is paused; five delivered inside the window. Its
  subtitle now names the window's **own dates** and the currency, because Meta's
  `last_30d` ends on the last complete day and a card captioned "30d" over it is
  captioning a window it is not.
- **"Followers · 9,412"** on Instagram kept its key and became **"Instagram
  accounts"**, three status lines rather than a metric. See below.

Five cards were added, because the ads data is richer than the catalog assumed:
**"Leads · 30d"** with Meta's own cost per lead and the attribution window named
on the card; **"Daily ad spend"** as bars — the `chart` kind's axis is percent,
bytes, count or USD and this money is EUR, the same reason the costs board draws
spend as bars; **"Where the ad money went"** as a table, because "which of these
was worth running" is a question about the set; **"Facebook Pages"**, which is a
follower count each and honest about that being all a Page can say here; and
**"What this token will not read"**, the same evidence card the costs board
carries for Replicate and the traffic board for Cloudflare.

**Three things the cards say out loud because the numbers cannot.**

- **Reach is never added and frequency is never averaged.** Meta de-duplicates
  both over each row's own window, so summing two campaigns' reaches counts
  anyone in both of them twice. The campaigns table has a Reached column and its
  footer row says `never summed` rather than carrying a total.
- **The daily line has twelve bars out of thirty days, and that is the card.**
  Meta returns a row only for a day that delivered, and drawing the silent days
  as measured zeroes would show a gradual decline where the spend simply
  stopped. The caption says how many days of the window carried delivery.
- **The money is EUR and no total spans it.** Every money card names the
  currency, and the spend card names the ad account it is a total of.

**Instagram is connected and there is nothing to read, which is a third state.**
The token is live and lists three Pages by name; not one of those Pages has an
Instagram Business account linked. Drawn as "0 followers" that is a measurement
of an audience nobody measured; drawn as an error it sends somebody to re-paste
a credential that works. So the card is three lines — the token works, no
account is linked on any of 3 Pages, and the one step that changes it — the same
move the AdSense access card makes, for the same reason: a card that shows the
fix beats one that paraphrases a failure, and both beat a confident zero. The
counts are a **pair**, because "0 of 0 Pages" and "0 of 3 Pages" are completely
different sentences and only the second is this state.

**LinkedIn and TikTok say they are unset, because they are.** The catalog read
"Credentials stored, flow not shipped" for both; the four vault entry names are
declared in workdash and none has ever held a value. Both entries now say
registered, no credential, nothing collected — and that nothing here reads
either service, which is a decision rather than a backlog item: both are posting
APIs behind an OAuth flow a human has to complete, with no read surface on the
other side worth collecting.

## The demand widgets

Not a dashboard — ten cards, for whichever board wants them. Three sources
under three names, **Reddit**, **Hacker News** and **SearXNG**, plus a fourth
called **Demand** for the two cards that legitimately span the first two. All
of them read one document (`/api/demand`), which is the opposite of the split
the two search engines take and passes the same test: a THREAD is a thread
whichever site it was posted on, so counting them together answers a real
question — while Google's impressions and Bing's answer two.

**Upvotes are never added across the sources and no card does it.** A Reddit
upvote and a Hacker News point are two crowds' currencies with no exchange
rate, so `demand.new` and `demand.coverage` count threads, and every
engagement figure stays on its own site's card.

### One catalog sample could never have been filled, and it changed

**"Agent searches · 24h · 186"** promised a number nothing publishes. Probed
2026-09-04: the node's `/stats` is HTML only — the `format` parameter is
ignored — and it counts ENGINES rather than queries; a search response carries
no total either; and this box is not the only thing that searches through the
node, so counting our own calls would answer a smaller question under a bigger
name. `searxng.queries` **kept its key** — a saved board points at it — and
stopped being a metric. It is now the node's own health, and it carries the
old promise as its last line: *query volume: not published*, with the date it
was checked.

That turned out to be the better card, and then a worse finding. A SearXNG
response names the engines that refused, in the node's own words, and on this
instance four of the five were refusing: brave "Suspended: too many requests",
duckduckgo "CAPTCHA", google "Suspended: CAPTCHA", qwant "access denied". Every
result came from Bing alone. **A metasearch node down to one engine still
answers ten links and still looks perfectly healthy**, and nothing else on this
box could see it — so `searxng.engines` is a card of its own, and the count of
engines answering is coloured: one is bad, two is thin.

**And ten results is not ten answers.** The probe asks a `site:reddit.com`
query — the one Reddit's fallback tier actually makes — and on the day this was
written it came back with ten links about free browser games: the one engine
still serving had ignored the site restriction and the query with it. So the
card's third line counts how many results were on the site that was asked for,
and reads `NONE of 10 results were on reddit.com — the engines are ignoring
site:, so Reddit's fallback cannot answer`. A results count alone calls that
perfect health.

`reddit.signals` and `hn.mentions` kept their keys, their names and their
shape, because the samples described exactly what these APIs can produce.

### Three things the cards say out loud, because the numbers cannot

**Which tier answered.** "12 threads from the Atom feed" and "12 threads from
SearXNG, unscored and unaged" are different claims about the same twelve links:
one set is dated and scored, the other is neither, because a web index knows a
thread's title and URL and nothing else. `reddit.tier` is where that lives,
along with whether the account's feed token is lifting Reddit's one-a-minute
throttle — which decides whether a collection asks the whole watch list or one
phrase of it. The fallback tier is coloured `warn` rather than `ok`: it is the
safety net doing its job, and green would say the unscored rows are as good as
the scored ones.

**A throttled phrase and a phrase nobody posted about are not the same.** Both
produce no rows and only one is a finding, so `demand.coverage` gives every
watch phrase a row whatever happened to it, prints a real zero as **"0 —
nobody"**, and says "throttled", "next in line" or "not asked yet" where a
count would be. It is the card that keeps the others honest, the same job
"What the query rows cover" does on the Search Console board.

**A score that was never measured is not a zero.** A Hacker News comment has no
points in Algolia's index, a thread found through SearXNG has none at all, and
a Reddit thread posted in the last day and a half is still a placeholder in the
archive that supplies the counts. All three say so in the place the number
would have been — "comments carry no score", "unscored (web index)" — because
"0 pts" is the opposite claim.

### And one figure that needed a caption to be true

`demand.new` counts threads **first seen by this box**, which is the only
freshness measure an undated row can contribute — but on the first morning
that is every thread the sources have ever handed back, including one posted in
March. So the card says how long it has been collecting rather than drawing a
spike out of the moment collection started, and names how many of them were
actually posted inside the window.

`reddit.subs` is the one shape worth drawing: a subreddit is the closest thing
this data has to an audience, and one busy subreddit against fifteen with a
thread each is the difference between a place to be and a phrase that is too
general. It counts threads rather than rows, because two watch phrases finding
the same thread is one conversation.


## The mail widgets

Not a dashboard — thirteen cards, for whichever board wants them. Gmail and
Resend are two sources reading **one document** (`/api/mail`), plus a third,
`Mail`, that belongs to neither and carries the one card that spans them.

That is the App-stores shape rather than the Google/Bing one, and it passes the
same test from the other side. The two search engines needed splitting because
one field holding both would be one field away from a card that adds them.
Nothing here is that shape: an inbox thread waiting on a reply and a
transactional password reset are not the same kind of thing, so no builder
could be tempted to cross them — and a second field would only be a second
thing to forget to pass.

**Nothing on any of these cards is a subject, a message body or a person's
name**, and that is a property of the server rather than restraint here: the
tables behind the document cannot hold one. The only addresses that reach the
client are the owner's own mailbox and the from-addresses of domains the owner
sends from.

### Four catalog samples, and two of them had to change what they claim

- **"Inbox needing a reply"** kept its key, its name and its meaning, and is now
  drawn from the real thing: threads whose last message came from somebody else
  with neither a reply nor a draft against it, over thirty days, with Gmail's
  Promotions, Social and Forums excluded in the query. It says `230+` rather
  than `230` when the run's thread budget bit, because a queue quietly capped at
  250 is a queue somebody stops trusting the day they find out.
- **"New contacts · 30d — first-time senders"** is the one that could not
  survive as written. "First-time" is a claim about every sender the mailbox has
  ever had — 97,472 messages of history — and counting senders at all makes a
  mailing-list census out of an inbox where 24,901 of 83,299 messages are
  promotions. The card keeps its key, because a saved board points at it, and
  answers the neighbouring question honestly: **"People you wrote to · 30d"**,
  counted from sent mail, which gets the subscription filter for free. "New"
  survives against a stated lookback, and the subtitle names the date the
  sent-mail history actually reaches back to — a "new contact" count is only as
  good as what it is new against.
- **"Emails sent · 7d"** became **"Emails sent · 30d"**, which is the window the
  route answers over. A card captioned for a window it is not is the quietest
  way to be wrong. It survived at all only because Resend turns out to have a
  list endpoint: `/emails` pages with a cursor and carries `last_event`, so the
  figure is a count of real rows. Had it not, this card and the bounce card
  would both have had to say so instead — the move `replicate.gpu` made about
  GPU seconds.
- **"Bounce rate"** kept its name and lost `"soft and hard combined"`, which is
  a distinction Resend does not publish: `last_event` is `bounced` and says no
  more. What the card *can* name is its denominator, which is the thing four
  different bounce rates disagree about — see below.

### Nine cards were added, because the data is richer than the catalog assumed

**"Unread in the inbox" is its own card and is not the queue.** "Waiting on a
reply" is work — somebody wrote last and you have not answered — and "unread" is
mail nobody has opened, most of which here is a promotion. They differ by an
order of magnitude, and a board carrying one under the other's name would be
describing a crisis that is a mailing list. The number is Gmail's own counter
from `labels.get` and is exact; the same question asked as a search comes back
with an estimate, and on this mailbox that estimate said 201 against a true 263.

**"Mail arriving, by day" draws received only.** Sent mail runs about twenty
times smaller here — 46 a day arriving against 2 written — and on a shared axis
starting at zero that is a flat line along the bottom impersonating a
measurement. It is the call `gsc.trend` makes about clicks against impressions.
Today is left off and the caption says how many complete days are in it: the
mailbox will receive more of today after the reading, so drawn beside finished
days it is a cliff that never happened. The sent figure is named in the caption
instead, explicitly as counted apart and never added.

**"Where the queue is" closes on a row saying the rows do not add up.** A thread
can carry INBOX and a hand-made label at once, so a total would double-count it
— the rule GitHub's unique visitors and Cloudflare's visitors follow, in a place
it is much easier to get wrong because labels look like folders. A label the
scan never reached prints a dash rather than a zero: nobody looked is not the
same as nothing is waiting.

**"The mailbox, and the token" says the uncomfortable thing out loud.** The
credential carries `gmail.modify` — archive, label, trash — because workdash's
own mail page sends replies with it, and a dashboard holding that owes its
reader the sentence. The card prints the scopes Google reported for the grant
and, beside them, why it does not matter: the provider has one HTTP entry point,
it hard-codes GET and takes no body, so there is no send, archive or trash path
in it at all. It is Cloudflare's "What this token will not read" pointed the
other way — that one is about power the token lacks, this one about power it has
and the code never uses.

**"Sending domains" uses Resend's own word for each state** rather than a
green/red pair: "pending" is a domain part-way through verification and "failed"
is one that will not send, and only the second is a thing to fix tonight. A
domain that is verified but has an unverified DNS record under it reads as a
warning, because that is a domain about to stop sending.

**"DNS behind the sending" exists because the listing cannot show it.** `GET
/domains` says "verified"; only the per-domain call carries the records and
their individual statuses. This is the only place on the board where a domain
that is verified today and has a pending DKIM record is visible as such. A
domain whose records could not be read prints as unread rather than as zero
records, which is a different and much more alarming claim.

**"What became of the mail · 30d" puts `suppressed` on its own line**, outside
every rate. A suppression is Resend declining to send at all, to an address
already on its own list — it never reached a mail server, so folding it into the
bounce denominator would make a domain's bounce rate FALL every time Resend
refused to try. Anything Resend has not finished with is "in flight" rather than
a failure, because a queued email has not gone wrong. And the card names opens
and clicks as **not measurable** rather than leaving them off: tracking is
switched off on every domain here, so Resend never writes an `opened` event and
an open rate would be a figure about a feature nobody turned on.

**"Sends by day" carries no partial-bucket caveat, and the difference from
Gmail's line is real.** An email Resend has accepted is a row the moment it
exists, so today's bar is complete for everything sent so far. What can still
change is each row's own `last_event`, which a re-read corrects in place.

**"What the mail APIs will not say"** is the same evidence card the costs board
carries for Replicate and the traffic board for Cloudflare: the request that was
made, the answer that came back, and the date it was checked. A reader looking
for an open rate or a monthly send allowance finds out why there isn't one
instead of re-pasting a perfectly good key.

### The bounce rate's denominator is on the card, because there are three

It is over mail that actually reached a mail server — delivered + bounced +
complained — and not over everything sent. The card prints `61 of 947 that
reached a server` rather than a bare percentage, and names the worst domain
beside it, because a 6.4% portfolio rate made of one domain at 15% and eight at
zero is a fact about one domain.
