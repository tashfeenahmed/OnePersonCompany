import { Link } from "react-router-dom";
import { CircleSlash } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudioReadiness } from "@/lib/api/studio";

/** Caption and image connections are independent. */
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
        ? `Pictures from ${readiness.image.label ?? readiness.image.model}`
        : `${readiness.image.label ?? readiness.image.model} · setup needed`,
      note: readiness.image.note,
      fix: readiness.image.ready
        ? undefined
        : { to: `/integrations/${readiness.image.provider ?? "openrouter"}`, label: "Connect" },
    },
  ];

  const missing = rows.filter((row) => !row.ready);
  if (!missing.length) return null;

  return (
    <div className="overflow-hidden rounded-[14px] bg-card">
      {missing.map((r, i) => (
        <div
          key={r.key}
          className={cn(
            "flex items-start gap-2.5 px-3.5 py-2.5",
            i > 0 && "border-line-soft border-t",
          )}
        >
          <CircleSlash className="text-warn mt-px size-4 shrink-0" strokeWidth={1.7} />
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
