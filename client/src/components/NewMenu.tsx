import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModuleIcon } from "@/components/ModuleIcon";
import { cn } from "@/lib/utils";
import { NEW_ITEMS, NEW_MENU_KEYS, OPEN_NEW_MENU, newItemForKey } from "@/lib/spotlight";

/**
 * NEW — ONE BUTTON, SPLIT. The wide half is still New chat, one press, because
 * that is what is made a dozen times a day. The narrow half opens everything
 * else that can be made: a dashboard, and a venture at each of its three
 * stages, so the form opens already knowing which kind of help is being asked
 * for.
 *
 * THE KEYBOARD GOES THROUGH THE MENU. ⌃N opens it with New chat lit, so ⌃N
 * then Enter — or ⌃N twice, without letting go of Control — is a new chat, and
 * ⌃N then one letter is any of the others. The letters are printed on the rows
 * and they ACT rather than jump: a menu of five does not need typeahead, and a
 * key that moved the highlight and waited for Enter would be two presses
 * pretending to be one. The key itself is heard in components/Spotlight.tsx,
 * the one place this app listens to the keyboard, and arrives here as an event.
 *
 * THE SEAM IS AN OPAQUE MIX, NOT A TINT. Every Button here has a transparent
 * one-pixel border with its fill clipped inside it, so where two halves meet
 * the rail shows through — black, in dark mode, on a near-white button. A
 * translucent line drawn over that gap is a tint of the RAIL. So the chat half
 * gives up its right border, the caret gives up its left, and the line is an
 * inset shadow in the button's own two colours mixed: a hairline a shade off
 * the fill in either theme. A shadow and not a border, because a border spans
 * the whole box and would stand a pixel proud of the clipped fill above and
 * below.
 *
 * COLLAPSED, THERE IS NO ROOM FOR TWO HALVES, so the one square button opens
 * the menu and New chat is its first row.
 */
export function NewMenu({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
   * IT DOES NOT TOUCH ANYTHING IN FLIGHT. An answer being written belongs to
   * its own session and goes on arriving — the mark stays on its row here, and
   * pressing New chat while one is streaming is how you ask a second question,
   * not how you cancel the first.
   */
  const go = useCallback((to: string) => { setOpen(false); navigate(to); }, [navigate]);

  useEffect(() => {
    const onAsk = () => {
      /* A second ⌃N with the menu up is the first row. And a rail that is not
         on screen — the phone layout, drawer shut — has nothing to anchor a
         menu to, so the key keeps its old meaning there. */
      if (open || !trigger.current?.getClientRects().length) go("/");
      else setOpen(true);
    };
    window.addEventListener(OPEN_NEW_MENU, onAsk);
    return () => window.removeEventListener(OPEN_NEW_MENU, onAsk);
  }, [open, go]);

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const item = newItemForKey(e.key);
    if (!item) return;
    e.preventDefault();
    go(item.to);
  }

  const chat = NEW_ITEMS[0];
  const ventures = NEW_ITEMS.filter(item => item.group === "venture");
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div className={cn("sidebar-new-chat mb-1.5 flex h-10 overflow-hidden rounded-lg", collapsed ? "mx-auto w-10" : "w-full")}>
        {!collapsed && <Button
          onClick={() => go(chat.to)} aria-label="New chat"
          className="h-10 min-w-0 flex-1 justify-start gap-2.5 rounded-r-none border-r-0 px-3 text-[13.5px]"
        >
          <Plus className="size-[14px]" strokeWidth={2} />
          <span className="sidebar-detail min-w-0 flex-1 text-left">New chat</span>
        </Button>}
        <Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild>
          <Button ref={trigger} aria-label={collapsed ? "New" : "More to create"} aria-keyshortcuts="Control+N Meta+N"
            className={cn("h-10 text-[11.5px]", collapsed ? "w-10 justify-center p-0" : "gap-1 rounded-l-none border-l-0 px-2.5 shadow-[inset_1px_0_0_color-mix(in_oklab,var(--primary-foreground)_14%,var(--primary))]")}>
            {collapsed ? <Plus className="size-[14px]" strokeWidth={2} /> : <>
              <span aria-hidden="true" className="sidebar-detail font-mono opacity-55">{NEW_MENU_KEYS}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 opacity-70" strokeWidth={2} />
            </>}
          </Button>
        </DropdownMenuTrigger></TooltipTrigger><TooltipContent side={collapsed ? "right" : "bottom"} sideOffset={8}>New… · {NEW_MENU_KEYS}</TooltipContent></Tooltip>
      </div>

      <DropdownMenuContent side={collapsed ? "right" : "bottom"} align={collapsed ? "start" : "end"} sideOffset={collapsed ? 12 : 6}
        className="w-[232px]" onKeyDown={onMenuKey}
        /* Escape hands focus back to whatever had it, not to the caret: the
           key is pressed from the composer as often as not. */
        onCloseAutoFocus={e => { if (!trigger.current?.matches(":focus-visible")) e.preventDefault(); }}>
        <DropdownMenuItem onSelect={() => go(chat.to)}>
          <ModuleIcon path={chat.icon} className="size-4" />{chat.title}<DropdownMenuShortcut>{chat.key.toUpperCase()}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {NEW_ITEMS.filter(item => item.group === "other").map(item => <DropdownMenuItem key={item.id} onSelect={() => go(item.to)}>
          <ModuleIcon path={item.icon} className="size-4" />{item.title}<DropdownMenuShortcut>{item.key.toUpperCase()}</DropdownMenuShortcut>
        </DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">New venture</DropdownMenuLabel>
          {ventures.map(item => <DropdownMenuItem key={item.id} onSelect={() => go(item.to)}>
            <ModuleIcon path={item.icon} className="size-4" />{item.short}<DropdownMenuShortcut>{item.key.toUpperCase()}</DropdownMenuShortcut>
          </DropdownMenuItem>)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
