/**
 * THE COMMITMENTS DOCUMENT — what the owner said he would do, in his own
 * words.
 *
 * EVERY ROW CARRIES ITS EVIDENCE. `sentence` is the owner's own sentence,
 * verbatim and clipped at 200 characters, and it is not optional decoration:
 * it is the only thing that makes `what` checkable. A client that showed the
 * summary without the sentence would be showing a model's paraphrase as if it
 * were a fact, which is exactly what the grounding gate in commitments.ts
 * exists to prevent.
 *
 * `due` IS NULL UNLESS HE WROTE ONE. `dueText` is his words; `due` is this
 * box's reading of those words as a date, and only for the forms it can
 * defend — a weekday, today, tomorrow. "End of the week" stays as words,
 * because deciding which Friday he meant is not this dashboard's decision.
 *
 * THE SCAN IS A BUTTON, NOT A TIMER. It reads message BODIES, which is the one
 * thing in this area that would be a surprise if it happened by itself.
 */
import { Hono, type Context } from "hono";
import {
  DEFAULT_DAYS,
  MAX_MESSAGES,
  MAX_SENTENCE,
  commitmentRow,
  commitmentRows,
  decide,
  scan,
  type CommitmentRow,
} from "./commitments.ts";

export const commitmentRoutes = new Hono();

const DEFINITIONS = {
  source:
    "Extracted from the owner's OWN sent mail. Only in:sent is ever read, so " +
    "nothing anybody else promised can appear here, and nothing he was asked " +
    "to do can either.",
  evidence:
    `Every row carries the sentence he actually wrote, verbatim, clipped at ` +
    `${MAX_SENTENCE} characters. Quote it whenever you report the promise; ` +
    `"what" is a model's shortest span of that sentence and is a summary.`,
  privacy:
    "The message bodies are read transiently and are never stored — not in " +
    "the database, not in a log. What is kept is the sentence, the recipient, " +
    "the subject he wrote, the date and the thread id.",
  deadlines:
    "dueText is his own words and is verified to appear in the message. due " +
    "is a date only where those words resolve to one unambiguously; it is " +
    "null otherwise and is NEVER invented.",
  statuses:
    "open, done, dismissed. Nothing is deleted: a dismissal is a decision and " +
    "the row keeps it, so a rescan of the same window does not resurrect it.",
};

const shape = (r: CommitmentRow) => ({
  id: r.id,
  mailbox: r.mailbox,
  threadId: r.thread_id,
  messageId: r.message_id,
  to: r.to_address,
  toName: r.to_name || null,
  subject: r.subject || null,
  what: r.what,
  sentence: r.sentence,
  dueText: r.due_text,
  due: r.due,
  sentAt: r.sent_at,
  status: r.status,
  foundAt: r.found_at,
  decidedAt: r.decided_at,
});

commitmentRoutes.get("/", (c) => {
  const status = (c.req.query("status") ?? "open").trim().toLowerCase();
  if (!["open", "done", "dismissed", "all"].includes(status))
    return c.json({ error: `status is open, done, dismissed or all — not “${status}”.` }, 400);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
  const all = commitmentRows();
  const rows = status === "all" ? all : all.filter((r) => r.status === status);
  return c.json({
    status,
    counts: {
      open: all.filter((r) => r.status === "open").length,
      done: all.filter((r) => r.status === "done").length,
      dismissed: all.filter((r) => r.status === "dismissed").length,
      matched: rows.length,
      returned: Math.min(rows.length, limit),
    },
    /* Overdue is computed on the read and only where a date was resolvable at
       all: an open promise with `due: null` is not overdue, it is undated. */
    overdue: rows.filter((r) => r.status === "open" && r.due !== null && r.due < new Date().toISOString().slice(0, 10)).length,
    commitments: rows.slice(0, limit).map(shape),
    definitions: DEFINITIONS,
    note: all.length
      ? null
      : "Nothing has been scanned yet. POST /api/commitments/scan reads the " +
        "last fortnight of your own sent mail.",
  });
});

/**
 * Read the sent mail and file what is in it.
 *
 * A POST because it costs Gmail quota, opens message bodies and may call a
 * model — three things a GET must never do.
 */
commitmentRoutes.post("/scan", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { days?: unknown } | null;
  const asked = Number(body?.days ?? c.req.query("days") ?? DEFAULT_DAYS);
  try {
    const result = await scan(Number.isFinite(asked) ? asked : DEFAULT_DAYS);
    return c.json({
      ...result,
      maxMessages: MAX_MESSAGES,
      note:
        result.truncated
          ? `More than ${MAX_MESSAGES} messages were sent in that window; the oldest ${MAX_MESSAGES} were read. Scan a shorter window to reach the rest.`
          : null,
      definitions: DEFINITIONS,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

function decided(c: Context, status: "done" | "dismissed" | "open") {
  const id = c.req.param("id") ?? "";
  if (!id || !commitmentRow(id)) return c.json({ error: `No commitment ${id}.` }, 404);
  return c.json({ commitment: shape(decide(id, status)!) });
}

commitmentRoutes.post("/:id/done", (c) => decided(c, "done"));
commitmentRoutes.post("/:id/dismiss", (c) => decided(c, "dismissed"));
/* The way back. A promise dismissed by mistake would otherwise need a shell,
   and there is nothing irreversible about either decision. */
commitmentRoutes.post("/:id/reopen", (c) => decided(c, "open"));
