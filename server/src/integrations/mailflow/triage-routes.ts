/**
 * /api/triage — today's inbox, sorted by what the mail is.
 *
 * THE READ IS A LIVE GMAIL CALL JOINED TO STORED JUDGEMENTS, and that split is
 * the whole design. The judgement half comes out of `mailflow_triage`, which
 * has no column for a subject; the mail half is fetched from Gmail on every
 * request and forgotten when the response is written, exactly as
 * routes/mailbox.ts does. So the page can show a subject line without this box
 * ever having stored one, and a thread that was archived in Gmail two minutes
 * ago is simply not in the answer.
 *
 * THAT COSTS A ROUND TRIP AND THE CAP IS WHY. Every row is a `threads.get` at
 * ten quota units, so the default read is fifty threads — about four seconds
 * through the provider's rate gate — and the ceiling is the scan's own 200.
 * A page that read two hundred every time would be fourteen seconds of
 * spinner to draw a list whose top ten are the point.
 *
 * FIVE GROUPS AND THE FIFTH IS THE IMPORTANT ONE. `unscored` holds threads the
 * model has not read: too new for the last pass, or a pass that failed. They
 * are NOT noise, they are counted, and the document says why they are there.
 * A caller that folds them into the bottom of a list is hiding mail because
 * nobody looked at it.
 */
import { Hono } from "hono";
import * as accounts from "../../accounts.ts";
import { now, ventureRows } from "../../db.ts";
import { GmailError, NoMailbox, listThreads, open } from "../../providers/gmail.ts";
import {
  MAX_WINDOW_DAYS,
  READ_MAX_DEFAULT,
  SCAN_MAX,
  WINDOW_DAYS,
  lastRun,
  markThread,
  scanAccount,
  storedFor,
  ventureByHost,
  ventureKeys,
} from "./triage.ts";

export const triageRoutes = new Hono();

const MAX_SNOOZE_DAYS = 30;

/** A whole number from a query string or a JSON field, clamped. An ABSENT or
 *  empty value is the fallback and not zero — `Number("")` is 0, which would
 *  silently turn "no ?days=" into a one-day window. */
function intParam(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const t = (raw ?? "").trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

/** Which mailbox. Absent means the first connected one, which is what an
 *  absent `?account=` means everywhere on this box. */
function accountParam(raw: string | undefined): number | undefined {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function firstGmail(): number | null {
  const a = accounts.list("gmail").find((x) => x.connected);
  return a ? a.id : null;
}

/* -------------------------------------------------------------------- read */

triageRoutes.get("/", async (c) => {
  const accountId = accountParam(c.req.query("account")) ?? firstGmail();
  if (accountId === null)
    return c.json(
      {
        error:
          "No Gmail account is connected, so there is no inbox to triage. " +
          "Connect one on the Integrations page.",
      },
      404,
    );

  const days = intParam(c.req.query("days"), WINDOW_DAYS, 1, MAX_WINDOW_DAYS);
  const max = intParam(c.req.query("max"), READ_MAX_DEFAULT, 1, SCAN_MAX);

  let threads;
  try {
    const session = await open("triage_read", accountId);
    threads = (await listThreads(session, { q: `in:inbox newer_than:${days}d`, max })).threads;
  } catch (err) {
    if (err instanceof NoMailbox) return c.json({ error: err.message }, 404);
    if (err instanceof GmailError)
      return c.json({ error: `Gmail refused the listing: ${err.body}` }, 502);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  const stored = storedFor(accountId);
  const keys = ventureKeys();
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  const nowMs = Date.now();

  const shaped = threads.map((t) => {
    const row = stored.get(t.id);
    /* STALE IS A FIRST-CLASS ANSWER. The score was made against a thread whose
       last message was at `at_ms`; a reply since then means the sentence
       beside it describes a conversation that has moved on. The score is still
       shown — it is the last thing anybody read — and it is flagged, rather
       than deleted or silently re-used. */
    const stale = !!row?.score && row.at_ms !== (t.at ?? null);
    const snoozed = row?.snoozed_until ? Date.parse(row.snoozed_until) > nowMs : false;
    return {
      id: t.id,
      accountId,
      subject: t.subject,
      from: t.from,
      fromName: t.fromName,
      at: t.at,
      snippet: t.snippet,
      unread: t.unread,
      messages: t.messages,
      score: row?.score ?? null,
      reason: row?.reason ?? null,
      urgency: row?.urgency ?? null,
      /* The venture is re-derived from the LIVE addresses when they settle it,
         so a venture whose host was typed in after the last pass tags its mail
         immediately. The stored guess only stands where the addresses say
         nothing. */
      venture: ventureByHost(t, keys) ?? row?.venture ?? null,
      ventureName:
        names.get(ventureByHost(t, keys) ?? row?.venture ?? "") ?? null,
      ventureBy: ventureByHost(t, keys) ? "host" : (row?.venture ? row.venture_by : null),
      stale,
      scoredAt: row?.scored_at ?? null,
      model: row?.model ?? null,
      snoozedUntil: row?.snoozed_until ?? null,
      snoozed,
      doneAt: row?.done_at ?? null,
    };
  });

  const active = shaped.filter((t) => !t.doneAt && !t.snoozed);
  const group = (key: string) => active.filter((t) => t.score === key);

  const run = lastRun(accountId);

  return c.json({
    account: {
      id: accountId,
      label: accounts.list("gmail").find((a) => a.id === accountId)?.label ?? null,
    },
    window: { days, threads: threads.length, max },
    lastRun: run
      ? {
          ranAt: run.ran_at,
          ok: run.ok === 1,
          threads: run.threads,
          scored: run.scored,
          note: run.note,
          error: run.error,
        }
      : null,
    counts: {
      needsReply: group("needs_reply").length,
      waitingOnThem: group("waiting_on_them").length,
      fyi: group("fyi").length,
      noise: group("noise").length,
      unscored: active.filter((t) => t.score === null).length,
      done: shaped.filter((t) => t.doneAt).length,
      snoozed: shaped.filter((t) => t.snoozed).length,
      stale: active.filter((t) => t.stale).length,
    },
    groups: {
      needs_reply: group("needs_reply"),
      waiting_on_them: group("waiting_on_them"),
      fyi: group("fyi"),
      noise: group("noise"),
      /* NOT a category. See the file header. */
      unscored: active.filter((t) => t.score === null),
    },
    done: shaped.filter((t) => t.doneAt),
    snoozedList: shaped.filter((t) => t.snoozed),
    note:
      "Categories are a model's reading of a subject line and Gmail's own " +
      "snippet, shown with its reason. `unscored` means the model has not read " +
      "that thread — it is not a verdict of noise. Nothing here reads or " +
      "stores a message body.",
  });
});

/* ------------------------------------------------------------- the two verbs */

const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

triageRoutes.post("/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    account?: number;
    days?: number;
    max?: number;
  };
  const accountId = accountParam(String(body.account ?? "")) ?? firstGmail();
  if (accountId === null)
    return c.json({ error: "No Gmail account is connected, so there is nothing to scan." }, 404);

  const result = await scanAccount(accountId, {
    days: body.days === undefined ? undefined : Number(body.days),
    max: body.max === undefined ? undefined : Number(body.max),
  });
  /* A pass that scored nothing because the provider is down is NOT a 500 —
     the run happened, the answer is "no scorer", and that is a document rather
     than a failure of this route. The status follows whether the SCAN could
     start, which is what `ok` says. */
  return c.json(result, result.ok ? 200 : 200);
});

triageRoutes.post("/:threadId/done", async (c) => {
  const threadId = c.req.param("threadId");
  if (!THREAD_ID.test(threadId)) return c.json({ error: "That is not a Gmail thread id." }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { account?: number; undo?: boolean };
  const accountId = accountParam(String(body.account ?? "")) ?? firstGmail();
  if (accountId === null) return c.json({ error: "No Gmail account is connected." }, 404);

  const doneAt = body.undo === true ? null : now();
  markThread(accountId, threadId, { doneAt });
  return c.json({
    threadId,
    accountId,
    doneAt,
    note:
      doneAt === null
        ? "Marked not done. The thread comes back on the list."
        : "Marked done here. NOTHING CHANGED IN GMAIL — the thread is still in the inbox, still unread if it was, and this only hides it from this list.",
  });
});

triageRoutes.post("/:threadId/snooze", async (c) => {
  const threadId = c.req.param("threadId");
  if (!THREAD_ID.test(threadId)) return c.json({ error: "That is not a Gmail thread id." }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { account?: number; days?: number };
  const accountId = accountParam(String(body.account ?? "")) ?? firstGmail();
  if (accountId === null) return c.json({ error: "No Gmail account is connected." }, 404);

  const days = intParam(String(body.days ?? ""), 1, 1, MAX_SNOOZE_DAYS);
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  markThread(accountId, threadId, { snoozedUntil: until });
  return c.json({
    threadId,
    accountId,
    snoozedUntil: until,
    days,
    note:
      "Hidden from this list until then. NOTHING CHANGED IN GMAIL. A reply " +
      "arriving cancels the snooze, because a new message is new work.",
  });
});
