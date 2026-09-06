/**
 * READING A STREAMED TURN TO ITS END — once, for both doors.
 *
 * Two loops over `ChatStreamEvent` existed: the chat run's, and the run
 * executor's. They were the same switch statement, and every place they
 * differed was a place one of them was wrong:
 *
 *   REASONING. Chat kept the frames and drew them folded; the executor dropped
 *   them. BOTH ARE RIGHT, and it is the SINK's decision — a report is not a
 *   place for the model's scratchpad, a live answer is. So this loop passes
 *   them on and a sink that does not want them says nothing.
 *
 *   USAGE. Chat recorded the last `done`'s numbers; the executor SUMMED across
 *   the turns of one run. Both are right too, for the same reason: one stream
 *   is one turn, and a run makes several. This returns one turn's numbers and
 *   the caller adds them up if it has several to add.
 *
 *   THE SETTLING GUARD. The flag that stops a cancel arriving in the last
 *   instant from reporting "cancelled" for an answer that then lands as `done`
 *   existed only on the chat side; the run queue had the same race and nothing
 *   to stop it. The hook is here, fired the instant `done` is seen, which is
 *   the earliest point at which stopping would be a lie for a ONE-TURN answer.
 *   A run that makes several turns and then prints and judges between them
 *   shuts its door at the run's tail instead — see runs/executor.ts, which
 *   explains why a per-turn flag would be the wrong one there.
 *
 *   THE TOOL MERGE. Both copies merged the two wire events per call into one
 *   record with two timestamps, in near-identical code, and the run's copy had
 *   drifted: it did not carry the emoji or the offset. One merge now.
 *
 * `done.text` REPLACES THE ACCUMULATOR and does not append to it. The adapter
 * counted the answer as it read it and may have applied a rule this loop
 * cannot see — a backend that falls back to the model's reasoning when the
 * content came back empty produces a whole answer that arrived as no deltas at
 * all. The sink is told what the accumulator held when that happens, because a
 * caller that has already written the deltas somewhere has to unwrite them.
 *
 * IT DOES NOT CATCH, AND IT FILLS THE RESULT AS IT GOES. A stream that throws
 * is the caller's to handle: the two callers write very different things about
 * a failure — a partial transcript row, a failed run — and swallowing it here
 * would take that choice away. But both of them still have to WRITE what was
 * said before it broke, so the result object is the caller's, passed in and
 * mutated in place. Returning it only at the end would have made a cut-off
 * answer unreachable, which is the one case a partial row exists for.
 */
import type { ChatToolCall } from "../db.ts";
import type { ChatStreamEvent, ChatToolEvent } from "./backend.ts";

/** Where a consumed turn's events go while it is still arriving. Every hook is
 *  optional: a sink that only wants the result passes nothing at all. */
export type TurnSink = {
  /** One chunk of the answer, with everything accumulated so far beside it. */
  delta?(text: string, soFar: string): void;
  /** The model's working. Omit the hook to drop it. */
  reasoning?(text: string): void;
  /** A tool call, AFTER merging — the record as it now stands, with the raw
   *  event beside it for a sink that needs to know which half arrived. */
  tool?(call: ChatToolCall, event: ChatToolEvent): void;
  /**
   * THE ANSWER IS COMPLETE. Called before anything is written, so a caller can
   * shut its cancel door: from here, reporting a stop would be reporting one
   * that did not happen. `soFar` is what the deltas accumulated, which differs
   * from `text` exactly when the adapter replaced the answer.
   */
  done?(text: string, soFar: string): void;
};

/** One turn, read to its end. */
export type ConsumedTurn = {
  /** The answer, as `done` gave it — or the accumulated deltas if the stream
   *  ended without one, which is a stream that was cut off. */
  text: string;
  model: string | null;
  /** THIS TURN's usage, not a running total. Null is "not reported". */
  usage: { prompt: number; completion: number } | null;
  ms: number;
  /** Null is "not measured", never zero — only a raw provider owns a queue. */
  queuedMs: number | null;
  /** Did a `done` arrive? False means the stream stopped mid-answer. */
  finished: boolean;
  /** Every tool call, merged, in the order they were first announced. */
  tools: ChatToolCall[];
};

/** An empty turn — what a stream that yielded nothing amounts to. Made by the
 *  caller so it survives a throw; see the header. */
export const newTurn = (): ConsumedTurn => ({
  text: "",
  model: null,
  usage: null,
  ms: 0,
  queuedMs: null,
  finished: false,
  tools: [],
});

export async function consumeTurn(
  stream: AsyncIterable<ChatStreamEvent>,
  sink: TurnSink = {},
  turn: ConsumedTurn = newTurn(),
): Promise<ConsumedTurn> {
  /* By id, for the merge; `turn.tools` is the same records in the order they
     were first announced, which is the order the steps are drawn in. */
  const tools = new Map<string, ChatToolCall>(turn.tools.map((t) => [t.toolCallId, t]));

  for await (const event of stream) {
    switch (event.type) {
      case "delta":
        turn.text += event.text;
        sink.delta?.(event.text, turn.text);
        break;

      case "reasoning":
        sink.reasoning?.(event.text);
        break;

      case "tool": {
        /*
          MERGED ON THE WAY THROUGH, not on the way out — the wire carries two
          events per call and one record is stored, with two timestamps. A
          `completed` for a call that was never announced still creates a
          record, with `startedAt` equal to `finishedAt`: a tool that finished
          is a thing that happened, and dropping it because the first half of
          the pair went missing would lose a fact to a wire glitch.
        */
        const existing = tools.get(event.toolCallId);
        if (existing) {
          if (event.status === "completed") existing.finishedAt = event.at;
          if (!existing.label && event.label) existing.label = event.label;
          if (!existing.emoji && event.emoji) existing.emoji = event.emoji;
        } else {
          const call: ChatToolCall = {
            toolCallId: event.toolCallId,
            tool: event.tool,
            label: event.label,
            emoji: event.emoji,
            startedAt: event.at,
            finishedAt: event.status === "completed" ? event.at : null,
            /* Where in the answer this happened, so a reload draws the grey
               line where it was watched rather than at the end. */
            offset: turn.text.length,
          };
          tools.set(event.toolCallId, call);
          turn.tools.push(call);
        }
        sink.tool?.(tools.get(event.toolCallId)!, event);
        break;
      }

      case "done": {
        const soFar = turn.text;
        turn.queuedMs = event.queuedMs ?? null;
        turn.text = event.text;
        turn.model = event.model;
        turn.usage = event.usage;
        turn.ms = event.ms;
        turn.finished = true;
        /* THE GUARD, FIRST. See the header: from this line a cancel is too
           late, and the sink is told before anything else can happen. */
        sink.done?.(turn.text, soFar);
        break;
      }
    }
  }

  return turn;
}
