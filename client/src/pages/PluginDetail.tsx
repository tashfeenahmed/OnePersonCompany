import { useState, type ComponentType } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, ExternalLink, Plus, X } from "lucide-react";
import { ago, when } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { BrandTile } from "@/components/BrandTile";
import { TopBar } from "@/components/PageShell";
import { cn } from "@/lib/utils";
import { CATEGORIES, PLUGINS, type Plugin } from "@/data/plugins";
import { useStore } from "@/lib/store";
import { useApi } from "@/hooks/useApi";
import { api, type PluginAccount, type ServerPlugin } from "@/lib/api";
import { HetznerPanel } from "@/components/HetznerPanel";
import { TelegramPanel } from "@/components/TelegramPanel";
import { AgentPanel } from "@/components/AgentPanel";
import { RuntimeJobsPanel } from "@/areas/runtime/JobsPanel";
import { SearxngPanel } from "@/components/SearxngPanel";
import { FreeLlmApiPanel } from "@/components/FreeLlmApiPanel";
import { LocalModelsPanel, ProviderPolicyPanel } from "@/components/LocalModelsPanel";
import { UmamiPanel } from "@/components/integrations/UmamiPanel";
import { CalendarPanel } from "@/components/integrations/CalendarPanel";
import { PypiPanel } from "@/components/integrations/PypiPanel";
import { BlueskyPanel } from "@/components/integrations/BlueskyPanel";
import { UptimePanel } from "@/components/integrations/UptimePanel";
import { FleetPanel } from "@/components/integrations/FleetPanel";
import { ProductsPanel } from "@/components/integrations/ProductsPanel";
import { UsersPanel } from "@/components/integrations/UsersPanel";
import { BacklinksPanel } from "@/components/integrations/BacklinksPanel";
import { PresencePanel } from "@/components/integrations/PresencePanel";
import { VoicePanel } from "@/components/integrations/VoicePanel";
import { WorkstationPanel } from "@/areas/security/WorkstationPanel";

/**
 * The panels that follow a connection, one per plugin that has one.
 *
 * A MAP RATHER THAN TEN MORE `&&` LINES BELOW. The six panels this page grew
 * first are each conditional on something of their own — an agent's panel
 * ignores `connected`, SearXNG's has to sit ABOVE the credentials form — so
 * they stay written out where their exceptions can be read. These ten have no
 * exceptions: each draws what its integration last read, each is worth nothing
 * before there is a credential or a list, and a table is the honest shape for
 * ten identical rules.
 *
 * Every one of them draws its own empty state, because "connected and it found
 * nothing" is a real answer that a blank space would read as a page that
 * failed to load.
 */
const PANELS: Record<string, ComponentType<{ onCollected: () => void }>> = {
  umami: UmamiPanel,
  calendar: CalendarPanel,
  pypi: PypiPanel,
  bluesky: BlueskyPanel,
  uptime: UptimePanel,
  fleet: FleetPanel,
  "product-stats": ProductsPanel,
  users: UsersPanel,
  backlinks: BacklinksPanel,
  presence: PresencePanel,
  voice: VoicePanel,
  workstation: WorkstationPanel,
};

/** The vault name a field lands under: one field takes the base name, several
 *  take `base-fieldKey`. The same rule as agent/integrations.js. */
/**
 * The vault entry one field lands in.
 *
 * A field that names its own entry wins, because the real names in the vault
 * predate any scheme and not all of them fit one. Otherwise: a single field
 * writes to the plugin's own entry, and several fall back to the server
 * registry's `<stem>-<field>` derivation. This string is what the interface
 * tells the owner their credential is stored under, so a guess here sends them
 * looking for an entry that does not exist.
 */
function secretFor(p: Plugin, key: string) {
  const field = p.fields.find((f) => f.key === key);
  if (field?.entry) return field.entry;
  return p.fields.length > 1 ? `${p.secret}-${key}` : p.secret;
}

export function PluginDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, setPluginConnected } = useStore();
  const [saved, setSaved] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  /*
    A PANEL CAN WRITE A SETTING, and the form above it has to notice.

    "Suggest from ventures" on uptime, backlinks and presence appends to the
    very list the settings form is showing, and that form holds what the owner
    has typed — so it cannot simply re-fetch underneath them. Bumping this
    remounts it instead, which drops a half-typed value the owner did not save
    and shows the list that is actually stored. That is the right trade: the
    button they just pressed is what they meant.
  */
  const [configNonce, setConfigNonce] = useState(0);

  const plugin = PLUGINS.find((p) => p.id === id);

  // Is this one actually wired to the API, or still catalog-only? The server
  // answers that; the page does not assume it.
  const server = useApi(() => api.plugin(id ?? ""), [id]);
  /*
    COLLECTABLE OR MERELY CONFIGURABLE — either one means the API backs this
    plugin, and only the second is true of the four that COMPLETE rather than
    collect. The two agents and the model providers hold real accounts and run
    no collector (a completion is its own health check and happens when
    somebody asks, not on a timer), so asking only about a collector drew them
    the catalog-only form and the sentence "not wired to the API yet" under a
    credential the vault was already holding. The server has answered both
    questions since `configurable` was added beside `collectable`.
  */
  const live =
    !server.error &&
    (server.data?.collectable === true || server.data?.configurable === true);

  /*
    THE TWO AGENTS ARE THE ONLY PLUGINS WHERE CONNECTING IS NOT THE LAST STEP.

    Everywhere else on this page, a stored credential means the integration is
    working: the collector runs and the cards fill. Hermes and OpenClaw do the
    same job as each other, and exactly one of them answers the Chat page — so
    a perfectly good key here can sit beside a green dot while the OTHER agent
    is the one being talked to. That is a confusing state to be in silently,
    and this is the page somebody is standing on when they wonder about it, so
    the page says which it is and offers the one click that changes it.

    Fetched only for those two ids. Every other plugin gets `null` without a
    request, because a chat-backend lookup on the Stripe page would be a call
    made to render nothing.
  */
  const isAgent = id === "hermes" || id === "openclaw";
  const chat = useApi(
    () => (isAgent ? api.chatBackends() : Promise.resolve(null)),
    [id, isAgent],
  );
  const chatRow = chat.data?.backends.find((b) => b.id === id) ?? null;

  /*
    SEARXNG IS THE ONE INTEGRATION THIS BOX CAN INSTALL RATHER THAN CONNECT TO,
    and its panel needs to know which endpoint the settings hold — the same
    value the Settings section below edits. Fetched here rather than read out
    of that section, because the panel sits ABOVE it: the choice between "a
    node you already run" and "install one here" is the first thing on the
    page, and a panel that had to wait for a form further down to load would
    render the wrong half of it first. Only for this one id; every other plugin
    gets `null` without a request.
  */
  const isSearxng = id === "searxng";
  const searxConfig = useApi(
    () => (isSearxng ? api.pluginConfig("searxng") : Promise.resolve(null)),
    [id, isSearxng],
  );

  if (!plugin) {
    return (
      <>
        <TopBar label="Integrations" />
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
          <div className="mx-auto w-full max-w-[720px]">
            <h1 className="mt-2 mb-1 text-[27px] font-normal tracking-[-0.025em]">
              No such plugin
            </h1>
            <p className="text-muted-foreground mb-5 text-[14.5px]">
              Nothing in the catalog is called “{id}”.
            </p>
            <Button variant="outline" onClick={() => navigate("/integrations")}>
              <ArrowLeft className="size-[15px]" strokeWidth={1.8} />
              Back to plugins
            </Button>
          </div>
        </div>
      </>
    );
  }

  // A live plugin's truth is the server's row; a catalog-only one falls back
  // to the local store, which is all a mock has.
  const connected = live
    ? (server.data?.connected ?? false)
    : (state.plugins[plugin.id] ?? plugin.connected);
  const category = CATEGORIES.find((c) => c.id === plugin.cat)?.label;
  const accountCount = live ? (server.data?.accounts.length ?? 0) : 0;
  /* Looked up as a COMPONENT rather than called as a function: every one of
     these panels holds hooks of its own, and a called function would hand them
     to this component's hook list — conditionally, which is the one thing hooks
     cannot survive. */
  const AreaPanel = live && connected ? PANELS[plugin.id] : undefined;

  /* The catalog-only path: nothing is verified and nothing is collected,
     because there is no route behind it. A live plugin's credentials go
     through <Accounts> below, which talks to the vault. */
  function save() {
    setPluginConnected(plugin!.id, true);
    setSaved(true);
  }

  function disconnect() {
    setSaved(false);
    setProblem(null);
    setPluginConnected(plugin!.id, false);
  }

  return (
    <>
      <TopBar label="Integrations" />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
        <div className="mx-auto w-full max-w-[720px]">
          <Link
            to="/integrations"
            className="text-muted-foreground hover:text-foreground -ml-1.5 mb-4 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[13.5px]"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.6} />
            All integrations
          </Link>

          <div className="flex items-start gap-3.5">
            <BrandTile
              icon={plugin.icon}
              name={plugin.name}
              mono={plugin.mono}
              tint={plugin.tint}
              className="size-11 rounded-[16px]"
              glyphClassName="size-[22px] text-[18px]"
            />
            <div className="min-w-0 flex-1">
              <h1 className="text-[27px] leading-tight font-normal tracking-[-0.025em]">
                {plugin.name}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="secondary"
                  className={cn(
                    connected && "bg-ok-bg text-ok border-transparent",
                  )}
                >
                  {connected
                    ? "Connected"
                    : plugin.fields.length
                      ? "Not connected"
                      : "No key needed"}
                </Badge>
                {category && <Badge variant="secondary">{category}</Badge>}
                {/* WHAT IS ACTUALLY IN THE VAULT. A live plugin says how many
                    accounts it holds, because that is the fact a list of entry
                    names stops telling you once there are two of them — six
                    names in a row reads as six credentials rather than as
                    three accounts of two. The names are still there, one
                    account at a time, in the section below. A catalog-only
                    plugin has no accounts, so it shows the names it WOULD
                    write, derived the same way the server derives them. */}
                {live && !!accountCount && (
                  <Badge variant="secondary">
                    {accountCount} account{accountCount === 1 ? "" : "s"}
                  </Badge>
                )}
                {!live &&
                  (plugin.fields.length
                    ? plugin.fields.map((f) => secretFor(plugin, f.key))
                    : plugin.secret
                      ? [plugin.secret]
                      : []
                  ).map((name) => (
                    <Badge
                      key={name}
                      variant="secondary"
                      className="font-mono font-normal"
                    >
                      {name}
                    </Badge>
                  ))}
              </div>
            </div>
          </div>

          <p className="text-muted-foreground mt-5 text-[14.5px]">
            {plugin.help}
          </p>

          {plugin.docs && (
            <a
              href={plugin.docs}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:bg-accent hover:text-foreground -ml-2 mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13.5px]"
            >
              <ExternalLink className="size-3.5" strokeWidth={1.6} />
              Where to get this
            </a>
          )}

          {/*
            LIVE, READY, OR NEITHER — the three states, in the three sentences
            they deserve. "Connected" is deliberately not one of them: it is
            true in two of the three cases and answers the wrong question.
          */}
          {chatRow && (
            <div className="border-line-strong bg-card mt-4 flex items-start gap-2.5 rounded-[14px] border px-4.5 py-3.5">
              <span
                className={cn(
                  "mt-1.5 size-[7px] shrink-0 rounded-full",
                  chatRow.live ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
              <div className="text-[13.5px]">
                {chatRow.live ? (
                  <>
                    <span className="font-medium">
                      This is the live chat backend.
                    </span>{" "}
                    <span className="text-muted-foreground">
                      Every message from the Chat page is answered by{" "}
                      {chat.data?.liveLabel ?? plugin.name}. Only one agent is
                      live at a time.
                    </span>
                  </>
                ) : chatRow.connected ? (
                  <>
                    <span className="font-medium">Connected, not live.</span>{" "}
                    <span className="text-muted-foreground">
                      {chat.data?.live
                        ? `The Chat page is answered by ${chat.data.liveLabel} instead — only one agent is live at a time.`
                        : "No agent is live at the moment, so nothing is answering the Chat page."}
                    </span>
                    <button
                      onClick={() => {
                        void api
                          .setChatBackend(id === "hermes" ? "hermes" : "openclaw")
                          .then(() => chat.reload());
                      }}
                      className="hover:bg-accent border-line-strong mt-2 block rounded-lg border px-2.5 py-1 text-[13.5px]"
                    >
                      Make {plugin.name} the live backend
                    </button>
                  </>
                ) : (
                  <>
                    <span className="font-medium">Not connected.</span>{" "}
                    <span className="text-muted-foreground">
                      Paste the URL and the key below. Connecting does not make
                      it live — one agent answers the Chat page, and you choose
                      which from there or from here.
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          {/*
              THE CREDENTIALS SECTION IS TWO DIFFERENT THINGS, and it is worth
              saying which. A plugin the API actually backs holds a LIST of
              accounts, each with its own state, and is edited through the
              routes below. A catalog-only plugin has nowhere to store anything
              and falls back to the single local form it always had — showing
              it an accounts list would be showing a feature that does not
              exist for it yet.
          */}
          {/* The two doors onto a search node, before the form for one of
              them — see SearxngPanel: neither is the advanced path, so the
              page offers both rather than leading with the one that needs a
              second machine. */}
          {live && isSearxng && (
            <SearxngPanel
              endpoint={searxConfig.data?.config.url ?? null}
              onChanged={() => {
                server.reload();
                searxConfig.reload();
              }}
            />
          )}

          {live && !!plugin.fields.length && (
            <Accounts
              plugin={plugin}
              server={server.data}
              onChanged={() => server.reload()}
            />
          )}

          {!live && !!plugin.fields.length && (
            <>
              <Separator className="mt-7 mb-5" />
              <div className="text-muted-foreground mb-3 text-[12px] tracking-[0.06em] uppercase">
                Credentials
              </div>

              <div className="grid max-w-[520px] gap-4">
                {plugin.fields.map((f) => (
                  <div key={f.key} className="grid gap-1.5">
                    <Label htmlFor={`${plugin.id}-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`${plugin.id}-${f.key}`}
                      type={f.kind === "secret" ? "password" : "text"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={f.ph}
                      value={values[f.key] ?? ""}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [f.key]: e.target.value }))
                      }
                      className="font-mono text-[13.5px]"
                    />
                    <p className="text-muted-foreground text-[12px]">
                      {f.kind === "secret"
                        ? `Stored as ${secretFor(plugin, f.key)}, write-only — it is never read back out.`
                        : "Public by design — shown in full."}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Button onClick={save}>
                  {connected ? "Save changes" : "Connect"}
                </Button>
                {connected && (
                  <Button variant="ghost" onClick={disconnect}>
                    Disconnect
                  </Button>
                )}
                {saved && !problem && (
                  <span className="text-ok flex items-center gap-1.5 text-[13px]">
                    <Check className="size-3.5" strokeWidth={2} />
                    Written to the vault
                  </span>
                )}
                {problem && (
                  <span className="text-destructive text-[13px]">
                    {problem}
                  </span>
                )}
              </div>

              {!server.loading && (
                <p className="text-muted-foreground mt-3 text-[12.5px]">
                  Not wired to the API yet — this saves locally so the interface
                  can be used, but nothing is collected.
                </p>
              )}
            </>
          )}
          {live && (
            <PluginSettings
              key={`${plugin.id}-${configNonce}`}
              id={plugin.id}
              onSaved={() => server.reload()}
            />
          )}

          {live && connected && plugin.id === "hetzner" && (
            <HetznerPanel onCollected={() => server.reload()} />
          )}
          {live && connected && plugin.id === "telegram" && <TelegramPanel />}
          {/* The agents get their panel whether or not a credential has been
              pasted, which is the one place this page breaks its own rule that
              a panel follows a connection. It has to: the whole point of
              "spawn here" is that there is nothing to paste, and hiding the
              second path behind the first would leave an owner with no agent
              anywhere staring at a form asking for the address of one. */}
          {live && isAgent && <AgentPanel id={plugin.id as "hermes" | "openclaw"} />}
          {/* WHAT THAT AGENT'S OWN SCHEDULER HAS DONE, under the panel that
              installs and starts it. Both managed runtimes schedule work of
              their own; this reads it and relays the results, and creates
              nothing — see areas/runtime/JobsPanel.tsx. */}
          {live && isAgent && <RuntimeJobsPanel id={plugin.id as "hermes" | "openclaw"} />}

          {/*
              FREELLMAPI, AND NOT GATED ON `connected` — which is the point of
              it. The panel's whole left half is the path for somebody with no
              account at all: install the gateway here, and it mints its own
              key and connects itself. A panel that waited for a credential
              would be a panel that could never produce the one it was waiting
              for. It draws its own empty states.
          */}
          {live && plugin.id === "freellmapi" && <FreeLlmApiPanel />}

          {/* The endpoints, what each one is serving right now, and the policy
              that decides which takes the next call. Gated on `connected`,
              unlike FreeLLMAPI's above: there is nothing this panel can do for
              somebody with no endpoint, and an endpoints list over an empty
              credentials form is a panel about nothing. */}
          {live && connected && plugin.id === "local" && <LocalModelsPanel />}

          {/* The same policy block, smaller, on the two COST integrations that
              can also complete. It draws nothing until an inference key has
              been stored, so a page whose owner only wants the spend chart is
              exactly as it was. */}
          {live && connected && (plugin.id === "openai" || plugin.id === "openrouter") && (
            <ProviderPolicyPanel id={plugin.id} />
          )}

          {/* The ten manifest-area integrations. Gated on `connected` for the
              same reason Hetzner's is: there is nothing for a panel to draw
              before there is a credential or a list, and for five of these
              "connected" IS the list — which is why pressing Save on the
              settings form above is what makes one appear. */}
          {AreaPanel && (
            <AreaPanel
              onCollected={() => {
                server.reload();
                setConfigNonce((n) => n + 1);
              }}
            />
          )}

          {live && !!server.data?.runs.length && (
            <>
              <Separator className="mt-7 mb-5" />
              <div className="text-muted-foreground mb-3 text-[12px] tracking-[0.06em] uppercase">
                Recent collections
              </div>
              <div className="flex flex-col gap-1.5">
                {server.data.runs.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-baseline gap-2.5 text-[13px]"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                        r.ok === true && "bg-ok",
                        r.ok === false && "bg-destructive",
                        r.ok === null && "bg-border",
                      )}
                    />
                    <span className="text-muted-foreground min-w-0 truncate">
                      {r.note ?? r.error ?? "running…"}
                    </span>
                    <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[12px]">
                      {when(r.startedAt, { year: true })}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {!!plugin.usedBy.length && (
            <>
              <Separator className="mt-7 mb-5" />
              <div className="text-muted-foreground mb-3 text-[12px] tracking-[0.06em] uppercase">
                Read by
              </div>
              <ul className="flex flex-col gap-2">
                {plugin.usedBy.map((u) => (
                  <li
                    key={u}
                    className="text-muted-foreground flex items-baseline gap-2 font-mono text-[13px] leading-relaxed"
                  >
                    <span>→</span>
                    {u}
                  </li>
                ))}
              </ul>
            </>
          )}

          <Separator className="mt-7 mb-5" />
          <div className="text-muted-foreground mb-3 text-[12px] tracking-[0.06em] uppercase">
            Also in {category}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PLUGINS.filter(
              (p) => p.cat === plugin.cat && p.id !== plugin.id,
            ).map((p) => (
              <Link
                key={p.id}
                to={`/plugins/${p.id}`}
                className="bg-card hover:bg-card-hover flex items-center gap-2 rounded-[12px] px-3 py-2 text-[13.5px] transition-colors"
              >
                <BrandTile
                  icon={p.icon}
                  name={p.name}
                  mono={p.mono}
                  tint={p.tint}
                  className="size-[18px] rounded-[7px]"
                  glyphClassName="size-[10px] text-[9px]"
                />
                {p.name}
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    (state.plugins[p.id] ?? p.connected)
                      ? "bg-ok"
                      : "bg-border",
                  )}
                />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ settings */

/**
 * SETTINGS THAT ARE NOT CREDENTIALS — and the difference is the whole reason
 * this is a separate section rather than another row in the credentials form.
 *
 * npm forced it. Its downloads API is public, so there is no key to paste and
 * no account to hold one; what it needs instead is a LIST of which packages
 * are mine, and that is a thing the owner maintains by hand. So it is READ
 * BACK IN FULL, unlike every value in the vault: a write-only field you can
 * never check is a field that eventually holds a typo forever, and "did I
 * spell the scope right" is not a question anybody should have to answer by
 * re-typing four package names.
 *
 * The keys come from the server rather than from the local catalog, because
 * the server is what refuses one it does not recognise. A page that offered a
 * setting the route would reject would be a page inventing a feature.
 *
 * A plugin with no settings renders nothing at all — not an empty panel with a
 * heading, which reads as something that failed to load.
 */
function PluginSettings({ id, onSaved }: { id: string; onSaved: () => void }) {
  const settings = useApi(() => api.pluginConfig(id), [id]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const keys = settings.data?.keys ?? [];
  if (settings.error || !keys.length) return null;

  const value = (key: string) =>
    typed[key] ?? keys.find((k) => k.key === key)?.value ?? "";

  async function save() {
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      const next = Object.fromEntries(keys.map((k) => [k.key, value(k.key)]));
      await api.savePluginConfig(id, next);
      setTyped({});
      setSaved(true);
      // Saving collects immediately, so the runs list below has something new
      // to show — the point of setting this is to see the numbers.
      settings.reload();
      onSaved();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="text-muted-foreground mb-3 text-[12px] tracking-[0.06em] uppercase">
        Settings
      </div>

      <div className="grid max-w-[520px] gap-4">
        {keys.map((k) => (
          <div key={k.key} className="grid gap-1.5">
            <Label htmlFor={`${id}-cfg-${k.key}`}>{k.label}</Label>
            <Input
              id={`${id}-cfg-${k.key}`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={k.ph ?? undefined}
              value={value(k.key)}
              onChange={(e) =>
                setTyped((v) => ({ ...v, [k.key]: e.target.value }))
              }
              className="font-mono text-[13.5px]"
            />
            <p className="text-muted-foreground text-[12px]">{k.hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
        {saved && !problem && (
          <span className="text-ok flex items-center gap-1.5 text-[13px]">
            <Check className="size-3.5" strokeWidth={2} />
            Saved, and collected
          </span>
        )}
        {problem && (
          <span className="text-destructive text-[13px]">{problem}</span>
        )}
      </div>
      <p className="text-muted-foreground mt-3 text-[12.5px]">
        Public by design — stored beside the plugin rather than in the vault,
        and shown here in full.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ accounts */

/**
 * Every account this plugin holds, and the three things you can do to one.
 *
 * WHAT AN ACCOUNT ROW HAS TO SAY, and why each part earns its place:
 *
 *   — whether it works, as its own state rather than the plugin's. Two
 *     Hetzner projects where one token has been revoked is a plugin that is
 *     still connected and an account that is not, and a single green dot over
 *     the pair is the lie this whole change exists to remove.
 *   — WHEN it last worked, kept apart from when the credential was stored. A
 *     key pasted five minutes ago that has never answered is not the same
 *     thing as one that answered five minutes ago, and one line saying
 *     "updated 5m ago" would read as both.
 *   — its last error, in the provider's own words. "Hetzner rejected that
 *     token (401)" tells the owner where to go; "failed" does not.
 *   — the vault entries it owns, BY NAME. Never a value: there is no route
 *     that returns one and this file could not render one if it tried.
 */
function Accounts({
  plugin,
  server,
  onChanged,
}: {
  plugin: Plugin;
  server: ServerPlugin | null;
  onChanged: () => void;
}) {
  /* Which form is open: an account id to replace that one's credentials,
     "new" to add another, or nothing. One at a time, because two open forms
     on one page make "which one did Save mean" a real question. */
  const [open, setOpen] = useState<number | "new" | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const accounts = server?.accounts ?? [];

  function begin(which: number | "new", initialLabel = "") {
    setOpen(which);
    setValues({});
    setLabel(initialLabel);
    setProblem(null);
    setDone(null);
  }

  function close() {
    setOpen(null);
    setValues({});
    setLabel("");
  }

  /** Every mutation goes through here so that a refusal is shown EXACTLY as
   *  the provider phrased it — the server checked the credential against the
   *  real API before storing it, and that sentence is the useful part. */
  async function run(fn: () => Promise<unknown>, said: string) {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      await fn();
      setDone(said);
      close();
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const typed = Object.values(values).some((v) => v.trim());

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="mb-3 flex items-center gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Credentials
        </div>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {accounts.length
            ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}`
            : "nothing connected"}
        </span>
      </div>

      {!accounts.length && (
        <p className="text-muted-foreground mb-4 text-[14px]">
          Nothing is stored for {plugin.name} yet. Add an account below and it
          is checked against {plugin.name} before anything is written down.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            plugin={plugin}
            account={a}
            editing={open === a.id}
            busy={busy}
            values={values}
            label={label}
            onLabel={setLabel}
            onValue={(k, v) => setValues((old) => ({ ...old, [k]: v }))}
            onEdit={() => begin(a.id, a.label)}
            onCancel={close}
            onSave={() =>
              run(
                () =>
                  api.updateAccount(plugin.id, a.id, {
                    label: label.trim() || undefined,
                    // A field left blank keeps the value already in the vault.
                    // The server fills the gaps and verifies the WHOLE set, so
                    // "change just the secret" is still checked as a pair.
                    ...(typed ? { fields: values } : {}),
                  }),
                typed ? "Verified and stored" : "Renamed",
              )
            }
            onRemove={() =>
              run(
                () => api.removeAccount(plugin.id, a.id),
                `${a.label} removed`,
              )
            }
          />
        ))}
      </div>

      {open === "new" ? (
        <div className="mt-2 rounded-[14px] bg-card p-3.5">
          <div className="mb-3 text-[14px] font-medium">
            Add another account
          </div>
          <AccountForm
            plugin={plugin}
            label={label}
            onLabel={setLabel}
            values={values}
            onValue={(k, v) => setValues((old) => ({ ...old, [k]: v }))}
            labelHint="What this one is — the project or the login it covers."
            fieldHint={(f) => f.ph ?? ""}
          />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !typed}
              onClick={() =>
                run(
                  () => api.addAccount(plugin.id, label.trim(), values),
                  "Verified and stored",
                )
              }
            >
              {busy ? "Checking…" : "Add account"}
            </Button>
            <Button size="sm" variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => begin("new")}
        >
          <Plus className="size-3.5" strokeWidth={1.8} />
          {accounts.length ? "Add another account" : "Add an account"}
        </Button>
      )}

      {problem && (
        <p className="text-destructive mt-3 text-[13px]">{problem}</p>
      )}
      {done && !problem && (
        <p className="text-ok mt-3 flex items-center gap-1.5 text-[13px]">
          <Check className="size-3.5" strokeWidth={2} />
          {done}
        </p>
      )}

      <p className="text-muted-foreground mt-3 text-[12.5px]">
        Every account is checked against {plugin.name} before it is stored, then
        encrypted with AES-256-GCM in the server's vault under its own entry
        name. The browser never holds a value and no route reads one back.
      </p>
    </>
  );
}

function AccountRow({
  plugin,
  account,
  editing,
  busy,
  values,
  label,
  onLabel,
  onValue,
  onEdit,
  onCancel,
  onSave,
  onRemove,
}: {
  plugin: Plugin;
  account: PluginAccount;
  editing: boolean;
  busy: boolean;
  values: Record<string, string>;
  label: string;
  onLabel: (v: string) => void;
  onValue: (key: string, value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  /* THREE STATES, NOT TWO. Connected-and-working, connected-but-the-provider
     refused it, and not connected at all. Folding the middle one into either
     neighbour is how a revoked token spends a week looking fine. */
  const failing = account.connected && !!account.lastError;

  return (
    <div className="rounded-[14px] bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            failing ? "bg-destructive" : account.connected ? "bg-ok" : "bg-border",
          )}
        />
        <span className="text-[14px] font-medium">{account.label}</span>
        <Badge
          variant="secondary"
          className={cn(
            !failing && account.connected && "bg-ok-bg text-ok border-transparent",
            failing && "text-destructive border-transparent",
          )}
        >
          {failing ? "Failing" : account.connected ? "Connected" : "Not connected"}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={editing ? onCancel : onEdit}
            disabled={busy}
          >
            {editing ? "Cancel" : "Replace credentials"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Disconnect ${account.label}`}
            title={`Disconnect ${account.label}`}
          >
            <X className="size-3.5" strokeWidth={1.8} />
          </Button>
        </div>
      </div>

      {/* Two dates, because they answer two questions. "Stored" is how old the
          credential is; "last read" is whether it still works. A single line
          would have to pick one and would be read as the other. */}
      <div className="text-muted-foreground mt-1.5 text-[12.5px]">
        stored {ago(account.updatedAt)} · last read{" "}
        {account.lastOkAt ? ago(account.lastOkAt) : "not yet"}
      </div>

      {account.lastError && (
        <p className="text-destructive mt-1.5 text-[12.5px]">
          {account.lastError}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {account.secrets.map((e) => (
          <Badge key={e.name} variant="secondary" className="font-mono font-normal">
            {e.name}
          </Badge>
        ))}
      </div>

      {editing && (
        <div className="border-line-soft mt-3.5 border-t pt-3.5">
          <AccountForm
            plugin={plugin}
            label={label}
            onLabel={onLabel}
            values={values}
            onValue={onValue}
            labelHint="Renaming is local — the vault entry keeps the name its value was sealed under."
            fieldHint={() => "leave blank to keep what is stored"}
          />
          <div className="mt-4">
            <Button size="sm" onClick={onSave} disabled={busy}>
              {busy ? "Checking…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The label and the plugin's own fields. Shared by "add" and "replace" so the
 *  two cannot drift into asking for different things. */
function AccountForm({
  plugin,
  label,
  onLabel,
  values,
  onValue,
  labelHint,
  fieldHint,
}: {
  plugin: Plugin;
  label: string;
  onLabel: (v: string) => void;
  values: Record<string, string>;
  onValue: (key: string, value: string) => void;
  labelHint: string;
  fieldHint: (f: Plugin["fields"][number]) => string;
}) {
  return (
    <div className="grid max-w-[520px] gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${plugin.id}-label`}>Name</Label>
        <Input
          id={`${plugin.id}-label`}
          value={label}
          autoComplete="off"
          onChange={(e) => onLabel(e.target.value)}
          placeholder="Account 1"
          className="text-[13.5px]"
        />
        <p className="text-muted-foreground text-[12px]">{labelHint}</p>
      </div>

      {plugin.fields.map((f) => (
        <div key={f.key} className="grid gap-1.5">
          <Label htmlFor={`${plugin.id}-${f.key}`}>{f.label}</Label>
          <Input
            id={`${plugin.id}-${f.key}`}
            type={f.kind === "secret" ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={fieldHint(f)}
            value={values[f.key] ?? ""}
            onChange={(e) => onValue(f.key, e.target.value)}
            className="font-mono text-[13.5px]"
          />
          <p className="text-muted-foreground text-[12px]">
            {/* An optional field says so HERE as well as in its label, because
                the label is what a reader skims and this is where they look
                when they are stuck on an empty box. */}
            {f.optional ? "Optional — leave it empty if there is nothing to paste. " : ""}
            {f.kind === "secret"
              ? "Write-only — it is never read back out."
              : "Public by design — shown in full."}
          </p>
        </div>
      ))}
    </div>
  );
}
