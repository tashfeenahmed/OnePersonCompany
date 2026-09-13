# Clay module icons

These assets are now an artwork library for sub-agents. Sidebar and owner-menu
navigation use Lucide React. See [the current role mapping](../agent-icons/README.md)
for the reused artwork and six matching additions. The notes below describe the
original generation of this set.

33 custom icons generated with the built-in `image_gen` tool for the sidebar: 31 modules, Settings, and pinned sessions.

The set uses rounded clay forms, a multicolored pastel palette, soft highlights, and transparent backgrounds. Icons display at 20 px (16 px for Settings), with 112 × 112 WebP exports for sharp rendering on high-density screens.

The expanded set includes Journal, Customers, Nurture, Motion, Publishing, Posts, Mobile health, and Web. The shared renderer displays the same artwork when a page is pinned.

- Artwork: [`client/src/assets/modules`](../../client/src/assets/modules)
- Exact generation prompts and Triage refinements: [`prompts.json`](./prompts.json)
- Shared renderer and route mapping: [`ModuleIcon.tsx`](../../client/src/components/ModuleIcon.tsx)

The WebP exports preserve transparency. Vite fingerprints and packages the assets for production. Images are decorative for screen readers, never draggable, and use a subtle hover lift and tilt that respects reduced-motion preferences.

To extend the set, use the style and subject structure in `prompts.json`, generate a single transparent icon, and export it to WebP at 112 px. Add its path mapping to `ModuleIcon.tsx`.
