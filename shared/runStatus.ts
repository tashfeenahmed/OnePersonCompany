/**
 * WHERE A RUN IS — one vocabulary, server and client.
 *
 * This union was declared five times: twice on the server (the runs area and
 * agentcore), three times on the client. Five declarations of one five-member
 * set means a sixth state can be added to a table without any of them
 * noticing, which is exactly what happened — `agent_runs` carries `paused` as
 * a bare column because the enum could not be extended in one place.
 *
 * It lives in the repo-root `shared/` and not under `server/`, because the
 * client's run pages are the other half of the vocabulary. A wire shape typed
 * separately on each end of a request is two shapes.
 *
 * ONE WORD FOR THE IN-BETWEEN STATE. A cancel that has been asked for and has
 * not yet landed was called `cancelling` on one path and `stopping` on
 * another, and neither was declared by any type. It is `cancelling` here: the
 * state it leads to is `cancelled`, and a vocabulary whose participle does not
 * match its past tense invites exactly the drift this file exists to stop.
 *
 * IT IS DELIBERATELY NOT A `RunStatus`. Aborting is a REQUEST the run honours
 * at its next checkpoint; the run is still `running` until it lands, and a run
 * cancelled in the last instant of its final turn may well land `done`. Typing
 * the acknowledgement as a status would let a page draw an outcome that has
 * not happened.
 */

/**
 * Every state a run row may hold, in lifecycle order. `queued` and `running`
 * are the two that mean a page must keep asking; the other three are final.
 */
export const RUN_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** What a cancel request replies with. See the header. */
export const CANCELLING = "cancelling";
export type Cancelling = typeof CANCELLING;

/** A status as a caller may report it, including the request that has not landed. */
export type RunStatusOrCancelling = RunStatus | Cancelling;

/** Is this string one of the five? For anything arriving off the wire or out of a row. */
export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);

/**
 * Still moving. THE POLLING PREDICATE, written once so no page invents its own
 * idea of "live" and keeps asking about a run that finished an hour ago.
 */
export const isLive = (status: RunStatusOrCancelling): boolean =>
  status === "queued" || status === "running" || status === CANCELLING;

/** Landed, whichever way. The complement of `isLive` over the five statuses. */
export const isFinal = (status: RunStatusOrCancelling): boolean => !isLive(status);
