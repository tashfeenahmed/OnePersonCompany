import { call } from "@/lib/api";

/**
 * THE ACTION INBOX FROM THIS SIDE — everything on this box waiting for the
 * owner, already joined and already filtered.
 *
 * IT IS NOT AN AREA AND IT OWNS NO TABLE. `/api/action-inbox` reads the alert
 * events, the open commitments, the mail threads scored "needs reply", the
 * failed agent runs and the payment failures through each area's own reader,
 * and drops anything resolved or snoozed before it answers. So the Overview's
 * "needs attention" card does no filtering of its own: the server already
 * applied the owner's decisions, and a second copy of that rule in a builder
 * would be a second place for "is this still open" to be answered differently.
 *
 * PRIORITY 1 IS ACTIONABLE AND 2 IS NOT URGENT, which is the route's own
 * vocabulary rather than a scale invented here — an alert, an overdue
 * commitment, an urgent reply and a payment failure are 1; a failed job and a
 * commitment with time left are 2. The route sorts by it and then by recency,
 * so the list arrives actionable-first and a card that reorders it would be
 * disagreeing with the page the owner opens from every one of these rows.
 */

/** One thing waiting, as the route hands it over. */
export type InboxItem = {
  /** "<kind>:<the source's own id>" — "alert:21", "run:r-5jublq". */
  id: string;
  /** Which reader produced it: Alert, Commitment, Email, Failed job, Revenue. */
  source: string;
  title: string;
  /** The narration, the reason, the error — empty where the source had none. */
  detail: string;
  /** 1 is actionable now, 2 is not urgent. The route's own two bands. */
  priority: number;
  at: string;
  /** The page that owns this row, for the "open source" link. */
  href: string;
  /** The venture id where the source recorded one; null on the rest. */
  venture: string | null;
  /** What resolving it would be CALLED — "Acknowledge", "Mark reviewed". */
  resolution: string;
};

export type InboxDoc = {
  items: InboxItem[];
  asOf: string;
};

export const inboxApi = {
  /* No parameters. The route takes none: what is open is open, and there is no
     window over a list of things nobody has answered yet. */
  open: () => call<InboxDoc>("/action-inbox"),
};
