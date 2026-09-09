import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * WHETHER THIS PAGE IS BEING DRAWN UNDER SOMEBODY ELSE'S HEADER.
 *
 * The Email shell (pages/Email.tsx) mounts five pages that each carry their
 * own PageShell title under a header that already says "Email" and which tab
 * you are on — two titles, an inch apart, saying nearly the same thing. A prop
 * would mean editing every embedded page and every page that might one day be
 * embedded; a context means the shell says it once and the pages stay exactly
 * as they are at their own addresses.
 */
const Embedded = createContext(false);

/** Draws the pages inside it without their own titles. */
export function EmbeddedPages({ children }: { children: ReactNode }) {
  return <Embedded.Provider value={true}>{children}</Embedded.Provider>;
}

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
  const embedded = useContext(Embedded);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-3 pb-20">
      <div
        className={cn(
          "mx-auto w-full",
          wide ? "max-w-[1040px]" : "max-w-[940px]",
        )}
      >
        {/* EMBEDDED KEEPS THE ACTION AND DROPS THE WORDS. The title and the
            sub are what the shell above already says; the action — Score new
            mail, and whatever the next page brings — is the page's own control
            and has nowhere else to go, so it gets a slim row of its own. */}
        {embedded ? (
          action && <div className="mt-3 mb-4 flex justify-end">{action}</div>
        ) : (
          <div className="mt-3 mb-8 flex items-end gap-4">
            <div>
              <h1 className="mb-1.5 text-[27px] font-normal tracking-[-0.025em]">
                {title}
              </h1>
              {sub && (
                <p className="text-muted-foreground text-[14.5px]">{sub}</p>
              )}
            </div>
            {action && <div className="ml-auto shrink-0">{action}</div>}
          </div>
        )}
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
      <span className="text-muted-foreground px-2 py-1 text-[13.5px]">
        {label}
      </span>
      {children && (
        <div className="ml-auto flex items-center gap-0.5">{children}</div>
      )}
    </header>
  );
}
