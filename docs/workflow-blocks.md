# Nightly workflows

Open **Workflows → Pipeline** to build and schedule a nightly business review.
The starter is a preview until you save it; scheduling stays off until enabled.

## Building a workflow

- Drag a block's handle to reorder it. Keyboard users can use **Alt + Up/Down**,
  or the move buttons inside the editor.
- Click a block to change its name, cadence, time limit and dependencies.
- Add, duplicate, disable or remove blocks, then **Save workflow**.
- Specialist blocks also have a role, instructions, venture stages, business
  types, optional venture selection, review interval and ventures-per-run limit.
- Leave venture selection empty to include matching current and future ventures.
  Connections, team instructions and the centrally selected LLM provider are
  reused; the workflow contains no credentials or separate provider settings.
- **Plan tonight** checks eligibility and ordering without dispatching jobs,
  calling a model or changing cadence. **Run saved workflow** starts real work.

The starter refreshes sources, checks alerts, reviews mail, runs six specialist
blocks (SEO, demand, competitors, AI visibility, research and app stores),
assembles findings, files board actions, checks SEO operations, reviews
relationships, consolidates memory and writes the morning brief. Relationships
and memory run weekly; the other blocks are daily. Each specialist reviews up to
two due ventures and waits seven days before reviewing a successful one again.
App store reviews target mobile businesses; roles needing websites require a host.

## How execution works

The saved order is the execution order. Dependencies must come first; synthesis
must follow the enabled specialists and the morning brief must come last. A
dependency normally controls ordering. Turn on **Require dependencies to succeed**
to skip a block unless its prerequisites completed in the same run.

Every run stores a snapshot of its block definitions. Editing the workflow during
a run affects the next run. Revision checks prevent a stale browser from
overwriting another editor's changes.

Specialists use the existing sub-agent team and durable run queue. A block waits
for each owned job to finish before continuing. Already busy or disabled
specialists are skipped, and eligible ventures rotate by least recent attempt.
Synthesis prioritises ventures with completed reports from the current night,
then fills its configured quota from the ordinary coverage rotation. Its evidence
and duplicate checks still control which proposals become board cards.

Each block records completed, skipped, failed or over-budget status, counts and
notes. Linked sub-agent reports are available in the run detail. Partial source
or model failures remain visible; an unavailable source is never counted as a
successful analysis. The morning brief can still run after a failed analysis.

**Stop run** cancels the active owned specialist job and skips the remaining
blocks. Block and nightly deadlines propagate cancellation to model calls;
legacy source collectors finish their current request before stopping. After a
server restart, an interrupted run is closed and its pending jobs are cancelled.
It is not silently replayed. Completed reports and run history remain available.

## Scheduling and budgets

The app checks its schedule every ten minutes using the selected time zone.
It must be running for work to execute; if the computer sleeps through the
scheduled hour, it catches up when awake. The persisted daily claim prevents a
restart from dispatching the same scheduled night twice. Use **Skip tonight** for
a single night, or disable the schedule entirely.

Blocks reserve their configured time against the remaining nightly budget. If
there is not enough time left, they are marked over budget. Timeouts stop further
work; dollar budgets are checked before blocks, with the shared runtime's
per-call and automation limits still applying. Reported cost includes direct
calls and linked specialist jobs. Dollar cost is unknown without token pricing.

When an enabled workflow owns specialist reviews, relationships, memory or the
morning brief, their separate timers stand down. Source refresh shares the
collector scheduler's lock and reuses successful readings from the last fifteen
minutes. Daytime collection, alert evaluation and mail triage continue normally.

## Extending the system

`shared/workflow.ts` defines the serializable block types and starter template.
`workflow-store.ts` validates definitions and performs revisioned saves.
`workflow-engine.ts` maps block kinds to existing application services through
`registerWorkflowExecutor`. Add a kind, its editor fields and an executor to
introduce another service without changing the nightly runner.

The database holds definitions in `pipeline_workflow`, run snapshots in
`pipeline_runs`, outcomes in `pipeline_stage_results`, and child-job links in
`pipeline_block_jobs`. Definitions contain scope and instructions; connected
data stays in the existing integrations and secrets storage.

API: `GET/PUT /api/pipeline/workflow`, `POST /api/pipeline/start`,
`POST /api/pipeline/stop`, `POST /api/pipeline/plan`, and
`GET /api/pipeline/runs/:id`. Schedule settings use the existing
`PUT /api/plugins/pipeline/config` endpoint.
