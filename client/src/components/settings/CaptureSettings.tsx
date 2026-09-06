import { useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { Section } from "@/components/settings/Section";
import { PluginSettingsForm } from "@/components/settings/PluginSettingsForm";
import { ventureApi } from "@/lib/api/ventures";
import { when } from "@/lib/format";

/**
 * SITE CAPTURE — whether this machine has a browser, and what each venture's
 * newest picture is.
 *
 * THE BROWSER IS FOUND RATHER THAN CONFIGURED, and this panel's first job is
 * to say WHICH claim is being made: "found in /Applications" and "you typed
 * this path" are different facts, and the server sends `source` so the
 * difference can be drawn. When nothing is found, the sentence explaining that
 * is the server's, because it is the same sentence a failed capture is stored
 * with.
 *
 * "CAPTURE ALL" IS ONE VENTURE AT A TIME, on purpose. There is no bulk route:
 * each capture launches Chrome, holds it for up to twenty-five seconds and
 * kills it, and firing six of those at once on a laptop is how a machine
 * becomes unusable for a minute. The row being worked on says so as it goes,
 * so the sequence is visible rather than a single spinner over a still list.
 *
 * A FAILED CAPTURE IS A ROW AND IS DRAWN AS ONE. "Never captured", "the last
 * one failed" and "captured, and it is nine days old" are three different
 * answers; `picture` is the newest one that produced a file and `last` is the
 * newest attempt of any kind, so a venture whose picture is good and whose
 * last attempt failed shows both.
 */

/** On this panel a missing timestamp really does mean never-captured — the
 *  em dash `when` defaults to would be the weaker claim. */
const NEVER = { nullText: "never" } as const;

export function CaptureSettings() {
  const doc = useApi(() => ventureApi.capture(), []);
  /** The venture currently in front of the browser, by slug. */
  const [shooting, setShooting] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const d = doc.data;

  async function shoot(slug: string) {
    setShooting(slug);
    setProblem(null);
    try {
      const res = await ventureApi.captureNow(slug);
      if (!res.ok && res.error) setProblem(res.error);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setShooting(null);
      doc.reload();
    }
  }

  async function captureAll() {
    if (!d) return;
    setAll(true);
    setProblem(null);
    /* Only the ventures that have a site. A venture with no website is a
       guaranteed failed row, and writing six of those is noise. */
    for (const v of d.ventures.filter((v) => v.website)) {
      setShooting(v.slug);
      try {
        await ventureApi.captureNow(v.slug);
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
      }
    }
    setShooting(null);
    setAll(false);
    doc.reload();
  }

  return (
    <Section
      title="Site capture"
      hint="A screenshot of each venture's own site, taken by Chrome's command line when this machine has one. A palette can be read out of CSS; what the page looks like cannot."
    >
      {doc.error && (
        <p className="text-muted-foreground text-[13.5px]">
          The API did not answer, so nothing can be said about the browser.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      )}

      {d && (
        <div className="bg-card grid gap-1 rounded-[14px] border px-4.5 py-3.5">
          <div className="text-[14px]">
            {d.browser.found
              ? d.browser.source === "configured"
                ? "Using the browser you pointed it at"
                : "Found a browser without being told where to look"
              : "No browser on this machine"}
          </div>
          {d.browser.path && (
            <p className="text-muted-foreground font-mono text-[12.5px] break-all">
              {d.browser.path}
            </p>
          )}
          <p className="text-muted-foreground text-[12.5px]">
            {d.browser.found ? d.browser.note : d.browser.error}
          </p>
          <p className="text-muted-foreground text-[12.5px]">
            A picture older than {d.refreshEveryDays} days counts as due.
          </p>
        </div>
      )}

      <div className="mt-1">
        <PluginSettingsForm
          plugin="capture"
          onSaved={() => doc.reload()}
          saveLabel="Save browser path"
        />
      </div>

      {d && d.ventures.length > 0 && (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void captureAll()}
              disabled={all || shooting !== null || !d.browser.found}
            >
              {all ? (
                <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />
              ) : (
                <Camera className="size-[15px]" strokeWidth={1.8} />
              )}
              {all ? "Capturing…" : "Capture all now"}
            </Button>
            <span className="text-muted-foreground text-[13px]">
              One at a time, each up to 25 seconds — every one launches a
              browser.
            </span>
          </div>

          {problem && (
            <p className="text-destructive text-[13.5px] leading-relaxed">
              {problem}
            </p>
          )}

          <div className="overflow-hidden rounded-[14px] border">
            {d.ventures.map((v, i) => (
              <div
                key={v.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2.5",
                  i > 0 && "border-line-soft border-t",
                )}
              >
                <span className="text-[13.5px]">{v.name}</span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12.5px]">
                  {v.website ?? "no website, so there is nothing to photograph"}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-[12.5px]",
                    v.last && !v.last.ok ? "text-warn" : "text-muted-foreground",
                  )}
                >
                  {shooting === v.slug
                    ? "capturing…"
                    : !v.last
                      ? "never captured"
                      : v.last.ok
                        ? `${when(v.last.ts, NEVER)}${v.last.width ? ` · ${v.last.width}×${v.last.height}` : ""}${v.due ? " · due" : ""}`
                        : `last attempt failed — ${v.last.error ?? "no reason given"}`}
                </span>
                {/* A picture that is good while the last attempt failed is two
                    facts, and both are worth having. */}
                {v.picture && v.last && !v.last.ok && (
                  <span className="text-muted-foreground shrink-0 text-[12.5px]">
                    the picture from {when(v.picture.ts, NEVER)} is still there
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!v.website || shooting !== null || !d.browser.found}
                  onClick={() => void shoot(v.slug)}
                >
                  Capture
                </Button>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-[12.5px]">
            The pictures themselves are on each venture's own page, beside the
            brand reading they belong with.
          </p>
        </>
      )}
    </Section>
  );
}
