# Clay module icons

25 custom icons generated with the built-in `image_gen` tool for the sidebar: 23 modules, Settings, and pinned sessions.

The set uses rounded clay forms, a multicolored pastel palette, soft highlights, and transparent backgrounds. Icons display at 20 px (16 px for Settings), with 112 × 112 WebP exports for sharp rendering on high-density screens. The complete set is about 100 KB.

- Artwork: [`client/src/assets/modules`](../../client/src/assets/modules)
- Exact generation prompts and Triage refinements: [`prompts.json`](./prompts.json)
- Shared renderer and route mapping: [`ModuleIcon.tsx`](../../client/src/components/ModuleIcon.tsx)

The WebP exports preserve transparency. Vite fingerprints and packages the assets for production. Images are decorative for screen readers, never draggable, and use a subtle hover lift and tilt that respects reduced-motion preferences.

To extend the set, use the style and subject structure in `prompts.json`, generate a single transparent icon, and export it to WebP at 112 px. Add its path mapping to `ModuleIcon.tsx`.
