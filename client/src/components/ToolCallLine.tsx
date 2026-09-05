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
 * THERE IS NO OUTPUT AND THE EXPANDED VIEW DOES NOT PRETEND OTHERWISE. The
 * agent's stream carries the tool's name, a one-line label and running or
 * completed — and nothing about what came back. So the chevron opens onto the
 * event itself: the raw record, both timestamps, the call id. That is
 * everything that is known, which is the only thing an expander should ever
 * contain. A "Output" heading over an empty box would be this interface
 * inventing a gap.
 *
 * A RUNNING CALL AND A FINISHED ONE READ DIFFERENTLY, and the difference is
 * the duration. "running…" is a live state and is drawn as one; "completed in
 * 0.8s" is a fact about something that is over. A call that is still marked
 * running after the turn ended — because the stream died mid-call — keeps
 * saying so rather than being quietly closed at the moment the connection
 * dropped, which would be inventing an end time.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
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

export function ToolCallLine({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const ms = took(call);

  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:bg-accent hover:text-foreground -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-[7px] px-1.5 py-1 text-left text-[12px] transition-colors"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          strokeWidth={1.8}
        />
        {/* The agent's own emoji when it sent one. Omitted rather than
            substituted when it did not — a made-up icon is a claim about a
            tool this page has never heard of. */}
        {call.emoji && <span className="shrink-0">{call.emoji}</span>}
        <span className="font-mono">{call.tool}</span>
        {call.label && (
          <>
            <span className="opacity-50">·</span>
            <span className="truncate font-mono opacity-80">{call.label}</span>
          </>
        )}
        <span className="opacity-50">·</span>
        <span className="shrink-0">
          {call.finishedAt
            ? ms === null
              ? "completed"
              : `completed in ${(ms / 1000).toFixed(1)}s`
            : "running…"}
        </span>
      </button>

      {open && (
        /*
          THE RAW EVENT, AS JSON. Not a table of prettied-up fields: this is a
          debugging view, and the thing somebody opening it wants is exactly
          what arrived, in a shape they can paste somewhere. Prettifying it
          would mean deciding which fields matter, which is the decision the
          collapsed line already made.
        */
        <pre className="border-line-soft bg-muted/40 text-muted-foreground mt-1 ml-4 overflow-x-auto rounded-[8px] border px-3 py-2 font-mono text-[11px] leading-[1.5]">
          {JSON.stringify(call, null, 2)}
        </pre>
      )}
    </div>
  );
}
