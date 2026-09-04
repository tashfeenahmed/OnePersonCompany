/**
 * THE BRIDGE: one Telegram chat, one agent, and a lock between them.
 *
 * WHAT THIS FILE DECIDES, AND WHY IT IS NOT IN THE POLLER. Everything here is
 * a decision about ONE update — whose chat it came from, whether it is allowed
 * anywhere near the agent, what to say back and what to remember. The poller
 * beside it decides nothing: it fetches, hands each update to `handleUpdate`,
 * and sleeps. Splitting it that way is what makes the lock testable without a
 * human: the test feeds this function the exact JSON Telegram would have sent
 * and asserts what came back, including the case where no agent is connected
 * at all.
 *
 * THE LOCK IS THE WHOLE SECURITY MODEL. A bot token is public the moment
 * anybody guesses the bot's @name — Telegram lets any person on earth open a
 * chat with any bot, and there is no setting that prevents it. So the bridge
 * pairs with exactly ONE chat, the first that speaks to it, and every message
 * from anywhere else is dropped before it reaches the agent and answered with
 * nothing at all. Not "you are not authorised": nothing. A refusal confirms
 * the bot is live and tells a stranger there is something here to keep
 * knocking at; silence is indistinguishable from a bot that does not exist.
 * The dropped ones are COUNTED, because "somebody else found this bot" is a
 * fact the owner should be able to read off the plugin page.
 *
 * This mirrors what workdash's notifier does on the Pi — locked to one
 * Telegram user id, everyone else logged and ignored — with one deliberate
 * difference: that bot's id is pasted into a .env by hand, and this one is
 * discovered, because the product this belongs to is a page where somebody
 * pastes a token and is then told to message their bot. The catalog has
 * promised exactly that for as long as it has had a Telegram entry.
 *
 * NOTHING HERE LOGS A PERSON. Not a name, not a username, not a word of a
 * message. Chat ids and counts, and that is all — on the wire, in the logs and
 * in the errors. The message text is stored, once, in `telegram_messages`,
 * because a chat with no memory of the last exchange is not a chat; no route
 * returns it.
 */
import {
  appendChatMessage,
  chatMessages,
  configValue,
  countTelegramMessage,
  deleteChatSession,
  forgetTelegramSessionsExcept,
  setConfig,
  telegramSessionTurns,
  telegramState,
  writeTelegramError,
  writeTelegramReply,
} from "../db.ts";
import * as accounts from "../accounts.ts";
import {
  NoBackendError,
  activeBackend,
  ask,
  type AskOptions,
  type ChatReply,
  type ChatTurn,
} from "../chat/backend.ts";
import * as telegram from "../providers/telegram.ts";
import { escapeHtml, type TelegramUpdate } from "../providers/telegram.ts";

export const PLUGIN = "telegram";

/** How much of the conversation goes back to the agent. Ten turns is five
 *  exchanges: enough that "and the second one?" resolves, short enough that a
 *  month of chatting does not become a token bill on every message. The
 *  backend gets the turns; a backend that keeps its own session (OpenClaw
 *  does) also gets the sessionId and can ignore ours. */
const HISTORY_TURNS = 10;

/**
 * WHERE A BRIDGED CONVERSATION IS KEPT: `chat_messages`, the table the Chat
 * page writes to, under the session id this bridge hands `ask()`.
 *
 * There is no second store and there was very nearly one — see 018 in db.ts.
 * The argument is 016_chat's own: two doors onto one agent with two
 * transcripts is one agent with amnesia on whichever door you did not come in
 * through. So the session id is the join, `channel` says which door a message
 * came in by, and the whole conversation is readable from either.
 */
export const sessionFor = (chatId: string) => `telegram:${chatId}`;

/* ------------------------------------------------------------- the lock */

/**
 * WHERE THE LOCKED CHAT ID LIVES, AND WHY IT IS A SETTING RATHER THAN A ROW OF
 * ITS OWN.
 *
 * It is not a credential — it is a number the owner is entitled to read back,
 * check and clear, which is exactly the distinction `plugin_config` exists to
 * draw (see routes/pluginConfig.ts). Written into a table of its own it would
 * be invisible on the plugin page and un-clearable without a route built for
 * the purpose.
 *
 * A PLUGIN HOLDS ACCOUNTS, so there can be two bots, and two bots pair with
 * two chats. The naming follows the rule accounts.ts uses for vault entries,
 * for the same reason: the FIRST claimant takes the plain key `chatId` — the
 * one the plugin page shows and the one the catalog describes — and every
 * account after it is suffixed with its own row id, `chatId#4`, which is the
 * one thing about an account that never changes.
 *
 * `chatOwner` records which account holds the plain key. Without it, "whose is
 * `chatId`?" would have to be inferred from the account list, and the answer
 * would silently move to a different bot the day the first account is deleted
 * — pointing a live bot at a chat that was never paired with it.
 */
export function lockKey(accountId: number): string {
  const owner = configValue(PLUGIN, "chatOwner");
  // The plain key is this account's if it claimed it, or free if nothing has
  // — including the case where the account that claimed it has since been
  // deleted, which leaves the key adoptable rather than orphaned. A value
  // typed into the field on the plugin page before any bot has been messaged
  // arrives here the same way, and is honoured rather than overwritten.
  if (!owner || Number(owner) === accountId || !accounts.get(Number(owner))) return "chatId";
  return `chatId#${accountId}`;
}

/** The chat this bot is paired with, or null for "nothing has messaged it
 *  yet" — which is a state, not a failure, and the one every fresh install
 *  is in. */
export function lockedChat(accountId: number): string | null {
  return configValue(PLUGIN, lockKey(accountId));
}

/** Pair with a chat. Idempotent by construction: it is only ever called when
 *  `lockedChat` returned null. */
export function lockChat(accountId: number, chatId: string) {
  const key = lockKey(accountId);
  setConfig(PLUGIN, key, chatId);
  if (key === "chatId") setConfig(PLUGIN, "chatOwner", String(accountId));
}

/**
 * Un-pair, so the owner can hand the bot to a different chat.
 *
 * The conversation goes with it. An unlock is what somebody does to re-pair a
 * bot somewhere else, and a rolling history carried across is one person's
 * words shown to the next.
 */
export function unlockChat(accountId: number): { was: string | null; forgot: number } {
  const key = lockKey(accountId);
  const was = configValue(PLUGIN, key);
  setConfig(PLUGIN, key, "");
  if (key === "chatId") setConfig(PLUGIN, "chatOwner", "");
  return { was, forgot: was ? deleteChatSession(sessionFor(was)) : 0 };
}

/**
 * Drop the history of any chat nothing is paired with any more.
 *
 * The settings door can clear or repoint a lock without this file being told
 * what the old value was — so rather than trying to observe the change, this
 * states the invariant: a conversation belongs to a paired chat, and one that
 * belongs to no pairing can never be continued by anybody. Called after a
 * settings write.
 */
export function pruneOrphanHistory(): number {
  const keep = accounts
    .list(PLUGIN)
    .map((a) => lockedChat(a.id))
    .filter((id): id is string => id !== null)
    .map(sessionFor);
  // Only `telegram:` sessions are swept. The table is shared with the Chat
  // page, whose conversations this has no business deleting.
  return forgetTelegramSessionsExcept(keep);
}

/* ------------------------------------------------------------- the seams */

/** One bot, as the bridge needs it. The token is here and goes nowhere else:
 *  it is never logged, never stored outside the vault, and never part of a
 *  string this file builds. */
export type BotContext = {
  accountId: number;
  label: string;
  token: string;
  bot: telegram.BotIdentity;
};

/**
 * The two outbound calls, injected rather than imported directly.
 *
 * This is what lets the whole of the behaviour below be exercised against fake
 * `getUpdates` payloads with no bot token, no network and no human: the test
 * passes a wire that records what would have been sent and an `ask` that
 * throws NoBackendError. It is not an abstraction for its own sake — there is
 * exactly one real implementation, `liveWire`, twelve lines down.
 */
export type Wire = {
  send(chatId: string, text: string, opts?: { html?: boolean }): Promise<unknown>;
  typing(chatId: string): Promise<void>;
  ask(turns: ChatTurn[], opts?: AskOptions): Promise<ChatReply>;
};

export function liveWire(ctx: BotContext): Wire {
  return {
    send: (chatId, text, opts) => telegram.send(ctx.token, chatId, text, opts),
    typing: (chatId) => telegram.typing(ctx.token, chatId),
    ask,
  };
}

/** What happened to one update, for the poller's log line and the test's
 *  assertions. Never carries text and never carries a person. */
export type Outcome = {
  action: "skipped" | "locked" | "ignored" | "answered" | "explained";
  /** Why it was skipped, in three words. Only ever about shape, never about
   *  who sent it. */
  reason?: string;
  /** True when something actually left for Telegram. */
  replied: boolean;
  chatId?: string;
};

/* --------------------------------------------------------- what it says */

const COMMANDS = [
  { command: "start", description: "What this bridge is, and whether an agent is live" },
  { command: "status", description: "Bot, paired chat, message counts, agent" },
];

export { COMMANDS };

/** The agent that would answer right now, or null. Read on every message
 *  rather than cached, because chat/backend.ts reads the choice on every call
 *  and a bot that reports yesterday's answer is worse than one that says
 *  nothing. */
function agentLabel(): string | null {
  try {
    return activeBackend()?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * /start — what this is, said once, to the person who just paired.
 *
 * It answers the two questions somebody has at that moment: did the pairing
 * work, and is there anything on the other end. The second one is the honest
 * half — a bridge with no agent behind it is a live bot that cannot answer,
 * and saying so here is the difference between "it is broken" and "there is
 * one more thing to connect".
 */
function startText(ctx: BotContext, chatId: string, justLocked: boolean): string {
  const agent = agentLabel();
  const lines = [
    `<b>${escapeHtml(ctx.bot.name)}</b> — the bridge to your dashboard's agent.`,
    "",
    justLocked
      ? `Paired with this chat (<code>${escapeHtml(chatId)}</code>). Messages from any other chat are ignored from now on, and nobody else can talk to this bot.`
      : `Paired with this chat (<code>${escapeHtml(chatId)}</code>).`,
    "",
    agent
      ? `Agent: <b>${escapeHtml(agent)}</b>. Send anything and it answers here.`
      : "No agent is connected yet, so there is nothing to answer you. Connect Hermes or OpenClaw under Integrations and choose one as the chat backend — nothing needs re-pairing after that.",
    "",
    "/status — what this bridge has seen",
  ];
  return lines.join("\n");
}

/**
 * /status — the same document the plugin page shows, in a sentence each.
 *
 * Counts and ids. There is no name here and no message here, and there is no
 * branch of this function that could add one.
 */
function statusText(ctx: BotContext, chatId: string): string {
  const state = telegramState(ctx.accountId);
  const agent = agentLabel();
  const history = telegramSessionTurns(sessionFor(chatId));
  const lines = [
    `<b>Bot</b> ${ctx.bot.username ? `@${escapeHtml(ctx.bot.username)}` : escapeHtml(ctx.bot.name)} · account “${escapeHtml(ctx.label)}”`,
    `<b>Chat</b> paired with <code>${escapeHtml(chatId)}</code>`,
    `<b>Agent</b> ${agent ? escapeHtml(agent) : "none connected"}`,
    `<b>Messages</b> ${state?.handled ?? 0} handled · ${state?.ignored ?? 0} from other chats ignored`,
    `<b>Memory</b> ${history} turn${history === 1 ? "" : "s"} kept, last ${HISTORY_TURNS} sent with each message`,
    `<b>Last reply</b> ${state?.last_reply_at ? escapeHtml(state.last_reply_at) : "none yet"}`,
  ];
  if (state?.last_error)
    lines.push(`<b>Last error</b> ${escapeHtml(state.last_error)}`);
  return lines.join("\n");
}

/* --------------------------------------------------------- the handler */

/**
 * One update, from the top.
 *
 * The order of the checks is the design:
 *
 *   1. is it a message with a chat at all       — otherwise there is nothing
 *                                                 to answer and nowhere to
 *   2. is the sender another bot                — bots do not talk to bots;
 *                                                 two bridges facing each
 *                                                 other is an infinite loop
 *                                                 that costs real money
 *   3. is anybody paired yet                    — if not, this chat is now
 *   4. is it THIS chat                          — if not: count it, say
 *                                                 nothing, and return before
 *                                                 the agent is ever reached
 *   5. only then: a command, or the agent
 *
 * Step 4 is before every path that can send or spend anything, which is the
 * property worth stating: a stranger's message cannot reach `ask()`, cannot
 * cost a token, and cannot produce a reply, because the function returns two
 * steps above all three.
 */
export async function handleUpdate(
  update: TelegramUpdate,
  ctx: BotContext,
  wire: Wire,
): Promise<Outcome> {
  const message = update.message;
  if (!message?.chat) return { action: "skipped", reason: "not a message", replied: false };

  const chatId = String(message.chat.id);

  // A bot's own messages, and any other bot's. Telegram does not deliver a
  // bot its own, but a second bot in a group is a real arrangement and two
  // agents answering each other is a bill with no human in it.
  if (message.from?.is_bot)
    return { action: "skipped", reason: "sent by a bot", replied: false, chatId };

  const locked = lockedChat(ctx.accountId);

  /* ------------------------------------------------ the pairing message */
  if (locked === null) {
    lockChat(ctx.accountId, chatId);
    countTelegramMessage(ctx.accountId, "handled");
    console.log(`[telegram] ${ctx.label}: paired with chat ${chatId}`);
    await wire.send(chatId, startText(ctx, chatId, true), { html: true });
    writeTelegramReply(ctx.accountId);
    // The first message is usually "hi" or "/start", and both are answered by
    // the greeting above. Anything else was a real question and is answered
    // properly as well rather than swallowed by the handshake.
    const text = (message.text ?? "").trim();
    if (text && !isCommand(text, ctx)) {
      await answer(ctx, wire, chatId, text);
      return { action: "answered", replied: true, chatId };
    }
    return { action: "locked", replied: true, chatId };
  }

  /* --------------------------------------------------------- a stranger */
  if (locked !== chatId) {
    countTelegramMessage(ctx.accountId, "ignored");
    // The chat id is deliberately absent. It identifies a person who is not
    // the owner, and it is of no use to anybody here: the count is the whole
    // finding.
    console.log(`[telegram] ${ctx.label}: ignored a message from another chat`);
    return { action: "ignored", replied: false, chatId };
  }

  /* ------------------------------------------------------- the owner */
  countTelegramMessage(ctx.accountId, "handled");
  const text = (message.text ?? "").trim();

  if (!text) {
    // A photo, a sticker, a voice note. Saying so is the point: silence here
    // reads as a bot that has stopped working, and the owner would have no way
    // to tell the difference from a phone.
    await wire.send(
      chatId,
      "I can only read text — that message had none, so there is nothing to send on.",
    );
    writeTelegramReply(ctx.accountId);
    return { action: "explained", reason: "no text", replied: true, chatId };
  }

  const command = isCommand(text, ctx);
  if (command === "/start" || command === "/help") {
    await wire.send(chatId, startText(ctx, chatId, false), { html: true });
    writeTelegramReply(ctx.accountId);
    return { action: "explained", reason: "start", replied: true, chatId };
  }
  if (command === "/status") {
    await wire.send(chatId, statusText(ctx, chatId), { html: true });
    writeTelegramReply(ctx.accountId);
    return { action: "explained", reason: "status", replied: true, chatId };
  }

  /*
    ANY OTHER SLASH COMMAND GOES TO THE AGENT rather than being refused. This
    is a bridge to something that can think, not a menu: /deploy and /whats-my-
    mrr are sentences an agent can act on, and a bot that answers "unknown
    command" to them would be pretending to be a smaller thing than it is. The
    two above are intercepted because they are questions about the BRIDGE,
    which the agent knows nothing about.
  */
  await answer(ctx, wire, chatId, text);
  return { action: "answered", replied: true, chatId };
}

/** `/status@my_bot` is what a Telegram client sends in a group; the suffix is
 *  Telegram's own routing and is not part of the command. */
function isCommand(text: string, ctx: BotContext): string | null {
  if (!text.startsWith("/")) return null;
  const word = text.split(/\s/, 1)[0]!.toLowerCase();
  const at = word.indexOf("@");
  const bare = at < 0 ? word : word.slice(0, at);
  if (at >= 0 && ctx.bot.username && word.slice(at + 1) !== ctx.bot.username.toLowerCase())
    return null; // addressed to a different bot in the same group
  return bare;
}

/**
 * The bridge itself: history, one `ask`, one reply.
 *
 * EVERY FAILURE ENDS IN A SENTENCE. `ask` throws NoBackendError when nothing
 * is connected, and that error's message is written to be sent as it is — so
 * it is, verbatim, rather than translated into a worse version of itself. Any
 * other failure gets one honest sentence naming what went wrong. The one
 * outcome that is not allowed here is silence: a bot that says nothing is
 * indistinguishable from a bot that is down, and the owner is holding a phone
 * with no logs on it.
 *
 * THE HISTORY IS WRITTEN ONLY ON A REAL ANSWER. A question stored with no
 * reply beside it would be replayed to the agent on the next message as
 * something it had already been asked and had answered — the model would see
 * its own silence as a turn. So a failed exchange leaves the history exactly
 * as it was, and the owner can simply send it again.
 */
async function answer(ctx: BotContext, wire: Wire, chatId: string, text: string) {
  const session = sessionFor(chatId);
  const turns: ChatTurn[] = [
    ...chatMessages(session, HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: text },
  ];

  await wire.typing(chatId);

  let reply: ChatReply;
  try {
    reply = await wire.ask(turns, { sessionId: `telegram:${chatId}`, channel: "telegram" });
  } catch (err) {
    if (err instanceof NoBackendError) {
      // Sent as written. It already says what to connect and where.
      await wire.send(chatId, err.message);
      writeTelegramReply(ctx.accountId);
      return;
    }
    const why = (err instanceof Error ? err.message : "an unknown error").slice(0, 300);
    writeTelegramError(ctx.accountId, why);
    await wire.send(chatId, `The agent could not answer that: ${why}`);
    writeTelegramReply(ctx.accountId);
    return;
  }

  const body = reply.text.trim();
  if (!body) {
    // A backend that answers with nothing has still answered, and that is a
    // different problem from a backend that failed. Neither is stored.
    await wire.send(chatId, "The agent answered with an empty message.");
    writeTelegramReply(ctx.accountId);
    return;
  }

  await wire.send(chatId, body);
  /*
    Both halves of the exchange, into the transcript the Chat page shares —
    the assistant row carrying WHICH agent answered and what the turn cost,
    because chat/backend.ts's rule is that the owner is entitled to know which
    backend spoke, and a row that recorded only the current choice would
    re-attribute old answers the moment somebody switched.
  */
  appendChatMessage({ sessionId: session, role: "user", content: text, channel: "telegram" });
  appendChatMessage({
    sessionId: session,
    role: "assistant",
    content: body,
    channel: "telegram",
    backend: reply.backend,
    model: reply.model,
    promptTokens: reply.usage?.prompt ?? null,
    completionTokens: reply.usage?.completion ?? null,
    ms: reply.ms,
  });
  writeTelegramReply(ctx.accountId);
  writeTelegramError(ctx.accountId, null);
}

/* ---------------------------------------------------------------- notify */

/**
 * OUTBOUND: the other half of a bridge, for the rest of the server to call.
 *
 * NOTHING CALLS THIS YET, and that is deliberate rather than unfinished. The
 * alerts it exists for — a server that stopped answering, a quota about to
 * run out, a payment that failed — are decisions about what is worth waking
 * somebody for, and inventing them here would put messages on the owner's
 * phone that the owner never asked for. What this file owes those callers is
 * a function that cannot send to the wrong person, and this is it:
 *
 *     import { notify } from "../telegram/bridge.ts";
 *     await notify("Hetzner: falkenstein-1 stopped answering.");
 *
 * IT SENDS ONLY TO A LOCKED CHAT. With no pairing there is no destination and
 * it returns `{ sent: false }` with the reason, rather than throwing — an
 * alert path that can crash the thing raising the alert is worse than a
 * missed alert. With several bots connected it uses the first one that is
 * paired unless an account is named, because notifying every bot means
 * notifying one person twice.
 */
export async function notify(
  text: string,
  opts: { accountId?: number; html?: boolean } = {},
): Promise<{ sent: boolean; accountId: number | null; reason?: string }> {
  const { ready } = accounts.credentialed(PLUGIN, ["token"], "telegram_notify");
  const candidates = opts.accountId
    ? ready.filter((r) => r.account.id === opts.accountId)
    : ready;
  if (!candidates.length)
    return { sent: false, accountId: null, reason: "No Telegram bot is connected." };

  for (const { account, values } of candidates) {
    const chatId = lockedChat(account.id);
    if (!chatId) continue;
    try {
      await telegram.send(values.token!, chatId, text, { html: opts.html });
      writeTelegramReply(account.id);
      return { sent: true, accountId: account.id };
    } catch (err) {
      const why = err instanceof Error ? err.message : "send failed";
      writeTelegramError(account.id, why);
      return { sent: false, accountId: account.id, reason: why };
    }
  }
  return {
    sent: false,
    accountId: null,
    reason: "No chat is paired yet — message the bot once from the chat that should receive alerts.",
  };
}
