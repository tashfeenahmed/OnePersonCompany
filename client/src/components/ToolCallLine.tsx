/**
 * WHAT THE AGENT DID WHILE IT WAS WRITING, AS ONE GREY LINE.
 *
 * Hermes runs tools mid-answer — a shell command, a search — and says so on
 * the stream: one event when a call starts, one when it finishes. This draws
 * that, in the transcript, at the point it happened.
 *
 * ONE LINE, COLLAPSED, AND GREY ON PURPOSE. A tool call is not what the agent
 * SAID; it is what it did in order to be able to say it. Drawn as a card or a
 * panel it competes with the answer, and a turn that used four tools becomes a
 * screen of scaffolding with two sentences at the bottom. Grey, one line, and
 * folded is the correct weight: present, skippable, and expandable by anybody
 * who wants to know exactly what ran.
 *
 * ------------------------------------------------------------------------
 *
 * IT USED TO WEAR THREE THINGS IT HAS NOW LOST, and each of them was making
 * the same mistake from a different direction: dressing scaffolding up as
 * content.
 *
 *   THE EMOJI. The agent sends one per call and this drew it. A pictogram is
 *   the loudest thing on a line of text — brighter than the answer above it,
 *   in a colour nothing else on the page uses — so a turn with four tool calls
 *   read as four illustrations with some prose around them. The `emoji` field
 *   is still on the wire and is deliberately not rendered anywhere; nothing
 *   here decides which glyph a tool deserves, which is the other reason (a
 *   substituted icon is a claim about a tool this page has never heard of).
 *
 *   THE MONOSPACE. `terminal` set in mono says "this is a literal you could
 *   type", and it is not: it is the name of a thing that ran. Mono also sets
 *   its own colour and rhythm against the proportional text either side of it,
 *   so a line meant to sit quietly under a paragraph sat apart from it.
 *
 *   THE CHEVRON. A disclosure arrow is furniture that exists to be the target
 *   of a click — but the whole line was already the target, so the arrow was a
 *   second control for the one thing that could be done. The line itself is
 *   the toggle now and carries `aria-expanded`, which is the part that
 *   actually told a screen reader anything; the arrow never did.
 *
 * WHY A `<button>` AND NOT A DIV WITH `role="button"`. Enter and Space have to
 * work, and on a div they are a keydown handler somebody has to write, keep,
 * and get right twice (Space activates on keyup, and scrolls the page if it is
 * not prevented). The element that already does all of that is a button. The
 * only cost is undoing its display and alignment defaults, which is a line of
 * classes rather than a behaviour to maintain.
 *
 * ------------------------------------------------------------------------
 *
 * THERE IS NO OUTPUT AND THE EXPANDED VIEW DOES NOT PRETEND OTHERWISE. The
 * agent's stream carries the tool's name, a one-line label and running or
 * completed — and nothing about what came back. So opening the line shows the
 * facts that exist: both timestamps, the duration, and the call id. That is
 * everything that is known, which is the only thing an expander should ever
 * contain. An "Output" heading over an empty box would be this interface
 * inventing a gap.
 *
 * IT IS PROSE RATHER THAN A JSON BLOCK, which is the same decision the
 * collapsed line makes about mono. A `<pre>` of raw event JSON is a debugging
 * artefact: it is bordered, tinted, wider than the column, and it shouts over
 * the answer it is supposed to be a footnote to. The four fields it held are
 * written out here as four grey lines instead — the same size and the same
 * grey as the line that opened them, so the whole thing reads as one aside.
 *
 * A RUNNING CALL AND A FINISHED ONE READ DIFFERENTLY, and the difference is
 * the duration and the shimmer. "running…" is a live state, drawn as one: the
 * line's own words carry a sweep (see `.tool-shimmer` in `index.css`, which
 * falls back to a static lighter grey under `prefers-reduced-motion`).
 * "completed in 0.8s" is a fact about something that is over, and it settles
 * into the static grey. A call that is still marked running after the turn
 * ended — because the stream died mid-call — keeps saying so rather than being
 * quietly closed at the moment the connection dropped, which would be
 * inventing an end time.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatToolCall } from "@/lib/api";

/** How long it took, from the two timestamps this side stamped on receipt.
 *  Null while it is still going — and null is drawn as "running…", never as
 *  0.0s. */
function took(call: ChatToolCall): number | null {
  if (!call.finishedAt) return null;
  const ms = Date.parse(call.finishedAt) - Date.parse(call.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** A timestamp as a clock time, which is the only part of it worth reading
 *  next to a message that is on screen now. The date is in the transcript. */
function at(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

export function ToolCallLine({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const ms = took(call);
  const running = !call.finishedAt;

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          /* The transcript's own size and leading, so the line sits IN the
             answer rather than beside it. The negative margin and the matching
             extra width are what let the hover tint reach past the text
             without the line moving when it appears. */
          "text-muted-foreground -mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline rounded-[7px] px-1.5 py-0.5 text-left text-[13.5px] leading-[1.6] transition-colors",
          /* Hover and focus are the same tint, because a keyboard reaching a
             line and a pointer resting on it are the same fact about which one
             is being addressed. A RUNNING line gets a ring instead of a tint:
             `background-clip: text` clips every background this element has,
             the colour included, so a tinted rectangle would be painted inside
             the glyphs and nowhere else. A ring is a box-shadow and is not
             clipped by it. */
          running
            ? "tool-shimmer focus-visible:ring-ring focus-visible:ring-1"
            : "hover:bg-accent hover:text-foreground focus-visible:bg-accent",
        )}
      >
        {/* The name and the label are one phrase and truncate as one: the
            label is the more specific half, so a narrow column losing the end
            of it still leaves the tool that ran. */}
        <span className="min-w-0 truncate">
          {call.tool}
          {call.label && ` · ${call.label}`}
        </span>
        <span className="shrink-0">
          {" · "}
          {running
            ? "running…"
            : ms === null
              ? "completed"
              : `completed in ${(ms / 1000).toFixed(1)}s`}
        </span>
      </button>

      {open && (
        <div className="text-muted-foreground border-line-soft mt-1 ml-1.5 flex flex-col gap-0.5 border-l pl-3 text-[13.5px] leading-[1.6]">
          {/* The label again, in full and wrapped, because the line above it
              is where it was cut off — and it is the field most likely to be
              a whole command. */}
          {call.label && (
            <p className="break-words whitespace-pre-wrap">{call.label}</p>
          )}
          <p>Started {at(call.startedAt)}</p>
          <p>
            {call.finishedAt
              ? `Finished ${at(call.finishedAt)}${
                  ms === null ? "" : ` · ${(ms / 1000).toFixed(1)}s`
                }`
              : "No end reported — the call was still running when the stream ended."}
          </p>
          {/* The id is here and nowhere else. It is the only field that is of
              no use to a reader and every use to somebody matching this line
              against a log on the other side. */}
          <p className="break-all">Call {call.toolCallId}</p>
          {/* Said once, plainly, rather than left as an empty section for
              somebody to conclude is broken. */}
          <p>The stream carries no result, so there is nothing else to show.</p>
        </div>
      )}
    </div>
  );
}
