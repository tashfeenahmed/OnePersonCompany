/**
 * THE BRIDGE, PROVED WITHOUT A HUMAN.
 *
 * The one thing that cannot be tested from here is the thing only the owner
 * can do: send the bot a message. Everything that happens AFTER that message
 * arrives is decided by `handleUpdate`, so this feeds it the exact JSON
 * Telegram's `getUpdates` returns — the same objects the poller hands over —
 * and asserts what came back out. What is being proved:
 *
 *   · the first message from any chat pairs the bot, and the pairing is
 *     written where the plugin page reads it;
 *   · a message from any OTHER chat is counted and answered with nothing —
 *     not a refusal, nothing — and never reaches `ask()`;
 *   · a message from the paired chat reaches `ask()` with the history in
 *     front of it and the reply goes back;
 *   · when no agent is connected, `ask` throws NoBackendError and its own
 *     sentence is what the chat receives, verbatim;
 *   · a backend that fails some other way still produces a sentence, because
 *     silence from a bot is indistinguishable from a broken bot.
 *
 * IT RUNS AGAINST A REAL DATABASE, in a temp directory. `OPC_DATA_DIR` is set
 * before anything is imported, so config.ts resolves the data directory to it
 * and db.ts creates a fresh file there — which means the counters, the lock
 * and the rolling history are exercised as they really are rather than
 * through a mock that agrees with whatever the code does.
 *
 *     node --experimental-strip-types --test src/telegram/bridge.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Types are erased, so importing them statically loads nothing and cannot
   race the line below. The VALUES are imported dynamically, after the data
   directory is set, because config.ts reads the environment at import. */
import type { AskOptions, ChatReply, ChatTurn } from "../chat/backend.ts";
import type { BotContext } from "./bridge.ts";

process.env.OPC_DATA_DIR = mkdtempSync(join(tmpdir(), "opc-telegram-"));

const {
  chatMessages,
  configValue,
  insertAccount,
  setAccountConnected,
  telegramState,
  upsertPlugin,
} = await import("../db.ts");
const { NoBackendError } = await import("../chat/backend.ts");
const bridge = await import("./bridge.ts");
const { chunk, escapeHtml } = await import("../providers/telegram.ts");

/* ------------------------------------------------------------- fixtures */

upsertPlugin("telegram", true, null);
const accountId = insertAccount("telegram", "Account 1");
setAccountConnected(accountId, true);

const ctx: BotContext = {
  accountId,
  label: "Account 1",
  // Not a real token and never used: every outbound call in these tests goes
  // through the fake wire below, which is the point of the seam.
  token: "test-token-not-real",
  bot: { id: 1, username: "opc_test_bot", name: "OPC Test" },
};

const OWNER = 4242;
const STRANGER = 9999;

/** One update, shaped exactly as Telegram sends it. */
function update(id: number, chat: number, text?: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: "private" },
      from: { id: chat, is_bot: false },
      ...(text === undefined ? {} : { text }),
      ...extra,
    },
  };
}

type Sent = { chatId: string; text: string; html: boolean };

/** A wire that records instead of sending, and an `ask` the test controls. */
function fakeWire(ask: (turns: ChatTurn[], opts?: AskOptions) => Promise<ChatReply>) {
  const sent: Sent[] = [];
  const asked: { turns: ChatTurn[]; opts?: AskOptions }[] = [];
  return {
    sent,
    asked,
    wire: {
      async send(chatId: string, text: string, opts?: { html?: boolean }) {
        sent.push({ chatId, text, html: opts?.html === true });
      },
      async typing() {},
      async ask(turns: ChatTurn[], opts?: AskOptions) {
        asked.push({ turns, opts });
        return ask(turns, opts);
      },
    },
  };
}

const reply = (text: string): ChatReply => ({
  text,
  backend: "hermes",
  model: "test",
  usage: null,
  ms: 1,
});

/* ---------------------------------------------------------------- tests */

test("the first message pairs the bot, and the pairing is where the page reads it", async () => {
  const { wire, sent, asked } = fakeWire(async () => reply("unused"));

  assert.equal(bridge.lockedChat(accountId), null, "nothing paired before the first message");

  const outcome = await bridge.handleUpdate(update(1, OWNER, "/start"), ctx, wire);

  assert.equal(outcome.action, "locked");
  assert.equal(outcome.replied, true);
  assert.equal(bridge.lockedChat(accountId), String(OWNER));
  // The plain key, because this is the first account — the one the plugin
  // page's settings field shows.
  assert.equal(configValue("telegram", "chatId"), String(OWNER));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /Paired with this chat/);
  // /start is a question about the bridge, so the agent is not troubled with
  // it.
  assert.equal(asked.length, 0);
});

test("a stranger gets nothing, is counted, and never reaches the agent", async () => {
  const { wire, sent, asked } = fakeWire(async () => {
    throw new Error("the agent must never be reached for a stranger");
  });

  const before = telegramState(accountId)?.ignored ?? 0;
  const outcome = await bridge.handleUpdate(update(2, STRANGER, "hello?"), ctx, wire);

  assert.equal(outcome.action, "ignored");
  assert.equal(outcome.replied, false);
  assert.equal(sent.length, 0, "not one byte goes back to a chat we are not paired with");
  assert.equal(asked.length, 0);
  assert.equal(telegramState(accountId)?.ignored, before + 1);
  // And the pairing is untouched: a stranger cannot steal a paired bot.
  assert.equal(bridge.lockedChat(accountId), String(OWNER));
});

test("the paired chat is bridged to the agent, with its history in front of it", async () => {
  const first = fakeWire(async () => reply("Seven servers, €63.47 a month."));
  await bridge.handleUpdate(update(3, OWNER, "how many servers?"), ctx, first.wire);

  assert.equal(first.asked.length, 1);
  assert.deepEqual(first.asked[0]!.turns, [
    { role: "user", content: "how many servers?" },
  ]);
  assert.equal(first.asked[0]!.opts?.sessionId, `telegram:${OWNER}`);
  assert.equal(first.asked[0]!.opts?.channel, "telegram");
  assert.deepEqual(
    first.sent.map((s) => s.text),
    ["Seven servers, €63.47 a month."],
  );
  // An agent's words go out unparsed: markdown that does not balance would be
  // refused whole by Telegram, and a missing reply is worse than a visible
  // asterisk.
  assert.equal(first.sent[0]!.html, false);

  const second = fakeWire(async () => reply("Falkenstein and Helsinki."));
  await bridge.handleUpdate(update(4, OWNER, "where are they?"), ctx, second.wire);

  assert.deepEqual(second.asked[0]!.turns, [
    { role: "user", content: "how many servers?" },
    { role: "assistant", content: "Seven servers, €63.47 a month." },
    { role: "user", content: "where are they?" },
  ]);

  const state = telegramState(accountId);
  assert.equal(state?.handled, 3, "the pairing message and both questions");
  assert.ok(state?.last_reply_at, "a reply time is recorded");
});

test("the exchange lands in the transcript the Chat page shares, tagged telegram", () => {
  // Not a table of this bridge's own: 016_chat's header asks for exactly this,
  // and the session id is the join between the two doors.
  const rows = chatMessages(bridge.sessionFor(String(OWNER)), 100);
  assert.deepEqual(
    rows.map((r) => [r.role, r.channel]),
    [
      ["user", "telegram"],
      ["assistant", "telegram"],
      ["user", "telegram"],
      ["assistant", "telegram"],
    ],
  );
  // Which agent answered travels with the answer, per chat/backend.ts's rule.
  assert.equal(rows[1]!.backend, "hermes");
  assert.equal(rows[1]!.model, "test");
});

test("with no agent connected, NoBackendError's own sentence is what the chat gets", async () => {
  const error = new NoBackendError();
  const { wire, sent } = fakeWire(async () => {
    throw error;
  });

  const outcome = await bridge.handleUpdate(update(5, OWNER, "are you there?"), ctx, wire);

  assert.equal(outcome.action, "answered");
  assert.equal(sent.length, 1);
  // Verbatim. The message is written to be sent as it is, and rewording it
  // here would mean two different sentences for one state.
  assert.equal(sent[0]!.text, error.message);
  assert.match(sent[0]!.text, /No agent is connected/);
  assert.match(sent[0]!.text, /Connect Hermes or OpenClaw/);
});

test("a failed exchange is not remembered, so the next question is not asked twice", async () => {
  const { wire } = fakeWire(async () => {
    throw new NoBackendError();
  });
  await bridge.handleUpdate(update(6, OWNER, "this one fails"), ctx, wire);

  const next = fakeWire(async () => reply("fine"));
  await bridge.handleUpdate(update(7, OWNER, "and this one works"), ctx, next.wire);

  const contents = next.asked[0]!.turns.map((t) => t.content);
  assert.ok(
    !contents.includes("this one fails"),
    "a question with no answer beside it would be replayed as one the agent had answered",
  );
});

test("any other failure still produces a sentence — silence is never an option", async () => {
  const { wire, sent } = fakeWire(async () => {
    throw new Error("Hermes answered HTTP 502.");
  });

  await bridge.handleUpdate(update(8, OWNER, "still there?"), ctx, wire);

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /could not answer/);
  assert.match(sent[0]!.text, /502/);
  assert.equal(telegramState(accountId)?.last_error, "Hermes answered HTTP 502.");
});

test("/status reports counts and ids and nothing that could name a person", async () => {
  const { wire, sent, asked } = fakeWire(async () => reply("unused"));
  await bridge.handleUpdate(update(9, OWNER, "/status@opc_test_bot"), ctx, wire);

  assert.equal(asked.length, 0, "a question about the bridge is not a question for the agent");
  assert.equal(sent[0]!.html, true);
  assert.match(sent[0]!.text, /@opc_test_bot/);
  assert.match(sent[0]!.text, new RegExp(String(OWNER)));
  assert.match(sent[0]!.text, /ignored/);
});

test("a message with no text is answered rather than dropped", async () => {
  const { wire, sent } = fakeWire(async () => reply("unused"));
  const outcome = await bridge.handleUpdate(update(10, OWNER), ctx, wire);

  assert.equal(outcome.action, "explained");
  assert.match(sent[0]!.text, /only read text/);
});

test("another bot's message is skipped without a reply and without a count", async () => {
  const { wire, sent } = fakeWire(async () => reply("unused"));
  const before = telegramState(accountId)?.handled ?? 0;

  const outcome = await bridge.handleUpdate(
    { update_id: 11, message: { message_id: 11, date: 1, chat: { id: OWNER }, from: { id: 7, is_bot: true }, text: "hi" } },
    ctx,
    wire,
  );

  assert.equal(outcome.action, "skipped");
  assert.equal(sent.length, 0);
  assert.equal(telegramState(accountId)?.handled, before);
});

test("an unknown slash command goes to the agent, because this is not a menu", async () => {
  const { wire, asked } = fakeWire(async () => reply("done"));
  await bridge.handleUpdate(update(12, OWNER, "/deploy staging"), ctx, wire);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.turns.at(-1)?.content, "/deploy staging");
});

test("unlocking forgets the chat, and the next message from anywhere re-pairs", async () => {
  const { was, forgot } = bridge.unlockChat(accountId);
  assert.equal(was, String(OWNER));
  assert.ok(forgot > 0, "the conversation goes with the pairing");
  assert.equal(bridge.lockedChat(accountId), null);

  const { wire } = fakeWire(async () => reply("unused"));
  await bridge.handleUpdate(update(13, STRANGER, "/start"), ctx, wire);
  assert.equal(bridge.lockedChat(accountId), String(STRANGER));
});

/* ------------------------------------------------- the wire's own rules */

test("a long reply is split under Telegram's cap, on boundaries", () => {
  const paragraph = `${"word ".repeat(200).trim()}\n\n`;
  const parts = chunk(paragraph.repeat(10));
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 3800, "every part fits Telegram's limit");
  assert.ok(!parts.some((p) => p.startsWith(" ")), "no part starts mid-space");
});

test("a split never lands inside an escaped entity", () => {
  // 4000 ampersands, escaped: any cut inside "&amp;" would produce a fragment
  // Telegram's HTML parser refuses whole.
  const parts = chunk(escapeHtml("&".repeat(2000)));
  for (const part of parts) {
    const tail = part.slice(-5);
    assert.ok(!/&[a-z]*$/.test(tail), `a part ends inside an entity: ${tail}`);
  }
});

test("escaping covers the three characters that break Telegram's parser", () => {
  assert.equal(escapeHtml('<b>a & b</b>'), "&lt;b&gt;a &amp; b&lt;/b&gt;");
});
