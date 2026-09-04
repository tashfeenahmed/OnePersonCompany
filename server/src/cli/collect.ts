/** `npm run collect` — one pass, then exit. What the scheduler does, by hand. */
import { COLLECTORS } from "../collector.ts";

for (const [id, run] of Object.entries(COLLECTORS)) {
  const r = await run();
  console.log(id, r.ok ? "ok" : "FAILED", JSON.stringify(r, null, 2));
}
process.exit(0);
