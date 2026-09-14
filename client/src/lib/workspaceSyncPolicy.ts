/** Brief reconnects and server restarts should not interrupt work. */
export const SYNC_FAILURE_GRACE_MS = 15_000;

export function syncFailureNotice(
  failure: { message: string; status?: number },
  firstFailureAt: number | null,
  now: number,
): { firstFailureAt: number | null; message: string } {
  // The API client already takes expired sessions to sign-in.
  if (failure.status === 401) return { firstFailureAt: null, message: "" };
  const since = firstFailureAt ?? now;
  const actionable = failure.status !== undefined && failure.status >= 400
    && failure.status < 500 && ![408, 425, 429].includes(failure.status);
  return {
    firstFailureAt: since,
    message: actionable || now - since >= SYNC_FAILURE_GRACE_MS ? failure.message : "",
  };
}

/** Object key order is not an edit. Array order IS: boards, cards and pins
 * belong in exactly the order their owner chose. */
export function workspaceFingerprint(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const object = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
    }
    return item;
  });
}

export function workspaceHydrationChoice(input: {
  local: string; server: string | null; saved: string | null;
  initial: string; hasLocal: boolean; revision: number; serverRevision: number;
}): "accept" | "write" | "conflict" {
  const { local, server, saved, initial, hasLocal, revision, serverRevision } = input;
  if (local === server) return "accept";
  if (hasLocal && saved === null && server !== null) return "conflict";
  const dirty = (saved !== null && local !== saved) || local !== initial;
  if (!dirty) return "accept";
  // A second browser may have saved the very same base. Its revision alone
  // does not make the owner's pending edits a conflict.
  if (serverRevision !== revision && server !== saved) return "conflict";
  return "write";
}
