import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Check, Copy, LayoutTemplate } from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { VentureSelect } from "@/components/VentureSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DASHBOARD_PRESETS, SOURCES, WIDGETS } from "@/data/widgets";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * MAKING A DASHBOARD IS A PAGE, NOT A DIALOG.
 *
 * It was a 420-pixel dialog with a name box and a scrolling list of preset
 * names — "Money", "Servers", "Domains" — with nothing to say what any of
 * them would put on the board. Choosing between twelve templates you cannot
 * see is not a choice; it is a guess followed by a delete. So this is a page:
 * every template is a card that lists the widgets it places, grouped by the
 * plugin they read from, and every existing board is a card that can be
 * copied, wherever it lives. The page has an address, so "make a dashboard
 * for this venture" is a link the venture page can hand out.
 *
 * ONE CHOICE, TWO KINDS OF THING. A template or a copy — never both, which is
 * why they are one piece of state rather than two. Picking a copy with no
 * name typed takes the source board's name, which is what somebody copying a
 * board nearly always wants and can still type over.
 *
 * A TEMPLATE CAN BE CHOSEN BY THE ADDRESS. `?preset=<id>` opens the page with
 * that template already picked and its name in the box, which is what makes
 * "make me an Email stats board" a link. The four reports that used to be
 * fixed tabs on the Dashboards page redirect here that way — see
 * pages/Dashboards — so an old bookmark becomes an offer to make the board.
 * An id naming no template is ignored rather than argued with: the page still
 * opens, on Blank, which is where somebody who typed a bad link would rather
 * be than on an error.
 *
 * IT SEEDS THE CHOICE AND THEN GETS OUT OF THE WAY. The query is read once,
 * into the initialiser; pressing another template does not rewrite the
 * address, because the choice on this page is a draft and not a destination.
 *
 * WHERE IT LANDS IS THE FORM'S TO SAY. The global page offers a venture
 * dropdown with "Everything" at the top; the venture's own page arrives with
 * that venture chosen. Either way the board is made in the scope shown, and
 * the page navigates to it in edit mode, so the first thing after "Create" is
 * the board itself with its widget panel open.
 */
export function NewDashboard() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { state, addDashboard, copyDashboard } = useStore();

  const here = slug ? (state.ventures.find((v) => v.slug === slug) ?? null) : null;
  const asked = DASHBOARD_PRESETS.find((p) => p.id === params.get("preset")) ?? null;
  const [ventureId, setVentureId] = useState<string | null>(here?.id ?? null);
  /* The asked-for template's own label, typed for you. It is a board name
     somebody would have typed anyway, and it is over-typeable — which is the
     difference between a default and a decision. */
  const [name, setName] = useState(asked?.label ?? "");
  /* "preset:<id>" or "copy:<board id>" — see the header. */
  const [from, setFrom] = useState(`preset:${asked?.id ?? "blank"}`);
  const presetId = from.startsWith("preset:") ? from.slice(7) : null;
  const copyId = from.startsWith("copy:") ? from.slice(5) : null;

  /* Every board that exists, grouped by where it lives, in the owner's order.
     A venture with no boards is not drawn: an empty heading says nothing. */
  const groups = useMemo(
    () =>
      [
        { key: "global", name: "Everything", boards: state.dashboards.filter((d) => !d.ventureId) },
        ...state.ventures.map((v) => ({
          key: v.id,
          name: v.name,
          boards: state.dashboards.filter((d) => d.ventureId === v.id),
        })),
      ].filter((g) => g.boards.length),
    [state.dashboards, state.ventures],
  );

  const scope = ventureId ? state.ventures.find((v) => v.id === ventureId) : null;
  const basePath = scope ? `/ventures/${scope.slug}/dashboards` : "/dashboards";

  function create() {
    const title = name.trim();
    if (!title) return;
    const made = copyId
      ? copyDashboard(copyId, { name: title, ventureId })
      : addDashboard(title, presetId ?? "blank", ventureId);
    if (made) navigate(`${basePath}/${made.slug}`, { state: { editing: true } });
  }

  return (
    <>
      <TopBar label={here ? here.name : "Dashboards"} />
      <PageShell
        wide
        title="New dashboard"
        sub="Start from a template, or copy a board that already exists. Widgets draw from whatever plugins are connected; a widget for a plugin that is not says so on the board rather than showing a number."
        action={
          <Link
            to={here ? `/ventures/${here.slug}/dashboards` : "/dashboards"}
            className="text-muted-foreground hover:text-foreground text-[13.5px]"
          >
            Back to the boards
          </Link>
        }
      >
        <div className="flex flex-col gap-7">
          {/* ------------------------------------------------ name and scope */}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid gap-1.5">
              <Label htmlFor="board-name">Name</Label>
              <Input
                id="board-name"
                value={name}
                autoFocus
                autoComplete="off"
                placeholder="Morning check"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>For</Label>
              {/* A board is either about everything or about one venture,
                  where it is narrowed to that venture's host. The address it
                  gets follows from this, so it is chosen before the name is
                  taken. */}
              <VentureSelect
                ventures={state.ventures}
                value={ventureId}
                onChange={setVentureId}
                none="Everything"
              />
            </div>
          </div>

          {/* ------------------------------------------------- templates */}
          <section>
            <div className="mb-2 flex items-baseline gap-2">
              <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
                Templates
              </div>
              <span className="text-muted-foreground ml-auto text-[12.5px]">
                {DASHBOARD_PRESETS.length} to start from
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {DASHBOARD_PRESETS.map((p) => (
                <TemplateCard
                  key={p.id}
                  label={p.label}
                  note={p.note}
                  widgets={p.widgets}
                  chosen={presetId === p.id}
                  onChoose={() => setFrom(`preset:${p.id}`)}
                />
              ))}
            </div>
          </section>

          {/* ------------------------------------------------------ copies */}
          {groups.length > 0 && (
            <section>
              <div className="mb-2 flex items-baseline gap-2">
                <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
                  Copy an existing dashboard
                </div>
                <span className="text-muted-foreground ml-auto text-[12.5px]">
                  the same arrangement, new ids, wherever you put it
                </span>
              </div>
              <div className="flex flex-col gap-4">
                {groups.map((g) => (
                  <div key={g.key}>
                    <div className="text-muted-foreground mb-1.5 text-[12.5px]">{g.name}</div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {g.boards.map((d) => (
                        <TemplateCard
                          key={d.id}
                          label={d.name}
                          note={`${d.widgets.length} widget${d.widgets.length === 1 ? "" : "s"}`}
                          widgets={d.widgets.map((w) => w.type)}
                          copy
                          chosen={copyId === d.id}
                          onChoose={() => {
                            setFrom(`copy:${d.id}`);
                            if (!name.trim()) setName(d.name);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={create} disabled={!name.trim()}>
              Create
            </Button>
            <Button variant="ghost" asChild>
              <Link to={here ? `/ventures/${here.slug}/dashboards` : "/dashboards"}>Cancel</Link>
            </Button>
            <span className="text-muted-foreground text-[12.5px]">
              It opens in edit mode, so widgets can be added or taken off straight away.
            </span>
          </div>
        </div>
      </PageShell>
    </>
  );
}

/**
 * ONE THING TO START FROM. The widgets it would place are listed by name,
 * under the plugin each reads — which is the information the old dialog's
 * one-line note could not carry and the reason a person picks one board over
 * another. Long lists are cut with a count rather than scrolled: the card is
 * for choosing, and the board itself is where the full list lives.
 */
function TemplateCard({
  label,
  note,
  widgets,
  chosen,
  copy = false,
  onChoose,
}: {
  label: string;
  note: string;
  widgets: string[];
  chosen: boolean;
  copy?: boolean;
  onChoose: () => void;
}) {
  const bySource = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const type of widgets) {
      const w = WIDGETS[type];
      if (!w) continue;
      const src = SOURCES[w.src]?.name ?? w.src;
      out.set(src, [...(out.get(src) ?? []), w.name]);
    }
    return [...out.entries()];
  }, [widgets]);
  const shown = bySource.slice(0, 4);
  const more = bySource.slice(4).reduce((n, [, names]) => n + names.length, 0);
  const Icon = copy ? Copy : LayoutTemplate;

  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      className={cn(
        "bg-card hover:bg-card-hover flex flex-col gap-2 rounded-[14px] px-4 py-3.5 text-left transition-colors",
        chosen && "ring-foreground/60 ring-1",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="bg-muted text-foreground grid size-7 shrink-0 place-items-center rounded-lg">
          {chosen ? (
            <Check className="size-3.5" strokeWidth={2} />
          ) : (
            <Icon className="size-3.5" strokeWidth={1.6} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{label}</span>
        <span className="text-muted-foreground shrink-0 text-[11.5px]">
          {widgets.length === 0 ? "empty" : `${widgets.length} widget${widgets.length === 1 ? "" : "s"}`}
        </span>
      </span>
      <span className="text-muted-foreground text-[12.5px] leading-relaxed">{note}</span>
      {shown.length > 0 && (
        <span className="mt-0.5 flex flex-col gap-1">
          {shown.map(([src, names]) => (
            <span key={src} className="text-[12px] leading-snug">
              <span className="text-foreground">{src}</span>
              <span className="text-muted-foreground"> · {names.join(", ")}</span>
            </span>
          ))}
          {more > 0 && (
            <span className="text-muted-foreground text-[12px]">and {more} more</span>
          )}
        </span>
      )}
    </button>
  );
}
