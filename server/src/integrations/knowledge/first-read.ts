/**
 * THE FIRST READ OF A VENTURE'S REPOSITORY, hung off the site reading.
 *
 * WHY IT IS ITS OWN FILE. `ventures/enrich.ts` is another area's, and the one
 * line it gained is a CALL — no policy, no error handling, no knowledge of what
 * a repository is. All three of those live here, so a change to when a first
 * read happens is a change to this file and not to the brand extractor.
 *
 * WHY IT IS FIRST-TIME ONLY. A repository read costs a handful of GitHub calls
 * and one completion. `enrichVenture` runs on every create and on every press
 * of "read the site again", and a button that quietly spends a completion each
 * time is a button the owner learns not to press. So this returns immediately
 * unless a repository is mapped AND has never been read: after that, refreshing
 * is the Knowledge tab's own button, the skill's `request_refresh`, or the
 * HEAD-moved rule inside `refreshRepo`.
 *
 * WHY IT SWALLOWS EVERYTHING. It is deliberately not awaited — a venture must
 * be creatable while GitHub is down — so there is nobody to catch a rejection.
 * The failure is recorded on the venture's knowledge row instead, where the tab
 * draws it beside the repository name, which is where a person would look.
 */
import { markRepo, repoRow } from "./store.ts";
import { refreshRepo, resolveRepo } from "./extract.ts";

export function startKnowledgeRead(ventureId: string): void {
  let target: ReturnType<typeof resolveRepo> = null;
  try {
    target = resolveRepo(ventureId);
  } catch {
    return;
  }
  if (!target) return;
  /* Already read once — including a read that failed, which is recorded and
     should not be retried on every site refresh. `extracted_at` is set on
     success and the error column on failure; either one means "this has been
     tried" and the owner has a button. */
  const known = repoRow(ventureId);
  if (known && (known.extracted_at || known.error)) return;

  void refreshRepo(ventureId).catch((err: unknown) => {
    try {
      markRepo(ventureId, {
        error: `the first read of ${target!.repo} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } catch {
      /* Nothing left to do: the process is not going to be told twice. */
    }
  });
}
