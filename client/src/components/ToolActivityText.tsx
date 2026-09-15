import type { ReactNode } from "react";

/** Keep the animated text separate from the button's hover/focus background.
 * Its clipping stays in place as steps start and finish, so no solid fill can flash. */
export function ToolActivityText({ running, children }: { running: boolean; children: ReactNode }) {
  return (
    <span className="tool-shimmer flex min-w-0 flex-1 items-baseline" data-running={running}>
      {children}
    </span>
  );
}
