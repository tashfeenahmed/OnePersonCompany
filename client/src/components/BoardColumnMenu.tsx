import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Gauge, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { BoardColumn, BoardDoc } from "@/lib/api";
import { boardColumnPrompt, type PromptVenture } from "@/lib/boardPrompt";
import { copyText } from "@/lib/clipboard";

export function BoardColumnMenu({ column, ventures, onLimit, onRemove, onMoveLeft, onMoveRight }: {
  column: BoardColumn;
  ventures: ReadonlyMap<string, PromptVenture>;
  onLimit: (limit: number | null) => Promise<BoardDoc | null>;
  onRemove: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [limiting, setLimiting] = useState(false);
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 4000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    const prompt = boardColumnPrompt(column, ventures);
    if (await copyText(prompt)) setCopied(`Copied ${column.cards.length} ${column.cards.length === 1 ? "card" : "cards"} from ${column.title}`);
    else setManualCopy(prompt);
  }
  async function saveLimit() {
    const next = limit.trim() === "" ? null : Number(limit);
    if (next !== null && (!Number.isSafeInteger(next) || next < 0)) {
      setError("Enter a whole number of zero or more, or leave it blank."); return;
    }
    if (saving) return;
    setSaving(true); setError(null);
    try {
      if (next === column.wipLimit || await onLimit(next)) setLimiting(false);
      else setError("The limit could not be saved. Please try again.");
    } catch (err) { setError(err instanceof Error ? err.message : "The limit could not be saved."); }
    finally { setSaving(false); }
  }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} variant="ghost" size="icon-sm" className="text-muted-foreground shrink-0" aria-label={`Column options: ${column.title}`}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={event => { if (limiting || manualCopy) event.preventDefault(); }}>
        <DropdownMenuItem onSelect={() => { setLimit(String(column.wipLimit ?? "")); setError(null); setLimiting(true); }}><Gauge />Set card limit…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!onMoveLeft} onSelect={onMoveLeft}><ArrowLeft />Move left</DropdownMenuItem>
        <DropdownMenuItem disabled={!onMoveRight} onSelect={onMoveRight}><ArrowRight />Move right</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!column.cards.length} onSelect={() => void copy()}><Copy />Copy to Prompt AI</DropdownMenuItem>
        <p className="text-muted-foreground px-1.5 py-1 text-xs">Copies all {column.cards.length} cards with project details, including hidden cards.</p>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={column.structural} onSelect={onRemove}><Trash2 />Delete column…</DropdownMenuItem>
        {column.structural && <p className="text-muted-foreground px-1.5 py-1 text-xs">Backlog and Done are required columns.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={limiting} onOpenChange={open => { if (!saving) setLimiting(open); }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
        <form onSubmit={event => { event.preventDefault(); void saveLimit(); }} className="grid gap-4">
          <DialogHeader><DialogTitle>Card limit for {column.title}</DialogTitle><DialogDescription>Highlight this column when it exceeds the limit. Leave blank for no limit. Cards can still be added.</DialogDescription></DialogHeader>
          <div className="grid gap-2"><Label htmlFor={`column-limit-${column.id}`}>Maximum cards</Label><Input id={`column-limit-${column.id}`} type="number" min={0} step={1} autoFocus value={limit} disabled={saving} onChange={event => setLimit(event.target.value)} placeholder="No limit" /></div>
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setLimiting(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save limit"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={manualCopy !== null} onOpenChange={open => { if (!open) setManualCopy(null); }}>
      <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader><DialogTitle>Copy to Prompt AI</DialogTitle><DialogDescription>Automatic copying is unavailable in this browser. Select the prompt below and copy it with your keyboard or device’s Copy action.</DialogDescription></DialogHeader>
        <Textarea ref={promptInput} aria-label="AI prompt" readOnly value={manualCopy ?? ""} className="h-80 text-sm" onFocus={event => event.currentTarget.select()} />
        <DialogFooter><Button variant="outline" onClick={() => setManualCopy(null)}>Close</Button><Button onClick={() => { promptInput.current?.focus(); promptInput.current?.select(); }}>Select prompt</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {copied && <div role="status" className="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-xl border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"><Check className="size-4 shrink-0" />{copied}</div>}
  </>;
}
