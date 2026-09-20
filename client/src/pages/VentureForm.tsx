import { businessTypesOf, toggleBusinessType } from "../../../shared/businessTypes";
import { BUSINESS_TYPES, type BusinessType } from "../../../shared/ventureJourney";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { BUSINESS_TYPE_ICONS } from "@/data/businessTypeIcons";
import { when } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageShell, TopBar } from "@/components/PageShell";
import { VentureMark } from "@/components/VentureChrome";
import { cn } from "@/lib/utils";
import { VENTURE_STAGES, type Venture, type VentureStage } from "@/lib/api";
import { VENTURE_COLORS, useStore } from "@/lib/store";

/**
 * NEW VENTURE, AND EDIT VENTURE — A PAGE, NOT A DIALOG.
 *
 * It was a dialog with a name, a description and seven colours, which is about
 * the right size for a dialog. It is not the right size for what a venture has
 * to say now: what it is, where it lives, and WHICH STAGE IT IS AT — the last
 * being the field the agent's advice turns on, and one that needs three
 * sentences beside it to be answered honestly rather than clicked past.
 *
 * A dialog is for a decision you have already made. This is a form you think
 * in, and it has its own address so it can be linked to, backed out of, and
 * arrived at from the chat picker.
 *
 * THE SITE IS READ ON SAVE, BY THE SERVER. Creating with a website takes as
 * long as fetching that site — a few seconds — so the button says what it is
 * doing. It cannot fail the create: a site that will not answer leaves a
 * reason on the venture's brand and the venture exists regardless, which is
 * why there is no "could not read the site" error path here.
 */
export function VentureForm() {
  const { slug } = useParams();
  const { state } = useStore();

  /* Editing an address this browser has not heard of. The cache may simply not
     have arrived yet, but saying "not found" for a venture that exists is the
     smaller wrong than showing an empty form that would CREATE a second one. */
  const venture = slug ? state.ventures.find((v) => v.slug === slug) : undefined;
  if (slug && !venture)
    return (
      <>
        <TopBar label="Ventures" />
        <PageShell
          title="No venture at this address"
          sub={`Nothing here is called “${slug}”. It may have been deleted, or the list may not have loaded yet.`}
        >
          <Button asChild variant="outline">
            <Link to="/ventures">Back to ventures</Link>
          </Button>
        </PageShell>
      </>
    );

  /* Keyed, so the fields initialise from the venture once rather than through
     an effect that resets them on every render. */
  return <Form key={venture?.id ?? "new"} venture={venture} />;
}

function Form({ venture }: { venture?: Venture }) {
  const { addVenture, updateVenture, deleteVenture, enrichVenture, dashboardsIn } =
    useStore();
  const navigate = useNavigate();

  const [name, setName] = useState(venture?.name ?? "");
  const [description, setDescription] = useState(venture?.description ?? "");
  const [website, setWebsite] = useState(venture?.website ?? "");
  /* `?stage=` — the New menu opens this form already at Idea, Pre-launch or
     Launched. The starting value; an edit ignores it. */
  const [params] = useSearchParams();
  const asked = VENTURE_STAGES.find(s => s.id === params.get("stage"))?.id;
  const [stage, setStage] = useState<VentureStage>(venture?.stage ?? asked ?? "idea");
  /* Asked again while the form is already open — the menu, a second time, for
     a different stage — moves the stage and leaves what was typed alone. */
  const [answered, setAnswered] = useState(asked);
  if (asked !== answered) { setAnswered(asked); if (!venture && asked) setStage(asked); }
  const [businessTypes, setBusinessTypes] = useState<BusinessType[]>(venture ? businessTypesOf(venture) : []);
  const [expectedUpdatedAt] = useState(venture?.updatedAt);
  /* Null means "whatever the site says" — the option that sends `color: null`
     and lets the server put back the measured primary, or a default when
     nothing was measured. A hex here is the owner overruling that. */
  const [color, setColor] = useState<string | null>(
    venture ? (venture.colorSource === "owner" ? venture.color : null) : null,
  );

  const [busy, setBusy] = useState<null | "saving" | "reading">(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const boards = venture ? dashboardsIn(venture.id) : [];
  const trimmedSite = website.trim();

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setFailure(null);
    setBusy("saving");
    try {
      if (venture) {
        const saved = await updateVenture(venture.id, {
          name: trimmed,
          description: description.trim(),
          website: trimmedSite || null,
          stage,
          businessTypes,
          expectedUpdatedAt,
          color,
        });
        navigate(`/ventures/${saved.slug}`);
      } else {
        const made = await addVenture({
          name: trimmed,
          description: description.trim(),
          website: trimmedSite || null,
          stage,
          businessTypes,
          color,
        });
        navigate(`/ventures/${made.slug}`);
      }
    } catch (e: unknown) {
      setFailure(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function reread() {
    if (!venture || busy) return;
    setFailure(null);
    setBusy("reading");
    try {
      await enrichVenture(venture.id);
    } catch (e: unknown) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  }

  async function remove() {
    if (!venture) return;
    setFailure(null);
    try {
      await deleteVenture(venture.id);
      navigate("/ventures");
    } catch (e: unknown) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
  }

  const brand = venture?.brand;

  return (
    <>
      <TopBar label={venture ? venture.name : "New venture"} />
      <PageShell
        title={venture ? "Edit venture" : "New venture"}
        sub={
          venture
            ? "The description and the stage are what the agent reads before it answers about this one."
            : "One thing you are building or running. The stage tells the agent what kind of help this needs."
        }
      >
        <div className="flex max-w-[620px] flex-col gap-6">
          <div className="grid gap-1.5">
            <Label htmlFor="venture-name">Name</Label>
            <Input
              id="venture-name"
              value={name}
              autoFocus={!venture}
              autoComplete="off"
              placeholder="Acme Analytics"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="venture-desc">What it is</Label>
            <Textarea
              id="venture-desc"
              value={description}
              placeholder="What it does and who pays for it, in one line."
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="text-muted-foreground text-[12.5px]">
              Your words. The agent quotes this rather than rewriting it.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="venture-site">Website</Label>
            <Input
              id="venture-site"
              value={website}
              autoComplete="off"
              placeholder="acme.example"
              onChange={(e) => setWebsite(e.target.value)}
            />
            <p className="text-muted-foreground text-[12.5px]">
              The favicon and colours are read from here. It also narrows this
              venture&rsquo;s dashboards to that host.
            </p>
          </div>

          {/*
            THE STAGE, AS THREE CARDS WITH THEIR SENTENCES ON THEM.

            A select would fit in a line and would be worse: "idea" and
            "launched" are not two values of a field, they are two different
            jobs to be helped with, and the sentence is the whole of the
            difference. Nobody reads a sentence in a tooltip on a select they
            have already clicked past.
          */}
          <div className="grid gap-1.5">
            <Label id="venture-business-types">Business types · select all that apply</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="venture-business-types">
              {BUSINESS_TYPES.map(t => {
                const Icon = BUSINESS_TYPE_ICONS[t.id];
                return <button key={t.id} type="button" aria-pressed={businessTypes.includes(t.id)}
                  className={cn("inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", businessTypes.includes(t.id) ? "bg-accent text-foreground" : "text-muted-foreground")}
                  onClick={() => setBusinessTypes(types => toggleBusinessType(types, t.id))}>
                  <Icon className="size-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
                  {t.label}
                </button>;
              })}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Stage</Label>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {VENTURE_STAGES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={stage === s.id}
                  onClick={() => setStage(s.id)}
                  className={cn(
                    "rounded-[14px] border p-3 text-left transition-colors",
                    stage === s.id
                      ? "border-foreground"
                      : "hover:border-line-strong",
                  )}
                >
                  <div className="text-[13.5px] font-medium">{s.label}</div>
                  <p className="text-muted-foreground mt-1 text-[12.5px] leading-snug">
                    {s.note}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Colour</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {VENTURE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={c === color}
                  onClick={() => setColor(c)}
                  style={{ background: c }}
                  className={cn(
                    "size-[22px] rounded-[9px] border-2 border-transparent transition-transform hover:scale-110",
                    c === color && "border-foreground",
                  )}
                />
              ))}
              {/* The default, and the honest one: a colour measured from the
                  site beats a colour chosen from seven. Picking this sends
                  `color: null`, which is the server's instruction to use what
                  it read — or a default when it could read nothing. */}
              <button
                type="button"
                aria-pressed={color === null}
                onClick={() => setColor(null)}
                className={cn(
                  "rounded-[9px] border px-2 py-1 text-[12.5px] transition-colors",
                  color === null ? "border-foreground" : "hover:border-line-strong",
                )}
              >
                From the site
              </button>
              {venture && (
                <span className="text-muted-foreground text-[12.5px]">
                  now {venture.color} ·{" "}
                  {venture.colorSource === "owner"
                    ? "yours"
                    : venture.colorSource === "site"
                      ? "measured from the site"
                      : "a default"}
                </span>
              )}
            </div>
          </div>

          {failure && (
            <p className="text-destructive text-[13.5px]">{failure}</p>
          )}

          <div className="flex items-center gap-1.5">
            <Button onClick={save} disabled={!name.trim() || busy !== null}>
              {busy === "saving"
                ? trimmedSite
                  ? "Reading the site…"
                  : "Saving…"
                : venture
                  ? "Save"
                  : "Create venture"}
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                navigate(venture ? `/ventures/${venture.slug}` : "/ventures")
              }
            >
              Cancel
            </Button>
          </div>

          {/*
            WHAT WAS READ FROM THE SITE — evidence, not decoration.

            It is on the edit page rather than on the venture page because this
            is where somebody comes when it looks wrong: the icon is stale, the
            colour is off, the title is last year's. Everything here was
            MEASURED, so everything here can be re-measured with one press, and
            what could not be measured says why instead of being left blank.
          */}
          {venture && brand && (
            <div className="rounded-[14px] bg-card p-4">
              <div className="flex items-center gap-2">
                <VentureMark venture={venture} size={20} />
                <span className="text-[14px] font-medium">Read from the site</span>
                <span className="text-muted-foreground text-[12.5px]">
                  {brand.enrichedAt
                    ? when(brand.enrichedAt, { year: true })
                    : "never read"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={reread}
                  disabled={busy !== null || !venture.website}
                >
                  <RefreshCw className="size-3.5" strokeWidth={1.6} />
                  {busy === "reading" ? "Reading…" : "Re-read the site"}
                </Button>
              </div>

              {!venture.website && (
                <p className="text-muted-foreground mt-2.5 text-[13px]">
                  No website on this venture, so there is nothing to read.
                </p>
              )}

              {brand.error && (
                <p className="text-destructive mt-2.5 text-[13px]">
                  {brand.error}
                </p>
              )}

              {(brand.title || brand.description) && (
                <div className="mt-3 flex flex-col gap-1">
                  {brand.title && (
                    <div className="text-[13.5px]">{brand.title}</div>
                  )}
                  {brand.description && (
                    <p className="text-muted-foreground text-[13px]">
                      {brand.description}
                    </p>
                  )}
                </div>
              )}

              {/* The palette as the roles it was assigned, each swatch offering
                  itself as the venture's colour — the shortest path from "that
                  one" to it being the colour. */}
              {(brand.palette.primary ||
                brand.palette.secondary ||
                brand.palette.accent) && (
                <div className="mt-3">
                  <div className="text-muted-foreground mb-1.5 text-[12.5px]">
                    Palette
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ["primary", brand.palette.primary],
                        ["secondary", brand.palette.secondary],
                        ["accent", brand.palette.accent],
                        ["background", brand.palette.background],
                        ["ink", brand.palette.ink],
                      ] as const
                    )
                      .filter(([, hex]) => !!hex)
                      .map(([role, hex]) => (
                        <button
                          key={role}
                          type="button"
                          title={`${role} · ${hex} — use as this venture's colour`}
                          onClick={() => setColor(hex!)}
                          className={cn(
                            "flex items-center gap-1.5 rounded-[9px] border px-1.5 py-1 text-[12px] transition-colors",
                            color === hex
                              ? "border-foreground"
                              : "hover:border-line-strong",
                          )}
                        >
                          <span
                            className="size-[14px] rounded-[5px]"
                            style={{ background: hex! }}
                          />
                          {role}
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {brand.fonts.length > 0 && (
                <p className="text-muted-foreground mt-3 text-[13px]">
                  Fonts: {brand.fonts.join(", ")}
                </p>
              )}

              {brand.faviconSource && (
                <p className="text-muted-foreground mt-1.5 truncate text-[12.5px]">
                  Icon from {brand.faviconSource}
                </p>
              )}

              {/* What could NOT be measured, in the server's words. A palette
                  with no icon behind it is a different thing from a site with
                  no icon, and this is where that difference is stated. */}
              {brand.notes.length > 0 && (
                <ul className="text-muted-foreground mt-2.5 flex flex-col gap-1 text-[12.5px]">
                  {brand.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}

              {venture.website && (
                <a
                  href={venture.website}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1.5 text-[12.5px]"
                >
                  <ExternalLink className="size-3.5" strokeWidth={1.6} />
                  {venture.website}
                </a>
              )}
            </div>
          )}

          {/*
            DELETING, LAST, AND IT COUNTS WHAT GOES WITH IT.

            The venture's dashboards go with it — they have no address without
            it and nothing else would ever find them — so the confirm names how
            many. The board cards do NOT: they keep the id they were filed
            under and are simply drawn unfiled, which is what already happens
            to a card whose venture this browser has never heard of. Chats stop
            naming it and stay in the rail, because the rail is flat on purpose.
          */}
          {venture && (
            <div className="border-line-soft border-t pt-4">
              {confirming ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[13.5px] leading-snug">
                    Delete <span className="font-medium">{venture.name}</span>
                    {boards.length > 0 && (
                      <>
                        {" "}
                        and its {boards.length}{" "}
                        {boards.length === 1 ? "dashboard" : "dashboards"}
                      </>
                    )}
                    ? Board cards filed under it stay on the board, unfiled, and
                    chats about it stay in the rail.
                  </p>
                  <div className="flex gap-1.5">
                    <Button
                      className="bg-destructive hover:bg-destructive/90 text-white"
                      onClick={remove}
                    >
                      Delete
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirming(true)}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px]"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.6} />
                  Delete this venture
                </button>
              )}
            </div>
          )}
        </div>
      </PageShell>
    </>
  );
}
