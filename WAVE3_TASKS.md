# Wave 3 — handoffs, schema merges, generalisation

Wave 2 forbade schema changes and cross-area edits, so every agent that hit one
wrote it down instead. This is that list, verbatim from their reports. The
signatures named here all exist on `main` of this branch and are tested.

## A. Cross-area handoffs

### chief (the quarantine bypass — highest priority)
`knowledge/store.ts` exports the gate:
```ts
ventureClaimRefusal({ ventureId?, scope?, source? }): { status: 422; error: string } | null
```
The line is the **venture argument, and only for an agent**. The owner is never
refused — they are the confirmation gate.
1. `chief/skills.ts` `remember` action: delete the whole `venture` parameter
   block, leaving `text` as the only parameter.
2. `chief/skills.ts` rules array: replace "SCOPE A NOTE TO A VENTURE WHEN IT IS
   ABOUT ONE…" with a rule saying a note is about the owner, never a product,
   and that product claims go to `propose_fact` where they carry a kind, a
   source and a date and wait for confirmation.
3. `chief/memory.ts` `remember()`: call `ventureClaimRefusal` right after the
   `looksLikeAMeasurement` refusal. Add `422` to the result's status union.
4. Leave the `venture` query parameter on the default VIEW alone — reading the
   owner's own venture notes is not the bypass.

### chief (the rest)
- `chief/outcomes.ts:97,125,133,160,395` → `shared/metrics-address.ts`
  (`paramsOf`, `urlFor`, `resolvePath`, `takeReading`). This gives outcomes
  `@count(...)`, which alert rules already had, and picks up the
  `?view=default` 404 fix.
- `chief/memory.ts:172` `key()` → `textKey` from `shared/textkey.ts`.
- `chief/memory.ts` and `people/brief.ts` each define `isoWeek`. Not in the 96;
  two implementations of a rule that is wrong to get slightly different.

### pipeline
- `pipeline/evidence.ts:127-171` → `ventureMrr(ventureId)` from
  `finance/attribution.ts`. Drop the `active || trialing` count and the
  `mrrUsd` stamping — the map is per-currency and nothing in it is USD by
  assumption.
- `pipeline/evidence.ts:250` → `openEventsForVenture(id, { days })` +
  `ruleCountForVenture(id)` from `proactive/store.ts`. Delete the raw SELECT.
- `pipeline/synthesis.ts:125` `normalise()` → `textKey`.

### activity / mailflow / nurture
- `activity/leakage.ts:117` → `ledgerDisputes(fromDay)` from
  `customers/store.ts`. Changes its grouping key to upper-case and its
  rounding to 4dp.
- `activity/leakage.ts:53` holds a ninth local `money` → `shared/money.ts`.
- `mailflow/triage.ts` must export, beside `storedFor`:
  ```ts
  markThread(accountId, threadId, patch: { snoozedUntil?, doneAt? }): void
  ```
  Omitted fields keep the stored value; the insert must keep the NULL score.
  Then `triage-routes.ts:196,225` become one call each and
  `routes/actionInbox.ts` drops its `triageVerb`/`triageRow` copies.
- `nurture/facts.ts:240-245,274` → `lookupHash(address)` from
  `activity/users.ts`. It returns `null` when there is no salt and must never
  mint one — nurture's two-meaning null depends on that.

### vision / screenshots
- `security/shotsqa.ts`: `MIN_WIDTH`/`MIN_HEIGHT` → `SHOT_FLOOR`; its IHDR
  reader (`:70-116`) → `imageDimensions`; its shot query (`:265`) → `lastShot`.
- `seoops/vision.ts`: `pngSize` (`:415`) → `imageDimensions`; shot query
  (`:439`) → `lastShot(id, true)`.
- **Both are currently reading rebrand rows as captures** — neither excluded
  `brand_rendered`. `lastShot` does.
- `seoops/brand.ts:288`: `SHOT_VIEWPORT` from `tools/chrome.ts` directly, not
  through `ventures/capture.ts`. Its CDP client stays its own.
- `publishing/assets.ts:138` → `imageDimensions`.

### socialfeed / publishing
- `socialfeed/ugc.ts:191-355` → `predict`/`firstUrl`/`download` from
  `tools/replicate-run.ts`; delete its local `firstUrl` (`:355`).
- `socialfeed/ugc.ts:456` → `formatForAspect(aspect)`, which returns **null**
  rather than defaulting to `"story"`. Refuse or note the aspect.
- `socialfeed/ugc.ts:399` → `aspectFrame`.
- `publishing/campaigns.ts:523` → `createPost()` from `ventures/studio.ts`;
  it never throws and carries `status`, so drop the HTTP unwrapping.

### ventures / signals / domains
- `ventures/entities.ts:92,118` → `shared/host.ts`; delete the local copy.
- `ventures/links.ts` must export `normaliseEntity(entity)` and
  `ventureOfEntity(plugin, entity)`. Four resolvers collapse the moment it
  does; the audit listed three and missed `finance/expenses.ts:396`.
- `signals/presence/sources.ts:150` and `signals/backlinks/sources.ts:97` are
  the last two host reducers. **`backlinks`' is not a `registrable` at all** —
  it strips `www.` only, which is `hostOf`. Mapping it to `registrable` would
  silently re-bucket stored backlink rows.
- `signals/backlinks/routes.ts:70` → `referringDomains(host)` from
  `growth/authority.ts`, or move the accessor into `backlinks/store.ts`.
- `routes/cloudflare.ts:34,125` → `registeredDomains()` from
  `providers/domains.ts`. Until then that page says "no connected registrar
  holds this name" about a name it prints in its own registrar block.

### stale comments and hints
- `routes/chat.ts:1278` — says it answers `stopping`; it answers `cancelling`.
- `routes/board.ts:823` — `fileCard` says "Nothing calls this." Stale.
- `runs/manifest.ts:298` — the Papers typst hint should say the path is shared
  with Video, and it lists two prefixes where `KNOWN_PREFIXES` probes five.
- `publishing/routes.ts:114` — asserts no action points at its `requireBrowser`
  routes. False while `skills.ts:236 retry_item` exists (see section D).
- Move `mailflow/outbound.ts` to `server/src/shared/` — publishing importing
  `../mailflow/outbound.ts` is the visible cost of Wave 2's file rules.

### client
- **`resolvedTimezone` is gone from the wire.** `GET /api/pipeline/schedule`
  and `GET /api/rounds/schedule` now send `timezone` (always a real zone) plus
  `zoneWasSet: boolean`. Fix `areas/pipeline/api.ts:54`, `PipelineTab.tsx:397,400`,
  `lib/api/chief.ts:178`, `RoundsTab.tsx:257,266,269`.
- `lib/api/deploy.ts:31` — `Health.retainDays` is replaced by
  `retention: {table, column, days, source, setting?, grain?, where?, note?}[]`.
- `lib/api/deploy.ts:104` + `areas/deploy/DeploymentSettings.tsx:362` —
  `refusedPrefixes` rows now carry `paths`, `level` and `demands`. The page
  shows only the first path and not the level, which is the interesting half.
- `lib/api/ventures.ts:133` — `source` union: `"application"` is now `"known"`.
- `components/org/roleLook.ts:67,80` — delete the table; import `appForKind`
  and `runPage` from `shared/runRoutes.ts`.
- Add `day(iso)` to `lib/format.ts` — `when` always appends a clock, and
  eleven sites are genuinely date-only: `journal/JournalFeed`,
  `customers/RecoveryQueue`, `activity/Feed`, `activity/UserProduct` x2,
  `mailflow/Outbox`, `nurture/Nurture`, `knowledge/KnowledgeTab`,
  `pages/Mailbox`, `pages/Board` x2.
- `Rules({ rules })` is byte-identical in `MobileHealth.tsx` and
  `WebAnalytics.tsx`; its home is `components/ui/state.tsx`.
- `pages/SectionPages.tsx:5` — unused `cn` import.
- Remove the deprecated re-exports Wave 2 left: `num` in
  `components/integrations/format.ts`, `duration` in `components/runs/format.ts`.

## B. Schema merges — migrations 400+, carry rows across, drop nothing holding data

1. **`domains` <- `cloudflare_registrar`.** Add `source = 'cloudflare'` rows via
   `replaceDomains`, carry existing rows in the migration, then drop the table.
   `registeredDomains()` becomes a one-line `allDomains()` that day.
2. **`site_windows`** keyed (account, website, window_days, offset_days),
   replacing `umami_windows` + `web_site_windows`. The read half is done —
   `webanalytics/store.ts::siteWindows()` UNIONs both and names the winner.
3. **`publish_destinations`** takes identity + venture mapping from
   `meta_pages` and `social_accounts`; `meta_pages` keeps measurements only,
   `social_accounts` keeps read-state only.
4. **`publish_items.approved_content`** snapshot column, so publishing gets
   the frozen-approval half of the outbox lifecycle.
5. **`venture_links` <- `campaign_ventures`** with `plugin = 'meta-campaign'`
   and an evidence column.
6. **One `digests` table** (kind, period, facts, markdown, model, note)
   replacing `briefings` + `people_briefs`.
7. **One self-published-document table** replacing `product_docs` +
   `activity_user_docs`, with a pluggable contract.
8. **`people_contacts` is the census**; `gmail_correspondents` becomes derived
   or goes. Two full mailbox scans of one rate-limited API today.
9. **`business_events` is the exact grain**; `activity_events` carries a
   projection rather than re-deriving `payment_failed`/`dispute` from the day
   tables. Two announcements, two suppression states, one real event.
10. **One competitor table** keyed on registrable domain; `competitorSet()`
    already joins the two at read time.
11. **`db.ts`'s `prune()`** should `registerRetention` its own 16 tables and
    let the sweep delete them. `scheduler.ts`'s `CENTRAL` block is a stand-in
    and says so; today those tables get one extra no-op DELETE per interval.
12. **`integrations/migrations.ts` order.** Sort at build time, do NOT
    renumber: `[...analytics, ...ops, …, ...INLINE].sort((a,b) =>
    a.name.localeCompare(b.name))`. Safe because the applied table is keyed on
    name, so everything already run is skipped regardless of position. Add a
    test asserting sorted order and no duplicate names.

## C. Generalisation — this repo is going open source

Single owner per install, nothing of one person's baked in. **The owner is
running this box; their existing rows must survive.**

- `db.ts:2566` seeds four of the owner's ventures directly in migration `060`.
  Make it a first-run-only default that does nothing when the table already
  has rows, and seed nothing (or one clearly-marked example). Never edit the
  applied migration's SQL — add a new one.
- ~60 skill `examples`, `asks` and settings `ph:` placeholders name the
  owner's ventures. `activity/manifest.ts:77`, `signals/manifest.ts:52,88,93,255,297`,
  `chief/skills.ts:119,306`, `growth/manifest.ts:148`, `finance/skills.ts:225`,
  `people/skills.ts:78`, `subagents/manifest.ts:125,146,213,214`,
  `pipeline/skills.ts:305`, `routes/pluginConfig.ts:144,146,316` (the owner's
  npm scope and a venture name).
- 57 test fixtures use the owner's ventures. Neutral fixtures.
- `migrate/workdash.ts:116` matches the owner's own secret filenames
  (`/^(ob1|example-app-1)-admin-token$/i`). Make it config-driven.
- **`migrate/**` is a legitimate WorkDash importer** — the name is the product
  there, not a private reference. Keep it. Genericise only the "my old system
  did X" asides elsewhere.
- Editing SQL **comments** inside an applied migration is safe (migrations are
  keyed by name with no checksum, so they never re-run). Editing the SQL is not.
- README needs a deployment note: **a reverse proxy in front of the dashboard
  must forward `Origin`**, or the owner cannot log in or change the password,
  and there is no CLI fallback. Recovery is
  `DELETE FROM security_owner WHERE id = 1` and a restart.
- No LICENSE file. Leave a placeholder and flag it — the licence is the
  owner's choice, not ours.

## D. Skill classification

- `subagents.dispatch` and `chief.rounds.start_now` spend tokens and are
  unflagged while `runs.start` is `destructive: true`. MCP publishes
  `destructiveHint` from the flag and a client reading none may call without
  asking — and `start_now` dispatches N runs to `start`'s one. Flag both, and
  delete the retracted paragraph at `subagents/manifest.ts:34-40`.
- `growth.indexing.submit` POSTs the owner's URLs to Bing, Yandex, Seznam and
  Naver with neither `openWorld` nor `destructive`. It needs both.
- `seoops.visualqa`, `video`, `videoplus` send data to third parties and
  declare no `openWorld`.
- `publishing.retry_item` is a published action pointing at a `requireBrowser`
  route, so it can only ever return 403. Delete the action (as `publish`
  correctly has none) or drop the guard — one, not both.
- State the `openWorld` rule once in `skills/registry.ts` beside the field.
- Add a test asserting skill ids are unique. `entry()` resolves by first match
  with no collision detection, so a future clash is a silent wrong answer.
