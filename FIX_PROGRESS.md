# Review fixes — 6 September 2026

Implemented the 33 items authorized after `PROJECT_REVIEW.md`, with the scoped limits below. Existing working-tree changes were preserved. This table distinguishes automated regression coverage from browser checks and code review.

| ID | Type | Implemented change | Verification |
|---|---|---|---|
| B1 | Bug | Owner-only mail/budget controls reject service credentials. Exact-content approval is mandatory. Public session IDs are separate from secret tokens. Service credentials cannot use owner login/password/session-management endpoints. | HTTP permission, immutable-preview and session-token tests. OS boundary remains as described below. |
| B2 | Bug | Atomic send claim, immutable message, daily-capacity reservation, locked edits and uncertain-delivery recovery. | Concurrent mocked Gmail sends produce one delivery; approved MIME content, interrupted sending and zero allowance tested. |
| B3 | Bug | Shared backup/restore manifest includes videos, papers and service identity; restore relocates artifact paths. | Actual archive/restore in separate temporary directories, checking file contents, keys and paths. |
| B4 | Bug | Explicit loading/disconnected/empty/failed/measured widget states; no sample measurements in fallbacks. | Browser disconnected-dashboard checks and source-state review. |
| B5 | Bug | Live widget rendering does not inherit sample charts, deltas or captions. | Regression test overlays a measured value on a populated sample trend/chart. |
| B6 | Bug | Missing API limit defaults to 100; UI pages 50 drafts with counts/navigation. | Default/offset regression and outbox browser inspection. |
| B7 | Bug | Shared full preference validation, invalid-cache recovery and root render error boundary. | Malformed schema tests, server validation and client build. |
| B8 | Bug | Authentication-storage errors return unavailable instead of opening private routes. | HTTP test makes the owner table unavailable and asserts 503. |
| B9 | Bug | Explicit env-file loading, process-env precedence, stable data paths and numeric validation. | Subprocess environment regression and launcher review. |
| B10 | Bug | Import/reset is scoped to preferences; ventures/accounts remain server-authoritative. | Validation/CAS tests and import/reset state-flow review. |
| B11 | Bug | Dashboard refresh button, polling, focus/mutation refresh, cleared disconnected data and per-source failures. | Browser states, source mapping review and catalog check. |
| B12 | Bug | Chat deletion waits for server success; errors retain the local conversation. | Handler/state-flow review and build. |
| B13 | Bug | Server-enforced 30-day absolute and seven-day idle expiry; old session format revoked. | Expired, idle and public-ID-as-token regression cases. |
| B14 | Bug | Migration discovery/application under a write lock, startup WAL contention retry, isolated test-worker databases. | Four concurrent initializers and parallel server suite. |
| B15 | Bug | Shared run-route mapping for AI visibility/Ops; screenshot QA detail route. | Canonical route regression and build. |
| B16 | Bug | Request generations prevent older refresh responses from replacing newer data, including manual reload/unmount. | Hook lifecycle review and incremental strict checking. |
| B17 | Bug | Session search works; Attach inserts a text file up to 100 KB into the draft, with errors and an accessible name. | Browser file-chooser smoke test inserted a local text fixture into the draft; search/control review. Binary attachment processing is outside this scope. |
| B18 | Bug | Catch-all page explains a missing address and links to the workspace. | Browser visit to an unknown route. |
| U1 | UX | Mobile navigation drawer, responsive grid/content, accessible tab picker and mobile widget editing layout. | 390 × 844 checks on chat, dashboards, settings, queue and outbox; desktop checks. |
| U2 | UX | Local draft autosave per conversation and mail composer/editor; storage errors surfaced. | Chat survives browser navigation; mail persistence reviewed. |
| U3 | UX | Import/reset scope/count confirmation, recovery copy, restore action and storage-failure feedback. | Schema/state-flow review and built controls. |
| U4 | UX | Grouped navigation, favorites and searchable all-app/dashboard picker. | Desktop/mobile navigation checks. |
| U5 | UX | Concise primary copy in settings, security, activity, outbox and queue; technical/worker detail is expandable. | Browser inspection and stale-copy corrections. |
| U6 | UX | Mailbox links to Triage/Commitments instead of claiming they are unbuilt. | Source review and build. |
| U7 | UX | Named chat/mail fields and controls, plus async errors/status announcements. | Browser accessibility tree confirms compose labels. |
| U8 | UX | Keyboard tab reordering, widget move controls and position announcements alongside pointer dragging. | Drag-order tests, control review and mobile editing layout. |
| F1 | Feature | Server-backed workspace/layout/session metadata, revision checks, local cache, conflict resolution and recovery. | Valid/invalid payload and stale-revision tests; browser sync flow review. Theme/unsent drafts remain local. |
| F2 | Feature | Root setup/dev/build/start/doctor/check commands, Node pin, production SPA serving, setup checklist and guide. | Production build/server browser smoke, environment regression and typechecks. |
| F3 | Feature | Queue pause/hold/reorder, retry original inputs as a new job, AI visibility checkpoint resume and missed-round catch-up. | Retry-preservation, checkpoint and schedule tests; queue UI checks. Resume is scoped below. |
| F4 | Feature | Runtime/call/output/token/estimated-dollar caps, atomic reservations, job/daily/per-venture accounting and owner-only settings. | Concurrent budget, missing-usage, checkpoint, unmetered-agent and settings-authorization tests. Accounting limits below. |
| F5 | Feature | Prioritized Action inbox: search/filter, venture context, sources, snooze, resolve and idempotent board handoff. | Commitment resolution, snooze and board handoff tests; empty-inbox browser check. |
| F6 | Feature | Mailbox/triage draft reply carries account/thread context; From/venture selection, local drafts and conversation backlink. | Compose accessibility/browser checks and mail state-flow review. Live Gmail flow not exercised. |
| F7 | Feature | Root test/check, CI, isolated fixtures, full server and incremental client strict checks. Route splitting reduces the initial bundle. | Local check suite plus desktop/mobile smoke. Browser smoke is manual, not a CI browser runner. |

## Validation

- `npm run check`: **149 server tests + 6 client tests**, server typecheck, client build, lint, catalog and incremental strict check.
- Temporary databases and mocked external calls cover mail/auth, storage restoration, workspace revisions, job controls, budgets and daily scheduling.
- Browser smoke uses a separate production server with temporary data, including phone-sized views, draft persistence, disconnected dashboards, setup/budgets, queue, outbox labels and missing-page recovery.
- Lint has no errors; nonblocking React/Fast Refresh/effect warnings remain. Vite warns about the main chunk (approximately 596 KB minified, down from the original 1.40 MB); pages load in separate chunks.
- No real emails or paid jobs were launched for verification. Provider-wide end-to-end coverage is not claimed. CI configuration was added; no hosted CI run was dispatched.

## Scope limits

- **Agent isolation:** API owner controls are enforced, but an unrestricted agent under the same OS user can read files or modify the database. Set owner sign-in before granting agent access. Separate OS users/containers and credential storage are needed for a hostile-code boundary.
- **Resume:** AI visibility reuses saved model steps. Other jobs retain retry because their external effects cannot safely be replayed by a generic mechanism.
- **Costs:** managed calls reserve tokens and estimated dollars. The owner sets the price ceiling; this is not a provider billing cap. Unmetered agents, video and screenshot QA are blocked under token/dollar caps. Arbitrary tools/subscriptions remain outside the ledger.
- **Strict checking:** the server is fully strict; the client strict target is incremental.
- **Storage:** old archives cannot gain previously omitted files. Theme and unsent drafts stay browser-local. Preference imports do not import server ventures or credentials.

See `README.md` for setup and recovery instructions.
