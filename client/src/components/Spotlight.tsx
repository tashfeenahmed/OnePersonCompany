import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CornerDownLeft, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ModuleIcon } from "@/components/ModuleIcon";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { find, type FindHit } from "@/lib/api/find";
import { IS_MAC, OPEN_NEW_MENU, OPEN_SPOTLIGHT, localItems, markParts, mergeItems, spotlightWords, type SpotlightItem, type SpotlightSources } from "@/lib/spotlight";
import { orderedOutputs } from "@/data/outputs";
import { MENU, NAV } from "@/data/navigation";
import { appPage } from "../../../shared/navigation";
import { dashboardDestination } from "../../../shared/dashboardNavigation";

const DEBOUNCE_MS = 140;

/**
 * SPOTLIGHT — ⌘K, from anywhere, over everything.
 *
 * It lives in the shell rather than beside a button because it belongs to no
 * page: the keys work with the rail collapsed, in the mobile drawer, and with
 * the hands in the composer. ⌘K used to start a new chat; ⌃N / ⌘N opens the
 * New menu now (components/NewMenu.tsx), and is heard here too so there is one
 * place the app listens to the keyboard.
 *
 * NAMES ARE INSTANT, WORDS ARRIVE. See lib/spotlight.ts for the two sources
 * and how they are merged.
 */
export function Spotlight() {
  const { state } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; hits: FindHit[] }>({ q: "", hits: [] });
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        /* The browser's own — a search field in Firefox, the address bar in
           Chrome. Pressed again it closes, as Spotlight does. */
        e.preventDefault();
        setOpen(was => !was);
      } else if (key === "n") {
        e.preventDefault();
        setOpen(false);
        window.dispatchEvent(new Event(OPEN_NEW_MENU));
      }
    }
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SPOTLIGHT, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_SPOTLIGHT, onOpen); };
  }, []);

  /* Every opening starts empty: the last question is not this one. */
  useEffect(() => { if (open) { setQuery(""); setActive(0); setFailed(false); } }, [open]);
  /* Arriving somewhere — by this palette or by anything else — closes it. */
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);

  const sources = useMemo<SpotlightSources>(() => ({
    pages: [
      ...NAV.map(item => ({ to: item.to, label: item.label })),
      { to: "/settings", label: "Settings" },
      ...MENU.map(item => ({ to: item.to, label: item.label })),
      ...orderedOutputs(state.appOrder).map(output => ({ to: appPage(output.slug), label: output.name, icon: "/outputs", also: "outputs reports" })),
    ],
    ventures: state.ventures,
    dashboards: state.dashboards.flatMap(board => {
      const to = dashboardDestination(board, state.ventures);
      return to ? [{ id: board.id, name: board.name, to, ventureId: board.ventureId }] : [];
    }),
    sessions: state.sessions,
  }), [state.appOrder, state.ventures, state.dashboards, state.sessions]);

  const trimmed = query.trim();
  useEffect(() => {
    if (!open || trimmed.length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      find(trimmed, abort.signal)
        .then(doc => { setHits({ q: trimmed, hits: doc.hits }); setFailed(false); })
        .catch(() => { if (!abort.signal.aborted) setFailed(true); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [open, trimmed]);

  const words = useMemo(() => spotlightWords(trimmed), [trimmed]);
  /* The last answer stays on screen while the next is fetched, as long as it
     still applies: every word typed since only narrows it, and a list that
     emptied between keystrokes would flicker. It is re-checked here rather
     than trusted, so a row that no longer matches is gone at once. */
  const fresh = hits.q === trimmed;
  const usable = useMemo(() => trimmed.length < 2 ? [] : fresh ? hits.hits : hits.hits.filter(hit => {
    const text = `${hit.title} ${hit.snippet ?? ""}`.toLowerCase();
    return trimmed.startsWith(hits.q) && words.every(word => text.includes(word));
  }), [fresh, hits, trimmed, words]);
  const items = useMemo(() => mergeItems(localItems(trimmed, sources), usable, sources), [trimmed, sources, usable]);
  const waiting = trimmed.length >= 2 && !fresh && !failed;

  useEffect(() => { setActive(0); }, [trimmed]);
  const current = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, items.length]);

  const go = useCallback((item: SpotlightItem, newTab = false) => {
    const to = item.to;
    if (!to) return;
    if (newTab) { window.open(to, "_blank", "noopener"); return; }
    setOpen(false);
    navigate(to);
  }, [navigate]);

  function onInputKey(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(items.length ? (current + 1) % items.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(items.length ? (current - 1 + items.length) % items.length : 0); }
    else if (e.key === "Home" && items.length) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && items.length) { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === "Enter" && items[current]) { e.preventDefault(); go(items[current], e.metaKey || e.ctrlKey); }
  }

  const mark = (text: string) => markParts(text, words).map((part, i) =>
    part.hit ? <mark key={i} className="rounded-[3px] bg-primary/15 text-foreground">{part.text}</mark> : <span key={i}>{part.text}</span>);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false}
        className="top-[14vh] flex max-h-[min(72vh,620px)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search pages, ventures, dashboards, chats, board cards and reports.</DialogDescription>
        <div className="flex items-center gap-3 border-b border-line-soft px-4">
          <Search aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.7} />
          <input
            autoFocus role="combobox" aria-expanded="true" aria-controls="spotlight-results" aria-autocomplete="list"
            aria-activedescendant={items[current] ? `spotlight-${current}` : undefined}
            aria-label="Search" placeholder="Search chats, cards, reports, ventures, pages…"
            autoComplete="off" autoCorrect="off" spellCheck={false}
            value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onInputKey}
            className="h-13 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground"
          />
          {waiting && <span role="status" className="shrink-0 text-[12px] text-muted-foreground">Searching…</span>}
        </div>

        <div ref={list} id="spotlight-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {!items.length && <p role="status" className="px-3 py-8 text-center text-[13.5px] text-muted-foreground">
            {waiting ? "Searching…" : failed ? "Could not search what was said. Names still work." : `Nothing found for “${trimmed}”.`}
          </p>}
          {items.map((item, index) => {
            const heading = index === 0 || items[index - 1].group !== item.group;
            const heading_label = !trimmed && item.group === "Chats" ? "Recent chats" : item.group;
            return <div key={item.key}>
              {heading && <div aria-hidden="true" className="px-2.5 pt-2.5 pb-1 text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{heading_label}</div>}
              <div
                id={`spotlight-${index}`} data-index={index} role="option" aria-selected={index === current}
                onMouseMove={() => { if (index !== current) setActive(index); }}
                onClick={e => go(item, e.metaKey || e.ctrlKey)}
                className={cn("flex cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2", index === current && "bg-accent")}
              >
                <span className="grid h-5 w-4 shrink-0 place-items-center text-muted-foreground"><ModuleIcon path={item.icon ?? (item.group === "Ventures" ? "/ventures" : "/board")} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-[14px]">{mark(item.title)}</span>
                    {item.detail && <span className="shrink-0 truncate text-[12px] text-muted-foreground">{item.detail}</span>}
                  </span>
                  {item.snippet && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-muted-foreground">{mark(item.snippet)}</span>}
                </span>
                {index === current && <CornerDownLeft aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.7} />}
              </div>
            </div>;
          })}
          {failed && items.length > 0 && <p role="status" className="px-3 py-2 text-[12px] text-muted-foreground">Could not search what was said. Names still work.</p>}
        </div>

        <div aria-hidden="true" className="flex items-center gap-4 border-t border-line-soft px-4 py-2 text-[11.5px] text-muted-foreground">
          <span><kbd className="font-mono">↑↓</kbd> move</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">{IS_MAC ? "⌘↵" : "Ctrl ↵"}</kbd> new tab</span>
          <span className="ml-auto"><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
