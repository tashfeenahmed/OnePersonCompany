# Automatic board cards

The server checks collected data every minute and files actionable work in
Backlog. The first check runs five seconds after startup. **Board → Auto cards**
lets the owner pause filing, choose sources, inspect errors, or check immediately.
Settings persist in the workspace database. Automatic filing is enabled by default.

| Source | What becomes a card |
| --- | --- |
| Health | Actionable server, domain, uptime and app alerts; unreadable checks and missing first samples are excluded. |
| Pending work | Open commitments, emails awaiting a reply, and payment failures, disputes or failed jobs from the last seven days. |
| Growth | A measured Search Console opportunity for a launched venture: at least 100 impressions and average position 5–20. At most one query per venture and six ventures per pass. |

Growth reads must be no more than three days old and their reporting window must
end within seven days. Explicit Search Console links take precedence over host
matching. A venture's existing proposal opt-out is respected. Sources without
data contribute no cards; this check does not collect data or call an LLM.

Each card retains a source link and dated snapshot. It is an editable task, so
later measurements do not overwrite its title, notes, position or completion.
Recoveries do not automatically complete work already on the board. Snoozed,
resolved and acknowledged source items are excluded before filing.

Stable origins prevent repeated cards across checks and restarts. Existing cards
filed from the Action Inbox are recognised, as are manually typed cards with the
same title and venture. Completed and archived cards still count as filed. A
durable receipt survives deletion, so deleting a card does not cause it to return.

A pass inserts at most 25 new cards. Remaining candidates are reconsidered on
later passes. Each source writes in its own transaction; one unavailable source
does not block the others. Concurrent checks share the current pass.

The board refreshes quietly every 15 seconds while visible and when work changes
or the tab becomes visible. It keeps the existing display during reads and pauses
background replacement during a drag, open card editor or mutation.

## Adding a source

Register an adapter during server startup with `registerBoardSource` from
`server/src/board/automation.ts`. Built-in examples are in
`server/src/board/sources.ts`.

```ts
registerBoardSource({
  id: "my-feed",
  label: "My feed's pending work",
  read: () => [{
    origin: "my-feed:stable-item-id",
    title: "Review the returned issue",
    detail: "The evidence and suggested next step.",
    href: "/my-feed",
    observedAt: new Date().toISOString(), // Use the actual source observation time.
    ventureId: null,
    urgency: 2,
  }],
});
```

Use a stable, namespaced origin for the same piece of work, and a new origin only
for a genuinely different item. Supply local source URLs and actual observation
times. Filter out stale, dismissed or snoozed items in the adapter. `aliases` can
name origins used by an existing manual filing path. The adapter appears in the
source controls automatically; keep reads bounded and use completed local data.

API: `GET /api/board/automation` reads status, `PATCH /api/board/automation`
updates `{ enabled, sources: { [sourceId]: boolean } }`, and
`POST /api/board/automation/sync` runs a check. Reading status never files cards.
