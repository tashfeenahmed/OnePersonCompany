import { useState } from "react";
import { Eye, Loader2, ScanEye } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";
import { seoopsApi } from "@/lib/api/seoops";

/**
 * WHAT A MODEL SEES — kept in its own block under the measured checks, and
 * never in the same table.
 *
 * The Shots QA table above is arithmetic: a variance over the PNG's pixels, a
 * pair of dimensions, a title matched against a list of error wordings. It can
 * be wrong about a page and it cannot be wrong about what it measured. What is
 * below is an opinion. Drawing them in one row of dots would make the second
 * look like more of the first, so this is a separate section with its own
 * words — ok, broken, unsure — and its own reminder of what it is.
 *
 * THREE STATES FOR THE CAPABILITY AND THE MIDDLE ONE IS THE POINT. `true` is
 * "images accepted", `false` is "the model refused an image", and `null` is
 * "the probe did not complete, so nothing is known either way". A page that
 * drew null as "not supported" would send the owner off to change a model that
 * was never the problem.
 */
const TONE: Record<string, string> = {
  ok: "bg-ok-bg text-ok",
  broken: "bg-destructive/15 text-destructive",
  unsure: "bg-warn/15 text-warn",
};

export function VisualQaSection() {
  const doc = useApi(() => seoopsApi.vision(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, key: string) {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
      doc.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (doc.error)
    return <p className="text-muted-foreground mt-6 text-[13.5px]">Visual QA is not answering: {doc.error}</p>;
  if (!doc.data) return null;
  const d = doc.data;
  const opted = d.ventures.filter((v) => v.optedIn);
  const judged = d.ventures.filter((v) => v.verdict);

  return (
    <div className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Visual verdicts — a model, not a measurement
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "probe"}
            onClick={() => void act(() => seoopsApi.probe(), "probe")}
          >
            {busy === "probe" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <ScanEye className="size-3.5" strokeWidth={1.8} />
            )}
            Probe for image input
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "run" || !opted.length}
            onClick={() => void act(() => seoopsApi.runVision(), "run")}
          >
            {busy === "run" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Eye className="size-3.5" strokeWidth={1.8} />
            )}
            Look at {opted.length} opted-in venture{opted.length === 1 ? "" : "s"}
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground mb-3 max-w-[760px] text-[13px] leading-relaxed">
        <span
          className={cn(
            "mr-1.5 rounded-full px-1.5 py-px text-[12px]",
            d.capability.supportsImages === true
              ? "bg-ok-bg text-ok"
              : d.capability.supportsImages === false
                ? "bg-destructive/15 text-destructive"
                : "border border-dashed",
          )}
        >
          {d.capability.supportsImages === true
            ? "images accepted"
            : d.capability.supportsImages === false
              ? "images refused"
              : "not known either way"}
        </span>
        {d.capability.detail}
        {d.capability.probedAt && <span className="opacity-70"> Probed {ago(d.capability.probedAt)}.</span>}
      </p>

      {problem && <p className="text-destructive mb-3 text-[13.5px]">{problem}</p>}

      {!opted.length ? (
        <p className="text-muted-foreground text-[13.5px]">
          No venture is opted in, so nothing is looked at and nothing is spent. Add slugs to “Vision ventures” under
          Integrations → SEO Ops.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[14px] border">
          {opted.map((v, i) => (
            <div
              key={v.ventureId}
              className={cn("px-3.5 py-2.5 text-[13.5px]", i > 0 && "border-line-soft border-t")}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {v.verdict ? (
                  <span className={cn("rounded-full px-1.5 py-px text-[12px]", TONE[v.verdict])}>{v.verdict}</span>
                ) : (
                  <span className="text-muted-foreground rounded-full border border-dashed px-1.5 py-px text-[12px]">
                    not judged
                  </span>
                )}
                <span className="font-medium">{v.venture}</span>
                <span className="text-muted-foreground ml-auto text-[12.5px]">
                  {v.shotTs ? `about the capture of ${ago(v.shotTs)}` : "no capture"}
                  {v.model ? ` · ${v.model}` : ""}
                </span>
              </div>
              {v.issues.map((issue) => (
                <div key={`${issue.kind}-${issue.where}`} className="mt-1 text-[13px]">
                  <span className="font-medium">{issue.kind}</span>{" "}
                  <span className="text-muted-foreground">
                    — {issue.where} (confidence {issue.confidence})
                  </span>
                </div>
              ))}
              {v.error && <p className="text-muted-foreground mt-1 text-[12.5px]">{v.error}</p>}
            </div>
          ))}
        </div>
      )}

      {judged.length > 0 && opted.length !== judged.length && (
        <p className="text-muted-foreground mt-2 text-[12.5px]">
          {judged.length - opted.filter((v) => v.verdict).length} venture(s) have a stored verdict but are no longer
          opted in. Their verdicts are kept and are about the capture named on each.
        </p>
      )}

      <div className="mt-3">
        {d.notes.map((n) => (
          <p key={n} className="text-muted-foreground mb-1.5 max-w-[760px] text-[12.5px] leading-relaxed">
            {n}
          </p>
        ))}
      </div>
    </div>
  );
}
