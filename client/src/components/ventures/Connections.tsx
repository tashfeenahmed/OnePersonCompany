import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandTile } from "@/components/BrandTile";
import { byPluginName, pluginLook } from "@/components/ventures/pluginLook";
import { useApi } from "@/hooks/useApi";
import { ventureApi, type VentureLinks } from "@/lib/api/ventures";
import { cn } from "@/lib/utils";

/**
 * WHAT THIS BUSINESS OWNS, ACROSS TWENTY-SEVEN INTEGRATIONS.
 *
 * A Cloudflare zone, a Search Console property and a Resend sending domain are
 * three views of one thing the owner runs, and until this table existed
 * nothing on the box said so. Every figure on every other page could be shown;
 * none of them could be captioned with a business's name.
 *
 * A SUGGESTION IS EVIDENCE AND A LINK IS A DECISION, and the two halves of
 * this screen are drawn differently on purpose. `acme.ie` and `acme.so` can be
 * two separate businesses: a box that filed one under the other because the hostnames
 * rhymed would be wrong in a way nobody notices until a revenue figure carries
 * the wrong name. So a suggestion always shows the SENTENCE that produced it —
 * the server's own `why`, quoted rather than summarised — and nothing is
 * written until somebody presses something.
 *
 * "ACCEPT ALL" IS ONE PRESS FOR A LIST, and the links it makes are recorded as
 * `auto` for that reason. Accepting one row by hand records `owner`, which is
 * the stronger statement — somebody looked at this one thing and said yes — and
 * re-linking promotes an auto row to it. Nothing ever demotes.
 *
 * THE SUGGESTION LIST IS FILTERED AGAINST THE LINKS HERE, because the route
 * currently offers rows that are already linked. Accepting one is harmless —
 * the insert does nothing — but a list that proposes what is already on the
 * screen above it reads as an app that has not looked at its own state.
 */
export function Connections({
  slug,
  doc,
  error,
  loading,
  reload,
  onLinksChanged,
}: {
  slug: string;
  doc: VentureLinks | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** The page above holds these too: they are what its boards are narrowed
   *  by, so a link made here changes the numbers on the next tab. */
  onLinksChanged: (links: VentureLinks["links"]) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const linked = useMemo(
    () => new Set((doc?.links ?? []).map((l) => `${l.plugin} ${l.entity}`)),
    [doc],
  );
  const suggestions = (doc?.suggestions ?? []).filter(
    (s) => !linked.has(`${s.plugin} ${s.entity}`),
  );

  const groups = useMemo(() => {
    const by = new Map<string, VentureLinks["links"]>();
    for (const l of doc?.links ?? []) {
      const list = by.get(l.plugin);
      if (list) list.push(l);
      else by.set(l.plugin, [l]);
    }
    return [...by.entries()].sort((a, b) => byPluginName(a[0], b[0]));
  }, [doc]);

  /** Every write answers with the table afterwards, so the page redraws from
   *  the server's copy rather than from its own guess at one — and then reloads
   *  for the suggestions, which the write did not recompute. */
  async function run(key: string, fn: () => Promise<{ links: VentureLinks["links"] }>) {
    setBusy(key);
    setFailed(null);
    try {
      const res = await fn();
      onLinksChanged(res.links);
      reload();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (error)
    return (
      <Body>
        <p className="text-destructive text-[13.5px]">{error}</p>
      </Body>
    );
  if (!doc)
    return (
      <Body>
        <p className="text-muted-foreground text-[13.5px]">
          {loading ? "Reading the connection table…" : "Nothing came back."}
        </p>
      </Body>
    );

  return (
    <Body>
      {failed && <p className="text-destructive text-[13.5px]">{failed}</p>}

      {/* ------------------------------------------------------- linked */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[14px] font-medium">
            Linked{doc.links.length ? ` · ${doc.links.length}` : ""}
          </h2>
          <button
            onClick={() => setAdding((v) => !v)}
            className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1.5 text-[12.5px]"
          >
            <Plus className="size-3.5" strokeWidth={1.6} />
            {adding ? "Close" : "Add link"}
          </button>
        </div>
        <p className="text-muted-foreground mb-2 text-[12.5px]">
          Each row is the owner’s own statement that this thing belongs to this
          business. Nothing here was inferred when the page loaded.
        </p>

        {adding && (
          <AddLink
            slug={slug}
            linked={linked}
            busy={busy}
            onAdd={(plugin, entity, label) =>
              run(`add ${plugin} ${entity}`, () =>
                ventureApi.link(slug, plugin, entity, label),
              )
            }
          />
        )}

        {groups.length ? (
          <div className="flex flex-col gap-3">
            {groups.map(([plugin, links]) => {
              const look = pluginLook(plugin);
              return (
                <div key={plugin} className="flex gap-3">
                  <BrandTile
                    icon={look.icon}
                    name={look.name}
                    mono={look.mono}
                    tint={look.tint}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {look.known ? (
                        <Link
                          to={`/integrations/${look.id}`}
                          className="text-[13.5px] font-medium hover:underline"
                        >
                          {look.name}
                        </Link>
                      ) : (
                        <span
                          title="No integration card carries this id — the link still works, and unlinking it still works."
                          className="text-[13.5px] font-medium"
                        >
                          {look.name}
                        </span>
                      )}
                      <span className="text-muted-foreground text-[12.5px]">
                        {links.length}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-col gap-px">
                      {links.map((l) => {
                        const key = `${l.plugin} ${l.entity}`;
                        return (
                          <div
                            key={key}
                            className="group hover:bg-accent -mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px]"
                          >
                            <span className="truncate">
                              {l.label ?? l.entity}
                            </span>
                            {l.label && l.label !== l.entity && (
                              <span
                                title="The integration's own identifier for it — what the link is stored against."
                                className="text-muted-foreground truncate text-[12px]"
                              >
                                {l.entity}
                              </span>
                            )}
                            <span
                              title={
                                l.source === "owner"
                                  ? "Linked one at a time — somebody looked at this and said yes."
                                  : "Came in with “Accept all”. Linking it by hand promotes it."
                              }
                              className="text-muted-foreground ml-auto shrink-0 text-[12px]"
                            >
                              {l.source === "owner" ? "by hand" : "in bulk"}
                            </span>
                            <button
                              onClick={() =>
                                void run(key, () =>
                                  ventureApi.unlink(slug, l.plugin, l.entity),
                                )
                              }
                              disabled={busy === key}
                              title={`Unlink ${l.entity}`}
                              className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-40"
                            >
                              <X className="size-3.5" strokeWidth={1.6} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground text-[13.5px]">
            Nothing linked yet, so this venture’s boards are narrowed by its
            hostname alone.
          </p>
        )}
      </section>

      {/* --------------------------------------------------- suggestions */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[14px] font-medium">
            Suggested{suggestions.length ? ` · ${suggestions.length}` : ""}
          </h2>
          {suggestions.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={busy === "accept-all"}
              onClick={() =>
                void run("accept-all", () => ventureApi.acceptAll(slug))
              }
            >
              {busy === "accept-all"
                ? "Accepting…"
                : `Accept all ${suggestions.length}`}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground mb-2 text-[12.5px]">{doc.note}</p>

        {suggestions.length ? (
          <div className="flex flex-col gap-1.5">
            {suggestions.map((s) => {
              const key = `${s.plugin} ${s.entity}`;
              const look = pluginLook(s.plugin);
              return (
                <div
                  key={key}
                  className="flex items-start gap-2.5 rounded-[14px] bg-card px-3 py-2.5"
                >
                  <BrandTile
                    icon={look.icon}
                    name={look.name}
                    mono={look.mono}
                    tint={look.tint}
                    className="size-[22px] rounded-[8px]"
                    glyphClassName="size-[12px] text-[11px]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px]">{s.label}</div>
                    {/* The server's sentence, quoted. It is the whole reason
                        this row can be accepted without opening anything. */}
                    <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">
                      {s.why}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    disabled={busy === key}
                    onClick={() =>
                      void run(key, () =>
                        ventureApi.link(slug, s.plugin, s.entity, s.label),
                      )
                    }
                  >
                    <Check className="size-3.5" strokeWidth={1.6} />
                    Accept
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground text-[13.5px]">
            Nothing left to propose. Anything else that belongs to this venture
            has to be linked by hand — a name that does not match a hostname is
            not evidence.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------- sources */}
      <section>
        <h2 className="mb-2 text-[14px] font-medium">Where the list came from</h2>
        <p className="text-muted-foreground mb-2 text-[12.5px]">
          Every listing that was asked, and what it said. “Nothing from Umami”
          and “Umami was never asked” are different answers.
        </p>
        <div className="flex flex-col gap-px">
          {doc.sources.map((s) => (
            <div
              key={s.plugin}
              className="flex items-baseline gap-2 py-1 text-[13.5px]"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                  s.ok ? "bg-ok" : "bg-destructive",
                )}
              />
              <span className="shrink-0">{s.plugin}</span>
              <span className="text-muted-foreground shrink-0 text-[12.5px]">
                {s.entities} {s.entities === 1 ? "thing" : "things"}
              </span>
              {s.note && (
                <span className="text-muted-foreground truncate text-[12.5px]">
                  {s.note}
                </span>
              )}
            </div>
          ))}
        </div>
      </section>
    </Body>
  );
}

/**
 * LINKING SOMETHING BY HAND.
 *
 * The choice is an integration and then one of its things, in that order,
 * because "which Cloudflare zone" is a question with twenty-three answers and
 * "which integration" is one with sixteen. The entity list is the map's, which
 * is every entity on the box rather than one plugin's — the same document the
 * connection map draws — so one fetch answers the whole picker.
 *
 * A thing already linked to ANOTHER venture is shown and says whose it is,
 * rather than being hidden. Two ventures sharing one Gmail account is a real
 * arrangement, and an app that quietly removed the row would be deciding
 * something the owner is better placed to decide.
 */
function AddLink({
  slug,
  linked,
  busy,
  onAdd,
}: {
  slug: string;
  linked: Set<string>;
  busy: string | null;
  onAdd: (plugin: string, entity: string, label: string) => void;
}) {
  const { data: map, error, loading } = useApi(() => ventureApi.map(), []);
  const [plugin, setPlugin] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const plugins = useMemo(
    () =>
      [...new Set((map?.entities ?? []).map((e) => e.plugin))].sort(byPluginName),
    [map],
  );

  const mine = map?.ventures.find((v) => v.slug === slug)?.id ?? null;
  const owners = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const e of map?.edges ?? []) {
      if (e.venture === mine) continue;
      const name = map?.ventures.find((v) => v.id === e.venture)?.name;
      if (!name) continue;
      const key = `${e.plugin} ${e.entity}`;
      const list = by.get(key);
      if (list) list.push(name);
      else by.set(key, [name]);
    }
    return by;
  }, [map, mine]);

  const rows = useMemo(() => {
    if (!plugin) return [];
    const needle = q.trim().toLowerCase();
    return (map?.entities ?? [])
      .filter((e) => e.plugin === plugin)
      .filter(
        (e) =>
          !needle ||
          e.label.toLowerCase().includes(needle) ||
          e.entity.toLowerCase().includes(needle),
      )
      .slice(0, 60);
  }, [map, plugin, q]);

  return (
    <div className="mb-3 rounded-[14px] bg-card p-3">
      {error && <p className="text-destructive text-[13.5px]">{error}</p>}
      {!map && !error && (
        <p className="text-muted-foreground text-[13.5px]">
          {loading ? "Reading every integration’s things…" : "Nothing came back."}
        </p>
      )}

      {map && (
        <>
          <div className="text-muted-foreground mb-1.5 text-[12.5px]">
            Which integration?
          </div>
          <div className="flex flex-wrap gap-1.5">
            {plugins.map((p) => {
              const look = pluginLook(p);
              return (
                <button
                  key={p}
                  onClick={() => {
                    setPlugin(p === plugin ? null : p);
                    setQ("");
                  }}
                  aria-pressed={p === plugin}
                  className={cn(
                    "hover:border-line-strong rounded-lg border px-2 py-1 text-[13px]",
                    p === plugin && "bg-accent border-line-strong",
                  )}
                >
                  {look.name}
                  <span className="text-muted-foreground ml-1.5 text-[12px]">
                    {map.entities.filter((e) => e.plugin === p).length}
                  </span>
                </button>
              );
            })}
          </div>

          {plugin && (
            <div className="mt-3">
              <div className="relative mb-1.5">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={`Filter ${pluginLook(plugin).name}…`}
                  className="h-8 pl-8 text-[13.5px]"
                />
              </div>
              <div className="flex max-h-[260px] flex-col gap-px overflow-y-auto">
                {rows.map((e) => {
                  const key = `${e.plugin} ${e.entity}`;
                  const elsewhere = owners.get(key);
                  const already = linked.has(key);
                  return (
                    <button
                      key={key}
                      disabled={already || busy === `add ${key}`}
                      onClick={() => onAdd(e.plugin, e.entity, e.label)}
                      className="hover:bg-accent flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13.5px] disabled:opacity-45"
                    >
                      <span className="truncate">{e.label}</span>
                      {e.host && e.host !== e.label && (
                        <span className="text-muted-foreground truncate text-[12px]">
                          {e.host}
                        </span>
                      )}
                      <span className="text-muted-foreground ml-auto shrink-0 text-[12px]">
                        {already
                          ? "already linked"
                          : elsewhere
                            ? `also ${elsewhere.join(", ")}’s`
                            : ""}
                      </span>
                    </button>
                  );
                })}
                {!rows.length && (
                  <p className="text-muted-foreground py-2 text-[13px]">
                    {q
                      ? "Nothing matches that."
                      : "That integration reports nothing at the moment. It can still be linked by hand from the map."}
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The tab's own scroller, the same width the overview uses. */
function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-16">
      <div className="mx-auto flex w-full max-w-[940px] flex-col gap-6">
        {children}
      </div>
    </div>
  );
}
