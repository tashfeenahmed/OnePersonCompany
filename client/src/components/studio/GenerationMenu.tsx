import { useRef, useState } from "react";
import { Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function GenerationMenu({ title, live, onDelete }: { title: string; live: boolean; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  async function remove() {
    if (busy || live) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this generation. Please try again.");
    } finally { setBusy(false); }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} variant="ghost" size="icon-sm" className="text-muted-foreground mr-1 shrink-0" aria-label={`Generation options: ${title}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={(event) => { if (open) event.preventDefault(); }}>
          <DropdownMenuItem variant="destructive" disabled={live} onSelect={() => { setError(null); setOpen(true); }}>
            <Trash2 /> Delete
          </DropdownMenuItem>
          {live && <p className="text-muted-foreground max-w-48 px-2 py-1 text-xs">Stop this generation before deleting it.</p>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent showCloseButton={!busy} onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Delete generation?</DialogTitle>
            <DialogDescription>
              This permanently deletes the generation and its files, including images, videos, clips and previews. Published social posts are kept.
            </DialogDescription>
          </DialogHeader>
          <p className="truncate font-medium" title={title}>{title}</p>
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          {live && <p role="alert" className="text-muted-foreground text-sm">This generation is working. Stop it before deleting.</p>}
          <DialogFooter>
            <Button variant="outline" autoFocus disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || live} onClick={() => void remove()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {busy ? "Deleting…" : "Delete generation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
