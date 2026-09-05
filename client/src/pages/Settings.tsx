import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Download, Monitor, Moon, Sun, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageShell, TopBar } from "@/components/PageShell";
import { cn } from "@/lib/utils";
import { isStoreState, useStore } from "@/lib/store";
import { useTheme, type Theme } from "@/lib/theme";
import { ModelsSettings } from "@/components/ModelsSettings";

const THEMES: { id: Theme; label: string; note: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", note: "Always the paper palette", icon: Sun },
  { id: "dark", label: "Dark", note: "Always the dark palette", icon: Moon },
  {
    id: "system",
    label: "System",
    note: "Follows the OS setting",
    icon: Monitor,
  },
];

/** A titled block with one line of context, repeated down every tab. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2.5 py-5">
      <div>
        <div className="text-[13px] font-medium tracking-tight">{title}</div>
        {hint && (
          <p className="text-muted-foreground mt-0.5 max-w-[560px] text-[12.5px]">
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

export function Settings() {
  const { state, setWorkspace, importState, reset } = useStore();
  const { theme, setTheme } = useTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `one-person-company-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      // Refuse a foreign file rather than half-loading it into a blank page.
      if (!isStoreState(parsed)) {
        setNote("That file is not a workspace export.");
        return;
      }
      importState(parsed);
      setNote("Workspace replaced from file.");
    } catch {
      setNote("That file could not be read as JSON.");
    }
  }

  return (
    <>
      <TopBar label="Settings" />
      <PageShell
        title="Settings"
        sub="Workspace, appearance and the data this browser is holding."
      >
        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            {/* MODELS, AND NOT UNDER "GENERAL". Which provider completes is
                not a preference about this browser — it is the one setting on
                this page that changes what the server DOES, and it has a table
                of four providers, their endpoints and their policies behind
                it. See ModelsSettings.tsx for why the one-click switch lives
                in the Chat header instead and this is the page you read. */}
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="data">Data</TabsTrigger>
          </TabsList>

          {/* ---------------------------------------------------- general */}
          <TabsContent value="general" className="mt-2 divide-y">
            <Section
              title="Workspace"
              hint="What the rail calls you, at the bottom of the sidebar."
            >
              <div className="grid max-w-[420px] gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="owner">Your name</Label>
                  <Input
                    id="owner"
                    value={state.workspace.owner}
                    onChange={(e) => setWorkspace({ owner: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ws-name">Workspace</Label>
                  <Input
                    id="ws-name"
                    value={state.workspace.name}
                    onChange={(e) => setWorkspace({ name: e.target.value })}
                  />
                </div>
              </div>
            </Section>

            <Section
              title="New chats"
              hint="Which venture the composer starts against. Sessions are a flat list either way — this only presets the picker."
            >
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setWorkspace({ defaultVentureId: null })}
                  className={cn(
                    "flex items-center gap-2 rounded-[9px] border px-3 py-1.5 text-[12.5px] transition-colors",
                    state.workspace.defaultVentureId === null
                      ? "border-foreground"
                      : "hover:border-line-strong",
                  )}
                >
                  <span className="border-border size-[7px] rounded-[2px] border" />
                  No venture
                </button>
                {state.ventures.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setWorkspace({ defaultVentureId: v.id })}
                    className={cn(
                      "flex items-center gap-2 rounded-[9px] border px-3 py-1.5 text-[12.5px] transition-colors",
                      state.workspace.defaultVentureId === v.id
                        ? "border-foreground"
                        : "hover:border-line-strong",
                    )}
                  >
                    <span
                      className="size-[7px] rounded-[2px]"
                      style={{ background: v.color }}
                    />
                    {v.name}
                  </button>
                ))}
              </div>
            </Section>
          </TabsContent>

          {/* ----------------------------------------------------- models */}
          <TabsContent value="models" className="mt-2 divide-y">
            <ModelsSettings />
          </TabsContent>

          {/* ------------------------------------------------- appearance */}
          <TabsContent value="appearance" className="mt-2 divide-y">
            <Section
              title="Theme"
              hint="System follows the OS and keeps following it, so a machine that switches at sunset switches this too."
            >
              <div className="grid max-w-[560px] gap-2 sm:grid-cols-3">
                {THEMES.map(({ id, label, note: n, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setTheme(id)}
                    aria-pressed={theme === id}
                    className={cn(
                      "bg-card rounded-[10px] border p-3.5 text-left transition-colors",
                      theme === id
                        ? "border-foreground"
                        : "hover:border-line-strong",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="size-4" strokeWidth={1.6} />
                      <span className="text-[13px] font-medium">{label}</span>
                      {theme === id && (
                        <Check className="ml-auto size-4" strokeWidth={2} />
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-[11.5px]">
                      {n}
                    </p>
                  </button>
                ))}
              </div>
            </Section>

            <Section
              title="Type and density"
              hint="Fixed for now. The rail sits at 12.5px against a 14px body, which is the ratio the rest of the app is drawn to."
            >
              <div className="text-muted-foreground flex flex-wrap gap-4 font-mono text-[11.5px]">
                <span>body 14px</span>
                <span>rail 12.5px</span>
                <span>page title 25px</span>
                <span>radius 10px</span>
              </div>
            </Section>
          </TabsContent>

          {/* ------------------------------------------------------- data */}
          <TabsContent value="data" className="mt-2 divide-y">
            <Section
              title="What is stored"
              hint="Everything lives in this browser's localStorage. Nothing is sent anywhere, and clearing site data clears all of it."
            >
              <div className="flex flex-wrap gap-2">
                {[
                  [state.ventures.length, "ventures"],
                  [state.sessions.length, "sessions"],
                  [state.dashboards.length, "dashboards"],
                  [
                    state.dashboards.reduce((n, d) => n + d.widgets.length, 0),
                    "placed widgets",
                  ],
                ].map(([v, k]) => (
                  <div
                    key={k as string}
                    className="bg-card min-w-[130px] flex-1 rounded-[10px] border px-3.5 py-3"
                  >
                    <div className="text-[22px] font-normal tracking-[-0.03em] tabular-nums">
                      {v}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-[11.5px]">
                      {k}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section
              title="Export and import"
              hint="A plain JSON file of the whole workspace. An import replaces what is here; a file that is not an export is refused."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={exportJson}>
                  <Download className="size-[15px]" strokeWidth={1.8} />
                  Export JSON
                </Button>
                <Button
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="size-[15px]" strokeWidth={1.8} />
                  Import JSON
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importJson(f);
                    e.target.value = "";
                  }}
                />
                {note && (
                  <span className="text-muted-foreground text-[12px]">
                    {note}
                  </span>
                )}
              </div>
            </Section>

            <Section
              title="Reset"
              hint="Puts the ventures, sessions and dashboards back to the starting set. There is no undo."
            >
              <div>
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 -ml-3"
                  onClick={() => {
                    reset();
                    setNote("Workspace reset to defaults.");
                  }}
                >
                  Reset to defaults
                </Button>
              </div>
            </Section>
          </TabsContent>
        </Tabs>

        <Separator className="mt-8 mb-4" />
        <p className="text-muted-foreground text-[12.5px]">
          Credentials and integrations are not here — each one lives on{" "}
          <Link
            to="/integrations"
            className="text-foreground underline underline-offset-2"
          >
            Integrations
          </Link>
          , beside the service it belongs to.
        </p>
      </PageShell>
    </>
  );
}
