import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ExternalLink,
  LayoutDashboard,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageShell, TopBar } from "@/components/PageShell";
import { TabStrip } from "@/components/TabStrip";
import { BoardView, NewDashboardDialog, NoBoard } from "@/components/BoardView";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { Audit } from "@/components/ventures/Audit";
import { Connections } from "@/components/ventures/Connections";
import { Site } from "@/components/ventures/Site";
import { useApi } from "@/hooks/useApi";
import { api, VENTURE_STAGES, type Venture as VentureDoc } from "@/lib/api";
import { ventureApi, type VentureLinks } from "@/lib/api/ventures";
import { ScopeProvider } from "@/lib/live";
import { useStore } from "@/lib/store";

/**
 * ONE VENTURE: what it is, what is happening to it, and its own dashboards.
 *
 * THE SAME SHAPE AS APPS AND DASHBOARDS — a strip of tabs, the URL as the
 * selection — because it is navigated the same way and the eye should learn
 * one pattern. Overview is a tab rather than a page above the tabs, so moving
 * between "how is it doing" and a board is one press in either direction.
 *
 * ITS DASHBOARDS ARE NARROWED TO ITS HOST. That is what a venture board is
 * for: on the global Search board "impressions" is twenty-three properties
 * added together, and here it is this one site. The narrowing is a provider
 * around the board rather than a prop through it — see lib/scope.ts for what
 * can honestly be narrowed and what is marked portfolio-wide instead.
 *
 * A venture with NO website is not an error and not an empty page: the boards
 * show the whole portfolio and say so under the title. Filtering everything
 * away because nobody has typed a URL would be a page pretending to measure.
 *
 * SINCE THE LINK TABLE EXISTS, THE HOST IS NOT THE ONLY JOIN. A venture owns a
 * Cloudflare zone id, a Search Console property, an uptime host — the owner
 * said so, one row at a time — and those statements narrow the boards more
 * precisely than a hostname guess ever could. So this page reads the venture's
 * links and hands them to the scope beside the host.
 */
/** The tabs that are not dashboards. Named once, because the strip builds them
 *  and the reorder handler has to be able to throw them away again. */
const FIXED_TABS = new Set(["overview", "connections", "site", "audit"]);

/**
 * What the board says it was narrowed to.
 *
 * BOTH HALVES OR NEITHER. The host is a guess that usually lands — a Cloudflare
 * zone called `example-app-1.example.test` almost certainly is Example App 1's — and a link is
 * the owner having said so. A card narrowed by seven links and a hostname is a
 * different claim from one narrowed by a hostname alone, so the sub-line says
 * which, and a venture with no website says that it is showing everything
 * rather than quietly showing nothing.
 */
function scopeNote(host: string | null, links: number): string {
  const named = links ? ` · ${links} ${links === 1 ? "link" : "links"}` : "";
  if (host) return `scoped to ${host}${named}`;
  return links
    ? `no website — scoped to ${links} linked ${links === 1 ? "thing" : "things"}`
    : "no website — showing the whole portfolio";
}

export function Venture() {
  const { slug, board: boardSlug } = useParams();
  /*
    WHICH TAB, OUT OF THE PATH. `useParams` cannot tell /ventures/x from
    /ventures/x/dashboards — both leave `board` undefined — and the four fixed
    tabs are literal segments rather than a `:tab` param, because a param there
    would also match /ventures/x/edit and swallow the form. So the segment is
    read straight off the path: "" is the overview, and everything else is
    named below.
  */
  const tab = useLocation().pathname.split("/")[3] ?? "";
  const bare = tab === "dashboards" && !boardSlug;
  const { state, dashboardsIn, addDashboard, copyDashboard, reorderDashboards } =
    useStore();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const venture = state.ventures.find((v) => v.slug === slug);
  const boards = venture ? dashboardsIn(venture.id) : [];
  const board = boardSlug ? boards.find((d) => d.slug === boardSlug) : undefined;

  /*
    THE LINK TABLE IS READ FOR TWO TABS AND NO OTHERS. It is not an expensive
    document but it is not a free one either — the route recomputes every
    suggestion out of live tables on each read, which is a dozen queries and up
    to eight loopback calls — and the overview does not use it. So it is
    fetched when the connections tab is open, which is what it is for, and when
    a board is open, which is what narrows it.
  */
  const wantsLinks = !!venture && !!slug && (tab === "connections" || !!board);
  const links = useApi(
    () => (wantsLinks && slug ? ventureApi.links(slug) : Promise.resolve(null)),
    [slug, wantsLinks],
  );
  /* A new array every render, deliberately: `ScopeProvider` keys on the
     CONTENTS of this list, not on its identity, for exactly this reason. */
  const linked = (links.data?.links ?? []).map((l) => ({
    plugin: l.plugin,
    entity: l.entity,
  }));

  if (!venture)
    return (
      <>
        <TopBar label="Ventures" />
        <PageShell
          title="No venture at this address"
          sub={`Nothing here is called “${slug}”. It may have been deleted, or the list may not have loaded yet.`}
        >
          <div className="flex flex-wrap gap-1.5">
            {state.ventures.map((v) => (
              <Link
                key={v.id}
                to={`/ventures/${v.slug}`}
                className="hover:bg-accent flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px]"
              >
                <VentureMark venture={v} size={16} />
                {v.name}
              </Link>
            ))}
          </div>
        </PageShell>
      </>
    );

  const basePath = `/ventures/${venture.slug}/dashboards`;

  /* The bare /ventures/<slug>/dashboards names no board. It lands on the first
     one and rewrites itself to that board's own address — the same way
     /dashboards does — and on the overview when there is none, because a
     venture with no boards has nothing at that path to be shown. */
  if (!boardSlug && bare)
    return (
      <Navigate
        to={boards[0] ? `${basePath}/${boards[0].slug}` : `/ventures/${venture.slug}`}
        replace
      />
    );

  function create(name: string, presetId: string | null, copyFromId: string | null) {
    const made = copyFromId
      ? copyDashboard(copyFromId, { name, ventureId: venture!.id })
      : addDashboard(name, presetId ?? "blank", venture!.id);
    if (made) navigate(`${basePath}/${made.slug}`, { state: { editing: true } });
  }

  const palette = (
    [
      ["primary", venture.brand.palette.primary],
      ["secondary", venture.brand.palette.secondary],
      ["accent", venture.brand.palette.accent],
    ] as const
  ).filter(([, hex]) => !!hex);

  return (
    <>
      {/* The header stays put across the tabs: it is what the page is ABOUT,
          and a board opening under a different heading would read as a
          different page. */}
      <header className="flex h-12 shrink-0 items-center gap-2.5 px-4.5">
        <VentureMark venture={venture} size={18} />
        <span className="text-[13px] font-medium tracking-tight">
          {venture.name}
        </span>
        <StagePill stage={venture.stage} />
        {venture.website && (
          <a
            href={venture.website}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11.5px]"
          >
            {venture.host}
            <ExternalLink className="size-3" strokeWidth={1.6} />
          </a>
        )}

        {/* The measured palette, at a glance. Hex in the tooltip rather than on
            the page: the colours are the answer and the codes are the working
            out. */}
        {palette.length > 0 && (
          <span className="flex items-center gap-1">
            {palette.map(([role, hex]) => (
              <span
                key={role}
                title={`${role} · ${hex} — measured from ${venture.host ?? "the site"}`}
                className="size-[11px] rounded-[3px]"
                style={{ background: hex! }}
              />
            ))}
          </span>
        )}

        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to={`/ventures/${venture.slug}/edit`}>
            <Pencil className="size-3.5" strokeWidth={1.6} />
            Edit
          </Link>
        </Button>
      </header>

      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4.5">
        <TabStrip
          tabs={[
            { key: "overview", to: `/ventures/${venture.slug}`, label: "Overview" },
            {
              key: "connections",
              to: `/ventures/${venture.slug}/connections`,
              label: "Connections",
              /* Only once it is known. A zero beside the label while the
                 table is still being read would be a measurement. */
              count: links.data?.links.length,
            },
            { key: "site", to: `/ventures/${venture.slug}/site`, label: "Site" },
            { key: "audit", to: `/ventures/${venture.slug}/audit`, label: "Audit" },
            ...boards.map((d) => ({
              key: d.id,
              to: `${basePath}/${d.slug}`,
              label: d.name,
              count: d.widgets.length,
            })),
          ]}
          activeKey={board ? board.id : boardSlug ? null : tab || "overview"}
          /* The four fixed tabs are not boards and cannot be dragged out of
             the front: their keys are dropped before the order reaches the
             store, which only ever knew about dashboards. */
          onReorder={(keys) =>
            reorderDashboards(keys.filter((k) => !FIXED_TABS.has(k)))
          }
        />
        <button
          onClick={() => setCreating(true)}
          className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
        >
          <Plus className="size-3.5" strokeWidth={1.6} />
          New dashboard
        </button>
      </div>

      {boardSlug && !board && (
        <NoBoard
          title="No dashboard at this address"
          body={`${venture.name} has nothing called “${boardSlug}”.`}
          boards={boards}
          basePath={basePath}
          onCreate={create}
        />
      )}

      {board && (
        <ScopeProvider
          hosts={venture.host ? [venture.host] : []}
          entities={linked}
        >
          <BoardView
            key={board.id}
            board={board}
            basePath={basePath}
            homePath={`/ventures/${venture.slug}`}
            ventureId={venture.id}
            scopeNote={scopeNote(venture.host, linked.length)}
          />
        </ScopeProvider>
      )}

      {!boardSlug && !tab && (
        <Overview venture={venture} onNewDashboard={() => setCreating(true)} />
      )}

      {tab === "connections" && slug && (
        <Connections
          slug={slug}
          doc={links.data}
          error={links.error}
          loading={links.loading}
          reload={links.reload}
          onLinksChanged={(rows) =>
            links.setData((d: VentureLinks | null) =>
              d ? { ...d, links: rows } : d,
            )
          }
        />
      )}

      {tab === "site" && <Site venture={venture} />}

      {tab === "audit" && <Audit venture={venture} />}

      <NewDashboardDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={create}
      />
    </>
  );
}

/**
 * The openers, tuned by stage.
 *
 * NOT A GENERIC "ASK ME ANYTHING" ROW. An idea and a launched product want
 * opposite conversations — one wants to know whether to build the thing at
 * all, the other wants to know why people are leaving — and a screen that
 * offers "How is it doing this month?" for something that does not exist yet
 * is the app admitting it has not read its own record.
 */
function openersFor(stage: VentureDoc["stage"], name: string): string[] {
  if (stage === "idea")
    return [
      `Size the market for ${name}`,
      `Who else does what ${name} would do, and what do they charge?`,
      `What would a first version of ${name} need?`,
      `What would have to be true for ${name} to be worth building?`,
    ];
  if (stage === "pre-launch")
    return [
      `Write the launch checklist for ${name}`,
      `Draft the landing page copy for ${name}`,
      `What should ${name} charge at launch?`,
      `Who are the first ten people to tell about ${name}?`,
    ];
  return [
    `How is ${name} doing this month?`,
    `Where is churn coming from on ${name}?`,
    `What is the one growth move for ${name}?`,
    `What is quietly broken on ${name}?`,
  ];
}

function Overview({
  venture,
  onNewDashboard,
}: {
  venture: VentureDoc;
  onNewDashboard: () => void;
}) {
  const { sessionsFor, dashboardsIn, enrichVenture } = useStore();
  const { data: board } = useApi(() => api.board(), []);
  const [reading, setReading] = useState(false);

  const chats = sessionsFor(venture.id);
  const boards = dashboardsIn(venture.id);
  const stage = VENTURE_STAGES.find((s) => s.id === venture.stage);

  /* This venture's work, still grouped by the column it sits in — a count
     would say there is something to do and the columns say what kind. Done is
     kept out: the board's own totals treat the column as the truth. */
  const columns = (board?.columns ?? [])
    .filter((c) => c.key !== "done")
    .map((c) => ({
      title: c.title,
      cards: c.cards.filter((card) => card.ventureId === venture.id),
    }))
    .filter((c) => c.cards.length);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-16">
      <div className="mx-auto flex w-full max-w-[940px] flex-col gap-6">
        {venture.description && (
          <p className="text-[13.5px] leading-relaxed">{venture.description}</p>
        )}
        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          {stage?.note}
        </p>

        {/* ---------------------------------------------------- ask */}
        <Section
          icon={Sparkles}
          title="Ask the agent"
          note="These carry the venture with them, so the answer knows what it is about."
        >
          <div className="grid gap-1.5 sm:grid-cols-2">
            {openersFor(venture.stage, venture.name).map((q) => (
              <Link
                key={q}
                to={`/?venture=${encodeURIComponent(venture.id)}&q=${encodeURIComponent(q)}`}
                className="hover:border-line-strong rounded-[10px] border px-3 py-2.5 text-[12.5px] leading-snug transition-colors"
              >
                {q}
              </Link>
            ))}
          </div>

          {/*
            THE SECOND ROW IS NOT MORE QUESTIONS — IT IS WORK.

            Everything above opens a chat: an answer in a minute, out of what
            the box already holds. Everything below queues a RUN: minutes of
            the agent investigating with its tools, on the server, surviving
            this tab, ending in a report that is kept and a set of cards this
            venture's board can be offered.

            That is a big enough difference to be worth a visual break rather
            than four more chips in the same grid — pressing one of these is a
            decision to spend real time and, on a paid provider, real money.
            They are smaller and quieter than the questions for the same
            reason: the cheap thing should be the easy thing to reach for.

            They carry `?venture=` and nothing else. The app on the other end
            preselects this venture and then waits, because the inputs and the
            history belong to the app and duplicating its Run button here would
            mean a press from this page could start work without ever showing
            what was about to be started.
          */}
          <div className="border-line-soft mt-3 flex flex-wrap gap-1.5 border-t pt-3">
            {(
              [
                ["research", "Run research"],
                ["competitors", "Sweep competitors"],
                ["seo", "SEO review"],
                ["demand", "Read demand"],
                ["visibility", "Ask the models"],
                ["papers", "Write a paper"],
              ] as const
            ).map(([slug, label]) => (
              <Link
                key={slug}
                to={`/apps/${slug}?venture=${encodeURIComponent(venture.id)}`}
                className="text-muted-foreground hover:border-line-strong hover:text-foreground rounded-[9px] border px-2.5 py-1.5 text-[12px] transition-colors"
              >
                {label}
              </Link>
            ))}
          </div>
          <p className="text-muted-foreground mt-1.5 text-[11.5px]">
            These queue long agent work rather than opening a chat — minutes,
            one at a time, and it carries on with this tab shut.
          </p>
        </Section>

        {/* -------------------------------------------------- board */}
        <Section
          title="On the board"
          note="Cards filed under this venture, in the column they are in."
          action={
            <Link
              to="/apps/board"
              className="text-muted-foreground hover:text-foreground text-[11.5px]"
            >
              Open the board
            </Link>
          }
        >
          {columns.length ? (
            <div className="flex flex-col gap-3">
              {columns.map((c) => (
                <div key={c.title}>
                  <div className="text-muted-foreground mb-1 text-[11.5px]">
                    {c.title} · {c.cards.length}
                  </div>
                  <div className="flex flex-col gap-px">
                    {c.cards.slice(0, 6).map((card) => (
                      <div
                        key={card.id}
                        className="truncate rounded-md px-1.5 py-1 text-[12.5px]"
                      >
                        {card.title}
                      </div>
                    ))}
                    {c.cards.length > 6 && (
                      <span className="text-muted-foreground px-1.5 pt-1 text-[11.5px]">
                        {c.cards.length - 6} more
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-[12.5px]">
              {board
                ? "Nothing filed under this venture."
                : "The board could not be read."}
            </p>
          )}
        </Section>

        {/* ----------------------------------------------- sessions */}
        <Section
          icon={MessageSquare}
          title="Chats"
          note="Sessions are one flat list; these are the ones that named this venture."
          action={
            <Link
              to={`/?venture=${encodeURIComponent(venture.id)}`}
              className="text-muted-foreground hover:text-foreground text-[11.5px]"
            >
              New chat
            </Link>
          }
        >
          {chats.length ? (
            <div className="flex flex-col gap-px">
              {chats.map((s) => (
                <Link
                  key={s.id}
                  to={`/chat/${encodeURIComponent(s.id)}`}
                  className="hover:bg-accent -mx-1.5 truncate rounded-md px-1.5 py-1 text-[12.5px]"
                >
                  {s.title}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-[12.5px]">
              Nothing asked about this one yet.
            </p>
          )}
        </Section>

        {/* --------------------------------------------- dashboards */}
        <Section
          icon={LayoutDashboard}
          title="Dashboards"
          note={
            venture.host
              ? `Narrowed to ${venture.host}. Figures with no per-site breakdown say so on the card.`
              : "No website yet, so these show the whole portfolio."
          }
        >
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {boards.map((d) => (
              <Link
                key={d.id}
                to={`/ventures/${venture.slug}/dashboards/${d.slug}`}
                className="hover:border-line-strong rounded-[10px] border p-3 transition-colors"
              >
                <div className="text-[12.5px] font-medium">{d.name}</div>
                <div className="text-muted-foreground mt-0.5 text-[11.5px]">
                  {d.widgets.length}{" "}
                  {d.widgets.length === 1 ? "widget" : "widgets"}
                </div>
              </Link>
            ))}
            <button
              onClick={onNewDashboard}
              className="text-muted-foreground hover:border-line-strong hover:text-foreground flex min-h-[62px] items-center justify-center gap-2 rounded-[10px] border border-dashed text-[12.5px] transition-colors"
            >
              <Plus className="size-3.5" strokeWidth={1.6} />
              New dashboard
            </button>
          </div>
        </Section>

        {/* -------------------------------------------------- brand
            THE SHORT VERSION. What was read, and when. The photograph, the
            rendered reading, the two palettes side by side and the statement
            about which of them is in use are all one tab away on Site — this
            is the summary that stops the overview from becoming that page. */}
        <Section
          title="Brand"
          note="Measured from the site, not written here."
          action={
            venture.website ? (
              <div className="flex items-center gap-3">
                <Link
                  to={`/ventures/${venture.slug}/site`}
                  className="text-muted-foreground hover:text-foreground text-[11.5px]"
                >
                  The page and both readings
                </Link>
                <button
                  onClick={() => {
                    setReading(true);
                    void enrichVenture(venture.id).finally(() => setReading(false));
                  }}
                  disabled={reading}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[11.5px]"
                >
                  <RefreshCw className="size-3.5" strokeWidth={1.6} />
                  {reading ? "Reading…" : "Re-read the site"}
                </button>
              </div>
            ) : undefined
          }
        >
          {!venture.website && (
            <p className="text-muted-foreground text-[12.5px]">
              No website on this venture, so nothing has been read.
            </p>
          )}

          {/* An outright failure is stated plainly rather than left as an
              absence: "the site could not be reached" and "the site has no
              icon" look identical on a page that only draws what it found. */}
          {venture.brand.error && (
            <p className="text-destructive text-[12.5px]">
              {venture.brand.error}
            </p>
          )}

          {venture.website && !venture.brand.error && (
            <div className="flex flex-col gap-2 text-[12.5px]">
              {venture.brand.title && <div>{venture.brand.title}</div>}
              {venture.brand.description && (
                <p className="text-muted-foreground">
                  {venture.brand.description}
                </p>
              )}
              {venture.brand.palette.ranked.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  {venture.brand.palette.ranked.slice(0, 8).map((c) => (
                    <span
                      key={c.hex}
                      title={`${c.hex} · weight ${c.weight}`}
                      className="size-[16px] rounded-[4px] border"
                      style={{ background: c.hex }}
                    />
                  ))}
                </div>
              )}
              {/* The fonts and the notes about what could not be measured are
                  on the Site tab, beside the rendered reading they are meant
                  to be compared with. */}
              <p className="text-muted-foreground text-[11.5px]">
                {venture.brand.enrichedAt
                  ? `Read ${new Date(venture.brand.enrichedAt).toLocaleString()}`
                  : "Never read."}
                {venture.brand.notes.length > 0 &&
                  ` · ${venture.brand.notes.length} ${venture.brand.notes.length === 1 ? "note" : "notes"} about what could not be measured`}
              </p>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

/** One block of the overview: a heading, a sentence saying what it is, and an
 *  optional control on the right. */
function Section({
  icon: Icon,
  title,
  note,
  action,
  children,
}: {
  icon?: typeof Sparkles;
  title: string;
  note?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        {Icon && (
          <Icon className="text-muted-foreground size-3.5" strokeWidth={1.6} />
        )}
        <h2 className="text-[13px] font-medium">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {note && (
        <p className="text-muted-foreground mb-2 text-[11.5px]">{note}</p>
      )}
      {children}
    </section>
  );
}
