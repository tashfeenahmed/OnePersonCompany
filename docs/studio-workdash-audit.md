# Studio workflow audit — 2026-09-16

Compared OPC with the retained Workdash checkout at `4eca140`, principally `src/pages/Studio.tsx`, `src/pages/StudioAutopilot.tsx`, and `agent/{studio,autopilot,shorts,faceless,motion,reel}.js`. Workdash remains retired. This audit does not activate Autopilot, submit a post, send a Telegram message, or spend generation credits.

## Comparison

| Area | Workdash | OPC after this audit |
| --- | --- | --- |
| Studio creation | Images, UGC, faceless, Shorts, Motion and character Reel, with model-written briefs/scripts and optional overrides. | All six corresponding creation flows remain. Workdash's character Reel is called **Stewie** here; the separate website Reel option stays removed as requested. Existing generation history and downloads remain. See `studio-workdash-inputs.md` for the per-format input comparison. |
| Generation → Publishing | Generated drafts, editable captions, explicit publishing. | Image drafts already had a queue action. Finished videos now have one too, and every Shorts clip can be filed separately. Sources retain their venture ownership. Pending clip drafts protect the underlying generation from deletion. |
| Autopilot | User-selected projects and types, sequential runs, model planning, repetition memory, delivery to Telegram. | Daily schedule, per-venture weekly cadence, stage exclusions, daily budget, shared run queue, source discovery and novelty memory. Selected video formats now rotate per venture instead of silently using only the first. The day budget counts actual items, not summary rows, in the owner's timezone. |
| Autopilot delivery | Completed work delivered as it lands. | Completed videos and all Shorts clips become unapproved Publishing drafts, using the same destination and proposed-slot rules as image posts. Failed filing is retried; already filed or edited items are retained. Existing Telegram settings still control notification delivery. |
| Publishing | Draft editing, explicit submission, timed queue, connected-channel capabilities, campaigns and performance feedback. | Queue, Calendar, Destinations, Campaigns, Assets and Published tabs exist. Added caption/destination editing and video previews. Editing approved content withdraws its approval and schedule. Rehearsal remains available; scheduled sends still require explicit approval. |
| Campaigns | Goal → concepts × platforms → drafts; suggestions and repetition avoidance. | Goal/concept/channel fan-out already calls the common Studio generator and files drafts. It now inherits automatic reference selection. OPC's suggestion implementation differs from Workdash's cached model-generated ideas. |
| Reference photos | Upload/paste/URL, per-photo instructions, project association, least-recently-used selection. | Added automatic rotation through available photos of the selected venture, with an explicit opt-out. Per-photo instructions now accompany image inputs, rather than disappearing for image-capable models. Clearing prompts works; drag/drop upload works; removal failures are shown. |
| Logos & branding | Uploaded/selected logo, editable palette/style/audience/language, website-derived defaults. | Same core controls. Logo selection now rejects missing files, non-logos and other ventures' assets. Moving/deleting a selected logo clears its assignment. Saved cleared overrides return to measured defaults without discarding unrelated edits. |

## Other fixes

- On small screens the Studio rail opens in a drawer, leaving the active section full width.

- Autopilot uses the canonical Publishing timezone, with legacy fallback.
- Proposed publishing slots and Autopilot start times support half/quarter-hour UTC offsets and daylight-saving transitions.
- Unknown Autopilot/Publishing tab parameters fall back to a usable tab.
- Autopilot help text reflects connected providers, format rotation, manual passes and draft delivery.
- Publishing actions are disabled while a request is in flight. Existing proposed times populate the scheduling control.

## Remaining product differences

OPC is not a pixel-for-pixel or renderer-for-renderer copy of Workdash. These are not claimed as newly implemented:

- Workdash's bulk image composer and separate UGC still-review/animation stages; OPC currently has single-image composition and its combined UGC flow.
- Workdash's manual per-pass project × format batch picker and batch stop control. OPC uses its cadence/stage configuration and individual run controls.
- Faceless voice/transition/music presets and Motion palette presets have different controls and rendering implementations.
- Workdash can associate one reference photo with multiple projects. OPC assigns one venture per asset; upload a copy for another venture.
- Telegram media-delivery presentation is not identical. This audit validates OPC's draft filing without exercising external delivery.
- Publishing support depends on each connector and media kind. In particular, the existing Instagram/LinkedIn adapters do not support video uploads; their capability checks report that limitation. X remains a copy-out target, not a publishing destination.

## Verification

- 124 focused server tests across Publishing, References, Social feed and Video, using isolated temporary databases. Added coverage for local-day budgets, timezones, format rotation, logo ownership/lifecycle, clearing prompts, reference rotation/instructions, HTTP automatic-reference defaults/opt-out, clip idempotency/deletion protection and partial delivery retries that preserve edits.
- Existing publishing tests rehearse through mock transports and cover approval invalidation, scheduling, retry safeguards and duplicate-submit protection.
- Server typecheck and production client build.
- Browser checks across all six Studio formats, three Autopilot tabs, six Publishing tabs and both References tabs; intercepted clip queue/caption edits, reference opt-out and mobile Publishing width. Production data reads only; no external publishing or paid rendering.
- Deployment verifies source hashes, served production assets, favicon, Hermes readiness, render-relay configuration and Telegram poller health after an idle restart. Source and database snapshots are retained for rollback.
