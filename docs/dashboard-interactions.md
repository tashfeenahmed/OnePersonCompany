# Dashboard interactions

The interaction layer uses the existing theme, Radix dialogs/menus, CSS and the
Web Animations API. It adds no animation dependency and does not change saved
boards, widget identities or navigation preferences.

| Pattern | Shared implementation | Behavior |
| --- | --- | --- |
| Quiet refresh | `lib/readingPresentation.ts`, `LiveProvider` | Holds the last complete reading during a range change, with its original range label. Completed failures remain visible as failures. Same-range refreshes update existing readings. |
| Detail drawers | `components/interactions/DetailDrawer.tsx` | Alerts, venture previews and server details open beside the board; Escape/close restores focus without scrolling. Nested details offer Back. Reading snapshots identify their period or last probe. |
| Selection | `SelectionPill`, `TabStrip`, `WindowPicker` | The selection moves between controls, including wrapped tabs. Board content fades briefly; returning to a board restores its scroll position. |
| Disclosure | `AnimatedDetails` | Native summary/details semantics with interruptible height animation. |
| Contextual actions | `InspectButton`, `BoardView` | Refresh/Edit stay visible. Rename/Copy live in an overflow menu. Widget controls reveal on hover or keyboard focus and remain available on touch screens. |
| Pinned readings | Overview chart kit, `ServerLoadChart` | Click/tap or Enter pins a value. Escape or Unpin clears it. CPU and area charts support arrow keys. Pins reset when the underlying series changes. |
| Undo | `UndoActions`, `server/src/actions/undo.ts` | Acknowledge, resolve and snooze write immediately and offer Undo for 30 seconds. Notifications stay accessible inside a drawer. |
| Reordering | `useReorderMotion`, board/tab/sidebar pointer handlers | Marked destinations, small movement thresholds, cancellation and 200ms settling. Keyboard reordering remains available. |

Animations run for 150–200ms and respect `prefers-reduced-motion`.

## Extending actions safely

Keep the source area's write verb authoritative. Wrap the verb in `undoable`
inside its database transaction, return the receipt, and use `useUndoActions`
in the client. Receipts only contain allowlisted disposition fields. Restoration
checks that those fields still match the action's result and refuses newer
changes. Recovery timestamps, source content and measurements are never restored.
A repeated successful Undo is idempotent; expired receipts cannot change data.

## Validation

- Unit/API coverage: range switches, partial and failed readings, acknowledgements,
  commitment resolution, email snoozes (including thread IDs containing colons),
  expired receipts, conflicts, duplicate Undo and recovery preservation.
- Full suite: 1,038 server tests and 206 client tests pass.
- Build, strict TypeScript, lint (existing warnings) and widget catalog checks pass.
- Browser checks use a disposable database and synthetic fleet/incident data:
  drawer focus and scroll restoration, pinned CPU values, keyboard and pointer
  reordering, mobile drawer layout, disclosures, acknowledge/Undo, and a delayed
  range request that retains all 19 cards and three CPU charts with the old label
  until the replacement is ready. No real incident was acknowledged for testing.
