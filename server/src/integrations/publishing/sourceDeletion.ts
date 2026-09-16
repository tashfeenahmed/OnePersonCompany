import { db } from "../../db.ts";

/** Pending publications still need their source file. Published items keep
 * their external post and history when the local generation is removed. */
export function sourceDeletionProblem(kind: "studio_post" | "video_job", id: string): string | null {
  const item = db.prepare(`SELECT id FROM publish_items
    WHERE source_kind = ? AND source_id = ? AND status NOT IN ('published', 'cancelled') LIMIT 1`).get(kind, id);
  return item ? "This generation is used in Publishing. Remove or cancel its pending publishing items before deleting it." : null;
}
