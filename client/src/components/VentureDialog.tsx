import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { VENTURE_COLORS, useStore, type Venture } from "@/lib/store";

/**
 * Create a venture, or edit one when `venture` is passed.
 *
 * The form is a child that only mounts while the dialog is open, so its fields
 * initialise from the venture once and a cancelled edit leaves nothing behind —
 * no effect resetting state on every open.
 */
export function VentureDialog({
  open,
  onOpenChange,
  venture,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venture?: Venture;
  onDeleted?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        {open && (
          <VentureForm
            venture={venture}
            onDone={() => onOpenChange(false)}
            onDeleted={onDeleted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function VentureForm({
  venture,
  onDone,
  onDeleted,
}: {
  venture?: Venture;
  onDone: () => void;
  onDeleted?: () => void;
}) {
  const { addVenture, updateVenture, deleteVenture } = useStore();
  const [name, setName] = useState(venture?.name ?? "");
  const [desc, setDesc] = useState(venture?.desc ?? "");
  const [color, setColor] = useState(
    () =>
      venture?.color ??
      VENTURE_COLORS[Math.floor(Math.random() * VENTURE_COLORS.length)],
  );

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (venture)
      updateVenture(venture.id, { name: trimmed, desc: desc.trim(), color });
    else addVenture({ name: trimmed, desc: desc.trim(), color });
    onDone();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{venture ? "Edit venture" : "New venture"}</DialogTitle>
        <DialogDescription>
          {venture
            ? "Rename it, or give it a colour you will recognise in the rail."
            : "One launched thing — an app, a site, a product. Sessions you start from here are filed under it."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="venture-name">Name</Label>
          <Input
            id="venture-name"
            value={name}
            autoFocus
            autoComplete="off"
            placeholder="Example Support"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="venture-desc">What it is</Label>
          <Textarea
            id="venture-desc"
            value={desc}
            placeholder="What it does and who pays for it, in one line."
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label>Colour</Label>
          <div className="flex gap-1.5">
            {VENTURE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={c === color}
                onClick={() => setColor(c)}
                style={{ background: c }}
                className={cn(
                  "size-[22px] rounded-[7px] border-2 border-transparent transition-transform hover:scale-110",
                  c === color && "border-foreground",
                )}
              />
            ))}
          </div>
        </div>
      </div>

      <DialogFooter className="sm:justify-start">
        <Button onClick={save} disabled={!name.trim()}>
          {venture ? "Save" : "Create venture"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {venture && (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive hover:bg-destructive/10 sm:ml-auto"
            onClick={() => {
              deleteVenture(venture.id);
              onDone();
              onDeleted?.();
            }}
          >
            Delete
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
