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
import { configValue, db, now } from "../../db.ts";
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

export type ChatRunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

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
     VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?)`,
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
  const info = db
    .prepare(
      `UPDATE chat_runs
          SET status = 'failed',
              error = ?,
              finished_at = ?
        WHERE status IN ('queued','running')`,
    )
    .run(
      "The server restarted while this answer was being written. Whatever had been said is in the transcript, marked as cut off.",
      now(),
    );
  return Number(info.changes ?? 0);
}
