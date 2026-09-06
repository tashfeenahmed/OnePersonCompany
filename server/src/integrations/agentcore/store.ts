/**
 * THE DURABLE HALF OF A CHAT RUN, AND THE ONE SETTING THAT BOUNDS A TOOL
 * ANSWER.
 *
 * Two small things live here because they are the two facts about the agent
 * runtime that outlive a process: which turns were started, and how big a tool
 * result is allowed to be. Everything else about a run — its buffered events,
 * its subscribers, the abort controller — is in `chat/runs.ts` and is memory,
 * deliberately (see migrations.ts).
 *
 * WHY THE ROW EXISTS AT ALL, given the events do not. Three readers need it:
 * a page that has just reloaded, and must decide between "reattach to a live
 * answer" and "read the transcript"; the run engine, which refuses a second
 * concurrent turn on one conversation; and a restarted process, which must be
 * able to say that a run it no longer holds did not finish. None of those can
 * be answered from memory, because memory is exactly what was lost.
 */
import type { RunStatus } from "../../../../shared/runStatus.ts";
import { configValue, db, now } from "../../db.ts";
import { NOW, settleOpenRows } from "../../shared/settle.ts";
import { DEFAULT_RESPONSE_BYTES } from "./bound.ts";

/** The pseudo-plugin the runtime's own settings hang off — no credential, no
 *  account, just the two numbers below. Named once, here, because the string is
 *  a foreign key value and two spellings of it would be two settings. */
export const AGENTCORE_PLUGIN = "agentcore";

/** Re-exported so a reader of the settings finds the number without having to
 *  know that it is defined in the pure shaper. An owner running a 1M-context
 *  model can raise it; an owner on a local 8k model should lower it. */
export { DEFAULT_RESPONSE_BYTES };

export function responseBudget(): { bytes: number; source: "setting" | "default" } {
  const raw = (configValue(AGENTCORE_PLUGIN, "response_bytes") ?? "").trim();
  if (!raw) return { bytes: DEFAULT_RESPONSE_BYTES, source: "default" };
  const n = Number(raw);
  /* An unreadable value reads as the default rather than as zero. A hand-edited
     row must not be able to make every tool answer empty. */
  if (!Number.isFinite(n) || n < 1024) return { bytes: DEFAULT_RESPONSE_BYTES, source: "default" };
  return { bytes: Math.floor(n), source: "setting" };
}

/* ------------------------------------------------------------------- runs */

/* The same five states the run queue uses, from the same declaration. The
   local name stays: a chat run and a queued agent run are different rows with
   the same lifecycle, and reading `ChatRunStatus` at a call site says which
   table is meant. */
export type ChatRunStatus = RunStatus;

export type ChatRunRow = {
  id: string;
  session_id: string;
  status: ChatRunStatus;
  channel: string;
  venture_id: string | null;
  backend: string | null;
  user_message_id: number | null;
  assistant_message_id: number | null;
  error: string | null;
  last_seq: number;
  started_at: string;
  finished_at: string | null;
};

/**
 * INSERTED AS `running`, NOT AS `queued`.
 *
 * The row used to go in as `queued` and be updated to `running` two statements
 * later, which bought nothing and cost something: `queued` was never observable
 * by any reader, and the gap between the two writes was a window in which a
 * throw left a row claiming a state nothing was in. Nothing here queues — the
 * engine starts the turn immediately and the only gate is the model provider's
 * own limiter — so the honest first state is the one it is actually in.
 *
 * `queued` stays in the union because it is the shape a caller that DOES queue
 * would write, and because the client's type mirrors this one; nothing on this
 * box produces it today.
 */
export function insertChatRun(r: {
  id: string;
  sessionId: string;
  channel: string;
  ventureId: string | null;
  backend: string | null;
  userMessageId: number | null;
}): ChatRunRow {
  db.prepare(
    `INSERT INTO chat_runs
       (id, session_id, status, channel, venture_id, backend, user_message_id, last_seq, started_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?, 0, ?)`,
  ).run(r.id, r.sessionId, r.channel, r.ventureId, r.backend, r.userMessageId, now());
  return chatRun(r.id)!;
}

export function updateChatRun(
  id: string,
  patch: {
    status?: ChatRunStatus;
    assistantMessageId?: number | null;
    error?: string | null;
    lastSeq?: number;
    finished?: boolean;
  },
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.assistantMessageId !== undefined) {
    sets.push("assistant_message_id = ?");
    values.push(patch.assistantMessageId);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.lastSeq !== undefined) {
    sets.push("last_seq = ?");
    values.push(patch.lastSeq);
  }
  if (patch.finished) {
    sets.push("finished_at = ?");
    values.push(now());
  }
  if (!sets.length) return;
  values.push(id);
  db.prepare(`UPDATE chat_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function chatRun(id: string): ChatRunRow | null {
  return (
    (db.prepare("SELECT * FROM chat_runs WHERE id = ?").get(id) as unknown as ChatRunRow) ?? null
  );
}

/** The newest run of one conversation, whatever became of it. What a page that
 *  has just opened a chat asks, so it can tell "still answering" from "there is
 *  nothing to wait for". */
export function latestChatRun(sessionId: string): ChatRunRow | null {
  return (
    (db
      .prepare("SELECT * FROM chat_runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(sessionId) as unknown as ChatRunRow) ?? null
  );
}

/** Which conversations the SERVER thinks are answering right now. The rail's
 *  marks are drawn from this after a reload, where the browser's own memory of
 *  them is gone. */
export function runningChatRuns(): ChatRunRow[] {
  return db
    .prepare("SELECT * FROM chat_runs WHERE status IN ('queued','running') ORDER BY started_at")
    .all() as unknown as ChatRunRow[];
}

/**
 * FORGET A CONVERSATION'S RUNS.
 *
 * `chat_runs` has no foreign key onto anything — the session id is a string the
 * browser chose, and there is no `chat_sessions` table for it to point at (see
 * `chatSessionSummaries` in db.ts for why). So deleting a conversation cannot
 * cascade, and without this the runs of an erased transcript outlive it:
 * `latestChatRun` would keep answering for a chat that no longer exists, and a
 * page opening a recycled id would be told there is an answer to reattach to.
 *
 * Called from the delete route rather than from `deleteChatSession` itself, so
 * db.ts keeps knowing nothing about this area's table.
 */
export function deleteChatRuns(sessionId: string): number {
  const info = db.prepare("DELETE FROM chat_runs WHERE session_id = ?").run(sessionId);
  return Number(info.changes ?? 0);
}

/**
 * DROP RUNS NOBODY WILL EVER ASK ABOUT AGAIN.
 *
 * One row per turn, for ever, is a table that grows with use and is read by
 * exactly two questions — "is this conversation being answered" and "what
 * happened to that one" — neither of which can be asked of a run from last
 * spring. The transcript is the durable record and it is not touched here.
 *
 * FINISHED RUNS ONLY. A row still marked running is either live or the residue
 * of a restart, and `failInterruptedChatRuns` is what settles those; sweeping
 * one away on age would delete the evidence rather than the clutter.
 */
export function pruneChatRuns(days = 30): number {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const info = db
    .prepare(
      `DELETE FROM chat_runs
        WHERE status NOT IN ('queued','running')
          AND COALESCE(finished_at, started_at) < ?`,
    )
    .run(cutoff);
  return Number(info.changes ?? 0);
}

/**
 * A PROCESS THAT RESTARTED HAS NO RUNS, whatever its table says.
 *
 * The events were in memory and the agent call died with the process, so a row
 * still marked `running` is a claim nothing can make good on — and a page that
 * believed it would wait for a stream that will never open. Called once at
 * start-up, before anything can read the table.
 *
 * `failed` rather than `cancelled`: nobody pressed anything. The message names
 * the restart, because "the agent failed" and "the server was restarted while
 * it was writing" send an owner to two different places.
 */
export function failInterruptedChatRuns(): number {
  return settleOpenRows({
    table: "chat_runs",
    /* QUEUED COUNTS AS OPEN HERE and does not elsewhere: a queued chat run is
       a turn this process was about to answer, not a row on a durable queue
       something else will pick up. Nothing will ever start it. */
    openWhen: "status IN ('queued','running')",
    set: { status: "failed", finished_at: NOW },
    note: {
      column: "error",
      text:
        "The server restarted while this answer was being written. Whatever had been said " +
        "is in the transcript, marked as cut off.",
    },
  });
}
