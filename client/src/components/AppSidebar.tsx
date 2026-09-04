import { Link, useLocation } from "react-router-dom";
import {
  ChevronsUpDown,
  FolderClosed,
  LayoutDashboard,
  LayoutGrid,
  Moon,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { useTheme, type Theme } from "@/lib/theme";
import { SUBAGENTS } from "@/data/subagents";

const NAV = [
  { to: "/ventures", label: "Ventures", icon: FolderClosed },
  { to: "/subagents", label: "Sub-agents", icon: Workflow },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/dashboards", label: "Dashboards", icon: LayoutDashboard },
  /*
    APPS is one row and one page, the way Dashboards is: the page carries a
    tab per app and each app has its own address under it. It was briefly a
    section of the rail with one entry per app, which made a single app look
    like a whole category and would have grown the rail by a row every time
    one was added. The rail names the place; the page names what is in it.
  */
  { to: "/apps", label: "Apps", icon: LayoutGrid },
];

export function AppSidebar() {
  const { state, setActiveSession } = useStore();
  const { theme, resolved, setTheme } = useTheme();
  const { pathname } = useLocation();

  const working = SUBAGENTS.filter((a) => a.running).length;

  const counts: Record<string, number | undefined> = {
    "/ventures": state.ventures.length,
    "/dashboards": state.dashboards.length,
    "/subagents": working || undefined,
  };

  return (
    <aside className="bg-sidebar border-sidebar-border flex w-[252px] shrink-0 flex-col border-r px-2.5 pt-3.5 pb-2.5">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-3.5">
        <div className="bg-primary text-primary-foreground grid size-[22px] place-items-center rounded-[7px] text-[11px] font-semibold tracking-tight">
          1
        </div>
        <span className="text-[13.5px] font-medium tracking-tight">
          One Person Company
        </span>
      </div>

      <Button
        asChild
        className="mb-3 h-auto w-full justify-start gap-2.5 py-2 text-[12.5px]"
      >
        <Link to="/">
          <Plus className="size-[14px]" strokeWidth={2} />
          New chat
          <span className="ml-auto font-mono text-[10.5px] opacity-55">⌘K</span>
        </Link>
      </Button>

      <nav className="flex flex-col gap-px">
        {NAV.map(({ to, label, icon: Icon }) => {
          // /integrations stays lit while one integration's own page is open.
          const active = pathname === to || pathname.startsWith(`${to}/`);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors",
                active ? "bg-accent font-medium" : "hover:bg-accent",
              )}
            >
              <Icon className="size-[14px] shrink-0" strokeWidth={1.6} />
              {label}
              {counts[to] !== undefined && (
                <span className="text-muted-foreground ml-auto text-[10.5px]">
                  {counts[to]}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <ScrollArea className="border-line-soft -mx-1 mt-3.5 min-h-0 flex-1 border-t px-1 pt-3">
        <div className="bg-sidebar sticky top-0 z-10 flex items-center justify-between px-2 pb-0.5">
          <span className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
            Sessions
          </span>
          <button
            className="text-muted-foreground hover:bg-accent hover:text-foreground grid place-items-center rounded-[7px] p-1"
            title="Search sessions"
          >
            <Search className="size-3.5" strokeWidth={1.6} />
          </button>
        </div>

        {/* One flat list, newest first. Most chats are about nothing in
            particular, so nothing here is grouped and nothing carries an icon;
            the only indent is a chat that dispatched sub-agent runs. */}
        <div className="flex flex-col gap-px pt-1">
          {state.sessions.map((s) => (
            <div key={s.id} className="flex flex-col">
              <button
                onClick={() => setActiveSession(s.id)}
                aria-current={s.id === state.activeSessionId}
                className={cn(
                  "text-muted-foreground hover:bg-accent hover:text-foreground block truncate rounded-[7px] px-2 py-[5px] text-left text-[12.5px]",
                  s.id === state.activeSessionId && "bg-accent text-foreground",
                )}
              >
                {s.title}
              </button>

              {!!s.children?.length && (
                <div className="border-line-soft mt-px mb-1 ml-3 flex flex-col gap-px border-l pl-2.5">
                  {s.children.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setActiveSession(c.id)}
                      aria-current={c.id === state.activeSessionId}
                      className={cn(
                        "text-muted-foreground hover:bg-accent hover:text-foreground block truncate rounded-[7px] px-2 py-[5px] text-left text-[12px]",
                        c.id === state.activeSessionId &&
                          "bg-accent text-foreground",
                      )}
                    >
                      {c.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* The whole row is the trigger — the standalone theme button moved into
          Appearance, so there is one place a preference is changed. */}
      <div className="border-line-soft mt-auto border-t pt-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger className="text-muted-foreground hover:bg-accent data-[state=open]:bg-accent flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors">
            <div className="bg-muted text-foreground grid size-[22px] shrink-0 place-items-center rounded-full text-[10.5px] font-semibold">
              {state.workspace.owner.trim()[0]?.toUpperCase() ?? "?"}
            </div>
            <div className="min-w-0">
              <div className="text-foreground truncate text-[12.5px]">
                {state.workspace.owner}
              </div>
              <div className="truncate text-[11px]">{state.workspace.name}</div>
            </div>
            <ChevronsUpDown
              className="ml-auto size-[13px] shrink-0"
              strokeWidth={1.6}
            />
          </DropdownMenuTrigger>

          <DropdownMenuContent side="top" align="start" className="w-[232px]">
            <DropdownMenuLabel className="font-normal">
              <div className="text-[12.5px]">{state.workspace.owner}</div>
              <div className="text-muted-foreground text-[11px]">
                {state.workspace.name} · 1 seat
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <Link to="/settings">
                <SettingsIcon className="size-4" strokeWidth={1.6} />
                Settings
              </Link>
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {resolved === "dark" ? (
                  <Moon className="size-4" strokeWidth={1.6} />
                ) : (
                  <Sun className="size-4" strokeWidth={1.6} />
                )}
                Appearance
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(v) => setTheme(v as Theme)}
                >
                  <DropdownMenuRadioItem value="light">
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
