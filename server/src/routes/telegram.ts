/**
 * What the Telegram bridge is doing.
 *
 * THE RULE THIS ROUTE IS WRITTEN AROUND: counts and ids, never a person. There
 * is no field here that could carry a name, a username of a human, or a word
 * anybody typed — not because the data is unavailable (the bridge has it) but
 * because a dashboard route is the wrong place for it. The one identifier on
 * the wire is the paired CHAT id, which the owner needs in order to recognise
 * their own pairing and to clear it.
 *
 * WHAT IT REPORTS THAT NOTHING ELSE CAN. A bot connected on the Integrations
 * page looks identical, from the plugin page, whether it is polling happily,
 * being refused by a second process holding the same token, or backing off
 * after a network failure. The poller's state is in memory — it is a fact
 * about right now rather than a measurement — so this is the only place it
 * exists, and it is why "connected" is not the whole answer here the way it is
 * for a collector.
 *
 * NULL MEANS "NOTHING HAS HAPPENED YET" and never zero: a bot nobody has
 * messaged has `chat.chatId: null`, not a chat of 0, and `lastReplyAt: null`
 * rather than a date that would read as a reply.
 */
import { Hono } from "hono";
import * as accounts from "../accounts.ts";
import { getPlugin, telegramSessionTurns, telegramState } from "../db.ts";
import { backends } from "../chat/backend.ts";
import { PLUGIN, lockKey, lockedChat, sessionFor, unlockChat } from "../telegram/bridge.ts";
import { statuses } from "../telegram/poller.ts";

export const telegramRoutes = new Hono();

/** The chat backend, as this bridge sees it. Read here rather than proxied
 *  from the chat routes, because "is there anything on the other end of the
 *  bot" is the first question this page has to answer and it must not depend
 *  on a second fetch. */
function agent() {
  const list = backends();
  const live = list.find((b) => b.connected) ?? null;
  return {
    /** Whether ANY backend is connected. Which one actually answers is the
     *  chat backend's own choice, made on every call. */
    connected: list.some((b) => b.connected),
    backends: list,
    label: live?.label ?? null,
  };
}

telegramRoutes.get("/", (c) => {
  const plugin = getPlugin(PLUGIN);
  const running = statuses();

  const bots = accounts.list(PLUGIN).map((account) => {
    const state = telegramState(account.id);
    const chatId = lockedChat(account.id);
    const poller = running.get(account.id) ?? null;

    return {
      accountId: account.id,
      /** The account's label. It is the bot's own @name once the poller has
       *  asked getMe — a handle the owner chose for a bot, never a person. */
      label: account.label,
      username: state?.bot_username ?? null,
      connected: account.connected,

      /*
        THE LOCK. `chatId` null is the state every fresh install is in and the
        one the page has to explain: the bot is live and waiting to be
        messaged. It is not an error and it is not a failure to configure.
      */
      chat: {
        locked: chatId !== null,
        chatId,
        /** Which `plugin_config` key holds it — `chatId` for the first bot,
         *  `chatId#<account>` for the rest. On the wire so the settings field
         *  on the page and this document can be seen to be the same value. */
        key: lockKey(account.id),
        /** Turns of conversation kept for that chat, in the transcript the
         *  Chat page shares. A count, never content. */
        turns: chatId ? telegramSessionTurns(sessionFor(chatId)) : 0,
        /** Where those turns live, so the same conversation can be found from
         *  the other door. It is the id handed to ask() as well. */
        session: chatId ? sessionFor(chatId) : null,
      },

      /*
        THE POLLER, WHICH IS A FACT ABOUT RIGHT NOW. `stopped` for a connected
        account means the loop is not running — after a boot it should be
        `starting` and then `polling` within a second or two. `conflict` names
        the one failure whose fix is on another machine.
      */
      poller: poller ?? {
        state: "stopped" as const,
        since: null,
        failures: 0,
        nextAttemptAt: null,
        lastError: null,
        updates: 0,
      },

      messages: {
        /** Answered, because they came from the paired chat. */
        handled: state?.handled ?? 0,
        /** Dropped, because they did not. Nothing was sent back and nothing
         *  reached the agent — this is the count of times somebody else has
         *  messaged this bot. */
        ignored: state?.ignored ?? 0,
        lastMessageAt: state?.last_message_at ?? null,
        lastIgnoredAt: state?.last_ignored_at ?? null,
        lastReplyAt: state?.last_reply_at ?? null,
      },

      lastError: state?.last_error ?? account.lastError ?? null,
      lastErrorAt: state?.last_error_at ?? null,
    };
  });

  return c.json({
    connected: plugin?.connected === 1,
    bots,
    agent: agent(),
    /** What the owner has to do that no route can do for them. */
    next: bots.length
      ? bots.every((b) => b.chat.locked)
        ? null
        : "Message the bot once from the chat that should own it. The first message it receives pairs it, and every message from any other chat is ignored from then on."
      : "Paste a bot token from @BotFather on the Telegram integration page.",
    cannot: [
      "who the paired chat belongs to — the bridge stores the chat id and nothing else about the person in it",
      "what was said — the conversation is in the shared transcript under its session id, and nothing on this route returns a word of it",
      "whether a second process is polling this token, until Telegram answers 409 — there is no endpoint that reports who holds a bot",
    ],
    generatedAt: new Date().toISOString(),
  });
});

/**
 * Un-pair a bot, so it can be handed to a different chat.
 *
 * A DELETE rather than a settings write, because the settings door
 * (`PUT /api/plugins/telegram/config`) can only address the first bot's key
 * and this has to work for the fifth. Both end in the same place: the
 * `plugin_config` row is removed, the next message from any chat pairs the bot
 * again, and the previous chat's conversation is forgotten with it.
 */
telegramRoutes.delete("/lock/:accountId", (c) => {
  const account = accounts.get(Number(c.req.param("accountId")));
  if (!account || account.pluginId !== PLUGIN)
    return c.json({ error: "No such Telegram bot." }, 404);
  const { was, forgot } = unlockChat(account.id);
  return c.json({
    accountId: account.id,
    unlocked: was !== null,
    /** How many turns of conversation went with it. */
    forgot,
    next: "The next message this bot receives, from any chat, pairs it again.",
  });
});

/** The same, for the ordinary case of one bot. It refuses rather than guesses
 *  when there are several — the pattern PUT /api/plugins/:id already sets. */
telegramRoutes.delete("/lock", (c) => {
  const all = accounts.list(PLUGIN);
  if (!all.length) return c.json({ error: "No Telegram bot is connected." }, 404);
  if (all.length > 1)
    return c.json(
      {
        error:
          `This plugin has ${all.length} bots (${all.map((a) => a.label).join(", ")}). ` +
          `Say which one: DELETE /api/telegram/lock/<account id>.`,
      },
      409,
    );
  const { was, forgot } = unlockChat(all[0]!.id);
  return c.json({
    accountId: all[0]!.id,
    unlocked: was !== null,
    forgot,
    next: "The next message this bot receives, from any chat, pairs it again.",
  });
});
