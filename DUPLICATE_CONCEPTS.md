# Duplicate concepts in One Person Company

96 findings from an eight-auditor read-only audit of commit d372f93. Every one was verified by reading both sides in the source. Severity: FIX-FIRST = wrong data, a bypassed gate or a double-send; DISAGREEING = two surfaces already publish different answers; DRIFT-RISK = copies equal today, one edit from diverging.

## Runs & runtime

### 1. A run's spend, read from budget_usage  — **FIX-FIRST**

- **Where:** `runtime/loop.ts:475` spentOn  |  `pipeline/nightly.ts:295` costOf
- **What breaks:** Identical query, opposite answer on an unpriced box: costOf returns null (the stage shows "unknown"), spentOn returns 0. The runtime tool loop reads "no price configured" as "spent nothing", so its turn_usd ceiling silently never trips.
- **Single home:** spentOnRun(runId): number | null in runtime/budgets.ts, beside usageReport()

### 2. Settling rows a killed process left open  — **FIX-FIRST**

- **Where:** `runs/store.ts:253`  |  `agentcore/store.ts:207`  |  `pipeline/nightly.ts:672`  |  `chief/manifest.ts:200` repairs nothing
- **What breaks:** Copied as a pattern rather than a helper, so the fourth table was forgotten. chief_rounds' own migration says an open row is a crash and is visible as one, but nothing ever closes it, and this box restarts on every source save. A round from weeks ago still reads as walking.
- **Single home:** One settleOpenRows({table, openWhen, set}) called from each area's onStart, with chief added

### 3. Local time, and the daily schedule around it  — **DISAGREEING**

- **Where:** `pipeline/registry.ts:480,431,513`  |  `chief/rounds.ts:123,111,143`  |  `proactive/briefing.ts:141,97,89`  |  inline `stages-called.ts:123`
- **What breaks:** Already drifted on zone fallback: chief and pipeline store null (system zone implied), briefing substitutes systemZone(). Briefing skips dueDay entirely, so it has no missed-day catch-up. A DST fix is a four-file edit.
- **Single home:** One runtime/schedule.ts owning zoned, zoneIsReal, nextRunAt, dueDay and dailySchedule(pluginId)

### 4. Consuming a ChatStreamEvent into a finished turn  — **DISAGREEING**

- **Where:** `chat/runs.ts:330-401`  |  `runs/executor.ts:525-558` + Session.toolEvent `:240-256`
- **What breaks:** Chat keeps reasoning frames, the executor drops them; chat records usage once, the executor sums. The settling guard that stops a cancel from lying about a landed answer exists only on the chat side, so a run cancelled in the last instant of its final turn is still written cancelled.
- **Single home:** One consumeTurn(stream, sink) in chat/; the two callers differ only in the sink

### 5. GET /api/runs' wire shape, typed twice on the client  — **DISAGREEING**

- **Where:** `client/lib/api/runs.ts:64,132,160,173`  |  `client/lib/api/reports.ts:730,754,777`
- **What breaks:** AgentRun is missing paused and canResume, both shipped by the server's shapeRun. RunKindInfo.inputs.kind lacks “select”, so every widget typed through RunsReport mis-draws a select input as a text box.
- **Single home:** client/lib/api/runs.ts; reports.ts re-exports it

### 6. Which app page a run of kind X lives on  — **DISAGREEING**

- **Where:** `shared/runRoutes.ts:4` runPage  |  `subagents/store.ts:59-72,85` appForKind  |  `client/components/org/roleLook.ts:67,80`
- **What breaks:** The three disagree today. shotsqa: runPage says ops, the server map says “shotsqa” (no such role). campaign: the server sends a link the client's table has no entry for, so the rail refuses to draw it. A new kind must be added in three files or it silently links nowhere.
- **Single home:** shared/runRoutes.ts exports both appForKind and runPage; the other two import

### 7. The run-status vocabulary, and the word a cancel replies with  — **DRIFT-RISK**

- **Where:** `runs/store.ts:22`  |  `agentcore/store.ts:43`  |  `client/lib/api/runs.ts:35`  |  `client/lib/api/reports.ts:719`  |  inline `client/lib/api.ts:2755`; cancel replies `executor.ts:472` “cancelling” vs `chat/runs.ts:616` “stopping”
- **What breaks:** Five declarations of one five-member union. A sixth status can be added to a table without any of them noticing -- agent_runs already carries paused as a bare column because the enum could not be extended. Two different words for the in-between state, neither declared by any type.
- **Single home:** One RunStatus + RUN_STATUSES in a shared module; one word for the in-between state

### 8. Two general key-value settings stores  — **DRIFT-RISK**

- **Where:** `plugin_config` via db.ts:2976  |  `runtime_settings`, open-coded SQL in runtime/budgets.ts:9,21  |  pipeline/nightly.ts:708  |  stages-called.ts:130  |  chief/rounds.ts:542
- **What breaks:** No accessor module, so the same upsert string is retyped in four files and keys are bare literals: 'rounds-last-due' is written from two different areas, and a typo in either makes the round run twice on the day the pipeline is switched off. None of it appears on the settings surface plugin_config gets free.
- **Single home:** Move the four keys into plugin_config, or give runtime_settings one accessor with key constants

### 9. The ledger of what a scheduled walk considered  — **DRIFT-RISK**

- **Where:** `chief_rounds.notes` JSON + counters (rounds.ts:441)  |  `chief_joblog` rows (rounds.ts:286)  |  `pipeline_stage_results` with a different outcome enum
- **What breaks:** One round writes each decision twice. chief_rounds.skipped counts per venture, chief_joblog writes skipped per role, so the header count and the drill-down disagree on any round where some roles were busy. Two outcome vocabularies that do not line up.
- **Single home:** One walk_items shape shared by rounds and pipeline stages; derive the counters from it

### 10. Folding agent_runs into done/failed/running/queued  — **DRIFT-RISK**

- **Where:** `runs/store.ts:126` countsByKind  |  `subagents/store.ts:172` tallies
- **What breaks:** tallies() adds WHERE venture_id IS NOT NULL, so app-card counts and worker-card counts for one kind differ by exactly the portfolio-wide runs, with nothing saying so. A fifth status is silently dropped by whichever fold is not updated.
- **Single home:** One runTallies({groupBy}) in runs/store.ts; subagents passes [kind, venture_id]

### 11. One run shown under a chat, typed three times  — **DRIFT-RISK**

- **Where:** `chat/inflight.ts:62` ChildEvent  |  `subagents/store.ts:343` RunChild  |  `client/lib/store.tsx:67` SessionChild
- **What breaks:** ChildEvent lacks app and to, so the live SSE frame cannot draw a linkable child -- the client throws the payload away and re-polls. The frame is now a bare “something changed” ping wearing a typed payload's clothes.
- **Single home:** One RunChild used by both doors; rename the SSE frame to the ping it actually is

## Analytics & search

### 12. The Umami 30-day headline for one website  — **FIX-FIRST**

- **Where:** `umami_windows` (analytics/store.ts:193, every 6h)  |  `web_site_windows` (webanalytics/store.ts:270, 12h rotation)
- **What breaks:** windows(30) and windowAt(30,0) compute the identical span. Two clocks means the rows are read hours to days apart, so /api/umami and /api/webanalytics publish different visitor counts for the same site and window -- and both are registered as agent skills on the umami plugin, so an agent's answer depends on which skill it picks.
- **Single home:** One site_windows table keyed (account, website, window_days, offset_days), one collector

### 13. Conversion events for a venture, and the ratio between steps  — **FIX-FIRST**

- **Where:** `growth/cro.ts:184,192,267` (umami_top, occurrences)  |  `webanalytics/attribution.ts:405-425` (web_events, participants)
- **What breaks:** umami_top counts occurrences, web_events counts participants -- the schema records the measured gap as 5,978 vs 4,434 on the live instance. cro.ts divides occurrences by summed sessions over a window that includes today's partial day, overstating the step by roughly 35%, and the header of the table it sums says those sessions cannot be summed. webanalytics refuses to call its own ratios conversion at all.
- **Single home:** One conversion-step reader over web_events; growth/cro.ts consumes it

### 14. Reducing a hostname to the thing ventures compare on  — **FIX-FIRST**

- **Where:** `growth/pages.ts:60`  |  `signals/presence/sources.ts:150`  |  `signals/backlinks/sources.ts:97`  |  `seoops/settings.ts:112`  |  `webanalytics/attribution.ts:49`  |  canonical `ventures/entities.ts:92,118`
- **What breaks:** Three incompatible semantics and two disagreeing public-suffix lists. seoops matches subdomains bidirectionally, so blog.x.com swallows x.com -- the canonical hostMatch calls its one-directional rule the whole of the protection against filing two businesses under one name. example.co.in is one domain to growth and two to presence.
- **Single home:** ventures/entities.ts hostOf + hostMatch, plus one shared suffix list, imported everywhere

### 15. Meta daily delivery: spend, impressions, clicks  — **DISAGREEING**

- **Where:** `meta_ad_days` (providers/meta.ts:953, account level)  |  `ad_days` (providers/meta.ts:2015, ad level)
- **What breaks:** The same insights for the same 30 days from the same token, at two grains. /api/meta sums one, webanalytics attribution sums the other. The ad-level read is capped at 1000 rows and tidies deleted ads, so it silently under-counts -- and nothing compares the two.
- **Single home:** Keep ad_days as the grain and derive account-day totals from it; or name one authoritative

### 16. Creative fatigue: CTR fall plus frequency rise  — **DISAGREEING**

- **Where:** `growth/ads.ts:88,78,84,253-273`  |  `webanalytics/fatigue.ts:33-44,140-190`
- **What breaks:** The constants are copied verbatim (the file says so). But the two “weeks” differ: fortnight() takes the last 14 rows present, so missing delivery days slide the window, while fatigue.ts uses Meta's own two explicit time_range calls. “Click-through is falling” and “fatigued” can contradict each other on the same fortnight.
- **Single home:** Export the bands and the two-week span from the ad_windows definition; growth imports

### 17. Striking-distance query  — **DISAGREEING**

- **Where:** `routes/gsc.ts:310` position > 10 && &le; 20, no floor  |  `growth/serp.ts:108` position 5–20, impressions >= 3
- **What breaks:** Two published definitions of the same recommendation over the same rows. A query at position 7 is a target for the teardown and invisible on the dashboard; a 1-impression query at 15 is on the dashboard and excluded from the teardown.
- **Single home:** One exported strikingQueries(property, …) used by the route and the run

### 18. An owner-confirmed edge from a third party to a venture  — **DISAGREEING**

- **Where:** `venture_links` + ventures/entities.ts:448 suggestFor  |  `campaign_ventures` + webanalytics/attribution.ts:125-210 suggestions()
- **What breaks:** Two link tables, two accept flows, two suggestion engines with different matching rules and different source vocabularies -- campaign_ventures' own header says it is venture_links' contract, deliberately. Anything asking what belongs to a venture must query both; the map UI shows only one.
- **Single home:** venture_links with plugin = 'meta-campaign' plus an evidence column -- one edge table

### 19. Umami referrer ranking over 30 days  — **DRIFT-RISK**

- **Where:** `umami_top` kind='referrer', top 20  |  `web_dimensions` dimension='referrer', up to 500
- **What breaks:** Same endpoint, same span, same population, two clocks and two depths. Referrer shares and “top referrer” disagree between pages with no way to tell which read is stale.
- **Single home:** Derive the ranking from web_dimensions; drop kind='referrer' from umami_top

### 20. The competitor set for a venture  — **DRIFT-RISK**

- **Where:** `growth_serp.competitors` (mechanical, per query, from SearXNG)  |  `competitor_profiles` (runs/executor.ts:811, model-written)
- **What breaks:** Two registries that never join: a domain outranking the venture on every teardown query never appears in competitor_profiles, and a profiled competitor carries no evidence it ranks. Two disjoint answers to one question.
- **Single home:** One competitor table keyed on registrable domain; the teardown files discovered domains

### 21. Referring domains for a host  — **DRIFT-RISK**

- **Where:** `growth/authority.ts:108-135` (largest single source wins)  |  `signals/backlinks/routes.ts:70` (combined is null on principle)
- **What breaks:** The backlinks page refuses to publish one number; the authority estimate publishes a max and feeds it into a keyword-difficulty ceiling. When a source's index changes the two surfaces move differently and neither cites the other's rule.
- **Single home:** One accessor returning {best, source, perSource, combined: null}

### 22. The Search Console window length  — **DRIFT-RISK**

- **Where:** `providers/gsc.ts:92` WINDOW_DAYS = 28  |  `seoops/settings.ts:44` WINDOW_DAYS = 28
- **What breaks:** Equal today. A change in one leaves baseline readings and the GSC route describing windows of different lengths while both caption them “Search Console's window”.
- **Single home:** Import WINDOW_DAYS from providers/gsc.ts

## Outbound messaging

### 23. Claiming an approved item before the network call  — **FIX-FIRST**

- **Where:** `publishing/publish.ts:163` bare UPDATE, no status guard, no transaction  |  correct twin at `mailflow/outbox.ts:373-391` (BEGIN IMMEDIATE, re-read, guarded WHERE)
- **What breaks:** The scheduler tick is guarded only by an in-process flag that the manual routes (routes.ts:432,449) bypass. A tick submitting item X while you press Publish on X: both read a null external_id, both pass CONSENTED, both call Meta. Two identical posts. This is the exact failure the file says it is arranged to prevent -- prevented for the crash case, not the concurrent one.
- **Single home:** One transactional claim helper (mailflow's pattern) used by scheduler and routes; drop 'publishing' from CONSENTED

### 24. Do not write to this address  — **FIX-FIRST**

- **Where:** `nurture_optouts` checked at draft time only (planner.ts:110, sequences.ts:244,382,444)  |  `mailflow/outbox.ts:188,383` floor + daily cap, the only suppression at the door
- **What breaks:** Someone opts out after a draft was written. The draft is approved, sendApproved never consults nurture_optouts, and the mail leaves -- while the Nurture page reports them as opted out.
- **Single home:** sendApproved re-checks the opt-out table alongside the floor, as it re-checks everything else

### 25. Have we already made this content for this venture  — **DISAGREEING**

- **Where:** `socialfeed/novelty.ts:382,273` durable gate over content_history  |  `publishing/campaigns.ts:283` a “do not repeat these angles” line in the prompt
- **What breaks:** The migration says outright that the prompt version is not a constraint and is the thing content_history replaced. A campaign fans out nine variants duplicating what the autopilot published, at full Replicate cost, recording no refusal -- and nothing a campaign makes enters content_history, so the autopilot re-derives the same topics next morning.
- **Single home:** socialfeed/novelty.ts -- campaigns call checkTopic before and remember after

### 26. Is this Resend sending domain verified  — **DISAGREEING**

- **Where:** `resend_domains.status` (collector, providers/resend.ts)  |  `nurture_send_identities.verified` (identities.ts:253,285, same API call)
- **What breaks:** Identical fact from an identical call, cached twice on two refresh triggers. A domain that lapses to failed updates one table on the collector's schedule while the identity still says verified, so the draft card shows no warning and the send is attempted. Two screens can contradict each other about one domain.
- **Single home:** resend_domains; verificationWarning reads it by name, verified_at becomes “last asked”

### 27. Which venture is this Gmail thread about  — **DISAGREEING**

- **Where:** `routes/mailbox.ts:325` matches Resend sending-domain chips  |  `mailflow/triage.ts:171` matches ventures.host
- **What breaks:** Same input, same question, two different authority lists -- and mailbox.ts claims outright the decision is made there and nowhere else. A venture with a host but no Resend domain is attributed by Triage and invisible to the mailbox filter; the reverse for a stale host. The counts disagree with no way to tell which is wrong.
- **Single home:** One ventureForThread(recipients, from) taking both lists, consumed by routes/mailbox.ts

### 28. The Facebook Pages this box can see  — **DISAGREEING**

- **Where:** `meta_pages` (collector, PAGE_FIELDS)  |  `publish_destinations` (manual probe, different field set)  |  `social_accounts` (collector, its own copy incl. venture_id)
- **What breaks:** Three one-row-per-Page tables on three refresh triggers. A Page added since the last probe is invisible to publishing while listed on the Meta page; a Page removed from the token still shows as an enabled destination and fails at submit. Re-mapping a Page to another venture leaves social_posts filed under the old one.
- **Single home:** publish_destinations owns identity and mapping; meta_pages keeps measurements; social_accounts keeps read-state

### 29. Local time and quiet hours for outbound timing  — **DISAGREEING**

- **Where:** `publishing/settings.ts:51,54,64`  |  `video/autopilot.ts:140,142,170`  |  `proactive/briefing.ts:88,97`; three separate timezone config keys
- **What breaks:** The owner sets a timezone three times. Set once, the other two fall back to the machine zone -- the autopilot generates on Dublin time, the blackout window applies on UTC, the briefing arrives an hour off. nextSlot and nextRunAt are the same 48-step loop with the same DST argument in both comments.
- **Single home:** One time.ts with validZone, localZone, wall, nextLocal, and one global timezone setting

### 30. Two outbound lifecycles, two ways to pin an approval  — **DRIFT-RISK**

- **Where:** `mailflow_outbox.status` + frozen approvalContent (outbox.ts:344,379)  |  `publish_items.status` + un-approve-on-edit (items.ts:424)
- **What breaks:** Same states under different names (sent/published, dismissed/cancelled, sending/publishing) and two opposite solutions to “an edited document is a different document”. No shared type, so nothing checks them against each other, and publishing's guarantee holds only while patchItem is the sole editor -- socialfeed/ugc.ts:599 and publishing/autopilot-hook.ts:110 already write around it.
- **Single home:** One shared OutboxStatus union and one approvalContent snapshot, extended per channel

### 31. fromAddress -- the same helper defined twice  — **DRIFT-RISK**

- **Where:** `mailflow/outbox.ts:221`  |  `nurture/identities.ts:109`
- **What breaks:** Byte-identical bodies, both live. Low impact today; one edit from two answers to “what address does this mailbox send from”, which is the field a send is refused on.
- **Single home:** mailflow/outbox.ts -- identities.ts already imports validAddress from that area

## Video & Studio

### 32. The newest screenshot of this venture  — **DISAGREEING**

- **Where:** `ventures/capture.ts:433` lastShot (not exported)  |  `security/shotsqa.ts:265`  |  `seoops/vision.ts:439`
- **What breaks:** They already disagree: shotsqa takes the newest row, vision adds “path IS NOT NULL AND error IS NULL” and takes the newest successful one. After one failed capture the same QA report prints “the last attempt failed” with every pixel check unchecked, beside a model verdict on last week's perfectly good picture.
- **Single home:** Export lastShot / lastRendered from ventures/capture.ts; the other two call it

### 33. Launching headless Chrome  — **DISAGREEING**

- **Where:** `ventures/capture.ts:189-205,375`  |  `videoplus/chrome.ts:146-160,134`  |  `seoops/brand.ts:291`  |  `runs/pdf.ts:211-233`
- **What breaks:** findBrowser is shared; everything after it is copied four times and has drifted three ways. runs/pdf.ts uses a named, never-deleted chrome-profile dir instead of mkdtemp+rmSync -- exactly the ProcessSingleton contention capture.ts documents -- and leaks one profile directory per paper, for ever. The stderr filters and flag sets also differ.
- **Single home:** One chrome.ts exporting findBrowser, withProfile, baseArgs, shoot and reason

### 34. One Replicate prediction, end to end  — **DISAGREEING**

- **Where:** `ventures/studio.ts:392,415,427,480,485` makeImage  |  `socialfeed/ugc.ts:191,211,239,337` animate; firstUrl defined twice (`studio.ts:506`, `ugc.ts:355`)
- **What breaks:** Same endpoint, same Prefer: wait header, same validation regex, same recursive output walker. The two halves of one UGC job behave differently for no stated reason: studio.ts gives up on a still-queued prediction, ugc.ts polls with a retry budget -- and a single run calls both copies.
- **Single home:** One providers/replicate.ts predict({model, input, poll}) with firstUrl beside it

### 35. Finding an external binary on this machine  — **DISAGREEING**

- **Where:** `video/tools.ts:59,61,77`  |  `runs/typst.ts:86,98,115`  |  `ventures/capture.ts:98,113,138`  |  `videoplus/moments.ts:44,59`
- **What breaks:** Identical shape, identical stated rule, onPath byte-for-byte the same in two files. Typst is discovered under two different settings keys -- video/tools.ts reads the video plugin's, runs/typst.ts reads Papers'. Set the path under Papers and every video still renders captionless, with a message telling you to install typst you already have.
- **Single home:** One tools/find-binary.ts with findBinary({name, aliases, candidates, configKeys})

### 36. The set of frame shapes this box supports  — **DISAGREEING**

- **Where:** `video/assemble.ts:51` ASPECTS (the real home)  |  hardcoded `videoplus/scenespec.ts:200`  |  `ventures/studio.ts:146` FORMATS  |  inverse inline at `socialfeed/ugc.ts:456`
- **What breaks:** Add a fourth aspect and the video routes accept it, then scenespec rejects it and silently renders 9:16 -- a motion spec in the wrong shape. ugc.ts falls through to “story” for any aspect the Studio does not know, so a new aspect makes UGC stills silently portrait.
- **Single home:** ASPECTS in video/assemble.ts; scenespec validates against it, one shared formatForAspect()

### 37. Reading a PNG's width and height  — **DRIFT-RISK**

- **Where:** `ventures/capture.ts:399`  |  `seoops/vision.ts:415`  |  `publishing/assets.ts:138`  |  `security/shotsqa.ts:83`  |  `ventures/enrich.ts:783`
- **What breaks:** Five hand-rolled IHDR readers at three strictness levels for the same file. The dimensions stored on venture_shots, judged against shotsqa's floors, and priced into vision tokens are three independent measurements of one image.
- **Single home:** One imageDimensions(bytes) (PNG + JPEG, as assets.ts already does)

### 38. The venture-screenshot viewport, 1280×800  — **DRIFT-RISK**

- **Where:** `ventures/capture.ts:78`  |  `seoops/brand.ts:288`; judged against a third floor at `security/shotsqa.ts:235`
- **What breaks:** Both drive Chrome at the same site for the same class of artefact and type the number twice. Change one and the two readings stop being comparable, while shotsqa's dimension check is calibrated against a constant it does not import.
- **Single home:** One exported SHOT_VIEWPORT in ventures/capture.ts

### 39. Ask the Studio to make a post  — **DRIFT-RISK**

- **Where:** `video/autopilot.ts:612` makePost  |  `publishing/campaigns.ts:523` makeVariant
- **What breaks:** Same call, same body shape, different hardcoded formats and different error unwrapping (campaigns.ts even says autopilot makes the same call for the same reason). A change to the Studio's response shape has to be found twice.
- **Single home:** A createPost() exported from ventures/studio.ts beside studioRoutes

## Money

### 40. Electricity cost for a month  — **FIX-FIRST**

- **Where:** `finance/power.ts:400-424` seeded into finance_expenses for the previous month  |  `finance/profit.ts:366` recomputed live for the requested month, in the same payload
- **What breaks:** The portfolio P&L returns the same euros twice on two different month bases, and nothing warns that power is already inside ledger.monthly. Any card adding “ledger + power” double-counts, and the two figures disagree by construction whenever the current month differs from the last. Venture margins are charged the stale number while the page shows the live one.
- **Single home:** One producer, powerLines(month) -- either stop seeding the ledger, or drop power from the P&L payload

### 41. App Store and Play payout money for a month  — **FIX-FIRST**

- **Where:** `routes/mobile.ts:149,238,384` (every row, no gates, 2dp)  |  `routes/mobileRevenue.ts:31-65` (month + report-state gate, 2dp)  |  `finance/attribution.ts:85-119` (month, no gate, 4dp)
- **What breaks:** Three summations of the same columns, and mobileRevenue is mounted inside mobile.ts -- one API tree, two answers for one month. Finance uses a third rule ignoring the report gate, so a venture's revenue can include payouts /api/mobile/revenue deliberately withholds, and every margin and allocation basis inherits it.
- **Single home:** One helper returning {month, currency, net} with the report gate applied once

### 42. A venture's Stripe MRR  — **FIX-FIRST**

- **Where:** `finance/attribution.ts:153-164` active only, per currency  |  `pipeline/evidence.ts:127-171` active || trialing, stamped mrrUsd regardless of currency
- **What breaks:** One venture, two MRRs. evidence.ts counts trials -- which routes/stripe.ts documents as explicitly not MRR (“counted in as revenue, it has to come back out as churn”) -- so the pipeline's proposals rest on an inflated figure, and it labels a non-USD amount as USD. The attribution figure also drives the mrr-share split, so the gap propagates into allocated revenue.
- **Single home:** ventureMrr(ventureId) in finance/attribution.ts; pipeline/evidence.ts imports it

### 43. What a Hetzner box costs per month  — **DISAGREEING**

- **Where:** `routes/hetzner.ts:72,117` monthly_eur ?? 0  |  `finance/expenses.ts:432-465` null amount, excluded, counted as unpriced
- **What breaks:** The route reports a confident low number; the ledger reports a smaller number plus unpriced: n. /api/costs points readers at the route figure as the euro spend. Once you correct an amount in the ledger, owner_fields pins it and the two disagree permanently. finance_expenses_source also treats NULL source_ref as distinct, so an owner-typed “Hetzner ue-api” row sums alongside the seeded one with no dedupe.
- **Single home:** One hetznerMonthlyCost(); the route reports the ledger figure and flags owner overrides

### 44. Stripe settled revenue per currency  — **DISAGREEING**

- **Where:** `routes/stripe.ts:294-354` rolling window, key “usd”, 2dp  |  `finance/attribution.ts:181-202` calendar month, key “USD”, 4dp
- **What breaks:** Both reduce stripe_ledger_days to the same five fields. The headline on /api/stripe and on the portfolio P&L disagree in rounding and window, and key one currency two ways, so nothing downstream can join them -- a future merge silently holds one currency under two keys.
- **Single home:** One stripeSettled(from, to) parameterised by window, returning upper-cased codes

### 45. Model spend -- the same dollars metered twice  — **DISAGREEING**

- **Where:** `runtime/budgets.ts:38,51,69` tokens × flat usdPerMillion into budget_usage, charged to margins at `finance/profit.ts:94-123`  |  `routes/costs.ts:98-286` the provider's invoiced dollars
- **What breaks:** One real dollar, two figures, two pricing rules. The P&L charges venture margins the local estimate while the invoice sits on /api/costs and nothing reconciles them. budgets.ts also reserves at the byte count and corrects only when usage returns, so the local figure is systematically the wrong one. Anyone assembling “total spend” from ledger + costs + P&L counts it twice.
- **Single home:** budget_usage stays the enforcement meter; profit.ts attributes cost from the provider tables

### 46. Which venture owns this Stripe product  — **DISAGREEING**

- **Where:** `ventures/links.ts:71` canonical  |  `customers/venture.ts:54-91` trims, lowercases, falls back to a sole venture  |  `finance/attribution.ts:54-61` exact, case-sensitive, no fallback
- **What breaks:** A product linked with different capitalisation attributes a dispute in the customers area and produces no revenue line in finance -- so a venture shows churn cases and zero revenue. The sole-venture fallback existing on one side only means the same dispute is attributed on one page and unattributed in the P&L.
- **Single home:** ventures/links.ts exports normaliseEntity + ventureOfEntity(plugin, entity)

### 47. Rendering an amount, and normalising its currency code  — **DISAGREEING**

- **Where:** `finance/money.ts:38,44` (the only one that normalises)  |  eight local copies: routes/stripe.ts:61, adsense.ts:36, costs.ts:87, mobile.ts:52, mobileRevenue.ts:9, activity/leakage.ts:53, customers/disputes-routes.ts:37
- **What breaks:** The same rows come out at 2dp on one route and 4dp on another, so two documents about one month never tie out to the cent. Currency codes are upper-case in finance and Stripe's lower-case everywhere else, so a per-currency map merged across areas holds one currency under two keys.
- **Single home:** Promote finance/money.ts money + currencyCode to a shared module; delete the seven copies

### 48. Stripe cents to major units  — **DRIFT-RISK**

- **Where:** `providers/stripe.ts:516` toFixed(6)  |  `customers/events.ts:64` toFixed(2), with a comment claiming it is the same conversion
- **What breaks:** For one failed invoice the Telegram amount and the recovery case amount can differ in the last places. The comment asserting they match is false.
- **Single home:** Export money from providers/stripe.ts; customers/events.ts imports it

### 49. Play report month key, YYYYMM to YYYY-MM  — **DRIFT-RISK**

- **Where:** `finance/attribution.ts:105`  |  `routes/mobileRevenue.ts:28,34`  |  `routes/mobile.ts:69,75`  |  `mobilehealth/play.ts:123`
- **What breaks:** Five hand-rolled conversions, five places to get the slice offsets wrong, and each route decides independently which spelling it publishes. A key that fails to match yields a silent zero, not an error.
- **Single home:** One pair of helpers beside isMonth/daysInMonth in a shared time module

### 50. Ledger dispute money for a window  — **DRIFT-RISK**

- **Where:** `activity/leakage.ts:117` (default 30d)  |  `customers/disputes-routes.ts:104` (default 90d)
- **What breaks:** Byte-for-byte the same reduction, and both documents print the same sentence describing it. The two are otherwise well coordinated -- but a fix to one (a sign convention, a new fee bucket) leaves the other reporting the old number.
- **Single home:** A ledgerDisputes(fromDay) helper in customers/store.ts used by both

## Infra & security

### 51. Is this request the owner's own browser  — **FIX-FIRST**

- **Where:** `security/gate.ts:157-172` browserShaped  |  `security/gate.ts:300-313` browserRejection; the allowed-port set is re-typed in both
- **What breaks:** They disagree on the case that matters. browserShaped treats a request with no Origin and no Sec-Fetch-Site as not a browser; browserRejection allows it. So a bare curl -XPOST with no headers passes requireBrowser -- the only guard on /api/deploy/service/install, /service/uninstall, /plan/write and /api/publishing/items/:id/publish. None of those prefixes is on OWNER_SURFACE, so nothing else catches it.
- **Single home:** One exported browserShaped + one ALLOWED_ORIGIN_PORTS; browserRejection calls it

### 52. The owner surface -- writes an agent may not perform  — **FIX-FIRST**

- **Where:** `gate.ts:97-108,196-209` global deny list  |  `gate.ts:314-326` requireBrowser / requireOwner, applied per route in security, deploy, mailflow, nurture, publishing
- **What breaks:** Three different rules for one idea. ownerSurfaceRefusal accepts owner-key or browser-shape or session; requireOwner demands a password and a live cookie and refuses the owner key; requireBrowser demands neither. /api/deploy and /api/publishing writes carry only the weakest, and are invisible to agentRefusal(), OWNER_SURFACE_PREFIXES, the isolation report and npm run doctor -- which tell you these are exactly the routes an agent cannot reach.
- **Single home:** One table: every owner-only prefix in OWNER_SURFACE, with requireBrowser/requireOwner as strictness levels within it

### 53. A registered domain  — **FIX-FIRST**

- **Where:** `domains` (db.ts:201, read by allDomains)  |  `cloudflare_registrar` (db.ts:1509)
- **What breaks:** Identical columns, identical meaning, two collectors that never learned about each other. /api/domains reads only the first, so a name registered at Cloudflare is missing from the portfolio total, the lapsed and expiring counts, autoRenewOff, unlocked and the renewal runway. routes/cloudflare.ts then classifies that zone as “no connected registrar holds this name” while printing the same name in its own registrar block -- and the venture map emits two entity shapes for one thing.
- **Single home:** Make Cloudflare Registrar a source in the domains table like Dynadot and Spaceship

### 54. How long history is kept  — **DISAGREEING**

- **Where:** `config.ts:24` OPC_RETAIN_DAYS, applied in db.ts:3367  |  hardcoded in `ops/uptime.ts:54`, `ops/fleet.ts:524`, `security/workstation.ts:584`, `deploy/leases.ts:356`
- **What breaks:** /api/health reports retainDays from config as if it described the box; it does not describe uptime_checks, fleet_samples, fleet_disks, fleet_containers, workstation_state or job_leases, which no setting can reach. And with no single home, three tables were simply forgotten: security_snapshots (whole JSON documents, one per incident), security_shotsqa and backup_runs have no prune anywhere.
- **Single home:** One retention registry (table → window → source) that prune() walks and /api/health reports verbatim

### 55. Where an ssh private key lives, and who owns it  — **DISAGREEING**

- **Where:** `ops/fleet.ts:75-102` keyPath / writeKeyFile  |  reaper `ops/fleet.ts:115-126`  |  other writers `security/workstation.ts:309,516`, `security/snapshots.ts:391`  |  path rebuilt at `ops/backups.ts:376`
- **What breaks:** reapKeyFiles() deletes the workstation account's key on every fleet collection, because a workstation id is never in accounts.list(“fleet”). It is masked only because workstation.ts rewrites the file before each use -- anything that reads the path without writing first (backups.ts only existsSyncs it) is a latent failure, and the duplicated path string will stop resolving if keyPath changes.
- **Single home:** One module exporting keyPath/writeKeyFile keyed by plugin id; the reaper takes the union

### 56. The order migrations are applied in  — **DRIFT-RISK**

- **Where:** numeric prefixes across 30 area files  |  the spread array at `integrations/migrations.ts:33`
- **What breaks:** Two statements of which step runs before which, and they already disagree in four places: chief (140) before mailflow (120), videoplus (330) before growth (150), agentcore (200) before deploy (210), and the inline 190–192 steps run last. No cross-area dependency is violated today -- but the next area that alters a neighbour's table will pick its number from the convention and get the wrong order.
- **Single home:** Sort INTEGRATION_MIGRATIONS by name at build time, or drop the prefixes and document the array

## Knowledge & alerts

### 57. A durable venture-scoped fact the agent learned  — **FIX-FIRST**

- **Where:** `chief/skills.ts:186` remember → chief_memory  |  `knowledge/skills.ts:166` propose_fact → knowledge_facts; both concatenated into one system turn at `chat.ts:443-455`
- **What breaks:** Opposite safety rules for the same write. propose_fact lands in the proposed tier: never exported, never given to another agent, not true until you confirm it. remember has no tier, no evidence field and no confirmation gate -- its only guard counts digits and passes any prose. An agent that wants “Example App 1 supports webhooks” in every future prompt writes it via remember and bypasses the entire quarantine, which the knowledge migration names as the exact failure it exists to prevent.
- **Single home:** knowledge_facts owns product and venture claims; remember refuses a venture argument and redirects

### 58. Reducing a hostname to the thing ventures compare on  — **FIX-FIRST**

- **Where:** `signals/backlinks/sources.ts:97` www-strip only  |  `signals/presence/sources.ts:151`  |  `activity/link.ts:72` label-set eTLD+1  |  `growth/pages.ts:62` a different MULTI_TLD
- **What breaks:** Four bodies under one name, two of them in sibling directories of one area. a.b.gov.br resolves three ways; x.co.in resolves two. The same domain is attributed to a venture on one page and to nothing on another, and signals' two collectors disagree about whether a backlink is ours.
- **Single home:** One shared/host.ts with hostOf + registrable + one suffix list, and one ventureForHost()

### 59. The address of a figure, read on a schedule  — **DISAGREEING**

- **Where:** `proactive` alert_rules + alert_observations + path.ts:31,47  |  `chief` chief_outcomes + chief_outcome_readings + outcomes.ts:97,125,160  |  a third generic timeseries, `readings`, already exists
- **What breaks:** Identical four-column address, identical loopback fetch, identical dot-path resolver -- and they already disagree: proactive supports @count(…), chief does not, so a path copied from a working alert rule silently reads as “nothing at that path” in an outcome. readParams and the URL builder differ too, so one stored address produces two URLs and can produce two numbers.
- **Single home:** One metrics/address.ts; both observation tables collapse into readings keyed by address

### 60. A person the owner corresponds with  — **DISAGREEING**

- **Where:** `people_contacts` + people_days (people/contacts.ts:440)  |  `gmail_correspondents` + gmail_days (db.ts:6570)
- **What breaks:** Two full mailbox scans on every collection against one rate-limited API for the same data, with two identity schemes that cannot be joined -- plain lowercased address versus a 32-char HMAC. The Mail page's contact counts and the People page's are computed over different populations with no way to reconcile them, because one side deliberately destroyed the address.
- **Single home:** people_contacts is the census; gmail_correspondents becomes derived, or goes

### 61. A revenue event the owner should be told about  — **DISAGREEING**

- **Where:** `activity_events` (derived from day tables)  |  `business_events` (from the Stripe events API)  |  `customer_cases`
- **What breaks:** Three rows for one failed payment. The action inbox surfaces one, Telegram pushes another, a workflow opens on the third -- two wordings, two granularities, two independent suppression states. Acknowledging in the inbox changes nothing in customers and vice versa. customers/events.ts reconciles against alert_events but not against activity_events, so the one overlap that is deduped is the one that overlaps least.
- **Single home:** business_events is the exact-grain event; activity_events carries a projection of it

### 62. The salted email-to-identity hash  — **DISAGREEING**

- **Where:** `activity/users.ts:120` hashEmail  |  `nurture/facts.ts:274`, the same expression inline
- **What breaks:** If activity ever changes the scheme -- normalisation, separator, salt rotation -- nurture's lookup silently returns “no product's users document carries this address”, which the file itself documents as meaning a fact about the person. A silent, unfalsifiable wrong answer.
- **Single home:** Export hashEmail from activity/users.ts and import it

### 63. Snoozing  — **DISAGREEING**

- **Where:** `action_inbox_state.snoozed_until` (routes/actionInbox.ts:44)  |  `mailflow_triage.snoozed_until` (triage-routes.ts:246)
- **What breaks:** The inbox reads the triage column for visibility but writes only its own. Snoozing an email from the action inbox hides it there for a hardcoded 24h and leaves it fully visible on the Mail page; snoozing on the Mail page hides it in both. Two states, one item, one direction. The same split exists for done-ness.
- **Single home:** The source table owns the state; the inbox writes through, as its resolve already does

### 64. An open alert  — **DRIFT-RISK**

- **Where:** `proactive/store.ts:272-302` events({openOnly})  |  raw SQL at `routes/actionInbox.ts:10`  |  raw SQL at `pipeline/evidence.ts:250`
- **What breaks:** Three hand-written definitions of one predicate, two of them in other areas that never call the exported reader. They already differ on kind filtering, so a fourth kind added later is included by one and silently excluded by the others. Three counts on three surfaces.
- **Single home:** proactive/store.ts events() / openCount(); delete the two raw SELECTs

### 65. Poll a JSON endpoint the owner's own app publishes  — **DRIFT-RISK**

- **Where:** `product_docs` + ops/products.ts:320  |  `activity_user_docs` + activity/users.ts
- **What breaks:** Same mechanism end to end -- one account, one URL, a bearer token, last document truncated, mapping errors never reported as zero -- and the second migration says so outright. Two plugins to connect for one endpoint pattern, two truncation caps (64 KB vs 1 MB), two validators. A product publishing both counts and users needs two accounts pointing at two URLs on one service.
- **Single home:** One self-published-document collector with a pluggable contract, one docs table

### 66. Is this the same sentence we already stored  — **DRIFT-RISK**

- **Where:** `chief/memory.ts:172` key()  |  `people/commitments.ts:250` normalise() -- byte-identical  |  `knowledge/store.ts:176` fingerprint()  |  `pipeline/synthesis.ts:125` normalise()
- **What breaks:** Four answers to “same statement”, each the identity half of an idempotent write. remember(“Revenue up 12%”) twice creates two notes where knowledge folds them into one; a commitment differing only by a digit dedupes in one store and not the other.
- **Single home:** One shared/textkey.ts with the strict key and the digit-folded fingerprint

### 67. A model-written periodic digest with its evidence  — **DRIFT-RISK**

- **Where:** `briefings` (proactive, day PK, facts JSON)  |  `people_briefs` (people, week PK, figures JSON)
- **What breaks:** Same table shape and the same stated argument arrived at twice: period as primary key for idempotence, evidence beside the prose, null prose with a reason when no provider is configured. Two schedulers, two “already written” checks, two fallback renderers, two model-error surfaces.
- **Single home:** One digests table (kind, period, facts, markdown, model, note) with the assembler per kind

### 68. Per-venture evidence assembled for a model  — **DRIFT-RISK**

- **Where:** `proactive/briefing.ts:214` assemble()  |  `pipeline/evidence.ts:247,313,365`
- **What breaks:** Three of the sections read the same three tables with independently written windows, caps and wordings -- one over loopback, one directly. The morning briefing and the nightly proposal can describe one venture's open alerts and overdue cards differently on the same night. Neither is wrong; they are two accounts of one state.
- **Single home:** Shared per-venture section builders both assemblers call

### 69. The local day and hour where the owner is  — **DRIFT-RISK**

- **Where:** `proactive/briefing.ts:141` zoned()  |  `chief/rounds.ts:122` localNow()  |  `pipeline/registry.ts:480` zoned()
- **What breaks:** Three copies of one formatter call, each re-deriving the same two non-obvious rules in its own comment. customers/store.ts:593 shows the right pattern -- it re-exports proactive's rather than copying it.
- **Single home:** Move zoned / validZone / systemZone to shared/, as customers already assumes

## Client & skills

### 70. Dispatching an agent run that spends tokens  — **FIX-FIRST**

- **Where:** `runs/manifest.ts:169` start, destructive: true  |  `subagents/manifest.ts:131-181` dispatch, no flag  |  `chief/skills.ts:292` start_now, no flag
- **What breaks:** All three enter the same queue -- chief calls subagents.dispatch in a loop, which queues runs of the runs area's own kinds. MCP publishes destructiveHint from the flag, and a client reading no hint may call without asking. So an MCP client is told runs.start needs a human but rounds.start_now does not, while start_now dispatches N runs to start's one. runtime/tools.ts patched it locally with a /^dispatch/ regex and says a connected Hermes still reaches every published action.
- **Single home:** Mark dispatch and start_now destructive; the verb regex stays a belt, not the only strap

### 71. This action reaches a third party (openWorld)  — **FIX-FIRST**

- **Where:** declared in `socialfeed`, `publishing`, `ventures`, `runs`  |  omitted in `growth/manifest.ts:225-269` indexing.submit, `seoops/skills.ts:274` vision, `video/skills.ts:169`, `videoplus/skills.ts:32`
- **What breaks:** Four areas' third-party writes are annotated openWorldHint: false -- a false claim in a field designed to be trusted, which runtime/tools.ts uses as a write-gate condition. growth.indexing.submit POSTs your URLs to Bing, Yandex, Seznam and Naver with neither openWorld nor destructive, and its own view param concedes it is a request to somebody else's server.
- **Single home:** One rule stated once beside openWorld? in skills/registry.ts; indexing.submit also needs destructive

### 72. Percentages  — **FIX-FIRST**

- **Where:** `areas/finance/format.ts:35` takes a 0–1 fraction  |  `components/integrations/format.ts:33` takes an already-scaled percent  |  `lib/liveWidgets.ts:251` already-scaled
- **What breaks:** Three exported functions named pct with the identical signature (number) => string, so auto-import picks one at random and renders 0.4% where 40% was meant -- silently, with no type error, on pages whose whole premise is not misreporting figures.
- **Single home:** One pct(fraction) in client/lib/format.ts; callers holding a server percent divide at the call site

### 73. Publish this item again  — **DISAGREEING**

- **Where:** `publishing/skills.ts:236` retry_item, destructive: true  |  the route it points at is requireBrowser (`publishing/routes.ts:443`), and `routes.ts:114` asserts no action points at it
- **What breaks:** The claim in the route header is false, so the documented three walls are two and nobody reviewing publishing knows it. Meanwhile the registry publishes an MCP tool, an opc CLI command and a Hermes pack entry for an action that can only ever return 403 -- an agent is told it can retry a failed post, tries, and reports a permissions failure to you.
- **Single home:** Delete retry_item (as publish correctly has no action), or drop requireBrowser -- one, not both

### 74. The integrations report client, written twice  — **DISAGREEING**

- **Where:** `client/lib/api/integrations.ts:661-682`  |  `client/lib/api/reports.ts:832-843` -- 10 endpoints, 10 same-named types
- **What breaks:** Drifted in both directions: verified.checked is number vs number|null; links[].fromDomain is string vs string|null, so a panel renders null as text; BacklinkSourceRow.source widens to string on one side, so a switch is exhaustive on one only. Default windows disagree on the same route -- products 7 vs 30, bluesky 30 vs 90, umami 30 vs 90 -- so one card shows different numbers on the panel and the dashboard.
- **Single home:** reports.ts (stricter nulls, closed unions); integrations.ts keeps voice, speak and venture links

### 75. The plugin credential schema, across the wire  — **DISAGREEING**

- **Where:** `client/data/plugins.ts:1166` (68 plugins)  |  `server/routes/plugins.ts:816` + manifestPlugins()
- **What breaks:** Both are the list of field keys naming the vault entry a credential is stored under. Rename a key on one side and the credential is written to an entry nothing reads -- surfacing as “the grant was refused” rather than a schema mismatch, exactly the failure the client file's own comment warns about. No test joins the two lists.
- **Single home:** The server's PluginRegistryEntry; the client fetches the field list and keeps only presentation

### 76. Durations  — **DISAGREEING**

- **Where:** `components/runs/format.ts:19` milliseconds  |  `components/integrations/format.ts:52` seconds  |  `lib/liveWidgets.ts:6235` ms, third rounding  |  five inline copies
- **What breaks:** Two exported functions named duration with the identical shape, differing by a factor of 1000, so the wrong import renders a 4-second run as “1h 6m” with no compile error.
- **Single home:** One duration(ms) in lib/format.ts; rename the seconds one durationS

### 77. Three area write verbs re-implemented as raw SQL  — **DISAGREEING**

- **Where:** `routes/actionInbox.ts:36-42`  |  `proactive/store.ts:323` ackEvent  |  `people/commitments.ts:441` decide  |  `mailflow/triage-routes.ts:196,225` verb
- **What breaks:** The area functions are bypassed, so anything added to them later -- a second column, an audit row, the kind === “test” refusal -- silently does not happen from the inbox. Three writes carry rules and a classification on one route and none on the other. The inbox already does this right for the board case, importing fileCard.
- **Single home:** actionInbox.ts calls ackEvent, decide and the mailflow verb

### 78. Relative timestamps  — **DISAGREEING**

- **Where:** `components/integrations/format.ts:17`  |  `lib/live.tsx:941`  |  `lib/liveWidgets.ts:1029`  |  `HetznerPanel.tsx:16`  |  `PluginDetail.tsx:712`  |  `deploy/DeploymentSettings.tsx:41`  |  `mailflow/Triage.tsx:69`
- **What breaks:** Seven copies, four byte-identical. Deploy switches to days at 48h, the other five at 24h -- so one collected-at stamp reads “36h ago” on the deployment panel and “2d ago” on the integrations panel. Triage has no “just now” branch and takes epoch ms.
- **Single home:** components/integrations/format.ts:17, moved to lib/format.ts to break the documented cycle

### 79. Currency, on the client  — **DISAGREEING**

- **Where:** `areas/finance/format.ts:14` and its verbatim copy `activity/Today.tsx:25`  |  `customers/Disputes.tsx:26` and `RecoveryQueue.tsx:70`  |  `liveWidgets.ts:2038,2511,1406,223`  |  hardcoded $ in `charts.tsx:225`, `PipelineTab.tsx:215`
- **What breaks:** Seven implementations, four output conventions. The same Stripe amount renders 12.00 EUR, EUR 12.00 and €12.00 on three screens, and two liveWidgets copies disagree about whether ≥1000 drops the cents. On a codebase whose universal rule is that money is never added across currencies, an inconsistent currency label is a correctness surface.
- **Single home:** One money(n, currency, opts) in lib/format.ts with the try/catch fallback one copy already got right

### 80. Bytes  — **DISAGREEING**

- **Where:** base 1024: `components/integrations/format.ts:39`, `BackupsSettings.tsx:43`, `Mailbox.tsx:545`, `ventures/Site.tsx:359`  |  base 1000: `charts.tsx:250`, `liveWidgets.ts:310,239,5696`
- **What breaks:** The same 5,368,709,120-byte disk reads 5.0 GB on one panel and 5.4 GB on another, and casing is the only clue which base was used. format.ts argues for 1024 because every source of these figures counts that way; the base-1000 copies contradict a stated rule.
- **Single home:** One bytes(n, { base }) in lib/format.ts

### 81. GET /skills, typed twice  — **DISAGREEING**

- **Where:** `client/lib/api/chief.ts:307,315` SkillSummary  |  `client/lib/api/proactive.ts:52,226` SkillCatalogue
- **What breaks:** CatalogueSkill carries about and rules[]; SkillSummary has neither, so the chief page cannot see honesty rules the server is already sending, and a new field reaches only one consumer.
- **Single home:** proactive.ts's SkillCatalogue; chief.ts imports it

### 82. /capture and /venture-links, typed twice  — **DISAGREEING**

- **Where:** capture: `lib/api/studio.ts:275,304,319` vs `lib/api/ventures.ts:122,179`  |  links: `lib/api/integrations.ts:631,692` vs `lib/api/ventures.ts:360`
- **What breaks:** CaptureVenture is declared under one name in two files with different member types; CaptureResult has path: string|null, CaptureRun omits path. The unlink DELETE returns {ok:true} on one side and {links} on the other -- one is factually wrong, and EntityLinks.tsx discards links the server returned and refetches.
- **Single home:** lib/api/ventures.ts for both; studio.ts and integrations.ts re-export

### 83. The page shell and header  — **DRIFT-RISK**

- **Where:** `components/PageShell.tsx:7` (shared)  |  retyped at `socialfeed/Posts.tsx:73`, `publishing/Publishing.tsx:115`, `video/Autopilot.tsx:76`, `video/Motion.tsx:75`, `mailflow/Triage.tsx:213`, `mailflow/Outbox.tsx:431`, `nurture/Nurture.tsx:682`, `Studio.tsx:199`
- **What breaks:** Each copy re-types PageShell's exact class strings. Already drifted -- PageShell uses mb-6, the copies mb-5 -- so header spacing and scroll padding differ page to page, and any future header change is a nine-file edit.
- **Single home:** components/PageShell.tsx; it already takes wide and action

### 84. The sub-tab strip  — **DRIFT-RISK**

- **Where:** `components/TabStrip.tsx:39` (shared, used correctly by People and Workflows)  |  13 hand-rolled strips in four looks across customers, finance, activity, proactive, publishing, video, webanalytics, mobilehealth, growth, security, nurture, Plugins, SectionPages
- **What breaks:** Four different “this tab is selected” affordances across sibling pages of one app; Nurture and Ops set no aria-current at all; no shared narrow-screen overflow behaviour.
- **Single home:** components/TabStrip.tsx, or a non-draggable variant extracted from it

### 85. Absolute short timestamps  — **DRIFT-RISK**

- **Where:** nine copies, eight character-identical: `SecuritySettings`, `DeploymentSettings`, `MigrationSettings`, `Sourcing`, `Posts`, `Publishing`, `CaptureSettings`, `BackupsSettings`, `PostCard`
- **What breaks:** Five return “never” for null and four return an em dash for the identical missing timestamp; Publishing has no NaN guard, so it renders “Invalid Date” where the others echo the raw string.
- **Single home:** components/integrations/format.ts, beside clock and dayLabel

### 86. The KPI stat-tile row  — **DRIFT-RISK**

- **Where:** `components/integrations/Panel.tsx:72` Tiles (shared)  |  eight copies in customers, proactive, activity, security, Subagents, Settings, HetznerPanel
- **What breaks:** Four different min-widths (128/130/132/150px) and three figure sizes (15/19/22px), so tile rows on adjacent pages neither line up nor wrap at the same breakpoint; one copy silently drops tabular-nums.
- **Single home:** Tiles from components/integrations/Panel.tsx -- it already takes {v, k, title}[]

### 87. Loading / Failed / Card / Num, copy-pasted whole  — **DRIFT-RISK**

- **Where:** `mobilehealth/MobileHealth.tsx:123,131,139,153`  |  `webanalytics/WebAnalytics.tsx:105,113,121,135`  |  `growth/pages/Growth.tsx:82,90`
- **What breaks:** A diff of the two blocks yields two hunks: flex vs flex flex-wrap, and four words of a comment. The two Num copies have already diverged -- one wraps in tabular-nums, one does not -- so the same figure is monospaced on one analytics page and proportional on the one beside it, and each variant re-decides its own rounding. The null-to-dash rule it carries is a correctness invariant the codebase states in prose five times.
- **Single home:** A shared Loading / Failed / Num in components/ui/ -- nothing exists yet

### 88. The last-N-days window picker  — **DRIFT-RISK**

- **Where:** `customers/Disputes.tsx:47` and `Events.tsx:53` pills  |  `MobileHealth.tsx:96` and `WebAnalytics.tsx:236` selects  |  `Publishing.tsx:535` outline buttons  |  `JournalFeed.tsx:158` select
- **What breaks:** One control, five designs, four label formats and four option sets, so a reader cannot carry a habit between pages.
- **Single home:** A shared WindowPicker -- none exists; this is a gap, not a misuse

### 89. The query-string helper  — **DRIFT-RISK**

- **Where:** `socialfeed/api.ts:208`, `mobilehealth/api.ts:277`, `publishing/api.ts:257`, `lib/api/customers.ts:221`, `people.ts:200`, `journal.ts:69`, `runs.ts:355`
- **What breaks:** Seven copies in two behaviours: four do not filter null, so a ?? null idiom upstream sends the literal string ?venture=null; three do. Two hand-roll encodeURIComponent so spaces encode %20 where the others encode +.
- **Single home:** One qs() exported from client/lib/api.ts beside call

### 90. The status pill  — **DRIFT-RISK**

- **Where:** `components/ui/badge.tsx:29` (shared)  |  `nurture/Nurture.tsx:46` border-tinted  |  `seoops/SeoFollowUpsTab.tsx:30` and `ListingsPanel.tsx:29` background-tinted  |  `knowledge/KnowledgeTab.tsx:465`
- **What breaks:** “ok” is a border tint in one area, a background tint in another and a filled badge in a third, so a reader learns three colour languages for one idea, and each local map re-derives its own warn and bad tokens.
- **Single home:** components/ui/badge.tsx, adding ok and warn variants once

### 91. The empty state  — **DRIFT-RISK**

- **Where:** `customers/Customers.tsx:109`  |  `EmailStats.tsx:254`  |  `BoardView.tsx:265`  |  `Board.tsx:653`  |  `components/integrations/Panel.tsx:198` PanelEmpty (shared)
- **What breaks:** Four paddings and two treatments for one state, so “nothing yet” reads as more or less alarming depending on the page.
- **Single home:** PanelEmpty, extended with the optional action link EmailStats needs

### 92. The ranked share-bar list  — **DRIFT-RISK**

- **Where:** `mobilehealth/MobileHealth.tsx:176`  |  `webanalytics/WebAnalytics.tsx:396`
- **What breaks:** Same truncated label width, same track and fill classes, same right-aligned figure. WebAnalytics adds a change column and MobileHealth a remainder row, so two identical-looking lists have diverged in what “the rest” means.
- **Single home:** A shared ranked-bar list -- charts.tsx has only the vertical Bars, so this is a gap

### 93. The titled section card  — **DRIFT-RISK**

- **Where:** `webanalytics/WebAnalytics.tsx:121`  |  `mobilehealth/MobileHealth.tsx:139`
- **What breaks:** Identical border, ground, radius, padding and heading size; only flex-wrap differs, so the two pages' card headers wrap their meta differently at narrow widths despite being presented as the same block.
- **Single home:** One shared card, or PanelSection from components/integrations/Panel.tsx

### 94. Counts  — **DRIFT-RISK**

- **Where:** `components/integrations/format.ts:27` en-IE  |  `liveWidgets.ts:1021` en-GB and `:1896` the same body under another name  |  `:1415` en-US  |  `chief/OutcomesTab.tsx:238`; compaction at `:1418` vs `RichBlock.tsx:69`
- **What breaks:** 1500000 renders 1.5M in one widget, 1.5m in another and 1,500,000 in a third. liveWidgets.ts:1896 is provably identical to :1021 and can be deleted today, independent of the wider refactor.
- **Single home:** One count() and one compact() in lib/format.ts

### 95. In N days  — **DRIFT-RISK**

- **Where:** `areas/finance/format.ts:29` inDays  |  `liveWidgets.ts:701` untilWord  |  `liveWidgets.ts:1899` untilReset
- **What breaks:** A domain renewal 41 days out reads “in 41d” on the finance page and “41d” on the runway widget.
- **Single home:** finance/format.ts:29 promoted to lib/format.ts; untilWord's month tail is a real extension

### 96. Saving a plugin's settings  — **DRIFT-RISK**

- **Where:** `areas/pipeline/api.ts:161,245`  |  `client/lib/api.ts:3412` savePluginConfig
- **What breaks:** The pipeline copy rebuilds the URL and body rather than calling the shared function, and its return type drops connected and collected -- so saving pipeline settings cannot show whether the plugin reconnected.
- **Single home:** client/lib/api.ts:3412
