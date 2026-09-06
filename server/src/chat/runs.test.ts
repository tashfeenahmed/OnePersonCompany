/**
 * THE RUN ENGINE, WITHOUT AN AGENT.
 *
 * `open(signal)` is a plain async generator on the contract, which is exactly
 * what makes this testable: a fake turn that yields three deltas and a `done`
 * exercises the same buffer, the same sequence numbers and the same write as
 * Hermes does. What is checked here is the half a live chat cannot demonstrate
 * on demand — that a subscriber attaching LATE gets the whole turn, that one
 * attaching with `since` gets only the tail, that a cancel stores what was said
 * so far, and that a second turn on one conversation is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendChatMessage, chatMessages, type ChatMessageRow } from "../db.ts";
import type { ChatStreamEvent } from "./backend.ts";
import {
  RunBusyError,
  activeRun,
  answeringSessions,
  cancelChatRun,
  runHandle,
  sessionRunState,
  startChatRun,
} from "./runs.ts";

let n = 0;
function session(): string {
  n += 1;
  return `test-session-${process.pid}-${n}`;
}

function plan(
  sessionId: string,
  open: (signal: AbortSignal) => AsyncGenerator<ChatStreamEvent>,
  user?: ChatMessageRow,
) {
  const stored =
    user ?? appendChatMessage({ sessionId, role: "user", content: "hello?", channel: "web" });
  return {
    sessionId,
    channel: "web",
    ventureId: null,
    backend: "hermes" as const,
    backendLabel: "Test",
    user: stored,
    start: { sessionId, userMessageId: stored.id },
    shape: (r: ChatMessageRow) => ({ id: r.id, content: r.content, partial: r.partial === 1 }),
    open,
  };
}

/** Frames of a finished run, in order. */
function frames(runId: string, since = 0) {
  const h = runHandle(runId);
  assert.ok(h, "the run should still be held");
  return h.replay(since);
}

test("a run buffers every frame and can be replayed from the start after it ends", async () => {
  const id = session();
  async function* turn(): AsyncGenerator<ChatStreamEvent> {
    yield { type: "delta", text: "one " };
    yield { type: "delta", text: "two " };
    yield { type: "done", text: "one two ", model: "m", usage: null, ms: 12 };
  }
  const row = startChatRun(plan(id, turn));
  await runHandle(row.id)!.ended;

  const all = frames(row.id);
  assert.deepEqual(
    all.map((f) => f.event),
    ["run", "start", "delta", "delta", "done"],
  );
  /* Dense and one-based, which is what makes `since` unambiguous. */
  assert.deepEqual(
    all.map((f) => f.seq),
    [1, 2, 3, 4, 5],
  );

  const done = all[4]!.data as { text: string; message: { partial: boolean } };
  assert.equal(done.text, "one two ");
  assert.equal(done.message.partial, false);

  /* And the transcript has exactly one assistant row, complete. */
  const msgs = chatMessages(id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1]!.role, "assistant");
  assert.equal(msgs[1]!.content, "one two ");
  assert.equal(msgs[1]!.partial, 0);
});

test("`since` hands back only the tail — a reattaching client is not told the answer twice", async () => {
  const id = session();
  async function* turn(): AsyncGenerator<ChatStreamEvent> {
    yield { type: "delta", text: "a" };
    yield { type: "delta", text: "b" };
    yield { type: "done", text: "ab", model: null, usage: null, ms: 1 };
  }
  const row = startChatRun(plan(id, turn));
  await runHandle(row.id)!.ended;

  assert.deepEqual(
    frames(row.id, 3).map((f) => f.event),
    ["delta", "done"],
  );
  assert.equal(frames(row.id, 99).length, 0);
});

test("a client attaching mid-run sees the rest live", async () => {
  const id = session();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  async function* turn(): AsyncGenerator<ChatStreamEvent> {
    yield { type: "delta", text: "first" };
    await gate;
    yield { type: "delta", text: "second" };
    yield { type: "done", text: "firstsecond", model: null, usage: null, ms: 1 };
  }
  const row = startChatRun(plan(id, turn));
  /* Let the generator reach the gate. */
  await new Promise((r) => setTimeout(r, 10));

  const h = runHandle(row.id)!;
  assert.equal(h.running, true);
  const seen: string[] = [];
  const replayed = h.replay(0).map((f) => f.event);
  const off = h.listen((f) => seen.push(f.event));
  release();
  await h.ended;
  off();

  assert.deepEqual(replayed, ["run", "start", "delta"]);
  assert.deepEqual(seen, ["delta", "done"]);
});

test("cancelling stores what was said as a partial row and reports it as a stop", async () => {
  const id = session();
  async function* turn(signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    yield { type: "delta", text: "half an answer" };
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    /* A real adapter throws on abort; this one simply stops, which is the
       harder case — nothing failed, and the run must still land. */
  }
  const row = startChatRun(plan(id, turn));
  await new Promise((r) => setTimeout(r, 10));

  const r = cancelChatRun(row.id);
  assert.equal(r.ok, true);
  await runHandle(row.id)!.ended;

  const last = frames(row.id).at(-1)!;
  assert.equal(last.event, "error");
  const data = last.data as { cancelled: boolean; partial: boolean; messageId: number | null };
  assert.equal(data.cancelled, true);
  assert.equal(data.partial, true);

  const msgs = chatMessages(id);
  assert.equal(msgs[1]!.content, "half an answer");
  assert.equal(msgs[1]!.partial, 1, "a stopped answer is stored and flagged");

  const state = sessionRunState(id)!;
  assert.equal(state.status, "cancelled");
});

test("a turn that fails before saying anything writes no assistant row", async () => {
  const id = session();
  // eslint-disable-next-line require-yield
  async function* turn(): AsyncGenerator<ChatStreamEvent> {
    throw new Error("the gateway said no");
  }
  let reported: string | null = null;
  const row = startChatRun({ ...plan(id, turn), onError: (m) => (reported = m) });
  await runHandle(row.id)!.ended;

  assert.equal(reported, "the gateway said no");
  const last = frames(row.id).at(-1)!;
  assert.equal(last.event, "error");
  const data = last.data as { message: string; partial: boolean; cancelled: boolean };
  assert.equal(data.message, "the gateway said no");
  assert.equal(data.partial, false);
  assert.equal(data.cancelled, false);
  assert.equal(chatMessages(id).length, 1, "only the question is in the transcript");
  assert.equal(sessionRunState(id)!.status, "failed");
});

test("one conversation answers one question at a time", async () => {
  const id = session();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  async function* turn(): AsyncGenerator<ChatStreamEvent> {
    await gate;
    yield { type: "done", text: "done", model: null, usage: null, ms: 1 };
  }
  const row = startChatRun(plan(id, turn));
  assert.ok(activeRun(id), "the run is live");
  assert.ok(answeringSessions().includes(id));

  assert.throws(() => startChatRun(plan(id, turn)), RunBusyError);

  release();
  await runHandle(row.id)!.ended;
  assert.equal(activeRun(id), null);
  assert.equal(answeringSessions().includes(id), false);

  /* And the conversation is free again. */
  const second = startChatRun(plan(id, async function* () {
    yield { type: "done", text: "again", model: null, usage: null, ms: 1 };
  }));
  await runHandle(second.id)!.ended;
  assert.equal(sessionRunState(id)!.runId, second.id);
});

test("tool calls are merged and carry the offset they happened at", async () => {
  const id = session();
  async function* turn(): AsyncGenerator<ChatStreamEvent> {
    yield { type: "delta", text: "looking… " };
    yield {
      type: "tool",
      toolCallId: "t1",
      tool: "opc_ventures",
      label: null,
      emoji: null,
      status: "running",
      at: "2026-09-06T10:00:00.000Z",
    };
    yield {
      type: "tool",
      toolCallId: "t1",
      tool: "opc_ventures",
      label: "Ventures",
      emoji: "📇",
      status: "completed",
      at: "2026-09-06T10:00:02.000Z",
    };
    yield { type: "delta", text: "found it." };
    yield { type: "done", text: "looking… found it.", model: null, usage: null, ms: 3 };
  }
  const row = startChatRun(plan(id, turn));
  await runHandle(row.id)!.ended;

  const done = frames(row.id).at(-1)!.data as {
    tools: { toolCallId: string; offset: number; finishedAt: string | null; label: string | null }[];
  };
  assert.equal(done.tools.length, 1, "two events, one record");
  assert.equal(done.tools[0]!.offset, "looking… ".length);
  assert.equal(done.tools[0]!.finishedAt, "2026-09-06T10:00:02.000Z");
  assert.equal(done.tools[0]!.label, "Ventures");
});

test("a conversation nobody has asked anything has no run state", () => {
  assert.equal(sessionRunState(session()), null);
});
