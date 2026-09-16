# Workflows comparison with Workdash

Reviewed 16 September 2026 against the local Workdash checkout (`4eca140`), particularly `src/pages/Workflows.tsx`, `src/pages/Schedule.tsx`, `agent/nightly.js` and `agent/schedule.js`. This is a comparison of implementation and behavior, not a live execution of the retired Workdash service.

| Capability | Workdash | OPC assessment |
| --- | --- | --- |
| Nightly configuration | Nightly switchboard, stage order, budgets and project rotation | Saved, revisioned workflow blocks with venture/stage/business filters, dependencies, per-block limits and nightly budgets. Workflows now opens here by default. |
| Scheduling | Durable daily watermark, execution window, optional catch-up, blackouts | Local-time daily schedule with coalesced catch-up and blackouts. Fixed a manual run consuming the scheduled claim and the skip control targeting the wrong day when a catch-up is pending. |
| Specialist rotation | Rotates project analysis and avoids duplicate work | Uses the existing sub-agent queue and waits for completed reports before synthesis. Fixed disabled/busy specialists occupying the cap and starving later ventures; changing specialist roles no longer inherits the old role's review history. |
| Preview | Readable schedule and next-stage decisions | Separate non-executing plan route. Existing tests confirm previews dispatch no jobs, create no teams, do not spend model tokens, and do not satisfy execution cadence. |
| Run history and artifacts | Nightly stage results, logs, summaries and report views | Persistent stage outcomes, errors, durations, cost and links to specialist reports. Fixed latest-run expansion, active snapshot display, interruption notes, stop-error feedback and real runs disappearing behind many previews. |
| Rounds | Scheduled project analysis | Separate venture-round controls and job ledger; the enabled workflow takes ownership when it contains specialist blocks. Kept accessible rather than presenting the disabled legacy round as the main workflow. |
| Goals and memory | Goals review and memory consolidation feed the nightly work | Explicit goal editing, owner-protected memory notes, consolidation and undo. Fixed stale save state, edits overwritten during saves, failed additions losing text, stale reopened memory editors, and model errors hidden behind a successful HTTP response. |
| Outcomes and SEO | Baseline reviews and follow-up analysis | Existing baseline/readings and SEO follow-up tests pass. Prevented overlapping UI actions from prematurely releasing the busy state; retained URL drafts typed during a request. |
| Phone layout | Workdash-specific settings navigation | Restored the six Workflows tab links on small screens and let the workflow name occupy its own row. Ledger rows wrap. |

## Deliberate differences

- OPC uses the selected workspace model and the shared sub-agent queue. Workdash's Dell wake/sleep ownership, GPU gate and per-stage local model rota are specific to its runtime; they were not copied into the OPC scheduler.
- Workdash offers a start/end window and opt-in catch-up. OPC currently has a local start hour, a night time budget, blackout windows and automatic coalesced catch-up. This audit fixes OPC's existing semantics; it does not change the owner's saved schedule or enable additional work.
- Workdash's process-level cron/source-monitor screens are not an exact visual match for OPC's workflow builder. Collector and integration status remain in their OPC areas. The builder manages the saved workflow, rather than claiming to control every service on the Pi.

## Validation

- 149 isolated server tests pass across Pipeline, Chief (rounds/goals/memory/outcomes), SEO follow-ups, timezones, workflow regressions, schedules and budgets. New tests cover fairness, role changes, busy scheduling, skip/catch-up behavior, persisted latest-run history and fractional timezone offsets.
- Server typecheck and production client build pass.
- Browser checks cover all six tabs, delayed and failed saves, saved-goal state, memory consolidation errors, active-run snapshot names, failed stop requests, latest-run expansion and mobile navigation/layout.
- Browser writes are intercepted fixtures. Live Pi requests are read-only; no real workflow, paid analysis, consolidation, notification or publishing job is started by verification.
- Deployment checks include an idle workflow/agent/chat guard, source hashes, a private source/database backup, served production assets, Hermes readiness, the render relay and Telegram poller health.
