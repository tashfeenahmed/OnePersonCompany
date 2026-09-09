/**
 * REFERENCES — everything the generators are given about one business, on one
 * page, before any of them writes a word.
 *
 * WHY THIS PAGE EXISTS. Four things on this box make something for a venture:
 * the Studio writes a caption and draws a picture, the faceless pipeline
 * writes a script, the reel writes a dialogue. Between them they read three
 * sources, and until this page each source was visible somewhere else and for
 * a different reason — the palette on the venture's own Brand card, where it
 * is evidence that a site was read; the pictures behind the fifth tab of the
 * Publishing page, where they are inputs to a queue; and the tone of voice
 * NOWHERE, because there was no field for it. So the honest answer to "what
 * does the Studio know about this business" was "open three pages and infer
 * it". This is that answer at one address.
 *
 * THE THREE BLOCKS ARE IN ORDER OF HOW MUCH THEY CAN BE TRUSTED, and the page
 * says which is which rather than styling them the same:
 *
 *   MEASURED    the palette and the font stacks, read off the live site by
 *               the venture enricher. Nobody chose these. An empty one means
 *               NOT MEASURED — the site has never been read — and it is drawn
 *               as that sentence, never as an absence of colour.
 *   WRITTEN     the style guide. Pure opinion, the owner's, and the only part
 *               of this page that is saved from here.
 *   COLLECTED   the pictures. The publishing area's library, shown here in
 *               shelves by kind because a logo, a look to imitate and a
 *               screenshot of the product are three different things to hand
 *               a model and the newest-first list flattened them.
 *
 * NOTHING ON THIS PAGE UPLOADS THROUGH A ROUTE OF ITS OWN. Every file goes to
 * `/api/publishing/assets` — the same multipart handler with the same 12 MB
 * cap, the same magic-number sniff and the same refusal to fetch a URL that
 * resolves onto a private address. A second uploader here would be a second
 * place to get all three wrong. The one write this page owns is the guide.
 *
 * A SHELF CARRIES THE KIND, SO NOTHING HAS TO BE PICKED TWICE. The Assets tab
 * has a row of kind buttons above one uploader; here the uploader is IN the
 * shelf, so dropping a logo onto the Logos shelf files it as a logo. Same
 * routes, one fewer thing to get wrong.
 *
 * WITH NO VENTURE CHOSEN THIS IS A GAP LIST. Not an empty state and not the
 * first venture's page: one row per business saying what it has and what it
 * has not, because "which of my nineteen products has no logo and no guide" is
 * a question this page is uniquely able to answer and none of the three
 * sources could.
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ExternalLink, ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { VentureSelect } from "@/components/VentureSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Failed, Loading, SectionCard } from "@/components/ui/state";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/hooks/useApi";
import { publishingApi, type Asset } from "@/areas/publishing/api";
import {
  referencesApi,
  type GuideLimits,
  type ReferencesDoc,
  type StyleGuide,
} from "@/lib/api/references";
import { bytes, when } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** The shelves, in the order they are useful: the mark, the look, the product,
 *  and everything that is none of those. The `kind` is the asset library's own
 *  and is what an upload from that shelf is filed as. */
const SHELVES = [
  {
    kind: "logo",
    title: "Logos",
    about:
      "The mark itself. Usually the wrong thing to hand a generative model, which will redraw it slightly wrong — it is here to be looked at and to be placed by hand.",
  },
  {
    kind: "reference",
    title: "Reference photos",
    about: "A look to imitate. This is the shelf the image model is actually meant to be given.",
  },
  {
    kind: "screenshot",
    title: "Screenshots",
    about: "The product as it really appears. What a walkthrough or a UGC shot is built from.",
  },
  { kind: "other", title: "Other", about: "Everything that is none of the three above." },
] as const;

/** The style guide's fields, in the order somebody writing one would think of
 *  them, with what each is for. The long ones get a textarea. */
const FIELDS: {
  key: keyof GuideLimits;
  label: string;
  hint: string;
  rows: number;
  ph: string;
  /**
   * WHERE THIS FIELD ACTUALLY ENDS UP, said on the field rather than implied
   * over the whole form. Six go into the three writers' prompts, one into the
   * image prompt, and two go nowhere near a model — and a form that let the
   * reader assume all nine were read by something would be lying about the two
   * that are not.
   */
  goes: "writers" | "image" | "nowhere";
}[] = [
  {
    key: "summary",
    label: "What this business is",
    hint: "In your own words, at more length than the one line on the venture record.",
    rows: 3,
    ph: "A support chatbot small sites drop into their own page in one tag…",
    goes: "writers",
  },
  {
    key: "tone",
    label: "Tone of voice",
    hint: "How it talks, and how it does not.",
    rows: 3,
    ph: "Plain and unhurried. Explains, never sells. No exclamation marks.",
    goes: "writers",
  },
  {
    key: "audience",
    label: "Who it is for",
    hint: "The person on the other end of a post, as specifically as you can put it.",
    rows: 3,
    ph: "Owners of small shops who already have traffic and answer their own email.",
    goes: "writers",
  },
  {
    key: "dos",
    label: "Do",
    hint: "One rule per line reads best.",
    rows: 4,
    ph: "Name the problem before the product.\nUse the second person.",
    goes: "writers",
  },
  {
    key: "donts",
    label: "Never",
    hint: "The words and moves that are out of bounds. This is the field that earns its keep.",
    rows: 4,
    ph: "Never say “revolutionise”.\nNever call them users — they are shop owners.",
    goes: "writers",
  },
  {
    key: "language",
    label: "Language",
    hint: "Which language the posts are written in, and for whom.",
    rows: 1,
    ph: "English, British spelling.",
    goes: "writers",
  },
  {
    key: "colours",
    label: "Colour, in words",
    hint: "For where the measured palette is wrong or out of date. Prose, not hexes — the hexes are measured above.",
    rows: 2,
    ph: "The green is the old logo. Use the navy and the warm grey.",
    goes: "image",
  },
  {
    key: "fonts",
    label: "Type, in words",
    hint: "Anything about typography a font stack cannot say.",
    rows: 2,
    ph: "Headings are set tight and lowercase.",
    goes: "nowhere",
  },
  {
    key: "notes",
    label: "Notes",
    hint: "Anything else worth keeping here. NOT put in any prompt — this one is a note to yourself.",
    rows: 3,
    ph: "The old tagline is still on two landing pages; do not reuse it.",
    goes: "nowhere",
  },
];

/** What the note beside a field's label says, for the three that do not go to
 *  the writers. The six that do say nothing: the paragraph above the form
 *  already does, and repeating it six times would bury the two exceptions. */
const GOES_NOTE: Record<string, string> = {
  image: "goes to the image prompt only",
  nowhere: "kept here only — no prompt reads it",
};

export function References() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [params, setParams] = useSearchParams();

  /* THE VENTURE IS IN THE URL, the rule every venture-scoped page here
     follows: a reference sheet somebody is looking at is one they will link
     to, and half an address is not an address. A SLUG rather than an id,
     because a slug survives being read out loud. Absent is the overview, on
     purpose — see the header. */
  const slug = params.get("venture");
  const venture = ventures.find((v) => v.slug === slug) ?? null;

  function pick(id: string | null) {
    const next = new URLSearchParams(params);
    const chosen = id ? ventures.find((v) => v.id === id) : null;
    if (chosen) next.set("venture", chosen.slug);
    else next.delete("venture");
    setParams(next, { replace: true });
  }

  return (
    <PageShell
      title="References"
      sub={
        <>
          What the generators are given before they make anything: the brand as measured off the
          site, the style guide you write, and the pictures they can be handed.
        </>
      }
      wide
    >
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <VentureSelect
          ventures={ventures}
          value={venture?.id ?? null}
          onChange={pick}
          none="Every venture"
        />
        {venture && (
          <Link
            to={`/ventures/${venture.slug}`}
            className="text-muted-foreground hover:text-foreground text-[13px] underline decoration-dotted"
          >
            the venture record
          </Link>
        )}
      </div>

      {slug && !venture ? (
        <Failed error={`There is no venture “${slug}” in this workspace.`} />
      ) : venture ? (
        <OneVenture slug={venture.slug} />
      ) : (
        <Overview />
      )}
    </PageShell>
  );
}

/* ----------------------------------------------------------- the gap list */

function Overview() {
  const doc = useApi(() => referencesApi.overview(), []);
  if (doc.loading && !doc.data) return <Loading what="the reference material" />;
  if (doc.error) return <Failed error={doc.error} />;
  const rows = doc.data?.ventures ?? [];

  return (
    <SectionCard
      title="Every venture"
      meta={`${rows.filter((r) => r.guide).length} of ${rows.length} have a style guide`}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[13.5px]">
          <thead className="text-muted-foreground text-[12px]">
            <tr className="border-line-soft border-b">
              <th className="py-2 pr-3 text-left font-normal">Venture</th>
              <th className="px-2 py-2 text-right font-normal">Logos</th>
              <th className="px-2 py-2 text-right font-normal">References</th>
              <th className="px-2 py-2 text-right font-normal">Screenshots</th>
              <th className="px-2 py-2 text-right font-normal">Other</th>
              <th className="py-2 pl-3 text-left font-normal">Style guide</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-line-soft border-b last:border-0">
                <td className="py-2.5 pr-3">
                  <Link
                    to={`/references?venture=${encodeURIComponent(r.slug)}`}
                    className="flex min-w-0 items-center gap-2 hover:underline"
                  >
                    <span className="min-w-0 truncate">{r.name}</span>
                    <StagePill stage={r.stage} />
                  </Link>
                </td>
                {["logo", "reference", "screenshot", "other"].map((k) => (
                  <td
                    key={k}
                    className={cn(
                      "px-2 py-2.5 text-right tabular-nums",
                      (r.assets[k] ?? 0) === 0 && "text-muted-foreground",
                    )}
                  >
                    {r.assets[k] ?? 0}
                  </td>
                ))}
                <td className="py-2.5 pl-3">
                  {r.guide ? (
                    <span className="text-ok">written {when(r.guideUpdatedAt)}</span>
                  ) : (
                    <span className="text-muted-foreground">not written</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p className="text-muted-foreground text-[14px]">
          No ventures yet. A reference sheet belongs to one.
        </p>
      )}
      <p className="text-muted-foreground mt-4 text-[12.5px] leading-relaxed">{doc.data?.note}</p>
    </SectionCard>
  );
}

/* ------------------------------------------------------------ one venture */

function OneVenture({ slug }: { slug: string }) {
  const doc = useApi(() => referencesApi.read(slug), [slug]);
  if (doc.loading && !doc.data) return <Loading what={`the references for ${slug}`} />;
  if (doc.error) return <Failed error={doc.error} />;
  if (!doc.data) return null;
  const d = doc.data;
  return (
    <>
      <Measured doc={d} />
      <GuideForm
        key={d.venture.id}
        ventureSlug={d.venture.slug}
        guide={d.guide}
        limits={d.limits}
        note={d.note}
        onSaved={doc.reload}
      />
      {SHELVES.map((shelf) => (
        <Shelf
          key={shelf.kind}
          shelf={shelf}
          ventureId={d.venture.id}
          uploadCap={d.uploadCap}
          assets={d.assets.filter((a) => a.kind === shelf.kind)}
          onChanged={doc.reload}
        />
      ))}
    </>
  );
}

/** One measured hex, with the name of the role it was assigned to. A null is
 *  drawn as a ruled empty square rather than skipped: "no accent was found" is
 *  a reading and it belongs on the page. */
function Swatch({ role, hex }: { role: string; hex: string | null }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="border-line-soft size-7 shrink-0 rounded-[9px] border"
        style={hex ? { background: hex } : undefined}
      />
      <span className="min-w-0">
        <span className="block text-[12.5px] capitalize">{role}</span>
        <span className="text-muted-foreground block font-mono text-[11.5px]">
          {hex ?? "not found"}
        </span>
      </span>
    </div>
  );
}

function Measured({ doc }: { doc: ReferencesDoc }) {
  const { brand, venture } = doc;
  const read = !!brand.enrichedAt;
  return (
    <SectionCard
      title="The brand, as measured"
      meta={
        read
          ? `read off the site ${when(brand.enrichedAt)}`
          : "the site has never been read — nothing below was measured"
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <VentureMark venture={{ name: venture.name, color: venture.color, brand }} size={22} />
        <span className="text-[14.5px]">{venture.name}</span>
        <StagePill stage={venture.stage} />
        {venture.website && (
          <a
            href={venture.website}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[13px]"
          >
            {venture.website.replace(/^https?:\/\//, "")}
            <ExternalLink className="size-[12px]" strokeWidth={1.7} />
          </a>
        )}
      </div>

      <p className="mb-4 text-[13.5px] leading-relaxed">
        {venture.description || (
          <span className="text-muted-foreground">
            No description on the venture record. The caption writer is handed this sentence, so it
            is worth one.
          </span>
        )}
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Swatch role="primary" hex={brand.palette.primary} />
        <Swatch role="secondary" hex={brand.palette.secondary} />
        <Swatch role="accent" hex={brand.palette.accent} />
        <Swatch role="background" hex={brand.palette.background} />
        <Swatch role="ink" hex={brand.palette.ink} />
      </div>

      <p className="text-muted-foreground text-[13px] leading-relaxed">
        <span className="text-foreground">Fonts in the site's CSS: </span>
        {brand.fonts.length ? `${brand.fonts.join(", ")}.` : "none were read."}
      </p>
      {venture.colorSource === "owner" && (
        <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
          The venture's own colour, <span className="font-mono">{venture.color}</span>, was chosen
          rather than measured — it is not part of the reading above.
        </p>
      )}

      {brand.error && <p className="text-destructive mt-2 text-[13px]">{brand.error}</p>}
      {brand.notes.length > 0 && (
        <ul className="text-muted-foreground mt-2 grid gap-1 text-[12.5px] leading-relaxed">
          {brand.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------- the guide */

function GuideForm({
  ventureSlug,
  guide,
  limits,
  note,
  onSaved,
}: {
  ventureSlug: string;
  guide: StyleGuide;
  limits: GuideLimits;
  note: string;
  onSaved: () => void;
}) {
  /* SEEDED ONCE AND REMOUNTED PER VENTURE — the caller keys this component on
     the venture id, so switching business replaces the form rather than
     leaving half-typed prose over somebody else's brand. */
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, guide[f.key] ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const dirty = FIELDS.some((f) => (draft[f.key] ?? "") !== (guide[f.key] ?? ""));
  const over = FIELDS.find((f) => (draft[f.key] ?? "").trim().length > limits[f.key]);

  async function save() {
    setBusy(true);
    setRefused(null);
    setSaid(null);
    try {
      /* ALL NINE, EVERY TIME. The route merges, so sending only what changed
         would work — and would mean that clearing a field by emptying it was
         indistinguishable from not touching it. The form knows the whole
         state; it says the whole state. */
      await referencesApi.saveGuide(
        ventureSlug,
        Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key] ?? ""])) as Partial<
          Record<keyof GuideLimits, string>
        >,
      );
      setSaid("Saved.");
      onSaved();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="The style guide"
      meta={
        guide.written
          ? `written by you, last saved ${when(guide.updatedAt)}`
          : "nothing written yet — the generators are working from the venture record alone"
      }
    >
      <p className="text-muted-foreground mb-4 text-[13px] leading-relaxed">
        Used by the Studio's caption writer, the faceless script writer and the reel dialogue
        writer. It is passed to them as your own instruction rather than as evidence: it decides
        how something is said, and never licenses a fact nobody has established.
      </p>

      <div className="grid gap-4">
        {FIELDS.map((f) => {
          const value = draft[f.key] ?? "";
          const long = value.trim().length > limits[f.key];
          return (
            <div key={f.key} className="grid gap-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <label htmlFor={`guide-${f.key}`} className="text-[13.5px]">
                  {f.label}
                </label>
                {GOES_NOTE[f.goes] && (
                  <span className="text-muted-foreground text-[11.5px]">{GOES_NOTE[f.goes]}</span>
                )}
                <span
                  className={cn(
                    "ml-auto text-[11.5px] tabular-nums",
                    long ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {value.trim().length}/{limits[f.key]}
                </span>
              </div>
              {f.rows > 1 ? (
                <Textarea
                  id={`guide-${f.key}`}
                  rows={f.rows}
                  value={value}
                  placeholder={f.ph}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="text-[13.5px] leading-relaxed"
                />
              ) : (
                <Input
                  id={`guide-${f.key}`}
                  value={value}
                  placeholder={f.ph}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="h-8 text-[13.5px]"
                />
              )}
              <p className="text-muted-foreground text-[12px] leading-relaxed">{f.hint}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <Button size="sm" disabled={busy || !dirty || !!over} onClick={() => void save()}>
          {busy && <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} />}
          Save the guide
        </Button>
        {over && (
          <span className="text-destructive text-[13px]">
            {over.label} is over its {limits[over.key]}-character ceiling.
          </span>
        )}
        {!dirty && !busy && <span className="text-muted-foreground text-[13px]">No changes.</span>}
        {said && <span className="text-ok text-[13px]">{said}</span>}
        {refused && <span className="text-destructive text-[13px]">{refused}</span>}
      </div>

      <p className="text-muted-foreground mt-4 text-[12.5px] leading-relaxed">{note}</p>
    </SectionCard>
  );
}

/* ------------------------------------------------------------- the shelves */

function Shelf({
  shelf,
  ventureId,
  uploadCap,
  assets,
  onChanged,
}: {
  shelf: (typeof SHELVES)[number];
  ventureId: string;
  uploadCap: number;
  assets: Asset[];
  onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  async function add(fn: () => Promise<unknown>) {
    setBusy(true);
    setRefused(null);
    try {
      await fn();
      setUrl("");
      onChanged();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title={shelf.title}
      meta={assets.length ? `${assets.length} · ${bytes(assets.reduce((n, a) => n + (a.bytes ?? 0), 0))}` : "none yet"}
    >
      <p className="text-muted-foreground mb-4 text-[13px] leading-relaxed">{shelf.about}</p>

      {assets.length > 0 && (
        <div className="mb-4 grid gap-2.5 sm:grid-cols-2">
          {assets.map((a) => (
            <AssetTile key={a.id} asset={a} onChanged={onChanged} />
          ))}
        </div>
      )}

      <div className="border-line-soft grid gap-2.5 rounded-[14px] border border-dashed p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Upload className="text-muted-foreground size-[14px]" strokeWidth={1.8} />
          <input
            type="file"
            aria-label={`Upload to ${shelf.title}`}
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={busy}
            className="max-w-full text-[13px]"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void add(() => publishingApi.uploadAsset({ ventureId, kind: shelf.kind, file }));
              e.target.value = "";
            }}
          />
          <span className="text-muted-foreground text-[12.5px]">
            PNG, JPEG, WebP or GIF, up to {Math.round(uploadCap / 1024 / 1024)} MB
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="…or paste an image URL — this box downloads it once and keeps the file"
            className="h-8 max-w-[440px] text-[13.5px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!url.trim() || busy}
            onClick={() =>
              void add(() =>
                publishingApi.importAsset({ ventureId, kind: shelf.kind, url: url.trim() }),
              )
            }
          >
            {busy ? (
              <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} />
            ) : (
              <ImageIcon className="size-[14px]" strokeWidth={1.8} />
            )}
            Import
          </Button>
        </div>
        {refused && <p className="text-destructive text-[13.5px]">{refused}</p>}
      </div>
    </SectionCard>
  );
}

/**
 * One picture, with the two sentences that travel with it.
 *
 * EDITED IN PLACE AND SAVED ON BLUR. A dialog for two short strings is a
 * dialog nobody opens, and the prompt is the field that decides what the image
 * model is actually told about this picture — it has to be as easy to fix as
 * it was to get wrong. The save is a PATCH of the one field, so two people
 * typing in two shelves cannot overwrite each other's other field.
 */
function AssetTile({ asset: a, onChanged }: { asset: Asset; onChanged: () => void }) {
  const [prompt, setPrompt] = useState(a.prompt ?? "");
  const [notes, setNotes] = useState(a.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function patch(field: "prompt" | "notes", value: string) {
    if ((field === "prompt" ? (a.prompt ?? "") : (a.notes ?? "")) === value) return;
    setSaving(true);
    try {
      await publishingApi.patchAsset(a.id, field === "prompt" ? { prompt: value } : { notes: value });
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-card border-line-soft flex gap-3 rounded-[14px] p-3.5">
      {a.onDisk ? (
        <img
          src={a.url}
          alt=""
          className="border-line-soft size-20 shrink-0 rounded-[11px] border object-cover"
        />
      ) : (
        <div className="border-line-soft text-muted-foreground flex size-20 shrink-0 items-center justify-center rounded-[11px] border border-dashed text-center text-[11.5px] leading-tight">
          file
          <br />
          gone
        </div>
      )}
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[13.5px]">{a.name ?? a.id}</span>
          <button
            aria-label={`Remove ${a.name ?? a.id}`}
            onClick={() => void publishingApi.removeAsset(a.id).then(onChanged)}
            className="text-muted-foreground hover:text-destructive ml-auto shrink-0"
          >
            <Trash2 className="size-[14px]" strokeWidth={1.8} />
          </button>
        </div>
        <p className="text-muted-foreground text-[12px]">
          {a.source} · {a.width && a.height ? `${a.width}×${a.height}` : "size not measured"} ·{" "}
          {bytes(a.bytes)} · used {a.usedCount}×{saving ? " · saving…" : ""}
        </p>
        <Input
          value={prompt}
          aria-label="How the image model should use it"
          placeholder="How the model should use it — “keep the palette cold”, not a description"
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => void patch("prompt", prompt.trim())}
          className="h-7 text-[12.5px]"
        />
        <Input
          value={notes}
          aria-label="A note to yourself"
          placeholder="A note to yourself"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => void patch("notes", notes.trim())}
          className="h-7 text-[12.5px]"
        />
      </div>
    </div>
  );
}
