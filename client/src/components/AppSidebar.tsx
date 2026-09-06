import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router-dom";
import {
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
import { cn } from "@/lib/utils";
import { useStore, type Session } from "@/lib/store";
import { useTheme, type Theme } from "@/lib/theme";
import { useRunQueue } from "@/hooks/useRunQueue";
import { useOpenAlerts } from "@/hooks/useOpenAlerts";
import { api } from "@/lib/api";
import { GROWTH_PAGES, MAIL_PAGES, SOCIAL_PAGES } from "@/data/navigation";

import { SidebarSection } from "@/components/SidebarSection";
import { PinnedSection } from "@/components/PinnedSection";
import { SidebarPinButton } from "@/components/SidebarPinButton";
import { SidebarSessionRow } from "@/components/SidebarSessionRow";
import { ModuleIcon } from "@/components/ModuleIcon";
import { pinKey, sidebarPins, type SidebarPin } from "../../../shared/sidebarPins";

const NAV = [
  { to: "/action-inbox", label: "Action inbox" },
  { to: "/board", label: "Board" },
  { to: "/journal", label: "Journal" },
  { to: "/outputs", label: "Sub-agent outputs" },
  /* The rail's order: the business (ventures, its workers, the org), what
     is happening (activity, alerts, people), what runs on its own (workflows),
     then the machinery (integrations, dashboards, apps). */
  { to: "/ventures", label: "Ventures" },
  { to: "/subagents", label: "Sub-agents" },
  { to: "/org", label: "Org chart" },
  { to: "/activity", label: "Activity" },
  { to: "/customers", label: "Customers" },
  { to: "/alerts", label: "Alerts" },
  { to: "/people", label: "People" },
  { to: "/workflows", label: "Workflows" },
  { to: "/integrations", label: "Integrations" },
  { to: "/dashboards", label: "Dashboards" },
  { to: "/ops", label: "Ops" },
  ...MAIL_PAGES,
  ...SOCIAL_PAGES,
  ...GROWTH_PAGES,
];

const NAV_GROUPS = [
  { name: "Work", paths: ["/action-inbox", "/board", "/journal", "/outputs", "/ventures", "/people", "/workflows"], expanded: true },
  { name: "Mail", paths: MAIL_PAGES.map(page => page.to), expanded: true },
  { name: "Social media", paths: SOCIAL_PAGES.map(page => page.to), expanded: true },
  { name: "SEO & growth", paths: GROWTH_PAGES.map(page => page.to), expanded: true },
  { name: "Insights", paths: ["/activity", "/customers", "/alerts", "/dashboards"], expanded: false },
  { name: "Manage", paths: ["/subagents", "/org", "/integrations", "/ops"], expanded: false },
];

export function AppSidebar() {
  const { state, renameSession, removeSession, streamingSessions, togglePinned, reorderPinned } = useStore();
  const { theme, resolved, setTheme } = useTheme();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const pins = sidebarPins(state);
  const pinnedKeys = new Set(pins.map(pinKey));
  const pinnedRows = pins.flatMap(pin => {
    const label = pin.type === "page" ? NAV.find(item => item.to === pin.path)?.label
      : state.sessions.find(session => session.id === pin.sessionId)?.title;
    return label ? [{ key: pinKey(pin), label, pin }] : [];
  });

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
   * It stays a `navigate` rather than reverting to a Link because ⌘K binds to
   * the same action below, and one function is one behaviour.
   *
   * IT DOES NOT TOUCH ANYTHING IN FLIGHT. An answer being written belongs to
   * its own session and goes on arriving — the mark stays on its row here, and
   * pressing New chat while one is streaming is how you ask a second question,
   * not how you cancel the first.
   */
  const newChat = useCallback(() => {
    navigate("/");
  }, [navigate]);

  /**
   * ⌘K, WHICH THIS BUTTON HAS BEEN PROMISING SINCE THE PROTOTYPE.
   *
   * The shortcut was printed on the button and bound to nothing: the label
   * said one thing and the keyboard did another, which is worse than no label
   * at all. It is bound here, beside the control it describes, rather than in
   * a global key-handling layer this app does not have.
   *
   * `preventDefault` because ⌘K is the browser's own — a search field in
   * Firefox, the address bar in Chrome — and a shortcut that opens a new chat
   * AND hijacks the URL bar is not a shortcut. Ctrl is taken beside Meta so
   * the same key works on the other two platforms. It deliberately fires from
   * inside the composer as well: reaching for a new chat with your hands
   * already in a text field is the case it exists for.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k") return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      newChat();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
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

  const counts: Record<string, number | undefined> = {
    "/ventures": state.ventures.length,
    "/dashboards": state.dashboards.length + 1,
    "/subagents": queue.running + queue.queued || undefined,
    "/alerts": openAlerts,
  };

  const visibleSessions = state.sessions.filter(session => {
    const query = search.trim().toLowerCase();
    if (!query) return !pinnedKeys.has(pinKey({ type: "session", sessionId: session.id }));
    return `${session.title} ${state.ventures.find(venture => venture.id === session.ventureId)?.name ?? ""}`.toLowerCase().includes(query);
  });

  function renderPage(path: string, handle?: ReactNode) {
    const item = NAV.find(item => item.to === path);
    if (!item) return null;
    const { label } = item;
    const active = pathname === path || pathname.startsWith(`${path}/`);
    const pin: SidebarPin = { type: "page", path };
    return <div className={cn("sidebar-row flex min-w-0 items-center gap-0.5 rounded-lg pr-1 transition-colors focus-within:bg-accent", active ? "bg-accent font-medium" : "hover:bg-accent")}>
      {handle}
      <Link to={path} aria-current={active ? "page" : undefined} title={label}
        className={cn("flex min-w-0 flex-1 items-center gap-2 py-1 text-[13.5px] outline-none", handle ? "pl-0.5" : "pl-1.5")}
      >
        <ModuleIcon path={path} />
        <span className="truncate">{label}</span>
        {counts[path] !== undefined && <span className="ml-auto text-xs text-muted-foreground">{counts[path]}</span>}
      </Link>
      <SidebarPinButton label={label} pinned={pinnedKeys.has(pinKey(pin))} onClick={() => togglePinned(pin)} />
    </div>;
  }

  function renderSession(session: Session, handle?: ReactNode) {
    const pin: SidebarPin = { type: "session", sessionId: session.id };
    return <SidebarSessionRow
      session={session} openSessionId={openSessionId} streaming={streaming}
      pinned={pinnedKeys.has(pinKey(pin))} handle={handle} deleting={!!deleting}
      onTogglePin={() => togglePinned(pin)} onRename={title => renameSession(session.id, title)}
      onDelete={() => void deleteSession(session.id, session.title)}
    />;
  }

  return (
    <aside className="bg-sidebar border-sidebar-border flex h-full min-h-0 w-[252px] shrink-0 flex-col border-r px-2.5 pt-3.5 pb-2.5">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-3.5">
        <div className="bg-primary text-primary-foreground grid size-[22px] place-items-center rounded-[9px] text-[12px] font-semibold tracking-tight">
          1
        </div>
        <span className="text-[14.5px] font-medium tracking-tight">
          One Person Company
        </span>
      </div>

      <Button
        onClick={newChat}
        className="mb-3 h-auto w-full justify-start gap-2.5 py-2 text-[13.5px]"
      >
        <Plus className="size-[14px]" strokeWidth={2} />
        New chat
        <span className="ml-auto font-mono text-[11.5px] opacity-55">⌘K</span>
      </Button>

      <ScrollArea data-sidebar-scroll className="-mx-1 min-h-0 flex-1 px-1 [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
      <PinnedSection items={pinnedRows} onReorder={reorderPinned} renderItem={(item, handle) => {
        if (item.pin.type === "page") return renderPage(item.pin.path, handle);
        const session = state.sessions.find(session => item.pin.type === "session" && session.id === item.pin.sessionId);
        return session ? renderSession(session, handle) : null;
      }} />
      {deleteError && <p role="alert" className="p-2 text-xs text-destructive">Could not delete: {deleteError}</p>}
      <nav aria-label="Workspace" className="space-y-0.5">
        {NAV_GROUPS.map(group => <SidebarSection
          key={group.name}
          title={group.name}
          pathname={pathname}
          defaultOpen={group.expanded}
          active={group.paths.some(path => pathname === path || pathname.startsWith(`${path}/`))}
        >
          {NAV.filter(item => group.paths.includes(item.to)).map(item => <div key={item.to}>{renderPage(item.to)}</div>)}
        </SidebarSection>)}
      </nav>

      <section aria-label="Sessions" className="border-line-soft mt-3.5 border-t pt-3 pb-3">
        <div className="flex items-center justify-between px-2 pb-0.5">
          <span className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            Sessions
          </span>
          <button
            className="text-muted-foreground hover:bg-accent hover:text-foreground grid place-items-center rounded-[9px] p-1"
            title="Search sessions"
            onClick={() => { setSearching(v => !v); setSearch(""); }}
            aria-expanded={searching}
          >
            <Search className="size-3.5" strokeWidth={1.6} />
          </button>
        </div>

        {searching && <input autoFocus aria-label="Search sessions" placeholder="Search by title or venture…" value={search} onChange={e => setSearch(e.target.value)} className="m-1 w-[95%] rounded border p-2 text-sm" />}
        <div className="flex flex-col gap-px pt-1">
          {!visibleSessions.length && <p className="px-2 py-1.5 text-[12.5px] leading-relaxed text-muted-foreground" role="status">
            {search.trim() ? "No matching sessions." : state.sessions.length ? "All sessions are pinned above." : "No conversations yet. Start a chat to see it here."}
          </p>}
          {visibleSessions.map(session => <div key={session.id}>{renderSession(session)}</div>)}
        </div>
      </section>
      </ScrollArea>

      {/* The whole row is the trigger — the standalone theme button moved into
          Appearance, so there is one place a preference is changed. */}
      <div className="border-line-soft shrink-0 border-t pt-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger className="text-muted-foreground hover:bg-accent data-[state=open]:bg-accent flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors">
            <div className="bg-muted text-foreground grid size-[22px] shrink-0 place-items-center rounded-full text-[11.5px] font-semibold">
              {state.workspace.owner.trim()[0]?.toUpperCase() ?? "?"}
            </div>
            <div className="min-w-0">
              <div className="text-foreground truncate text-[13.5px]">
                {state.workspace.owner}
              </div>
              <div className="truncate text-[12px]">{state.workspace.name}</div>
            </div>
            <ChevronsUpDown
              className="ml-auto size-[13px] shrink-0"
              strokeWidth={1.6}
            />
          </DropdownMenuTrigger>

          <DropdownMenuContent side="top" align="start" className="w-[232px]">
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
