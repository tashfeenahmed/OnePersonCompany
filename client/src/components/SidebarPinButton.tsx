import { Pin, PinOff } from "lucide-react";

export function SidebarPinButton({ label, pinned, onClick }: { label: string; pinned: boolean; onClick: () => void }) {
  const Icon = pinned ? PinOff : Pin;
  const action = `${pinned ? "Unpin" : "Pin"} ${label}`;
  return <button
    type="button"
    title={action}
    aria-label={action}
    aria-pressed={pinned}
    onClick={onClick}
    className="sidebar-row-action grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
  </button>;
}
