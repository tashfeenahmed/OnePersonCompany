import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, Download, Monitor, Moon, Sun, Upload } from "lucide-react";
import { Tiles } from "@/components/integrations/Panel";
import { BudgetSettings } from "@/components/settings/BudgetSettings";
import { SetupChecklist } from "@/components/settings/SetupChecklist";
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
import { Section } from "@/components/settings/Section";
import { PaletteSettings } from "@/components/settings/PaletteSettings";
import { BackupsSettings } from "@/components/settings/BackupsSettings";
import { CaptureSettings } from "@/components/settings/CaptureSettings";
import { StudioSettings } from "@/components/settings/StudioSettings";
import { SecuritySettings } from "@/areas/security/SecuritySettings";
import { MigrationSettings } from "@/areas/migrate/MigrationSettings";
import { DeploymentSettings } from "@/areas/deploy/DeploymentSettings";

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

export function Settings() {
  const { state, setWorkspace, importState, reset } = useStore();
  const [query, setQuery] = useSearchParams();
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
      if (!window.confirm(`Replace preferences with “${parsed.workspace.name}”: ${parsed.dashboards.length} dashboards and ${parsed.sessions.length} session labels? Your current preferences will be saved for recovery. Ventures and integration connections stay in the server database.`)) return;
      importState(parsed);
      setNote("Preferences imported. The previous version is available below.");
    } catch (error) {
      setNote(error instanceof SyntaxError ? "That file could not be read as JSON." : "Import could not be completed. Check browser storage space; your current preferences have been kept.");
    }
  }

  return (
    <>
      <TopBar label="Settings" />
      <PageShell
        title="Settings"
        sub="Your workspace, appearance, models, backups and security."
      >
        <Tabs value={query.get("tab") || "general"} onValueChange={tab => setQuery({ tab })}>
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="general">General</TabsTrigger>
            {/* MODELS, AND NOT UNDER "GENERAL". Which provider completes is
                not a preference about this browser — it is the one setting on
                this page that changes what the server DOES, and it has a table
                of four providers, their endpoints and their policies behind
                it. See ModelsSettings.tsx for why the one-click switch lives
                in the Chat header instead and this is the page you read. */}
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="budgets">Usage limits</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            {/* THE BOX'S OWN SETTINGS, and not under Data — "Data" on this
                page has always meant the workspace in this browser's
                localStorage, and putting the server's nightly archive beside
                an export button would blur the one distinction that page
                makes. Backups, the screenshot browser and the image model are
                three settings that change what the MACHINE does with its own
                disk, which is a fourth kind of thing and gets a fourth tab.
                Models is server-side too and stays where it is: it is a table
                of four providers, not a form. */}
            <TabsTrigger value="server">Server</TabsTrigger>
            {/* SECURITY, AND IT IS NOT UNDER "SERVER". That tab is three
                settings about what the machine does with its own disk; this
                one is the lock on the API itself, it is OFF until a password
                is set, and it is the page somebody looks for by name the day
                they put this box behind a tunnel. See
                areas/security/SecuritySettings.tsx. */}
            <TabsTrigger value="security">Security</TabsTrigger>
            {/* DEPLOYMENT, AND IT IS NOT UNDER "SERVER" EITHER. That tab is
                three settings about what this machine does with its own disk.
                This one is about whether the machine runs this app at all when
                nobody is watching — the service, its health checks, the
                per-source collection schedule, how boxed-in the agent is, and
                who is holding a shared GPU. See areas/deploy/DeploymentSettings.tsx. */}
            <TabsTrigger value="deployment">Deployment</TabsTrigger>
            {/* MIGRATION, AND IT IS NOT UNDER "DATA". That tab is this
                browser's own preferences, exported and imported as a file.
                This one is about data arriving from ANOTHER application —
                imported batches, what they created, and whether the product
                adapters are publishing what this box asks for. See
                areas/migrate/MigrationSettings.tsx. */}
            <TabsTrigger value="migration">Migration</TabsTrigger>
            <TabsTrigger value="data">Data</TabsTrigger>
          </TabsList>

          {/* ---------------------------------------------------- general */}
          <TabsContent value="general" className="mt-2 divide-y">
            <SetupChecklist />
            <Section
              title="Workspace"
              hint="The name shown in your workspace."
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
              hint="Choose the default venture for new conversations."
            >
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setWorkspace({ defaultVentureId: null })}
                  className={cn(
                    "flex items-center gap-2 rounded-[12px] border px-3 py-1.5 text-[13.5px] transition-colors",
                    state.workspace.defaultVentureId === null
                      ? "border-foreground"
                      : "hover:border-line-strong",
                  )}
                >
                  <span className="border-border size-[7px] rounded-[3px] border" />
                  No venture
                </button>
                {state.ventures.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setWorkspace({ defaultVentureId: v.id })}
                    className={cn(
                      "flex items-center gap-2 rounded-[12px] border px-3 py-1.5 text-[13.5px] transition-colors",
                      state.workspace.defaultVentureId === v.id
                        ? "border-foreground"
                        : "hover:border-line-strong",
                    )}
                  >
                    <span
                      className="size-[7px] rounded-[3px]"
                      style={{ background: v.color }}
                    />
                    {v.name}
                  </button>
                ))}
              </div>
            </Section>
          </TabsContent>

          {/* ----------------------------------------------------- models */}
          <TabsContent value="budgets"><BudgetSettings /></TabsContent>
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
                      "bg-card rounded-[14px] p-4.5 text-left transition-colors",
                      theme === id
                        ? "border-foreground"
                        : "hover:border-line-strong",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="size-4" strokeWidth={1.6} />
                      <span className="text-[14px] font-medium">{label}</span>
                      {theme === id && (
                        <Check className="ml-auto size-4" strokeWidth={2} />
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-[12.5px]">
                      {n}
                    </p>
                  </button>
                ))}
              </div>
            </Section>

            <PaletteSettings />

            <Section
              title="Type and density"
              hint="The interface uses a consistent type scale and spacing."
            >
              <div className="text-muted-foreground flex flex-wrap gap-4 font-mono text-[12.5px]">
                <span>body 14px</span>
                <span>rail 12.5px</span>
                <span>page title 25px</span>
                <span>radius 10px</span>
              </div>
            </Section>
          </TabsContent>

          {/* ----------------------------------------------------- server */}
          <TabsContent value="server" className="mt-2 divide-y">
            {/* Backups first: it is the only one of the three whose absence
                can cost anything that cannot be made again. */}
            <BackupsSettings />
            <CaptureSettings />
            <StudioSettings />
          </TabsContent>

          {/* ------------------------------------------------- deployment */}
          <TabsContent value="deployment" className="mt-2 divide-y">
            <DeploymentSettings />
          </TabsContent>

          {/* --------------------------------------------------- security */}
          <TabsContent value="security" className="mt-2 divide-y">
            <SecuritySettings />
          </TabsContent>

          {/* ------------------------------------------------------- data */}
          {/* -------------------------------------------------- migration */}
          <TabsContent value="migration" className="mt-2 divide-y">
            <MigrationSettings />
          </TabsContent>

          <TabsContent value="data" className="mt-2 divide-y">
            <Section
              title="What is stored"
              hint="Preferences sync to your local server and are included in backups. This browser keeps a cached copy. Ventures and connected accounts are managed separately."
            >
              <Tiles
                items={[
                  { v: state.ventures.length, k: "ventures" },
                  { v: state.sessions.length, k: "sessions" },
                  { v: state.dashboards.length, k: "dashboards" },
                  {
                    v: state.dashboards.reduce((n, d) => n + d.widgets.length, 0),
                    k: "placed widgets",
                  },
                ]}
              />
            </Section>

            <Section
              title="Export and import"
              hint="Export workspace preferences for portability. Imports replace dashboard layouts and session labels after validation and confirmation."
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
                  <span role="status" className="text-muted-foreground text-[13px]">
                    {note}
                  </span>
                )}
              </div>
            </Section>

            <Section
              title="Reset"
              hint="Restore the default workspace name and dashboard layouts. Your ventures, chats and accounts are preserved. A recovery copy is saved first."
            >
              <div>
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 -ml-3"
                  onClick={() => {
                    if (!window.confirm("Reset workspace preferences and dashboard layouts? A recovery copy will be saved first.")) return;
                    try {
                      reset();
                      setNote("Workspace reset to defaults.");
                    } catch {
                      setNote("The recovery copy could not be saved. Free browser storage space before resetting; your preferences have been kept.");
                    }
                  }}
                >
                  Reset to defaults
                </Button>
                <Button variant="outline" onClick={() => {
                  try {
                    const saved = JSON.parse(localStorage.getItem("opc-workspace-recovery") || "null");
                    if (!isStoreState(saved)) { setNote("No valid recovery copy is available."); return; }
                    if (!window.confirm("Restore the previous preferences? The current version will become the recovery copy.")) return;
                    importState(saved); setNote("Previous preferences restored.");
                  } catch { setNote("The recovery copy could not be read."); }
                }}>Restore previous preferences</Button>
              </div>
            </Section>
          </TabsContent>
        </Tabs>

        <Separator className="mt-8 mb-4" />
        <p className="text-muted-foreground text-[13.5px]">
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
