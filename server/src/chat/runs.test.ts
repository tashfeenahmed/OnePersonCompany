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
  sessionBusy,
  sessionRunState,
  startChatRun,
} from "./runs.ts";
import { begin as beginInflight } from "./inflight.ts";
import { chatRun as chatRunRow, deleteChatRuns } from "../integrations/agentcore/store.ts";

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

/* ======================================================================
   REGRESSIONS FROM REVIEW. Each of these left the engine in a state it
   could not get out of, and each is reachable from an ordinary failure.
   ====================================================================== */

test("regression: a throw while landing the run still releases the conversation", async () => {
  /*
    `plan.shape` is the caller's function and runs while the run is writing its
    terminal frame. It used to run outside any `try`: the throw escaped a
    `void`-ed async function as an unhandled rejection, and — worse — skipped
    the two lines that release the session, so every later turn on that chat was
    refused as busy for the life of the process and every subscriber waited on a
    promise that never resolved.
  */
  const id = session();
  const row = startChatRun({
    ...plan(id, async function* () {
      yield { type: "delta", text: "an answer" };
      yield { type: "done", text: "an answer", model: null, usage: null, ms: 1 };
    }),
    shape: () => {
      throw new Error("the shaper blew up");
    },
  });

  /* The `ended` promise still resolves — a subscriber is not stranded. */
  await runHandle(row.id)!.ended;

  /* The conversation is free: the next question is not refused. */
  assert.equal(activeRun(id), null);
  const second = startChatRun(
    plan(id, async function* () {
      yield { type: "done", text: "and another", model: null, usage: null, ms: 1 };
    }),
  );
  await runHandle(second.id)!.ended;

  /* And the failure is on the record rather than swallowed. */
  const first = frames(row.id).at(-1)!;
  assert.equal(first.event, "error");
  assert.match((first.data as { message: string }).message, /shaper blew up/);
});

test("regression: a run that throws while landing is recorded as failed, not left running", async () => {
  const id = session();
  const row = startChatRun({
    ...plan(id, async function* () {
      yield { type: "done", text: "words", model: null, usage: null, ms: 1 };
    }),
    shape: () => {
      throw new Error("nope");
    },
  });
  await runHandle(row.id)!.ended;
  const state = sessionRunState(id)!;
  assert.equal(state.status, "failed");
  assert.equal(state.runId, row.id);
});

test("regression: hitting the buffer cap still delivers a terminal frame", async () => {
  /*
    The cap used to refuse EVERY frame once it was reached, the closing
    `done`/`error` included — so a live reader saw the socket close with no
    ending and a reattacher replayed the whole buffer and still found none.
  */
  const id = session();
  const big = "x".repeat(200_000);
  const row = startChatRun(
    plan(id, async function* (signal) {
      /* Eighty megabytes of deltas, well past the byte cap. A real adapter
         stops when its signal is aborted and never reaches its own `done`,
         which is exactly the shape that used to end with no terminal frame. */
      for (let i = 0; i < 400; i++) {
        if (signal.aborted) return;
        yield { type: "delta", text: big };
      }
    }),
  );
  await runHandle(row.id)!.ended;

  const all = frames(row.id);
  const last = all.at(-1)!;
  assert.equal(last.event, "error", "the ending is always sent");
  const data = last.data as { incomplete: boolean; message: string };
  assert.equal(data.incomplete, true, "and it says the middle is missing");
  assert.match(data.message, /longer than this server will hold/);
  /* The cap is about MEMORY, so it bit long before the frame count could. */
  assert.ok(all.length < 400, `${all.length} frames buffered`);
  assert.equal(sessionRunState(id)!.status, "failed");
  /* And the conversation is usable again. */
  assert.equal(activeRun(id), null);
});

test("regression: a cancel that lands after the answer is refused rather than mis-reported", async () => {
  /*
    `cancelChatRun` gated on a status the tail had not written yet, so a stop
    pressed in the instant between the last token and the row write was accepted
    — and then the turn landed as `done` while the owner had been told it was
    cancelled. The stop button's one job is to report what it did.
  */
  const id = session();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const row = startChatRun(
    plan(id, async function* () {
      yield { type: "done", text: "complete", model: null, usage: null, ms: 1 };
      /* Held open after `done` so the cancel below lands inside the window. */
      await gate;
    }),
  );
  await new Promise((r) => setTimeout(r, 10));

  const r = cancelChatRun(row.id);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /already finished/);

  release();
  await runHandle(row.id)!.ended;
  assert.equal(sessionRunState(id)!.status, "done");
  assert.equal(frames(row.id).at(-1)!.event, "done");
});

test("a successful cancel answers `stopping`, because the run has not landed yet", async () => {
  const id = session();
  const row = startChatRun(
    plan(id, async function* (signal) {
      yield { type: "delta", text: "half" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  const r = cancelChatRun(row.id);
  assert.equal(r.ok, true);
  assert.equal(r.status, "stopping");
  await runHandle(row.id)!.ended;
  assert.equal(sessionRunState(id)!.status, "cancelled");
});

test("`sessionBusy` sees the other door too", async () => {
  const id = session();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const row = startChatRun(
    plan(id, async function* () {
      await gate;
      yield { type: "done", text: "x", model: null, usage: null, ms: 1 };
    }),
  );
  assert.deepEqual(sessionBusy(id), { busy: true, runId: row.id });
  release();
  await runHandle(row.id)!.ended;
  assert.deepEqual(sessionBusy(id), { busy: false, runId: null });

  /* And an `ask()` on the same session — the non-streaming door, which starts
     no run — is busy with no stream to point at. */
  const end = beginInflight(id);
  assert.deepEqual(sessionBusy(id), { busy: true, runId: null });
  end();
  assert.equal(sessionBusy(id).busy, false);
});

test("deleting a conversation forgets its runs", async () => {
  const id = session();
  const row = startChatRun(
    plan(id, async function* () {
      yield { type: "done", text: "kept", model: null, usage: null, ms: 1 };
    }),
  );
  await runHandle(row.id)!.ended;
  assert.ok(sessionRunState(id));
  assert.equal(deleteChatRuns(id), 1);
  /* The in-memory run is still in its retention window, so the state comes back
     from there; the ROW is gone, which is what a recycled id would have found. */
  assert.equal(chatRunRow(row.id), null);
});
