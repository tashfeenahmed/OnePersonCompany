# Studio input comparison

Compared on 2026-09-16 with Workdash's `src/pages/Studio.tsx` and `agent/{studio,shorts,faceless,motion,reel}.js`. The local generation modules matched the retained files under `/opt/workdash/agent` on the Pi byte for byte. Workdash remains retired; OPC owns the UI, model selection and jobs.

| OPC format | Workdash's input model | OPC changes |
| --- | --- | --- |
| Image post | Optional topic, selected brands/platform and quantity. The model could choose an angle. | Topic is optional. An empty brief asks the workspace model for a fresh angle from saved venture/brand/knowledge facts, avoiding recent briefs. The resulting angle drives both caption and image. Shape and reference overrides are optional settings. |
| UGC clip | Describe the opening shot; optional references. Animation had a separate prompt and duration. | A described shot no longer requires uploading a picture first. References remain available, restricted to the chosen venture. The route checks the configured image provider rather than demanding Replicate for an OpenRouter image. |
| Faceless video | A subject, optional own script/instructions, plus manual voice/footage/layout controls. No venture required. | Subject works without a venture. AI chooses bounded shots and timing by default. Target duration and framing remain optional; an explicit duration keeps the existing fixed-length behavior. |
| YouTube Shorts | Search, preview, select videos and choose 1–5 clips per source (default 1). The worker selected moments and reframed vertically. | Matches that primary input flow, retaining pasted URLs. Clip count now works across UI, executor, pipeline and model prompt. Venture, moment guidance, shape, length cap and framing are optional. |
| Reel | No separate generic walkthrough format; Workdash's character Reel corresponds to OPC's Stewie. | Keeps OPC's page walkthrough. Venture, pages and brief remain primary; layout and target length move to optional settings. |
| Motion | Prompt, automatic palette (or override), optional end-card handle. Model wrote scenes/timing. | Prompt first; no required venture or scene list. Existing branding, narration, shape and saved-scene editor remain optional. Saved scene URLs still open the editor and preserve the saved shape unless overridden. |
| Stewie | Images/pages, topic (optional with pages), automatic or selected gameplay. | Same main controls; optional venture association moves under settings. Workspace AI continues to write the script before OPC's render relay runs it. |

## Scope

This aligns the creation inputs and removes unnecessary requirements. It does not make the renderers identical: OPC still uses its own stock-footage, Shorts, motion and UGC pipelines. Workdash's image batch composition, two-stage UGC approval, faceless voice/transition/music presets, motion palette presets and character rendering are distinct capabilities. This change does not add unsupported controls for those features. Workdash's character renderer is already available through OPC's Stewie relay.

Manual overrides are retained instead of discarded. An explicit brief is not rewritten; saved Motion scenes remain selectable and editable; target duration still overrides automatic faceless timing. Generated content remains a draft.

## Validation

- Focused video, motion, social-feed and input-contract tests use an isolated database and mocked providers; no paid generation.
- Isolated browser checks cover all seven forms, intercepted submissions, default and overridden values, saved Motion links, and mobile widths.
- Production typecheck/build and deployed asset checks; no fresh GPU render or published content.
