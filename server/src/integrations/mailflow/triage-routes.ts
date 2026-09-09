/**
 * /api/triage — today's inbox, sorted by what the mail is.
 *
 * THE READ TALKS TO SQLITE AND NOT TO GMAIL, AND THAT REVERSES WHAT THIS FILE
 * USED TO SAY. It used to describe a live Gmail listing joined to stored
 * judgements, and it was honest about the price: a `threads.get` per row, fifty
 * rows, four and a half seconds of spinner. That price was paid on every open,
 * to redraw a list the background pass had already settled half an hour
 * earlier. Now the pass caches the row (`mailflow_triage_threads`, migration
 * 123 — subject, sender, snippet, time, counts) and this route is two SELECTs.
 * It is typically a few milliseconds.
 *
 * WHAT THAT COSTS IN HONESTY, STATED HERE RATHER THAN DISCOVERED. The page is
 * as fresh as the last pass, not as fresh as Gmail: a thread archived two
 * minutes ago is still drawn until the next pass drops it. So the document
 * carries `pass` — when it last ran, when it runs next, whether one is running
 * right now — and the page prints it, because a list of unknown age is worse
 * than a list that says its age.
 *
 * THE READ NEVER FETCHES MAIL, WITH ONE NARROW EXCEPTION THAT STILL DOES NOT
 * BLOCK IT: a mailbox with an empty cache and no pass ever recorded gets a
 * pass KICKED OFF in the background (`kickPass`), and this request is answered
 * immediately from the empty cache with `pass.running` true. Otherwise a box
 * that has just connected Gmail would show a blank page until a timer fired.
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
import {
  MAX_WINDOW_DAYS,
  READ_MAX_DEFAULT,
  SCAN_MAX,
  WINDOW_DAYS,
  cachedCount,
  cachedPage,
  domainsOf,
  kickPass,
  lastRun,
  markThread,
  passState,
  scanAccount,
  storedFor,
  unscoredCount,
  ventureByDomains,
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

  const run = lastRun(accountId);
  const threads = cachedPage(accountId, { days, max });
  /* A mailbox nobody has ever passed over. See the header: the pass is started
     and NOT waited for, so this request still answers now. */
  if (!threads.length && !run) kickPass(accountId);

  const stored = storedFor(accountId);
  const keys = ventureKeys();
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  const nowMs = Date.now();

  const shaped = threads.map((t) => {
    const row = stored.get(t.thread_id);
    /* STALE IS A FIRST-CLASS ANSWER. The score was made against a thread whose
       last message was at `at_ms`; a reply since then means the sentence
       beside it describes a conversation that has moved on. The score is still
       shown — it is the last thing anybody read — and it is flagged, rather
       than deleted or silently re-used. Both halves now come from this box, so
       what this compares is the judgement against the cached row the last pass
       wrote: a reply that arrives between passes is caught by the pass that
       re-reads the thread, not by the page. */
    const stale = !!row?.score && row.at_ms !== t.at_ms;
    const snoozed = row?.snoozed_until ? Date.parse(row.snoozed_until) > nowMs : false;
    /* The venture is re-derived from the thread's DOMAINS on every read, so a
       venture whose host was typed in after the last pass tags its mail
       immediately — the one live-read behaviour worth keeping, and the reason
       the cache stores hosts at all. The stored guess only stands where the
       addresses say nothing. */
    const byHost = ventureByDomains(domainsOf(t), keys);
    return {
      id: t.thread_id,
      accountId,
      subject: t.subject,
      from: t.from_address,
      fromName: t.from_name,
      at: t.at_ms,
      snippet: t.snippet,
      unread: t.unread === 1,
      messages: t.messages,
      score: row?.score ?? null,
      reason: row?.reason ?? null,
      urgency: row?.urgency ?? null,
      venture: byHost ?? row?.venture ?? null,
      ventureName: names.get(byHost ?? row?.venture ?? "") ?? null,
      ventureBy: byHost ? "host" : (row?.venture ? row.venture_by : null),
      stale,
      scoredAt: row?.scored_at ?? null,
      model: row?.model ?? null,
      snoozedUntil: row?.snoozed_until ?? null,
      snoozed,
      doneAt: row?.done_at ?? null,
      /* When the pass last saw this row in Gmail. The page's freshness line is
         about the pass rather than the row, but a single row's age is the
         thing somebody asks about when one looks wrong. */
      seenAt: t.seen_at,
    };
  });

  const active = shaped.filter((t) => !t.doneAt && !t.snoozed);
  const group = (key: string) => active.filter((t) => t.score === key);

  const state = passState();

  return c.json({
    account: {
      id: accountId,
      label: accounts.list("gmail").find((a) => a.id === accountId)?.label ?? null,
    },
    window: { days, threads: threads.length, max, cached: cachedCount(accountId, days) },
    /**
     * WHEN THIS WAS READ, WHEN IT IS READ NEXT, AND WHETHER IT IS BEING READ
     * NOW. The page is drawn from a cache, so these three are not decoration:
     * they are the difference between "your inbox" and "your inbox as of some
     * time nobody will tell you". `running` is what the page polls on — it
     * asks every few seconds while a pass is in flight and stops when it is
     * not, rather than polling a mailbox nothing is happening to.
     *
     * `ranAt` repeats `lastRun.ranAt` because this is the object the page's
     * one-line header reads; `lastRun` keeps the whole run row beside it.
     */
    pass: {
      ranAt: run?.ran_at ?? null,
      nextRunAt: state.nextRunAt,
      running: state.running,
      /* Over the whole window rather than the drawn page — asking for fewer
         rows must not make unread mail disappear from the count. */
      unscored: unscoredCount(accountId, days),
    },
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
      "that thread — it is not a verdict of noise. This list is drawn from a " +
      "cache the background pass fills, so subject lines, senders and Gmail's " +
      "snippets are stored on this box; message bodies are never fetched or " +
      "stored, and recipient addresses are kept only as their domains.",
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
