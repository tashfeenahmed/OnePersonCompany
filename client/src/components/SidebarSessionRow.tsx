import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarPinButton } from "@/components/SidebarPinButton";
import { ModuleIcon } from "@/components/ModuleIcon";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/store";

export function SidebarSessionRow({ session, openSessionId, streaming, pinned, handle, deleting, onTogglePin, onRename, onDelete }: {
  session: Session;
  openSessionId: string | null;
  streaming: Set<string>;
  pinned: boolean;
  handle?: ReactNode;
  deleting: boolean;
  onTogglePin: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState<string | null>(null);
  const cancelRename = useRef(false);
  const active = session.id === openSessionId;
  return <div className="flex min-w-0 flex-col">
    {title !== null ? <input
      autoFocus
      aria-label="Session title"
      value={title}
      onChange={event => setTitle(event.target.value)}
      onBlur={() => { if (!cancelRename.current) onRename(title); setTitle(null); }}
      onKeyDown={event => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") { cancelRename.current = true; setTitle(null); }
      }}
      className="bg-accent text-foreground focus:border-foreground w-full rounded-lg border border-transparent px-2 py-[5px] text-[12.5px] outline-none"
    /> : <div className={cn("sidebar-row relative flex min-w-0 items-center gap-0.5 rounded-lg pr-1 transition-colors focus-within:bg-accent focus-within:text-foreground", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
      {handle}
      <Link to={`/chat/${encodeURIComponent(session.id)}`} aria-current={active ? "page" : undefined} title={session.title}
        className={cn("flex min-w-0 flex-1 items-center gap-2 text-[12.5px] outline-none", pinned ? "py-1" : "py-1.5", handle ? "pl-0.5" : "pl-2")}
      >
        {pinned && <ModuleIcon path="/chat" />}
        <span className="truncate">{session.title}</span>
      </Link>
      {streaming.has(session.id) && <span title="Still answering" aria-label="Still answering" className="bg-foreground/60 size-1.5 shrink-0 animate-pulse rounded-full" />}
      <SidebarPinButton label={session.title} pinned={pinned} onClick={onTogglePin} />
      <DropdownMenu>
        <DropdownMenuTrigger title="Rename or delete" aria-label={`More options for ${session.title}`}
          className="sidebar-row-action grid size-6 shrink-0 place-items-center rounded-md transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        ><MoreHorizontal aria-hidden="true" className="size-3.5" strokeWidth={1.6} /></DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={() => { cancelRename.current = false; setTitle(session.title); }}><Pencil className="size-3.5" />Rename</DropdownMenuItem>
          <DropdownMenuItem disabled={deleting} onSelect={onDelete}><Trash2 className="size-3.5" />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>}
    {!!session.children?.length && <div className="border-line-soft mt-px mb-1 ml-3 flex flex-col gap-px border-l pl-2.5">
      {session.children.map(child => {
        const to = child.to ?? `/chat/${encodeURIComponent(child.id)}`;
        const here = !child.to && child.id === openSessionId;
        return <div key={child.id} className={cn("flex min-w-0 items-center gap-1 rounded-lg transition-colors focus-within:bg-accent", here ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <Link to={to} aria-current={here ? "page" : undefined} title={child.title} className="min-w-0 flex-1 truncate px-2 py-[5px] text-[12px] outline-none">{child.title}</Link>
          {child.status && <span className="mr-2 shrink-0 text-[10.5px] text-muted-foreground">{child.status}</span>}
          {streaming.has(child.id) && <span title="Still answering" aria-label="Still answering" className="bg-foreground/60 mr-2 size-1.5 shrink-0 animate-pulse rounded-full" />}
        </div>;
      })}
    </div>}
  </div>;
}
