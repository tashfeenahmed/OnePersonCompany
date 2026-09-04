/**
 * THE POLLER: one long-polling loop per connected bot, inside the API process.
 *
 * WHY LONG POLLING AND NOT A WEBHOOK. A webhook needs a public HTTPS URL with
 * a certificate Telegram will accept. This server binds to 127.0.0.1 on
 * purpose — it holds a vault key and it has no business listening on every
 * interface — so a webhook would mean a tunnel, a domain, a certificate and a
 * publicly reachable door into the box that reads the bill. `getUpdates` needs
 * none of that: the connection is outbound, it works behind any NAT, and it is
 * what workdash's own notifier has been doing on the Pi for a year.
 *
 * WHY IT LIVES IN THE API PROCESS. The alternative was a second service with
 * its own systemd unit. It would need the vault key, the database and the chat
 * backend — which is to say it would be this process with a different name. An
 * idle long poll costs one outbound request a minute and no CPU, and Node's
 * event loop runs it beside Hono without either noticing the other: there is
 * no blocking call anywhere in this file, so a poll that is asleep for fifty
 * seconds is fifty seconds in which the server answers requests exactly as
 * fast as it would have.
 *
 * THE SINGLETON RULE, WHICH IS NOT OPTIONAL. Telegram allows exactly ONE
 * `getUpdates` per token: a second caller gets 409 Conflict, and — worse —
 * whichever of them wins takes the update, so two loops would each answer half
 * the messages. The guard is `loops`, keyed by account id, and every path that
 * could start one goes through `startLoop`, which returns early if that key is
 * already running. `--watch` in dev re-imports modules, which is exactly the
 * case that map exists to survive.
 *
 * HOW IT STARTS AND STOPS WITHOUT A RESTART. `reconcile()` compares the
 * accounts that should be polling with the loops that are, and fixes the
 * difference: a bot connected on the Integrations page starts polling within
 * seconds, a disconnected one stops, and a token REPLACED on an existing
 * account restarts that loop so the new credential is the one in use. It reads
 * only the plugin and account rows — no vault, no network — so running it on a
 * short timer costs nothing and, critically, does not write a `secret_access`
 * row every few seconds. The vault is opened once per loop start.
 */
import * as accounts from "../accounts.ts";
import {
  telegramState,
  writeTelegramBot,
  writeTelegramError,
  writeTelegramOffset,
} from "../db.ts";
import * as telegram from "../providers/telegram.ts";
import {
  COMMANDS,
  PLUGIN,
  handleUpdate,
  liveWire,
  lockedChat,
  type BotContext,
} from "./bridge.ts";

/**
 * What a loop is doing, as the plugin page reports it.
 *
 *   polling   the long poll is open and Telegram is answering
 *   conflict  409 — something else is polling this same bot token
 *   backoff   the last call failed and the next attempt is waiting
 *   starting  the token is being checked with getMe
 *   stopped   there is no loop for this account
 *
 * `conflict` is its own state rather than a kind of `backoff` because it is
 * the one failure here with a cause outside this box, and the fix is somewhere
 * else entirely: another process — very likely one of the owner's own bots on
 * the Pi — is holding the same token.
 */
export type PollerState = "starting" | "polling" | "conflict" | "backoff" | "stopped";

export type PollerStatus = {
  state: PollerState;
  since: string;
  /** How many attempts in a row have failed. Zero while polling. */
  failures: number;
  /** When the next attempt is due, while backing off. Null otherwise. */
  nextAttemptAt: string | null;
  /** The last thing that went wrong, already scrubbed of the token. */
  lastError: string | null;
  /** Updates this loop has taken off Telegram since it started. */
  updates: number;
};

type Loop = {
  accountId: number;
  /** The account's `updated_at` when this loop started. A change means the
   *  credential was replaced and the loop is restarted around the new one. */
  signature: string;
  abort: AbortController;
  status: PollerStatus;
};

const loops = new Map<number, Loop>();

/** The reconciler's own guard: two managers would each start loops, and the
 *  second would lose the singleton race by a millisecond rather than reliably. */
let manager: ReturnType<typeof setInterval> | null = null;

/** How often the desired set is compared with the running one. Seconds rather
 *  than minutes because it is what makes "connect it and it works" true, and
 *  it costs two indexed SELECTs. */
const RECONCILE_MS = 10_000;

/** Ceiling on the wait between failed attempts. A minute is long enough that a
 *  down Telegram is not being hammered and short enough that the owner does
 *  not notice the recovery. */
const MAX_BACKOFF_MS = 60_000;

/** A message older than this, relative to when the credential was stored,
 *  cannot pair the bot. Five minutes of slack for clocks and for a token
 *  pasted just after the message was sent. */
const PAIRING_GRACE_S = 300;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Unref'd so a sleeping poller can never be the reason this process
    // refuses to exit — the HTTP server is what keeps it alive, deliberately.
    t.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Exponential, from a second, capped. Telegram's own `retry_after` wins when
 *  it sends one: a service that says how long to wait has been asked and has
 *  told us, and guessing over it is how a 429 becomes a ban. */
function backoffMs(failures: number, retryAfter: number | null): number {
  if (retryAfter !== null) return Math.min(retryAfter * 1000, 5 * MAX_BACKOFF_MS);
  return Math.min(1000 * 2 ** Math.min(failures - 1, 6), MAX_BACKOFF_MS);
}

function setState(loop: Loop, state: PollerState, extra: Partial<PollerStatus> = {}) {
  loop.status = {
    ...loop.status,
    state,
    since: state === loop.status.state ? loop.status.since : new Date().toISOString(),
    ...extra,
  };
}

/* ------------------------------------------------------------- the loop */

/**
 * One bot, from its token to its updates.
 *
 * The whole body is inside a `while (!aborted)`, and every failure path leads
 * back to the top of it after a sleep. Nothing in here can throw out of the
 * loop: a thrown error would end the poller silently and leave the plugin page
 * saying `polling` about a loop that no longer exists, which is the exact
 * shape of lie this codebase spends its comments avoiding.
 */
async function run(loop: Loop, token: string, label: string) {
  const { accountId } = loop;
  const signal = loop.abort.signal;

  /* ---- who is this token? Retried, because a network blip at boot must not
     leave a connected bot permanently silent. */
  let ctx: BotContext | null = null;
  while (!signal.aborted && !ctx) {
    try {
      const bot = await telegram.getMe(token, signal);
      ctx = { accountId, label, token, bot };
      writeTelegramBot(accountId, bot.id, bot.username);
      writeTelegramError(accountId, null);

      /*
        THE ACCOUNT TAKES THE BOT'S NAME, once, and only if nobody has named
        it. "Account 1" is a placeholder the routes hand out when a credential
        is stored without a label; @my_dashboard_bot is what the owner
        actually calls this thing. A label the owner chose is never touched.
      */
      if (/^Account \d+$/.test(label) && bot.username) {
        accounts.rename(accountId, `@${bot.username}`);
        label = `@${bot.username}`;
        ctx.label = label;
      }

      // Idempotent, and it is what puts /start and /status in the client's
      // command menu instead of leaving the owner to guess.
      await telegram.setCommands(token, COMMANDS).catch(() => {});
    } catch (err) {
      const why = err instanceof Error ? err.message : "getMe failed";
      loop.status.failures++;
      writeTelegramError(accountId, why);
      const wait = backoffMs(
        loop.status.failures,
        err instanceof telegram.TelegramError ? err.retryAfter : null,
      );
      setState(loop, "backoff", {
        lastError: why,
        nextAttemptAt: new Date(Date.now() + wait).toISOString(),
      });
      console.log(`[telegram] ${label}: getMe failed — ${why} (retrying in ${Math.round(wait / 1000)}s)`);
      await sleep(wait, signal);
    }
  }
  if (!ctx || signal.aborted) return;

  const wire = liveWire(ctx);
  const account = accounts.get(accountId);
  /** Messages sent before the credential was stored cannot pair this bot —
   *  see the pairing check below. */
  const pairingFloor =
    (account ? Date.parse(account.updatedAt) / 1000 : Date.now() / 1000) - PAIRING_GRACE_S;

  let offset = telegramState(accountId)?.next_offset ?? 0;
  loop.status.failures = 0;
  setState(loop, "polling", { lastError: null, nextAttemptAt: null });
  console.log(
    `[telegram] ${label}: polling as ${ctx.bot.username ? `@${ctx.bot.username}` : ctx.bot.name}` +
      `${lockedChat(accountId) ? "" : " — no chat paired yet; message the bot to pair it"}`,
  );

  while (!signal.aborted) {
    let updates: telegram.TelegramUpdate[];
    try {
      updates = await telegram.getUpdates(token, offset, signal);
      if (loop.status.state !== "polling") {
        console.log(`[telegram] ${label}: polling again`);
        writeTelegramError(accountId, null);
      }
      loop.status.failures = 0;
      setState(loop, "polling", { lastError: null, nextAttemptAt: null });
    } catch (err) {
      if (signal.aborted) return;
      const te = err instanceof telegram.TelegramError ? err : null;
      const why = err instanceof Error ? err.message : "getUpdates failed";
      loop.status.failures++;
      const wait = backoffMs(loop.status.failures, te?.retryAfter ?? null);

      /*
        409 IS A DIFFERENT SENTENCE FROM THE OTHERS. It means a second process
        is long-polling this same token — another copy of this server, or one
        of the owner's own bots on another box that happens to hold it. Both of
        us will keep taking half the updates until one stops, so this says so
        plainly on the plugin page and keeps trying: the moment the other
        process goes away, this one recovers on its own.
      */
      const conflict = te?.status === 409;
      /*
        ONE 409 IS NOT THE SAME FINDING AS FIVE, and telling the owner to go
        hunting after the first is bad advice. Restarting this process
        ABANDONS a long poll that Telegram keeps open on its side for up to
        fifty seconds, so the loop that comes up next is refused once and
        clears itself — measured here, repeatedly, during development. A
        conflict that survives several attempts is the other thing entirely:
        something else is genuinely holding this token, and only then does the
        message say so.
      */
      const message = conflict
        ? loop.status.failures >= 3
          ? "Another process is polling this bot. Telegram allows one getUpdates per token, so both are taking half the messages — stop the other one, or use a second bot here."
          : "Telegram refused this poll because another getUpdates for this bot is still open. That is what a restart looks like — the abandoned poll is dropped within a minute and this recovers on its own."
        : why;
      writeTelegramError(accountId, message);
      setState(loop, conflict ? "conflict" : "backoff", {
        lastError: message,
        nextAttemptAt: new Date(Date.now() + wait).toISOString(),
      });
      console.log(
        `[telegram] ${label}: ${conflict ? "409 conflict" : `poll failed — ${why}`}` +
          ` (retrying in ${Math.round(wait / 1000)}s)`,
      );
      await sleep(wait, signal);
      /*
        The wait is over and the next call is in flight, which can itself take
        the length of a long poll. Leaving `nextAttemptAt` set would put a time
        in the PAST on the plugin page for the best part of a minute, which
        reads as a loop that has stopped trying rather than one that is
        mid-attempt. The STATE stays as it was, because whether this has
        recovered is not known until the call comes back.
      */
      loop.status = { ...loop.status, nextAttemptAt: null };
      continue;
    }

    for (const update of updates) {
      if (signal.aborted) return;
      loop.status.updates++;
      try {
        /*
          THE PAIRING FLOOR. Telegram holds undelivered updates for 24 hours,
          so a bot whose token has been sitting in a drawer can have a backlog
          — and the FIRST message in it would otherwise pair this bot with
          whoever wandered past it yesterday. A message that predates the
          moment the credential was stored is acknowledged and dropped while
          nothing is paired. Once a chat IS paired the floor is irrelevant and
          not applied: a message sent while the box was rebooting is a real
          question, and it gets its answer late rather than never.
        */
        const date = update.message?.date ?? 0;
        if (!lockedChat(accountId) && date && date < pairingFloor) {
          console.log(`[telegram] ${label}: dropped an update older than this connection`);
        } else {
          const outcome = await handleUpdate(update, ctx, wire);
          if (outcome.action === "answered" || outcome.action === "locked")
            writeTelegramError(accountId, null);
        }
      } catch (err) {
        /*
          One bad update must not end the bridge. The reply may or may not have
          got out — if it did not, the owner sees a message that was never
          answered, which is why this is recorded rather than swallowed.
        */
        const why = err instanceof Error ? err.message : "handler failed";
        writeTelegramError(accountId, why);
        console.log(`[telegram] ${label}: handling an update failed — ${why}`);
      }
      /*
        The cursor moves after the update has been dealt with, one at a time.
        Written before, a crash mid-answer would lose the message; written
        after, the worst case is that one message is answered twice — and a
        duplicate answer is a thing the owner can read, where a lost one is
        not.
      */
      offset = update.update_id + 1;
      writeTelegramOffset(accountId, offset);
    }
  }
}

/* ---------------------------------------------------- start, stop, reconcile */

function startLoop(account: accounts.Account, token: string) {
  if (loops.has(account.id)) return; // the singleton guard, and the only one
  const loop: Loop = {
    accountId: account.id,
    signature: account.updatedAt,
    abort: new AbortController(),
    status: {
      state: "starting",
      since: new Date().toISOString(),
      failures: 0,
      nextAttemptAt: null,
      lastError: null,
      updates: 0,
    },
  };
  loops.set(account.id, loop);

  // Deliberately not awaited: this returns to the caller — a boot sequence or
  // a ten-second timer — while the loop runs beside the HTTP server.
  void run(loop, token, account.label)
    .catch((err: unknown) => {
      const why = err instanceof Error ? err.message : "poller stopped";
      writeTelegramError(account.id, why);
      console.log(`[telegram] ${account.label}: poller stopped — ${why}`);
    })
    .finally(() => {
      // Only if it is still ours: a restart will have replaced the entry.
      if (loops.get(account.id) === loop) loops.delete(account.id);
    });
}

function stopLoop(accountId: number, why: string) {
  const loop = loops.get(accountId);
  if (!loop) return;
  loops.delete(accountId);
  loop.abort.abort();
  console.log(`[telegram] account ${accountId}: poller stopped — ${why}`);
}

/**
 * Make the running loops match the connected accounts.
 *
 * Cheap on purpose: the account rows carry everything this needs to decide,
 * so the common case — nothing changed — is two SELECTs and no vault read at
 * all. The vault is only opened for an account that is about to get a loop,
 * which is what keeps `secret_access` a record of real credential use rather
 * than a heartbeat.
 */
export function reconcile(): { started: number; stopped: number } {
  let started = 0;
  let stopped = 0;

  const live = new Map(accounts.list(PLUGIN).map((a) => [a.id, a]));

  for (const [id, loop] of loops) {
    const account = live.get(id);
    if (!account || !account.connected) {
      stopLoop(id, account ? "account disconnected" : "account removed");
      stopped++;
    } else if (account.updatedAt !== loop.signature) {
      // The credential was replaced. The loop is holding the old token in a
      // closure and would keep using it until something restarted the process.
      stopLoop(id, "credential replaced");
      stopped++;
    }
  }

  const wanted = [...live.values()].filter((a) => a.connected && !loops.has(a.id));
  if (wanted.length) {
    const { ready, broken } = accounts.credentialed(PLUGIN, ["token"], "telegram_poller");
    for (const { account } of broken)
      writeTelegramError(account.id, "No bot token stored for this account.");
    for (const { account, values } of ready) {
      if (loops.has(account.id)) continue;
      const token = (values.token ?? "").trim();
      if (!token) continue;
      startLoop(account, token);
      started++;
    }
  }
  return { started, stopped };
}

/**
 * Start the bridge. Called once, from index.ts, at boot.
 *
 * Idempotent: calling it twice does not create a second reconciler, and the
 * reconciler cannot create a second loop for one bot. Both guards exist
 * because `node --watch` re-imports this module on every save.
 */
export function start() {
  if (manager) return;
  reconcile();
  manager = setInterval(() => {
    try {
      reconcile();
    } catch (err) {
      console.log(`[telegram] reconcile failed — ${err instanceof Error ? err.message : err}`);
    }
  }, RECONCILE_MS);
  // The same `unref` the collection scheduler takes: a timer must never be the
  // reason this process stays alive.
  manager.unref();
}

/** Stop everything. Nothing calls this in the server; the tests and the CLI
 *  do, and a process that can be asked to stop cleanly is worth the six
 *  lines. */
export function stop() {
  if (manager) clearInterval(manager);
  manager = null;
  for (const id of [...loops.keys()]) stopLoop(id, "shutting down");
}

/** What every loop is doing, for GET /api/telegram. An account with no loop is
 *  absent from this map, which the route reads as `stopped` — the honest
 *  answer, and not the same as "polling and quiet". */
export function statuses(): Map<number, PollerStatus> {
  return new Map([...loops].map(([id, loop]) => [id, loop.status]));
}
