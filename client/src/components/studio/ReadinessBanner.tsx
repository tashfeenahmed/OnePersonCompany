import { Link } from "react-router-dom";
import { CircleCheck, CircleSlash } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudioReadiness } from "@/lib/api/studio";

/**
 * WHETHER A POST CAN BE MADE, SAID BEFORE THE BUTTON IS PRESSED.
 *
 * The image half costs money and the caption half is the half without which
 * there is no post at all, so both are stated up front with the server's own
 * sentences. This is the whole reason `GET /api/studio` exists: an app that
 * discovered "Replicate is not connected" after twenty seconds of spinner
 * would have taught the owner to distrust the button.
 *
 * IT IS NOT A WARNING BAR. Both halves ready is the normal case and is drawn
 * as two quiet lines of fact, not as a green success banner — the state worth
 * shouting is the missing one, and only that one gets a link to go fix it.
 * The caption half's link is Settings, because that is where this app chooses
 * a provider; the image half's is Replicate's own page under Integrations,
 * because that is where the token is pasted.
 */
export function ReadinessBanner({ readiness }: { readiness: StudioReadiness }) {
  const rows: {
    key: string;
    ready: boolean;
    title: string;
    note: string;
    fix?: { to: string; label: string };
  }[] = [
    {
      key: "caption",
      ready: readiness.caption.ready,
      title: readiness.caption.ready
        ? `Words from ${readiness.caption.label ?? readiness.caption.provider}`
        : "No model provider is live",
      note: readiness.caption.note,
      fix: readiness.caption.ready
        ? undefined
        : { to: "/settings", label: "Choose a provider" },
    },
    {
      key: "image",
      ready: readiness.image.ready,
      title: readiness.image.ready
        ? `Pictures from ${readiness.image.model}${readiness.image.isDefault ? "" : " (not the default)"}`
        : "Replicate is not connected",
      note: readiness.image.note,
      fix: readiness.image.ready
        ? undefined
        : { to: "/integrations/replicate", label: "Paste a token" },
    },
  ];

  return (
    <div className="overflow-hidden rounded-[14px] border">
      {rows.map((r, i) => (
        <div
          key={r.key}
          className={cn(
            "flex items-start gap-2.5 px-3.5 py-2.5",
            i > 0 && "border-line-soft border-t",
          )}
        >
          {r.ready ? (
            <CircleCheck
              className="text-ok mt-px size-4 shrink-0"
              strokeWidth={1.7}
            />
          ) : (
            <CircleSlash
              className="text-warn mt-px size-4 shrink-0"
              strokeWidth={1.7}
            />
          )}
          <div className="min-w-0">
            <div className="text-[14px]">{r.title}</div>
            <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
              {r.note}
            </p>
          </div>
          {r.fix && (
            <Link
              to={r.fix.to}
              className="hover:bg-accent ml-auto shrink-0 rounded-lg border px-2.5 py-1 text-[13px]"
            >
              {r.fix.label}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
