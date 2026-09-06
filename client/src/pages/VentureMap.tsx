import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageShell, TopBar } from "@/components/PageShell";
import { BrandTile } from "@/components/BrandTile";
import { VentureMark } from "@/components/VentureChrome";
import { byPluginName, pluginLook } from "@/components/ventures/pluginLook";
import { useApi } from "@/hooks/useApi";
import { ventureApi } from "@/lib/api/ventures";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * HOW IT ALL CONNECTS: every venture, every integration, and the things they
 * hold between them.
 *
 * THE PICTURE IS THE POINT. The connections tab answers "what does this
 * venture own"; this answers the question nobody could ask before — "what does
 * this box hold that belongs to NOBODY", which on a box that has been
 * collecting for a while is usually most of it. A list would report that
 * number. A map shows it: three columns, a handful of coloured threads through
 * the middle, and a wall of grey either side of them.
 *
 * THE EDGES ARE SVG AND THE NODES ARE NOT, and that is a decision rather than
 * a compromise. Curves between two moving points are exactly what a path is
 * for and there is no library here to draw them. A node, though, is a favicon
 * measured off a real site, a brand glyph out of the icon set, a link to a
 * page — all of it already built, all of it drawn with the type scale the rest
 * of the app uses. Rebuilding that inside a <text> element would mean a second
 * venture mark, a second brand tile and a font stack maintained by hand. So the
 * layout is computed once, the curves are drawn into an absolutely positioned
 * SVG underneath, and the nodes sit over it at the same coordinates.
 *
 * UNLINKED ENTITIES ARE ONE GREY NODE PER INTEGRATION, not two hundred rows.
 * Drawing them individually would make the map unreadable to say something a
 * count says better — and the count is the finding. Press an integration to go
 * to its page, where every one of them is listed.
 */

/* The layout, in one place, because the SVG and the nodes must agree about it
   exactly — a node drawn eight pixels off its own edge is a picture that looks
   broken rather than one that is. */
const COL_V = 0;
const W_V = 196;
const COL_E = 316;
const W_E = 268;
const COL_P = 704;
const W_P = 206;
const WIDTH = COL_P + W_P;
/** Row pitch and node height. The gap between them is the breathing room. */
const RH = 34;
const NODE_H = 26;
const PAD = 14;

export function VentureMap() {
  const { data, error, loading } = useApi(() => ventureApi.map(), []);
  const { state } = useStore();
  const navigate = useNavigate();
  const [hover, setHover] = useState<string | null>(null);

  const layout = useMemo(() => {
    if (!data) return null;

    const plugins = [...data.plugins].sort((a, b) => byPluginName(a.id, b.id));
    const linkedKeys = new Set(data.edges.map((e) => `${e.plugin} ${e.entity}`));

    /* The middle column, grouped by integration so the threads to the right
       run roughly parallel instead of crossing the whole picture. */
    type Mid =
      | { kind: "entity"; key: string; plugin: string; entity: string; label: string }
      | { kind: "rest"; key: string; plugin: string; count: number };
    const mids: Mid[] = [];
    for (const p of plugins) {
      for (const e of data.entities)
        if (e.plugin === p.id && linkedKeys.has(`${e.plugin} ${e.entity}`))
          mids.push({
            kind: "entity",
            key: `${e.plugin} ${e.entity}`,
            plugin: e.plugin,
            entity: e.entity,
            label: e.label,
          });
      const rest = data.unlinked.filter((u) => u.plugin === p.id).length;
      if (rest)
        mids.push({ kind: "rest", key: `rest ${p.id}`, plugin: p.id, count: rest });
    }
    /* An edge can name an entity no collector currently reports — a zone
       deleted this morning, an integration between credentials. It is drawn
       rather than dropped, because that absence is the useful part. */
    for (const e of data.edges)
      if (!e.present && !mids.some((m) => m.key === `${e.plugin} ${e.entity}`))
        mids.push({
          kind: "entity",
          key: `${e.plugin} ${e.entity}`,
          plugin: e.plugin,
          entity: e.entity,
          label: e.label ?? e.entity,
        });

    const rows = Math.max(data.ventures.length, mids.length, plugins.length, 1);
    const inner = rows * RH;
    const y = (i: number, n: number) =>
      PAD + (inner - n * RH) / 2 + i * RH + RH / 2;

    const vY = new Map(data.ventures.map((v, i) => [v.id, y(i, data.ventures.length)]));
    const mY = new Map(mids.map((m, i) => [m.key, y(i, mids.length)]));
    const pY = new Map(plugins.map((p, i) => [p.id, y(i, plugins.length)]));

    return {
      plugins,
      mids,
      height: inner + PAD * 2,
      vY,
      mY,
      pY,
      present: new Set(data.entities.map((e) => `${e.plugin} ${e.entity}`)),
    };
  }, [data]);

  const faviconOf = (slug: string) =>
    state.ventures.find((v) => v.slug === slug) ?? null;

  return (
    <>
      <TopBar label="Ventures" />
      <PageShell
        wide
        title="How it all connects"
        sub={
          data ? (
            <>
              <b className="text-foreground font-medium">{data.ventures.length}</b>{" "}
              ventures,{" "}
              <b className="text-foreground font-medium">{data.plugins.length}</b>{" "}
              integrations and{" "}
              <b className="text-foreground font-medium">{data.entities.length}</b>{" "}
              things between them.{" "}
              <b className="text-foreground font-medium">{data.edges.length}</b>{" "}
              of those things have been claimed by a venture; {data.unlinked.length}{" "}
              belong to nobody.
            </>
          ) : (
            "Every venture, every integration, and which of them the owner has said belong together."
          )
        }
        action={
          <Link
            to="/ventures"
            className="text-muted-foreground hover:text-foreground text-[13.5px]"
          >
            Back to the list
          </Link>
        }
      >
        {error && <p className="text-destructive text-[13.5px]">{error}</p>}
        {!data && !error && (
          <p className="text-muted-foreground text-[13.5px]">
            {loading ? "Asking every integration what it holds…" : "Nothing came back."}
          </p>
        )}

        {data && layout && (
          <>
            <div className="overflow-x-auto">
              <div
                className="relative"
                style={{ width: WIDTH, height: layout.height }}
                onMouseLeave={() => setHover(null)}
              >
                {/* ------------------------------------------- the threads */}
                <svg
                  width={WIDTH}
                  height={layout.height}
                  className="absolute inset-0"
                  aria-hidden
                >
                  {/* Integration to thing: always grey, because that edge is
                      not a claim about ownership — it is where the thing
                      lives. */}
                  {layout.mids.map((m) => {
                    const y1 = layout.mY.get(m.key)!;
                    const y2 = layout.pY.get(m.plugin);
                    if (y2 === undefined) return null;
                    return (
                      <path
                        key={`p ${m.key}`}
                        d={curve(COL_E + W_E, y1, COL_P, y2)}
                        fill="none"
                        className="stroke-border"
                        strokeWidth={1}
                        strokeDasharray={m.kind === "rest" ? "3 3" : undefined}
                        opacity={hover ? 0.35 : 0.75}
                      />
                    );
                  })}

                  {/* Venture to thing: the owner's own statement, in the
                      venture's own colour. */}
                  {data.edges.map((e) => {
                    const key = `${e.plugin} ${e.entity}`;
                    const y1 = layout.vY.get(e.venture);
                    const y2 = layout.mY.get(key);
                    if (y1 === undefined || y2 === undefined) return null;
                    const v = data.ventures.find((x) => x.id === e.venture);
                    const on = !hover || hover === e.venture;
                    return (
                      <path
                        key={`v ${e.venture} ${key}`}
                        d={curve(W_V, y1, COL_E, y2)}
                        fill="none"
                        stroke={v?.color ?? "currentColor"}
                        strokeWidth={on ? 2 : 1.25}
                        strokeDasharray={e.present ? undefined : "4 3"}
                        opacity={on ? 0.85 : 0.12}
                      />
                    );
                  })}
                </svg>

                {/* ------------------------------------------- the ventures */}
                {data.ventures.map((v) => {
                  const stored = faviconOf(v.slug);
                  const on = !hover || hover === v.id;
                  const n = data.edges.filter((e) => e.venture === v.id).length;
                  return (
                    <div
                      key={v.id}
                      role="link"
                      tabIndex={0}
                      title={`${v.name} — ${n} ${n === 1 ? "link" : "links"}. Open its connections.`}
                      onMouseEnter={() => setHover(v.id)}
                      onFocus={() => setHover(v.id)}
                      onClick={() => navigate(`/ventures/${v.slug}/connections`)}
                      onKeyDown={(e) =>
                        e.key === "Enter" &&
                        navigate(`/ventures/${v.slug}/connections`)
                      }
                      style={{
                        left: COL_V,
                        top: layout.vY.get(v.id)! - NODE_H / 2,
                        width: W_V,
                        height: NODE_H,
                        borderColor: on ? v.color : undefined,
                        background: on ? `${v.color}14` : undefined,
                      }}
                      className={cn(
                        "absolute flex cursor-pointer items-center gap-2 rounded-[11px] border px-2 text-[13px] transition-opacity",
                        !on && "opacity-40",
                      )}
                    >
                      <VentureMark
                        venture={
                          stored ?? { name: v.name, color: v.color, brand: undefined }
                        }
                        size={15}
                      />
                      <span className="truncate">{v.name}</span>
                      <span className="text-muted-foreground ml-auto shrink-0 text-[12px]">
                        {n}
                      </span>
                    </div>
                  );
                })}

                {/* --------------------------------------------- the things */}
                {layout.mids.map((m) => {
                  const owners = data.edges.filter(
                    (e) => `${e.plugin} ${e.entity}` === m.key,
                  );
                  const on =
                    !hover ||
                    (m.kind === "entity" && owners.some((e) => e.venture === hover));
                  const colour =
                    m.kind === "entity" && owners[0]
                      ? (data.ventures.find((v) => v.id === owners[0].venture)?.color ??
                        null)
                      : null;
                  return (
                    <div
                      key={m.key}
                      title={
                        m.kind === "rest"
                          ? `${m.count} things ${pluginLook(m.plugin).name} holds that no venture has claimed.`
                          : `${m.entity} — ${pluginLook(m.plugin).name}`
                      }
                      style={{
                        left: COL_E,
                        top: layout.mY.get(m.key)! - NODE_H / 2,
                        width: W_E,
                        height: NODE_H,
                        borderColor: on && colour ? colour : undefined,
                      }}
                      className={cn(
                        "absolute flex items-center gap-2 rounded-[11px] border px-2 text-[13px] transition-opacity",
                        m.kind === "rest" && "border-dashed",
                        !on && "opacity-25",
                      )}
                    >
                      <span
                        className={cn(
                          "truncate",
                          m.kind === "rest" && "text-muted-foreground",
                        )}
                      >
                        {m.kind === "rest"
                          ? `${m.count} not linked to anything`
                          : m.label}
                      </span>
                      {m.kind === "entity" &&
                        !layout.present.has(m.key) && (
                          <span
                            title="Nothing currently reports this. A paused integration and a deleted zone look the same from here."
                            className="text-warn ml-auto shrink-0 text-[12px]"
                          >
                            missing
                          </span>
                        )}
                    </div>
                  );
                })}

                {/* --------------------------------------- the integrations */}
                {layout.plugins.map((p) => {
                  const look = pluginLook(p.id);
                  const on =
                    !hover ||
                    data.edges.some((e) => e.venture === hover && e.plugin === p.id);
                  return (
                    <Link
                      key={p.id}
                      to={`/integrations/${look.id}`}
                      title={`${look.name} — ${p.entities} ${p.entities === 1 ? "thing" : "things"}, ${p.connected ? "connected" : "not connected"}`}
                      style={{
                        left: COL_P,
                        top: layout.pY.get(p.id)! - NODE_H / 2,
                        width: W_P,
                        height: NODE_H,
                      }}
                      className={cn(
                        "hover:border-line-strong absolute flex items-center gap-2 rounded-[11px] border px-2 text-[13px] transition-opacity",
                        !on && "opacity-30",
                      )}
                    >
                      <BrandTile
                        icon={look.icon}
                        name={look.name}
                        mono={look.mono}
                        tint={look.tint}
                        className="size-[16px] rounded-[5px]"
                        glyphClassName="size-[10px] text-[10px]"
                      />
                      <span className="truncate">{look.name}</span>
                      <span
                        className={cn(
                          "ml-auto size-1.5 shrink-0 rounded-full",
                          p.connected ? "bg-ok" : "bg-border",
                        )}
                      />
                    </Link>
                  );
                })}
              </div>
            </div>

            <p className="text-muted-foreground mt-4 text-[12.5px] leading-relaxed">
              {data.note}
            </p>
            <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">
              Hover a venture to pick its threads out of the rest; press one to
              go to its connections. The dashed rows are everything an
              integration holds that nobody has claimed — press the integration
              to see them listed.
            </p>

            {/* Which listings answered, so an empty column reads as "asked and
                told nothing" rather than as "never asked". */}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
              {data.sources.map((s) => (
                <span
                  key={s.plugin}
                  title={s.note ?? undefined}
                  className="text-muted-foreground flex items-center gap-1.5 text-[12.5px]"
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      s.ok ? "bg-ok" : "bg-destructive",
                    )}
                  />
                  {s.plugin} · {s.entities}
                </span>
              ))}
            </div>
          </>
        )}
      </PageShell>
    </>
  );
}

/** A cubic between two points on facing edges. The control points sit at a
 *  fixed fraction of the horizontal gap, so a thread that climbs the whole
 *  picture and one that runs straight across leave at the same angle. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) * 0.5;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
