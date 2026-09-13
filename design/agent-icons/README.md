# Sub-agent artwork

Navigation uses Lucide React through `ModuleIcon.tsx`. The clay artwork identifies
workers through `RoleIcon.tsx`, with one stable image per role across every venture.
The role cards and Chief of Staff use 40 px artwork; chart rows use 28 px.

| Role | Artwork | Source |
| --- | --- | --- |
| Researcher | Telescope | New |
| Competitor analyst | Rival chess knights | New |
| SEO analyst | Magnifying glass and check | New |
| Demand analyst | Speech bubble | Reused: chat |
| AI visibility analyst | Robot | Reused: autopilot |
| Academic paper writer | Open book and pencil | New |
| Video producer | Clapperboard | Reused: video |
| SERP analyst | Search results | New |
| Store listing auditor | Phone and star | New |
| Campaign planner | Publishing calendar | Reused: publishing |
| People analyst | People | Reused: people |
| Chief of Staff | Organization tree | Reused: org |

New assets live in `client/src/assets/agents`, exported as transparent 112 × 112
WebP images. Reused artwork stays in `client/src/assets/modules`. Both are bundled
and fingerprinted by Vite. Images are decorative, non-draggable, and have fixed
dimensions to avoid layout shifts. Unknown future roles use the clay workflow icon.

The exact prompts for the six additions are in [prompts.json](./prompts.json).
They were generated with the built-in `image_gen` tool, matching the original
pastel clay palette, rounded shapes, and lighting. To add a role, generate a matching
asset and add its role key to `client/src/components/org/roleArtwork.ts`.
