# Workdash / OPC specialist audit — 2026-09-16

Compared the retained Workdash agent modules with OPC's run executor, specialist
prompts, persistent stores, artifact routes and the Pi's existing run metadata.
The local Workdash copies of `seo.js`, `competitors.js`, `research.js` and
`academic.js` match the retained Pi copies by SHA-256. Workdash stayed stopped.

| Specialist | Workdash | OPC after this change |
| --- | --- | --- |
| SEO | Structured, ranked JSON recommendations grounded in audit/GSC snapshots. Code validates basis, numbers, URLs and rewrite lengths; baseline narration describes changes. | Hermes review of audit, GSC, Bing, backlinks and presence. The specialist prompt now requires exact check/page/query evidence, ranked implementation table, observed text before rewrites, counted lengths, crawl limits and verification steps. Saved input snapshot plus the Markdown report are downloadable. These editorial rules are prompt requirements, **not Workdash's machine validation**. |
| Competitors | Persistent domain register; verifies, deepens and extends it. Checks domains and numeric claims against the actual tool evidence log. Computes change history and writes an HTML report. | Persistent domain register, first-seen/last-verified dates, computed changes, open follow-ups and HTML already existed. Now retains the investigation/context artifact and uses the raw provider for the writing pass when configured. A tool-free run cannot add competitors, change prices or refresh verification dates. URL presence remains a weaker check than Workdash's retrieved-domain and number validation. |
| Deep research | Reading-tool allowlist, enforced tool budgets, compacted conversation plus separate evidence log, business snapshots, HTML shelf. Default tool-call range is 20–30 (configurable). | Now separates the Hermes investigation from writing, saves evidence notes and context before writing, prompts for outside sources and business/market/economic coverage, then requires a complete self-contained HTML document with one format repair attempt. Writing uses the tool-free provider when available. In an agent-only configuration it is instructed not to use tools. Invalid output fails with evidence retained. No-tools runs are explicitly saved-context reviews. |
| Academic | Learned topic banks, literature harvest across arXiv, OpenAlex, Crossref, Europe PMC, DOAJ, OpenAIRE and DBLP; novelty planning, Typst body, SVG figures, bibliography, PDF and compile repair. | Already scouts arXiv/OpenAlex, keeps a library, plans a contribution, validates citations, draws SVGs and compiles Typst with repair (browser-print fallback). Now preserves the owner's full brief after search condensation, checks novelty against all saved papers rather than just 20, saves the exact supplied library/brief, and offers the complete source package. The fallback writer is explicitly told not to invent experimental results. |

## Downloadable artifacts

`GET /api/runs/:id/artifacts` returns a private `tar.gz` attachment for a stopped
run. It includes a manifest, the report as HTML or Markdown, board suggestions
when appended to HTML, and the saved `evidence.json` for new runs.

For papers it also includes available `paper.pdf`, `paper.typ`, `paper.md`,
`refs.bib` and `fig-N.svg`. Downloading the `.typ` alone previously omitted its
referenced dependencies. Missing source/PDF files are identified in the manifest;
no PDF is advertised as recreated. Export only admits named regular files inside
OPC's data directory, never arbitrary paths or symlinks. "All artifacts" is
available in the worker conversation, run view and paper shelf.

Existing reports and papers can be downloaded immediately. Older runs do not gain
retroactive evidence logs; their manifests say when there is no saved snapshot.
The evidence notes returned by Hermes are identified as agent notes, not as an
independently verified transcript of every fetched page.

## Remaining differences

This is not an identical copy of Workdash's execution engine. OPC uses its managed
Hermes integration, whose current tool event interface includes names/labels and
timestamps but not result bodies. Therefore it cannot apply Workdash's mechanical
source/number checks against raw tool results. Research coverage and read-only
behaviour are prompt instructions, not a tool allowlist or a forced minimum count.
The writer's provider call is actually tool-free when a provider is configured.

OPC's academic source breadth is still two indexes. It does not run Workdash's
independent seven-index daily harvest, adaptive topic bank or web novelty scout.
A successful OPC paper is a literature-grounded proposal, not a systematic review
or evidence that experiments were performed. Adding those collectors would be a
separate substantive port, not a prompt change.

No Workdash schedules, background services or automatic publications are enabled.

## Validation

- Production build (server typecheck and client build).
- Isolated tests for artifact extraction with standard `tar`, source dependencies,
  HTML sanitisation, missing files, traversal/symlink rejection, research phase
  separation, no-tools limits, incomplete report repair, and preservation of
  competitor verification dates without tools; existing merge/HTML/Typst tests.
- Deployment checks read already-saved Pi reports and paper artifacts; no paid
  investigation, paper generation or external message is started.
