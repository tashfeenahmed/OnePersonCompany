import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The header every page but the chat screen shares: title, one line of
 *  context, and an optional action pinned right. */
export function PageShell({
  title,
  sub,
  action,
  children,
  wide,
}: {
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
      <div
        className={cn(
          "mx-auto w-full",
          wide ? "max-w-[1040px]" : "max-w-[940px]",
        )}
      >
        <div className="mt-2 mb-6 flex items-end gap-3">
          <div>
            <h1 className="mb-1 text-[25px] font-normal tracking-[-0.025em]">
              {title}
            </h1>
            {sub && (
              <p className="text-muted-foreground text-[13.5px]">{sub}</p>
            )}
          </div>
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The slim top strip: a label on the left, actions on the right. */
export function TopBar({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-4.5">
      <span className="text-muted-foreground px-2 py-1 text-[12.5px]">
        {label}
      </span>
      {children && (
        <div className="ml-auto flex items-center gap-0.5">{children}</div>
      )}
    </header>
  );
}
