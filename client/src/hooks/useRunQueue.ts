import { useEffect, useState } from "react";
import { runsApi } from "@/lib/api/runs";

/**
 * HOW MUCH AGENT WORK IS IN FLIGHT, for the one badge in the sidebar.
 *
 * The rail used to read this off `data/subagents.ts` — a hand-written roster
 * with `running: true` typed into it — so the badge said "2" on a box where
 * nothing had ever run. This asks the queue instead.
 *
 * A POLL AND NOT THE LIVE FEED. `lib/live` is a several-hundred-line context
 * that fans one collector document out to forty widgets, and the runs queue is
 * two integers. Ten seconds while nothing is moving; three while something is,
 * because a run's status is the thing the owner is watching then.
 *
 * AND IT LOOKS THE MOMENT A CHAT TURN ENDS. A sub-agent is dispatched from
 * inside an answer, and the owner's eye goes to the rail as the answer lands —
 * where a badge that would arrive within ten seconds is a badge that is not
 * there. The Chat page fires `opc:work-changed` when a turn finishes (see
 * `announce` in pages/Chat.tsx) and this re-reads on it, and on the tab coming
 * back into view, which is the other moment "is it still running" is asked.
 */
/** Fired by the Chat page when agent work changed: a turn ended, or a
 *  sub-agent was filed under a conversation mid-answer. */
export const WORK_CHANGED = "opc:work-changed";

export function useRunQueue(): { running: number; queued: number } {
  const [counts, setCounts] = useState({ running: 0, queued: 0 });
  const live = counts.running + counts.queued > 0;

  useEffect(() => {
    let alive = true;
    const read = () =>
      runsApi
        .list({ limit: 1 })
        .then((doc) => {
          if (alive)
            setCounts({ running: doc.running ? 1 : 0, queued: doc.queued });
        })
        .catch(() => {
          if (alive) setCounts({ running: 0, queued: 0 });
        });
    void read();
    const t = setInterval(() => void read(), live ? 3_000 : 10_000);
    const now = () => void read();
    const visible = () => {
      if (document.visibilityState === "visible") now();
    };
    window.addEventListener(WORK_CHANGED, now);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(WORK_CHANGED, now);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [live]);

  return counts;
}
