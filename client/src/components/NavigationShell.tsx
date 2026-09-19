import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { Spotlight } from "./Spotlight";
const COLLAPSED_KEY = "opc-sidebar-collapsed";
export function NavigationShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); }
    catch { /* Navigation still works when browser storage is unavailable. */ }
  }, [collapsed]);
  const location = useLocation();
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);
  useEffect(() => { const query = matchMedia("(min-width: 768px)"); const resize = () => { if (query.matches) setOpen(false); }; query.addEventListener("change", resize); return () => query.removeEventListener("change", resize); }, []);
  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>("button, a, input"); first?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      if (event.key !== "Tab") return;
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>("a,button,input,[tabindex='0']") ?? []).filter(n => n.getClientRects().length > 0);
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && index === nodes.length - 1) { event.preventDefault(); nodes[0]?.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  return <div className="flex h-dvh overflow-hidden">
    <div ref={panel} className={`${open ? "flex fixed inset-y-0 left-0 z-50 shadow-xl" : "hidden"} md:static md:flex`}>
      <AppSidebar collapsed={collapsed && !open} onCollapsedChange={setCollapsed} />
      {open && <button className="absolute top-1 right-1 p-2 md:hidden" aria-label="Close navigation" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button>}
    </div>
    {open && <button aria-label="Close navigation overlay" tabIndex={-1} className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
    <main className="flex min-w-0 flex-1 flex-col" inert={open || undefined}>
      <div className="border-b p-2 md:hidden"><button ref={trigger} aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)} className="rounded border px-3 py-1.5">☰ Menu</button></div>
      {children}
    </main>
    <Spotlight />
  </div>;
}
