import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { runtimeApi } from "@/lib/api/runtime";
import { cn } from "@/lib/utils";

/**
 * WHAT THIS CONNECTION ACTUALLY GIVES YOU — text, or tools.
 *
 * WHY THIS SENTENCE HAS TO BE ON THIS PAGE. Connecting a model key used to
 * give a chat that could talk and could not look anything up, and nothing said
 * so: the owner pasted a key, asked "what did Stripe collect last week", and
 * got a confident answer assembled out of the model's own head. The gap
 * analysis called that out as its own row. Half the fix is the tool loop; the
 * other half is this line, because a model that CANNOT call tools still exists
 * and an owner is entitled to know which one they have before they trust an
 * answer.
 *
 * IT IS A MEASUREMENT, NOT A CLAIM ABOUT THE PROVIDER. "OpenAI supports
 * function calling" is true of the company and useless about the model behind
 * a router. So the page prints what a probe found, when, and says "not
 * measured" when there has been none — never the flattering guess.
 *
 * THE THIRD STATE IS NOT A VERDICT. A probe that could not be run (endpoint
 * down, key refused) says so and offers the button again. Drawing that as
 * "text-only" would blame a model for a network.
 */
const TONE: Record<string, string> = {
  tools: "bg-ok",
  text: "bg-warn",
  error: "bg-muted-foreground",
};

const WORD: Record<string, string> = {
  tools: "Tools",
  text: "Text only",
  error: "Not measured",
};

export function ToolModeNote() {
  const doc = useApi(() => runtimeApi.tools(), []);
  const { reload } = doc;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (doc.error || !doc.data) return null;
  const d = doc.data;
  const mode = d.mode ?? null;

  async function measure() {
    setBusy(true);
    setProblem(null);
    try {
      await runtimeApi.probe();
      reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border-line-soft mt-3 rounded-[14px] border p-4.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn("size-[7px] rounded-[3px]", mode ? TONE[mode] : "bg-muted-foreground")}
          aria-hidden
        />
        <span className="text-[14px] font-medium">
          What this connection gives: {mode ? WORD[mode] : "not measured"}
        </span>
        {d.stale && (
          <span className="text-muted-foreground text-[12.5px]">measured over a week ago</span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={busy || !d.provider}
          onClick={() => void measure()}
        >
          {busy ? "Checking…" : mode ? "Check again" : "Check now"}
        </Button>
      </div>

      <p className="text-muted-foreground mt-2 text-[13.5px]">{d.why}</p>

      {d.detail && <p className="text-muted-foreground mt-1 text-[12.5px]">{d.detail}</p>}
      {problem && <p className="text-destructive mt-1 text-[12.5px]">{problem}</p>}

      <p className="text-muted-foreground mt-2 text-[12.5px]">
        {d.model ? `Measured for ${d.provider} · ${d.model}` : "No model named on this provider"}
        {d.measuredAt ? ` · ${d.measuredAt.slice(0, 16).replace("T", " ")} UTC` : ""}
        {" · "}
        {d.settings.tools
          ? `at most ${d.settings.maxToolCalls} tool calls and ${d.settings.toolSeconds}s per turn, ` +
            (d.settings.actions ? "writes allowed (irreversible actions refused)" : "reads only")
          : "tool use switched off"}
        {" · "}
        <Link className="underline" to="/plugins/runtime">
          change
        </Link>
      </p>
    </div>
  );
}
