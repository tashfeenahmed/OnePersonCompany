/**
 * WHAT A DELETED RUN OWNS IN THIS AREA, in a module that depends on nothing.
 *
 * `video/execute.ts`'s `forgetVideo` clears the run's `video_jobs` row and the
 * videoplus area's framing rows, and it has to clear this area's `ugc_jobs`
 * row too — otherwise a forgotten UGC run leaves a row pointing at a deleted
 * directory. (It is honest about it: `shapeUgc` reports `imageOnDisk: false`.
 * It is still an orphan.)
 *
 * WHY IT IS ITS OWN FILE. `forgetVideo` is synchronous, so the guarded dynamic
 * import the `ugc` FORMAT uses is not available to it — and a static import of
 * `socialfeed/ugc.ts` from `execute.ts` would drag the publishing area, the
 * Studio and the whole asset library into the video manifest's import graph
 * for one DELETE. This module imports `db.ts` and nothing else, so it can be
 * imported from anywhere without closing a cycle.
 */
import { db } from "../../db.ts";

export function forgetSocialfeed(runId: string) {
  db.prepare("DELETE FROM ugc_jobs WHERE run_id = ?").run(runId);
}
