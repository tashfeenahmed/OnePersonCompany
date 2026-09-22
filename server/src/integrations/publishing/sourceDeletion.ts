import { db } from "../../db.ts";

/** Pending publications still need their source file. Published items keep
 * their external post and history when the local generation is removed.
 *
 * A carousel is a `video` run, so it is deleted through the same run route as
 * every video and asked about as a `video_job`; its items are `carousel`
 * sources under the same run id, and they hold it back exactly as a queued
 * image post holds back its Studio post. */
export function sourceDeletionProblem(kind: "studio_post" | "video_job", id: string): string | null {
  const item = db.prepare(`SELECT id FROM publish_items
    WHERE ((source_kind = ? AND source_id = ?) OR
      (? = 'video_job' AND source_kind = 'carousel' AND source_id = ?) OR
      (? = 'video_job' AND source_kind = 'video_clip' AND substr(source_id, 1, length(?) + 1) = ? || ':'))
      AND status NOT IN ('published', 'cancelled') LIMIT 1`).get(kind, id, kind, id, kind, id, id);
  return item ? "This generation is used in Publishing. Remove or cancel its pending publishing items before deleting it." : null;
}
