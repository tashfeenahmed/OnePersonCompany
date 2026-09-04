import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageShell, TopBar } from "@/components/PageShell";
import { VentureDialog } from "@/components/VentureDialog";
import { useStore, type Venture } from "@/lib/store";

export function Ventures() {
  const { state, setActiveSession, sessionsFor } = useStore();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Venture | undefined>();

  // Sessions are a flat list now, so a venture's count is the ones that
  // happened to name it — not everything that exists.
  const filed = state.sessions.filter((s) => s.ventureId).length;

  return (
    <>
      <TopBar label="Ventures" />
      <PageShell
        title="Ventures"
        sub={
          <>
            <b className="text-foreground font-medium">
              {state.ventures.length}
            </b>{" "}
            ventures running,{" "}
            <b className="text-foreground font-medium">{filed}</b> of{" "}
            {state.sessions.length} sessions about one of them.
          </>
        }
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-[15px]" strokeWidth={2} />
            New venture
          </Button>
        }
      >
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {state.ventures.map((p) => {
            const mine = sessionsFor(p.id);
            return (
              <div
                key={p.id}
                className="bg-card hover:border-line-strong flex min-h-[148px] flex-col rounded-[10px] border p-3.5 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="size-[9px] shrink-0 rounded-[3px]"
                    style={{ background: p.color }}
                  />
                  <span className="text-[13.5px] font-medium tracking-tight">
                    {p.name}
                  </span>
                  <button
                    title="Edit venture"
                    onClick={() => setEditing(p)}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto grid place-items-center rounded-[7px] p-1"
                  >
                    <Pencil className="size-4" strokeWidth={1.6} />
                  </button>
                </div>

                <p className="text-muted-foreground mt-1.5 line-clamp-2 text-[12px]">
                  {p.desc || "No description yet."}
                </p>

                <div className="border-line-soft mt-3 flex flex-col gap-px border-t pt-2.5">
                  {mine.length ? (
                    <>
                      {mine.slice(0, 3).map((s) => (
                        <button
                          key={s.id}
                          onClick={() => {
                            setActiveSession(s.id);
                            navigate("/");
                          }}
                          className="hover:bg-accent -mx-1.5 block truncate rounded-md px-1.5 py-1 text-left text-[12px]"
                        >
                          {s.title}
                        </button>
                      ))}
                      {mine.length > 3 && (
                        <span className="text-muted-foreground pt-1 text-[11.5px]">
                          {mine.length - 3} more
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground text-[11.5px]">
                      Nothing asked about this one yet.
                    </span>
                  )}
                </div>

                <div className="mt-auto flex items-center gap-1.5 pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate("/")}
                  >
                    <Plus className="size-[15px]" strokeWidth={2} />
                    New chat
                  </Button>
                  <Badge variant="secondary">
                    {mine.length} {mine.length === 1 ? "session" : "sessions"}
                  </Badge>
                </div>
              </div>
            );
          })}

          <button
            onClick={() => setCreating(true)}
            className="text-muted-foreground hover:border-line-strong hover:text-foreground flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed transition-colors"
          >
            <Plus className="size-[18px]" strokeWidth={1.6} />
            <span className="text-[13px]">New venture</span>
          </button>
        </div>
      </PageShell>

      <VentureDialog open={creating} onOpenChange={setCreating} />
      <VentureDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(undefined)}
        venture={editing}
      />
    </>
  );
}
