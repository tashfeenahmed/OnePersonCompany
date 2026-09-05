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
 * not one of its sources; hanging a badge off it would mean the rail waited on
 * a document it needs nothing else from. Ten seconds is the right interval for
 * a number whose only job is to say "something is happening" — a run takes
 * minutes, so a badge that is ten seconds stale has never been wrong about
 * anything a person would notice.
 *
 * IT FAILS TO NOTHING. A server that has not shipped the runs area answers 404
 * and this returns zeroes, which the rail draws as no badge at all. A count
 * that is absent is the honest rendering of "not known"; a zero would be a
 * claim that nothing is running, and those are not the same.
 */
export function useRunQueue(): { running: number; queued: number } {
  const [counts, setCounts] = useState({ running: 0, queued: 0 });

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
    const t = setInterval(() => void read(), 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return counts;
}
