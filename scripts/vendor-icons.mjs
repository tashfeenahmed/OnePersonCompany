// Rebuilds the carousel's offline icon sets from the npm packages.
//   npm pack lucide-static @tabler/icons   (in a scratch directory, then untar each)
//   node scripts/vendor-icons.mjs <lucide-static/package> <@tabler/icons/package>
// Writes server/src/integrations/videoplus/icons/{lucide,tabler}.json: the
// licence, the version, and each icon's inner SVG markup keyed by name. The
// outer <svg> is rebuilt by the renderer, so only the shapes are stored.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const [lucideDir, tablerDir] = process.argv.slice(2);
if (!lucideDir || !tablerDir) throw new Error("usage: vendor-icons.mjs <lucide-static/package> <@tabler/icons/package>");
const out = resolve(new URL("../server/src/integrations/videoplus/icons", import.meta.url).pathname);
function pack(name, dir, iconDir) {
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const icons = {};
  for (const file of readdirSync(join(dir, iconDir)).filter((f) => f.endsWith(".svg")).sort()) {
    const svg = readFileSync(join(dir, iconDir, file), "utf8");
    const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1] ?? "";
    icons[file.slice(0, -4)] = inner.replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/, "").replace(/\s+/g, " ").replace(/> </g, "><").trim();
  }
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ _license: readFileSync(join(dir, "LICENSE"), "utf8"), _version: `${meta.name}@${meta.version}`, icons }));
  console.log(name, Object.keys(icons).length);
}
pack("lucide", lucideDir, "icons");
pack("tabler", tablerDir, "icons/outline");
