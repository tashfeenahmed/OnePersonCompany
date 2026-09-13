# Venture journeys

Each venture overview follows its saved `stage`: `idea`, `pre-launch`, or `launched`. The owner can move in either direction. Stage changes record a decision; they never replace workspace preferences, dashboards, connections, or checklist progress.

`businessType` is optional: `web`, `mobile`, `desktop`, `website`, `shop`, `goods`, or `service`. Existing ventures stay unclassified until the owner chooses. Common foundations still work without a type.

## Data and extension points

- `shared/ventureJourney.ts` defines the versioned document, commands, readiness calculation and export.
- `shared/ventureJourneyTemplates.ts` supplies common and business-specific tasks. Keys are persistent identities: change copy freely, but never reuse or rename a saved key. Add new keys for materially different work. Never seed completion or evidence.
- `server/src/integrations/ventures/journey.ts` owns persistence and validation. The `480_venture_journeys` migration is additive. A plan is one bounded document per venture; indexed stage decisions and review snapshots are separate tables. Deleting a venture cascades only its own records.
- `client/src/components/ventures/journey/` separates layout, forms, performance and chart geometry. The existing venture overview remains available under “Work, team, chats & saved dashboards.”

`GET /api/venture-journey/:key` returns revision, profile, progress, custom steps, name candidates and recent history. `PATCH` accepts `{revision, command}`; commands update named fields instead of replacing a plan. A stale revision returns HTTP 409. UI editors keep drafts while the owner reloads the saved plan and chooses whether to retry.

Commands: `profile`, `task`, `add-task`, `delete-task`, `name`, `delete-name`, `start-review`. Skip decisions need a reason. A chosen name needs recorded checks; the app does not assert domain availability or purchase domains. Custom steps are scoped to a stage and optionally a business type. Type changes retain hidden tracks.

Starting a new operating review archives its task definitions and evidence in one transaction before reopening the current track. `GET /api/venture-journey/:key/reviews/:id` reads the snapshot, scoped to its venture. Read summaries contain the 100 most recent stage changes and 50 most recent reviews; older records remain in the database.

The existing venture PATCH accepts `businessType`, `stageChangeNote`, and optional `expectedUpdatedAt` for concurrency protection. The UI uses that protection for stage/type edits and the full venture form. The `ventures` agent skill exposes the saved journey as a read view.

## Real business data

Launched finance comes from the existing venture P&L attribution endpoint. No currencies are summed together and incomplete coverage is visible. Daily signals use the existing provider-neutral insight-source interface and include only an exact `ventureId` match. Portfolio series and another venture's series are excluded. Missing days break chart lines; stale or insufficient data suppresses projections.

For a new integration, publish an `insightSources` provider through its manifest, or import daily observations at `POST /api/insights/sources` with this venture's ID, a stable source ID, metric, unit, collection timestamp and measured points. Shops, services and physical-goods businesses can use custom sales, order, booking or stock metrics. This does not imply a native POS, inventory or order-system connector.

## Verification

`npm run check` runs isolated server/client tests, type checking, build, lint, widget catalog consistency and strict shared-type checks. Journey tests cover all 21 type/stage combinations, persistence across database connections, exact venture scoping, validation, concurrency, archives, deletion and preservation of custom workspace preferences. Browser verification uses a disposable venture and does not reset user dashboards.
