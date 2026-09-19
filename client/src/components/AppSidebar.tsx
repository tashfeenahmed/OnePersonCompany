import { useCallback, useState } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronsUpDown,
  Moon,
  Plus,
  Search,
  Sun,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useStore, type Session } from "@/lib/store";
import { useTheme, type Theme } from "@/lib/theme";
import { useRunQueue } from "@/hooks/useRunQueue";
import { useOpenAlerts } from "@/hooks/useOpenAlerts";
import { useDashboardAlerts } from "@/hooks/useDashboardAlerts";
import { AlertBadge } from "@/components/AlertBadge";
import { api } from "@/lib/api";
import { MENU, NAV } from "@/data/navigation";
import { NEW_CHAT_KEYS, SEARCH_KEYS, openSpotlight } from "@/lib/spotlight";

import { SortableList } from "@/components/SortableList";
import { SidebarPinButton } from "@/components/SidebarPinButton";
import { SidebarDashboards } from "@/components/SidebarDashboards";
import { SidebarDashboardRow } from "@/components/SidebarDashboardRow";
import { SidebarOutputs } from "@/components/SidebarOutputs";
import { orderedOutputs } from "@/data/outputs";
import { appPage } from "../../../shared/navigation";
import { SidebarSessionRow } from "@/components/SidebarSessionRow";
import { WorkspaceModelMenu } from "@/components/WorkspaceModelMenu";
import { ModuleIcon } from "@/components/ModuleIcon";
import { pinKey, sidebarPins, type SidebarPin } from "../../../shared/sidebarPins";
import { orderNav } from "../../../shared/sidebarNav";
import { sidebarPath } from "../../../shared/navigation";
import { dashboardDestination } from "../../../shared/dashboardNavigation";

const NAV_PATHS = NAV.map(item => item.to);

/** Rows above the fold: five, the owner's number. The rest are one press
 *  away, and a page dragged above the line stays there. */
const VISIBLE = 5;
const SESSION_PAGE_SIZE = 20;

export function AppSidebar({ collapsed = false, onCollapsedChange }: {
  collapsed?: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { state, renameSession, removeSession, streamingSessions, togglePinned, reorderPinned, setNavOrder } = useStore();
  const { theme, resolved, setTheme } = useTheme();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const pins = sidebarPins(state);
  const pinnedKeys = new Set(pins.map(pinKey));
  const pinnedRows = pins.flatMap(pin => {
    const label = pin.type === "page" ? NAV.find(item => item.to === pin.path)?.label
      : pin.type === "dashboard" ? state.dashboards.find(board => board.id === pin.dashboardId)?.name
      : state.sessions.find(session => session.id === pin.sessionId)?.title;
    return label ? [{ key: pinKey(pin), label, pin }] : [];
  });

  const here = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const isHere = (path: string) => {
    const mine = here(path);
    /* THE DEEPEST ROW WINS. A row is "here" for everything under it, which is
       what keeps a run page lighting the page it belongs to — but Publishing
       lives at /social/studio/publishing now, so the Studio's own row matched
       it too and two rows lit at once. A row whose path is the PREFIX of
       another row that also matches is not the one you are on. */
    return mine && !NAV_PATHS.some(other => other !== path && other.startsWith(`${path}/`) && here(other));
  };

  /* THE FOLD. The owner's order, the first VISIBLE rows showing, and the
     rest behind "See more". Arriving at a page below the fold reveals it —
     a rail that hides the page you are on is not a rail — and a manual
     toggle is kept until the next navigation, which is the same rule the
     old groups followed. */
  /* Through `sidebarPath` because the order is stored as paths and a page
     that changed address would otherwise fall out of the owner's order and
     reappear at the bottom of the list. */
  const ordered = orderNav(NAV_PATHS, state.navOrder?.map(sidebarPath));
  const below = ordered.slice(VISIBLE);
  const [more, setMore] = useState({ pathname, open: below.some(isHere) });
  if (more.pathname !== pathname) setMore({ pathname, open: more.open || below.some(isHere) });
  const navRows = (more.open ? ordered : ordered.slice(0, VISIBLE)).map(path => ({ key: path, label: NAV.find(item => item.to === path)?.label ?? path }));

  /** The chats with an answer arriving. A Set because this is looked up once
   *  per row and the rail is the one place that asks. */
  const streaming = new Set(streamingSessions);

  /**
   * WHICH CHAT IS OPEN — READ OFF THE ADDRESS, NOT OUT OF THE STORE. The URL
   * is the only copy, so a lit row and the page in front of you cannot come
   * apart. Do not add a store field for this; see `StoreState` in lib/store.tsx.
   *
   * `useMatch` rather than picking the pathname apart by hand: it decodes the
   * segment, and a session id is arbitrary text that goes through
   * `encodeURIComponent` on the way out.
   */
  const openSessionId = useMatch("/chat/:sessionId")?.params.sessionId ?? null;

  /**
   * NEW CHAT IS AN ADDRESS NOW, WHICH IS WHAT FINALLY MADE IT HONEST.
   *
   * It was a `<Link to="/">` once, and that was a real bug: `/` and the chat
   * being read were the same address, so the router matched the same route,
   * rendered the same component, and the store still named the same active
   * session — the "new" chat opened with the last conversation in it. The fix
   * at the time was to clear `activeSessionId` first. With the session in the
   * URL there is nothing to clear: `/` names no conversation, so arriving
   * there IS the empty composer, and the row in the rail is still created by
   * the first message and named after it.
   *
   * The keys for it — ⌃N, and ⌘N where a browser lets it through — are bound
   * in components/Spotlight.tsx, beside ⌘K, which was this button's shortcut
   * until search took it. One place listens to the keyboard.
   *
   * IT DOES NOT TOUCH ANYTHING IN FLIGHT. An answer being written belongs to
   * its own session and goes on arriving — the mark stays on its row here, and
   * pressing New chat while one is streaming is how you ask a second question,
   * not how you cancel the first.
   */
  const newChat = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Delete the transcript first; only a successful response removes its row and pin.
  async function deleteSession(id: string, title: string) {
    if (deleting || !confirm(`Delete “${title}”? The conversation goes with it.`)) return;
    setDeleting(id); setDeleteError(null);
    try { await api.deleteChatSession(id); removeSession(id); if (id === openSessionId) navigate("/"); }
    catch (e) { setDeleteError(e instanceof Error ? e.message : String(e)); }
    finally { setDeleting(null); }
  }

  /* THE BADGE IS THE QUEUE, NOT A ROSTER. It used to count `running: true`
     out of a hand-written list of workers, which meant the rail said two runs
     were in flight on a box that had never started one. `undefined` rather
     than 0 when nothing is moving: no badge is the honest drawing of "nothing
     to report", where a grey 0 is a number somebody has to read. */
  const queue = useRunQueue();

  /* HOW MANY ALERTS ARE OPEN — a trip or an unreadable nobody has
     acknowledged. `undefined` when there are none, and `undefined` when the
     API could not be asked: no badge is the honest drawing of "nothing to
     report", where a 0 drawn because the fetch failed would be a claim that
     nothing is wrong made by a page that never found out. */
  const openAlerts = useOpenAlerts();
  const dashboardAlerts=useDashboardAlerts();

  const counts: Record<string, number | undefined> = {
    "/ventures": state.ventures.length,
    "/subagents": queue.running + queue.queued || undefined,
    "/alerts": openAlerts,
  };

  // Search the full history before limiting the rows shown in the sidebar.
  const matchingSessions = state.sessions.filter(session => {
    const query = search.trim().toLowerCase();
    if (!query) return !pinnedKeys.has(pinKey({ type: "session", sessionId: session.id }));
    return `${session.title} ${state.ventures.find(venture => venture.id === session.ventureId)?.name ?? ""}`.toLowerCase().includes(query);
  });
  const visibleSessions = matchingSessions.slice(0, sessionLimit);
  const remainingSessions = matchingSessions.length - visibleSessions.length;

  function renderPage(path: string, accordion = false) {
    const item = NAV.find(item => item.to === path);
    if (!item) return null;
    const { label } = item;
    const active = isHere(path);
    const pin: SidebarPin = { type: "page", path };
    if (path === "/dashboards" && accordion) return <SidebarDashboards pinned={pinnedKeys.has(pinKey(pin))} onTogglePin={() => togglePinned(pin)} />;
    if (path === "/outputs" && accordion) return <SidebarOutputs pinned={pinnedKeys.has(pinKey(pin))} onTogglePin={() => togglePinned(pin)} />;
    return <div className={cn("sidebar-row flex min-w-0 items-center gap-0.5 rounded-lg pr-1 transition-colors focus-within:bg-accent", active ? "bg-accent font-medium" : "hover:bg-accent")}>
      <Link to={path} aria-current={active ? "page" : undefined} title={label} draggable={false}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1.5 text-[13.5px] outline-none"
      >
        <ModuleIcon path={path} />
        <span className="truncate">{label}</span>
        {path==="/dashboards" && <AlertBadge summary={dashboardAlerts.total} stale={!!dashboardAlerts.error} className="ml-auto"/>}
        {counts[path] !== undefined && <span className="ml-auto text-xs text-muted-foreground">{counts[path]}</span>}
      </Link>
      <SidebarPinButton label={label} pinned={pinnedKeys.has(pinKey(pin))} onClick={() => togglePinned(pin)} />
    </div>;
  }

  function renderSession(session: Session) {
    const pin: SidebarPin = { type: "session", sessionId: session.id };
    return <SidebarSessionRow
      session={session} openSessionId={openSessionId} streaming={streaming}
      pinned={pinnedKeys.has(pinKey(pin))} deleting={!!deleting}
      onTogglePin={() => togglePinned(pin)} onRename={title => renameSession(session.id, title)}
      onDelete={() => void deleteSession(session.id, session.title)}
    />;
  }

  function renderCompactPage(path: string) {
    const item = NAV.find(item => item.to === path);
    if (!item) return null;
    const active = isHere(path);
    const label = item.label;
    const className = cn("relative flex size-10 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground");
    const hasAlert = path === "/dashboards" && (dashboardAlerts.total.count > 0 || dashboardAlerts.error);
    const contents = <>
      <ModuleIcon path={path} className="size-[18px]" />
      {(hasAlert || (path === "/subagents" && counts[path])) && <span aria-hidden="true" className={cn("absolute right-1.5 top-1.5 size-1.5 rounded-full", hasAlert ? "bg-warn" : "bg-primary")} />}
    </>;
    if (path === "/dashboards") return <DropdownMenu key={path}>
      <Tooltip><TooltipTrigger asChild><DropdownMenuTrigger aria-label={label} className={className}>{contents}</DropdownMenuTrigger></TooltipTrigger><TooltipContent side="right" sideOffset={8}>{label}</TooltipContent></Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={12} className="max-h-[min(70vh,600px)] w-60 overflow-y-auto">
        <DropdownMenuLabel>Dashboards</DropdownMenuLabel>
        {state.dashboards.filter(board => !board.ventureId).map(board => {
          const to = dashboardDestination(board, state.ventures);
          return to && <DropdownMenuItem key={board.id} asChild><Link to={to} aria-current={pathname === to ? "page" : undefined} className={cn(pathname === to && "bg-accent")}>
            <span className="min-w-0 flex-1 truncate">{board.name}</span>
            {dashboardAlerts.byBoard[board.id] && <AlertBadge summary={dashboardAlerts.byBoard[board.id]} stale={!!dashboardAlerts.error} />}
          </Link></DropdownMenuItem>;
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/dashboards/new"><Plus className="size-4" />New dashboard</Link></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>;
    /* The same fly-out Dashboards has, for the same reason: a collapsed rail
       cannot unfold, and a row that opens onto nine pages needs somewhere to
       list them. */
    if (path === "/outputs") return <DropdownMenu key={path}>
      <Tooltip><TooltipTrigger asChild><DropdownMenuTrigger aria-label={label} className={className}>{contents}</DropdownMenuTrigger></TooltipTrigger><TooltipContent side="right" sideOffset={8}>{label}</TooltipContent></Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={12} className="max-h-[min(70vh,600px)] w-60 overflow-y-auto">
        <DropdownMenuLabel>Outputs</DropdownMenuLabel>
        {orderedOutputs(state.appOrder).map(output => {
          const to = appPage(output.slug);
          const on = pathname === to || pathname.startsWith(`${to}/`);
          return <DropdownMenuItem key={output.slug} asChild><Link to={to} aria-current={on ? "page" : undefined} className={cn(on && "bg-accent")}>
            <output.icon className="size-4" strokeWidth={1.6} />
            <span className="min-w-0 flex-1 truncate">{output.name}</span>
          </Link></DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>;
    return <Tooltip key={path}><TooltipTrigger asChild><Link to={path} aria-label={label} aria-current={active ? "page" : undefined} className={className}>{contents}</Link></TooltipTrigger><TooltipContent side="right" sideOffset={8}>{label}{counts[path] ? ` · ${counts[path]}` : ""}</TooltipContent></Tooltip>;
  }

  return (
    <aside aria-label="Main navigation" data-collapsed={collapsed} className={cn("app-sidebar bg-sidebar border-sidebar-border flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r pt-3.5 pb-2.5", collapsed ? "w-16 px-2" : "w-[252px] px-2.5")}>
      <div className="relative flex min-h-11 items-start px-1 pb-3.5">
        <div aria-hidden={collapsed || undefined} className="sidebar-brand sidebar-detail flex h-7 min-w-0 flex-1 items-center gap-2 pr-9"><div className="bg-primary text-primary-foreground grid size-[22px] shrink-0 place-items-center rounded-[9px] text-[12px] font-semibold tracking-tight">
          1
        </div>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium tracking-tight">
          One Person Company
        </span></div>
        <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs"
          className={cn("sidebar-collapse-button absolute top-0 hidden shrink-0 text-muted-foreground md:inline-flex", collapsed ? "left-1/2 -translate-x-1/2" : "right-1")}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed} aria-controls="app-sidebar-content"
          onClick={() => onCollapsedChange(!collapsed)}>
          <span aria-hidden="true" className="sidebar-collapse-mark bg-primary text-primary-foreground absolute grid size-[22px] place-items-center rounded-[9px] text-[12px] font-semibold">1</span>
          <ChevronLeft aria-hidden="true" className="sidebar-collapse-icon size-[18px]" strokeWidth={1.75} />
        </Button></TooltipTrigger><TooltipContent side={collapsed ? "right" : "bottom"}>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent></Tooltip>
      </div>

      <Tooltip><TooltipTrigger asChild>
      <Button
        onClick={newChat}
        aria-label="New chat" aria-keyshortcuts="Control+N Meta+N"
        className={cn("sidebar-new-chat mb-1.5 h-10 overflow-hidden text-[13.5px]", collapsed ? "mx-auto w-10 justify-center gap-0 p-0" : "w-full justify-start gap-2.5 px-3")}
      >
        <Plus className="size-[14px]" strokeWidth={2} />
        {!collapsed && <><span className="sidebar-detail min-w-0 flex-1 text-left">New chat</span>
        <span aria-hidden="true" className="sidebar-detail ml-auto font-mono text-[11.5px] opacity-55">{NEW_CHAT_KEYS}</span></>}
      </Button>
      </TooltipTrigger>{collapsed && <TooltipContent side="right" sideOffset={8}>New chat · {NEW_CHAT_KEYS}</TooltipContent>}</Tooltip>

      {/* SEARCH IS EVERYTHING, NOT THE SESSION FILTER BELOW. That field narrows
          the rail's own list by title; this opens the palette over chats,
          cards, reports, ventures and pages — see components/Spotlight.tsx. */}
      <Tooltip><TooltipTrigger asChild>
      <Button
        type="button" variant="ghost" onClick={openSpotlight}
        aria-label="Search" aria-keyshortcuts="Meta+K Control+K"
        className={cn("mb-3 h-9 overflow-hidden text-[13.5px] font-normal text-muted-foreground", collapsed ? "mx-auto w-10 justify-center gap-0 p-0" : "w-full justify-start gap-2.5 px-3")}
      >
        <Search className="size-[14px]" strokeWidth={1.8} />
        {!collapsed && <><span className="sidebar-detail min-w-0 flex-1 text-left">Search</span>
        <span aria-hidden="true" className="sidebar-detail ml-auto font-mono text-[11.5px] opacity-70">{SEARCH_KEYS}</span></>}
      </Button>
      </TooltipTrigger>{collapsed && <TooltipContent side="right" sideOffset={8}>Search · {SEARCH_KEYS}</TooltipContent>}</Tooltip>

      <ScrollArea id="app-sidebar-content" data-sidebar-scroll className="-mx-1 min-h-0 flex-1 px-1 [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
      <div key={collapsed ? "compact" : "expanded"} className="sidebar-content-enter">
      {collapsed ? <>
        <nav aria-label="Workspace" className="flex flex-col items-center gap-1">{ordered.map(renderCompactPage)}</nav>
      </> : <>
      {/* Only when there is something pinned: an empty heading with a hint
          under it is a section asking to be used, and the pin on every row
          already says how. */}
      {pinnedRows.length > 0 && <section aria-label="Pinned" className="mb-2 border-b border-line-soft pb-2">
        <h2 className="px-2 py-2 text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Pinned</h2>
        <SortableList items={pinnedRows} onReorder={reorderPinned} describedAs="pin" renderItem={item => {
          if (item.pin.type === "page") return renderPage(item.pin.path);
          if (item.pin.type === "dashboard") {
            const board = state.dashboards.find(board => item.pin.type === "dashboard" && board.id === item.pin.dashboardId);
            return board ? <SidebarDashboardRow board={board} /> : null;
          }
          const session = state.sessions.find(session => item.pin.type === "session" && session.id === item.pin.sessionId);
          return session ? renderSession(session) : null;
        }} />
      </section>}
      {deleteError && <p role="alert" className="p-2 text-xs text-destructive">Could not delete: {deleteError}</p>}
      <nav aria-label="Workspace">
        {/* A reorder while folded only names the rows above the fold; the
            ones below keep their order behind it. */}
        <SortableList items={navRows} describedAs="page" renderItem={item => renderPage(item.key, true)}
          onReorder={keys => setNavOrder([...keys, ...ordered.filter(path => !keys.includes(path))])} />
        {below.length > 0 && <button
          type="button"
          aria-expanded={more.open}
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg py-1 pl-1.5 pr-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setMore({ pathname, open: !more.open })}
        >
          <ChevronDown aria-hidden="true" className={cn("sidebar-more-chevron ml-1 size-3.5 shrink-0", more.open && "open")} strokeWidth={1.75} />
          {more.open ? "See less" : `See more (${below.length})`}
        </button>}
      </nav>

      <section aria-label="Sessions" className="border-line-soft mt-3.5 border-t pt-3 pb-3">
        <div className="flex items-center justify-between px-2 pb-0.5">
          <span className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            Sessions
          </span>
          <button
            className="text-muted-foreground hover:bg-accent hover:text-foreground grid place-items-center rounded-[9px] p-1"
            title="Search sessions"
            onClick={() => { setSearching(v => !v); setSearch(""); setSessionLimit(SESSION_PAGE_SIZE); }}
            aria-expanded={searching}
          >
            <Search className="size-3.5" strokeWidth={1.6} />
          </button>
        </div>

        {searching && <input autoFocus aria-label="Search sessions" placeholder="Search by title or venture…" value={search} onChange={e => { setSearch(e.target.value); setSessionLimit(SESSION_PAGE_SIZE); }} className="m-1 w-[95%] rounded border p-2 text-sm" />}
        <div id="sidebar-session-list" className="flex flex-col gap-px pt-1">
          {!visibleSessions.length && <p className="px-2 py-1.5 text-[12.5px] leading-relaxed text-muted-foreground" role="status">
            {search.trim() ? "No matching sessions." : state.sessions.length ? "All sessions are pinned above." : "No conversations yet. Start a chat to see it here."}
          </p>}
          {visibleSessions.map(session => <div key={session.id}>{renderSession(session)}</div>)}
        </div>
        {remainingSessions > 0 && <button
          type="button"
          aria-controls="sidebar-session-list"
          aria-label={`Show ${Math.min(SESSION_PAGE_SIZE, remainingSessions)} more sessions`}
          onClick={() => setSessionLimit(limit => limit + SESSION_PAGE_SIZE)}
          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
          Show more
        </button>}
      </section>
      </>}
      </div>
      </ScrollArea>

      {/* The whole row is the trigger — the standalone theme button moved into
          Appearance, so there is one place a preference is changed. */}
      <div className="border-line-soft shrink-0 border-t pt-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`${state.workspace.owner} · Workspace menu`} title={collapsed ? `${state.workspace.owner} · Workspace menu` : undefined} className={cn("text-muted-foreground hover:bg-accent data-[state=open]:bg-accent flex w-full items-center rounded-lg py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", collapsed ? "justify-center px-0" : "gap-2.5 px-2")}>
            <div className="bg-muted text-foreground grid size-[22px] shrink-0 place-items-center rounded-full text-[11.5px] font-semibold">
              {state.workspace.owner.trim()[0]?.toUpperCase() ?? "?"}
            </div>
            {!collapsed && <><div className="min-w-0">
              <div className="text-foreground truncate text-[13.5px]">
                {state.workspace.owner}
              </div>
              <div className="truncate text-[12px]">{state.workspace.name}</div>
            </div>
            <ChevronsUpDown
              className="ml-auto size-[13px] shrink-0"
              strokeWidth={1.6}
            />
            </>}
          </DropdownMenuTrigger>

          <DropdownMenuContent side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} sideOffset={collapsed ? 12 : 4} className="w-[232px]">
            <DropdownMenuLabel className="font-normal">
              <div className="text-[13.5px]">{state.workspace.owner}</div>
              <div className="text-muted-foreground text-[12px]">
                {state.workspace.name} · 1 seat
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <Link to="/settings">
                <ModuleIcon path="/settings" className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>

            {MENU.map(item => (
              <DropdownMenuItem key={item.to} asChild>
                <Link to={item.to}>
                  <ModuleIcon path={item.to} className="size-4" />
                  {item.label}
                  {counts[item.to] !== undefined && (
                    <span className="text-muted-foreground ml-auto text-xs">{counts[item.to]}</span>
                  )}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />

            <WorkspaceModelMenu />
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
