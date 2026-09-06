import { useEffect, useState } from "react";
import { alertsApi } from "@/lib/api/proactive";

/**
 * HOW MANY ALERTS ARE OPEN, for the one badge on the rail's Alerts row.
 *
 * Built the way `useRunQueue` is, and deliberately not sharing its code: that
 * hook polls a queue that moves every few seconds, this polls a ledger that
 * changes when the evaluator runs — about every half hour. One shape, two
 * clocks, and a shared abstraction would have to hold both.
 *
 * A POLL AND NOT A FEED. `lib/live` fans one collector document out to forty
 * widgets; this is one integer. Sixty seconds is far more often than the
 * number can change on its own, and it is what makes acknowledging an alert on
 * the page take the badge down without a reload.
 *
 * `undefined` RATHER THAN 0 WHEN NOTHING IS OPEN, and when the API cannot be
 * reached at all. No badge is the honest drawing of "nothing to report"; a grey
 * 0 is a number somebody has to read, and a 0 drawn because the fetch failed
 * would be a claim that nothing is wrong made by a page that could not ask.
 *
 * OPEN COUNTS UNREADABLES BESIDE TRIPS — the server's own definition. A rule
 * that has not been able to read its document for three days is a watchdog
 * that has stopped watching, and a rail that hid that would be hiding the one
 * failure this feature exists to prevent.
 */
export function useOpenAlerts(): number | undefined {
  const [open, setOpen] = useState<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const read = () =>
      alertsApi
        .summary()
        .then((doc) => {
          if (alive) setOpen(doc.open.total || undefined);
        })
        .catch(() => {
          if (alive) setOpen(undefined);
        });
    void read();
    const t = setInterval(() => void read(), 60_000);
    const visible = () => {
      if (document.visibilityState === "visible") void read();
    };
    /* Acknowledging one on the page fires this; so does building a briefing.
       Without it the badge would be up to a minute behind an action the owner
       just took on screen. */
    window.addEventListener(ALERTS_CHANGED, read);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(ALERTS_CHANGED, read);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  return open;
}

/** Fired by the Alerts page whenever the ledger changed: an acknowledgement, a
 *  rule saved or deleted, an evaluation run. */
export const ALERTS_CHANGED = "opc:alerts-changed";

export function announceAlerts() {
  window.dispatchEvent(new Event(ALERTS_CHANGED));
}
