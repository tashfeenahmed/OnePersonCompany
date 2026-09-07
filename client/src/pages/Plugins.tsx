import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { SubTabs } from "@/components/TabStrip";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { BrandTile } from "@/components/BrandTile";
import { PageShell, TopBar } from "@/components/PageShell";
import { cn } from "@/lib/utils";
import { CATEGORIES, PLUGINS } from "@/data/plugins";
import { useStore } from "@/lib/store";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";

export function Plugins() {
  const { state } = useStore();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");

  // The catalog carries the starting answer; the store carries what has been
  // changed since, so this page and a plugin's own page always agree.
  // Server-backed plugins report their own truth; the rest fall back to the
  // local store. One map either way, so the grid does not have to care.
  const server = useApi(() => api.plugins(), []);

  /* One row per server-backed plugin, so the grid can say both "connected"
     and "connected, but one of its two accounts is refusing" — which are
     different facts. */
  const rows = useMemo(
    () => new Map((server.data?.plugins ?? []).map((p) => [p.id, p])),
    [server.data],
  );

  /*
    A ROW IS WHAT MAKES A PLUGIN LIVE, not membership of `configurable`.

    `configurable` is the CREDENTIAL registry — the plugins with a vault entry
    to write — and keying off it meant every integration whose configuration is
    a LIST rather than a key read its state out of this browser's own store.
    npm, Hacker News and now PyPI, Bluesky, uptime, backlinks and presence: all
    of them genuinely connected on the server, all of them drawn from a local
    flag that nothing on the server has ever seen. That flag is mock data, and
    the AdSense correction this file already carries is the same mistake — a
    dot saying "Connected" about something nobody measured.

    So: a plugin the server has a row for is answered by the server, whether
    what it holds is a credential or a list. Everything else — the catalog
    entries with no route behind them yet — keeps the local fallback, which is
    all a mock has.
  */
  const connected = useMemo(
    () =>
      Object.fromEntries(
        PLUGINS.map((p) => [
          p.id,
          rows.has(p.id)
            ? rows.get(p.id)!.connected
            : (state.plugins[p.id] ?? p.connected),
        ]),
      ),
    [state.plugins, rows],
  );

  const total = PLUGINS.length;
  const on = PLUGINS.filter((p) => connected[p.id]).length;

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return PLUGINS.filter((p) => {
      if (cat === "connected" && !connected[p.id]) return false;
      if (cat !== "all" && cat !== "connected" && p.cat !== cat) return false;
      if (!needle) return true;
      const hay =
        `${p.name} ${p.desc} ${p.secret ?? ""} ${p.cat}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [q, cat, connected]);

  const grouped =
    cat === "all" || cat === "connected"
      ? CATEGORIES.filter((c) => c.id !== "all" && c.id !== "connected")
          .map((c) => [c.label, visible.filter((p) => p.cat === c.id)] as const)
          .filter(([, items]) => items.length)
      : ([[null, visible]] as const);

  return (
    <>
      <TopBar label="Integrations">
        <button className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13.5px]">
          <Plus className="size-3.5" strokeWidth={1.6} />
          Add custom
        </button>
      </TopBar>

      <PageShell
        title="Integrations"
        sub={
          <>
            <b className="text-foreground font-medium">{on}</b> of{" "}
            <b className="text-foreground font-medium">{total}</b> connected.
            Keys are stored in the encrypted vault and never shown again once
            saved.
          </>
        }
      >
        <div className="relative mb-4">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-[15px] -translate-y-1/2"
            strokeWidth={1.6}
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search integrations…"
            className="pl-8"
          />
        </div>

        <SubTabs
          tabs={CATEGORIES.map((c) => ({
            key: c.id,
            label: c.label,
            count:
              c.id === "all"
                ? total
                : c.id === "connected"
                  ? on
                  : PLUGINS.filter((p) => p.cat === c.id).length,
          }))}
          activeKey={cat}
          onSelect={setCat}
          className="mb-4.5"
        />

        {!visible.length && (
          <p className="text-muted-foreground py-8 text-[14px]">
            Nothing matches that. Every integration here is custom built — if it
            is missing, it has not been wired up yet.
          </p>
        )}

        {grouped.map(([label, items]) => (
          <div key={label ?? "flat"}>
            {label && (
              <div className="text-muted-foreground mt-6 mb-2.5 text-[12px] tracking-[0.06em] uppercase first:mt-1">
                {label}
              </div>
            )}
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(268px,1fr))]">
              {items.map((p) => (
                <Link
                  key={p.id}
                  to={`/integrations/${p.id}`}
                  className="bg-card hover:bg-card-hover flex items-start gap-3 rounded-[14px] p-4.5 text-left transition-colors active:translate-y-px"
                >
                  <BrandTile
                    icon={p.icon}
                    name={p.name}
                    mono={p.mono}
                    tint={p.tint}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14.5px] font-medium tracking-tight">
                        {p.name}
                      </span>
                      <span
                        className={cn(
                          "ml-auto size-1.5 shrink-0 rounded-full",
                          connected[p.id] ? "bg-ok" : "bg-border",
                        )}
                      />
                    </div>
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[13px]">
                      {p.desc}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {rows.has(p.id) && (
                        <Badge
                          variant="outline"
                          className="font-normal"
                          title={
                            p.fields.length
                              ? "Backed by the API — real credentials, real data"
                              : "Backed by the API — no key to paste, but the state and the data are real"
                          }
                        >
                          live
                        </Badge>
                      )}
                      <Badge
                        variant="secondary"
                        className={cn(
                          connected[p.id] &&
                            "bg-ok-bg text-ok border-transparent",
                        )}
                      >
                        {connected[p.id]
                          ? "Connected"
                          : p.fields.length
                            ? "Set up"
                            : "No key needed"}
                      </Badge>
                      {/* WHAT IS BEHIND THE DOT. A live plugin says how many
                          accounts it holds and how many of them are failing —
                          because "Connected" over two accounts where one has
                          been revoked is true and useless. A catalog-only
                          plugin has no accounts to count, so it keeps naming
                          the vault entry it would write. */}
                      {rows.has(p.id)
                        ? (() => {
                            const row = rows.get(p.id);
                            if (!row?.accounts.length) return null;
                            const failing = row.accounts.filter(
                              (a) => a.connected && a.lastError,
                            ).length;
                            return (
                              <>
                                <Badge variant="secondary">
                                  {row.accounts.length} account
                                  {row.accounts.length === 1 ? "" : "s"}
                                </Badge>
                                {!!failing && (
                                  <Badge
                                    variant="secondary"
                                    className="text-destructive border-transparent"
                                  >
                                    {failing} failing
                                  </Badge>
                                )}
                              </>
                            );
                          })()
                        : p.secret && (
                            <Badge
                              variant="secondary"
                              className="font-mono font-normal"
                            >
                              {p.secret}
                            </Badge>
                          )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </PageShell>
    </>
  );
}
