/**
 * DOES EVERY BOARD IN THIS BUILD ACTUALLY EXIST?
 *
 * A dashboard is three files that have to agree with each other: the catalog in
 * `data/widgets.ts` says what a widget IS, `lib/liveWidgets.ts` says how it
 * fills itself with real numbers, and `lib/store.tsx` hands out boards made of
 * widget ids. Nothing in the type system joins them — a board is a list of
 * STRINGS — so a renamed widget, a typo in a seed, or a `live` flag with no
 * builder behind it all compile perfectly and fail in the browser as a card
 * that is silently missing or permanently showing samples.
 *
 * This is the join, run by hand and in one second:
 *
 *   1. Every widget id a seeded board or a preset names EXISTS.
 *   2. Every one of those that is marked `live` HAS A BUILDER. A card promising
 *      real numbers with no function behind it is the worst failure here,
 *      because it looks exactly like a provider that is not connected.
 *   3. Every widget's `src` is a real source, so the tile has a name and a mark.
 *   4. Every builder answers to a widget that exists — an orphan builder is
 *      dead code that reads as coverage.
 *
 * RUN IT WITH: npm run check:catalog
 *
 * WHY IT READS store.tsx AS TEXT. The seed is a module-private
 * constant, and it should stay that way: exporting it so a checker could
 * import it would add a non-component export to a file fast refresh
 * already complains about, and would let a page reach for the seed at runtime.
 * A regex over `type: "..."` is a weaker join than an import — and it is the
 * right weakness here, because the thing being checked IS the strings.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* Relative rather than the `@/` alias every other file uses: node resolves
   this one itself, with no bundler and no tsconfig paths in front of it. Both
   modules below import nothing but types, so stripping them is enough. */
import { WIDGETS, SOURCES, DASHBOARD_PRESETS } from "../src/data/widgets.ts";
import { LIVE_BUILDERS } from "../src/lib/liveWidgets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const store = readFileSync(join(here, "..", "src", "lib", "store.tsx"), "utf8");

/** Every widget id a seeded board places, in seed order. */
const seeded = [...store.matchAll(/type: "([^"]+)"/g)].map((m) => m[1]!);

const inPresets = DASHBOARD_PRESETS.flatMap((p) => p.widgets);

const failures: string[] = [];
const fail = (line: string) => failures.push(line);

/* --- 1 & 2: every placed widget exists, and answers when it promises to --- */

const placed = new Map<string, string>();
for (const [where, ids] of [
  ["a seeded board", seeded],
  ["a preset", inPresets],
] as const)
  for (const id of ids) if (!placed.has(id)) placed.set(id, where);

for (const [id, where] of placed) {
  const widget = WIDGETS[id];
  if (!widget) {
    fail(`${id} is placed by ${where} and is not in the catalog`);
    continue;
  }
  if (widget.live && !LIVE_BUILDERS[id])
    fail(
      `${id} is placed by ${where} and marked live, and has no builder — ` +
        `its card would promise real numbers and show samples for ever`,
    );
}

/* --- 3: every widget's source is a real source ------------------------- */

for (const [id, widget] of Object.entries(WIDGETS))
  if (!SOURCES[widget.src])
    fail(`${id} is filed under the source "${widget.src}", which does not exist`);

/* --- 4: no builder without a widget ------------------------------------ */

for (const id of Object.keys(LIVE_BUILDERS))
  if (!WIDGETS[id]) fail(`${id} has a builder and no widget in the catalog`);

/* --- what it found ------------------------------------------------------ */

const live = Object.values(WIDGETS).filter((w) => w.live).length;
console.log(
  `${Object.keys(WIDGETS).length} widgets across ${Object.keys(SOURCES).length} sources · ` +
    `${live} marked live · ${Object.keys(LIVE_BUILDERS).length} builders · ` +
    `${placed.size} distinct widgets placed by a board or a preset`,
);

if (failures.length) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? "" : "s"}:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log("catalog is consistent");
