# Workspace insights and work tracking

These features use the current workspace database and connected accounts. They do not contain venture names, server addresses, account IDs, or credentials. Existing saved dashboards are never reseeded by this update.

## Where to use them

- **Board:** add, rename, reorder and remove custom columns. Optional work-in-progress limits are editable. Backlog and Done retain their structural roles. Removing a custom column moves its live and archived cards to Backlog; it does not delete cards.
- **Activity → Work journal:** record `did`, `shipped`, `dismissed`, or `note` entries, optionally linked to a venture. Entries can be backdated, edited and deleted. Only `did` and `shipped` count toward the work streak and heatmap. Calendar dates use the timezone configured in Briefing settings, with the host timezone as fallback. A streak through yesterday remains current until today's opportunity to work has passed.
- **Insights** (in the account menu): pace projections, dormant ventures, anomaly evidence, configurable thresholds and a daily-data import form.
- **Ventures:** dormant ventures are hidden as a group until “Show dormant ventures” is selected. Unknown coverage remains visible. Grouping does not alter venture stages or delete anything.
- **Alerts:** set a persistence duration and number of consecutive failing checks. Both requirements must be met. Missing/undecidable checks or a long collection gap break the pending sequence. One incident remains active until a successful check confirms recovery. Acknowledgement means “seen”, independently of recovery. History includes recovery time and reason; filter by active/recovered status and paginate up to a 400-day window. Rows remain stored beyond that UI window. Disabling a rule preserves its history; explicitly deleting it removes its events.
- **Activity → Infrastructure:** chronological observations of failed/recovered site checks, failed/recovered server and workstation probes, disk threshold crossings, running-container membership changes, and GPU idle/busy transitions. Timestamps identify when a transition was observed, not the exact moment it began between samples.

Reusable widgets are available in every dashboard's widget picker: **At this pace**, **Dormant ventures**, and **Infrastructure changes**. New workspace defaults place the first two on Overview and the timeline on Servers. Existing layouts are left alone; add the widgets through Edit.

## Daily data contract

`shared/insights.ts` owns the provider-neutral types and pure calculations. An integration can implement `IntegrationManifest.insightSources()` to return `MetricSeries[]` from its collected data. Adapters currently cover Umami traffic, product user/sign-up data and Stripe MRR. These adapters read stored results; opening Insights does not call providers.

Other tools can upsert a source using `POST /api/insights/sources` with the application's normal authentication, or paste the same JSON into Insights:

```json
{
  "id": "example-users",
  "label": "Example product users",
  "metric": "users",
  "unit": "users",
  "ventureId": null,
  "observedAt": "2026-09-13T09:00:00Z",
  "completeThrough": "2026-09-12",
  "points": [
    { "day": "2026-09-11", "value": 120 },
    { "day": "2026-09-12", "value": 125 }
  ]
}
```

Replace sample dates with actual collection dates. Supported metrics: `mrr`, `users`, `signups`, `pageviews`, `custom`. Link `ventureId` to an existing venture to include its observations in dormancy. MRR uses one uppercase currency code per source; currencies are never added together.

An upload contains 1–400 unique complete daily points; null means missing, never zero. Reusing the source ID upserts days rather than duplicating them. Changing metric, unit or venture requires a new ID to avoid mixing histories. Old uploads are refused. Imported source IDs are namespaced with `import:`. `GET /api/insights/sources` lists imports; `DELETE /api/insights/sources/:id` removes an import and stops its automatic watch while retaining incident history. Use a new ID or re-enable the existing watch if reconnecting a removed source.

`GET /api/insights` is the computed report. `GET/PATCH /api/insights/settings` reads/updates validated workspace settings. Settings affect every adapter equally. No integration-specific UI is required to use the import contract.

## Evidence requirements

- Pace projects the next 30 days from a regression over recent daily **levels**, using elapsed calendar days. It needs at least 14 measured days and 75% coverage, suppresses recent trend reversals, and shows its observed period. These are conditional projections, not promises. Existing installations may need more collection history before forecasts appear.
- Anomalies examine completed daily traffic/sign-up/custom observations, excluding the day being evaluated from the baseline. Defaults require 14 measured baseline days in a 28-day window and a deviation exceeding robust median/MAD, relative-change and absolute-change bounds. Baselines remain fixed while an incident is active so a persistent problem cannot silently become normal. Missing, stale, incomplete or unavailable data never opens a numerical anomaly or clears one. Each stable source has an automatic rule that can be disabled individually.
- Dormancy needs adequate traffic/sign-up coverage, activity below configured thresholds, no recent tracked work and no reported revenue. Growing ventures stay active. Unknown provider coverage stays unknown. Revenue checks conservatively include all calendar months touched by the lookback. Monthly costs remain separated by currency and report unpriced items.
- Infrastructure uses `observeInfrastructure()` and an independent watermark per entity/measurement. The first sample sets a baseline. Duplicate and out-of-order samples do not generate events. Missing samples do not invent state changes. Threshold changes reset the comparison basis. Existing retained uptime and workstation history is replayed once; other transitions accumulate as collectors run.

## Extension and storage

Feature-specific migrations own journal entries, observed user totals, imported series, anomaly baselines, preferences and infrastructure watermarks. Rule persistence and event recovery extend the existing alert tables. Pending checks and anomaly baselines survive restarts. Imported observations retain a rolling 400 days per source; journal entries and incident evidence persist until explicitly removed.

Infrastructure integrations call `recordInfrastructure()` with stable keys, timestamps, nullable values and a transition description. It atomically stores the watermark and event, and collection failures remain separate from measured resource changes. A new provider can reuse this mechanism without changing the timeline UI.

Verification covers board card preservation, journal calendar boundaries and backdating, projection coverage and reversal, missing/zero distinctions, imported-history validation, anomaly deduplication and recovery after acknowledgement, rule persistence across gaps, and infrastructure transition idempotence.
