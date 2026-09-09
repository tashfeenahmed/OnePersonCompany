import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { useApi } from "@/hooks/useApi";
import { api, type VentureBrand } from "@/lib/api";
import { publishingApi, type Asset } from "@/areas/publishing/api";
import { referencesApi, type GuidePatch, type ReferencesRow, type StyleGuide } from "@/lib/api/references";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";

/**
 * REFERENCES — the two tabs Workdash's Studio kept for what a generator is
 * handed before it draws: the pictures, and the brand.
 *
 * "Reference photos" is ONE LIBRARY across every venture, the way Workdash
 * had it: tick the venture, drop pictures in — the picker, a URL, or Ctrl+V
 * anywhere on the tab — and write each picture's instruction on its own card
 * afterwards, because uploading ten pictures and captioning ten pictures are
 * different jobs. A card's prompt is forwarded verbatim to the image model
 * whenever the picture is used; a picture can change hands by clicking
 * another venture's chip on it.
 *
 * "Logos & branding" is one card per venture, and every card is the same
 * card: the logo strip with the active mark, four colours, the look and feel
 * the model gets verbatim, the audience and the language, with what was read
 * off the site under a fold. A colour shows the MEASUREMENT until the owner
 * types over it; the tag beside it says which is in force, and clearing the
 * field hands it back to the measurement. That is the whole model: nothing
 * here is merged into the venture record, which the next site read would
 * overwrite — see the references area's migrations for why.
 *
 * ONE ASSET BELONGS TO ONE VENTURE here, where Workdash let a photo belong
 * to several pages. The library underneath is the publishing area's, and it
 * files a picture under one business; a photo that fits two is uploaded
 * twice. The chips on a card are therefore a move, not a set of ticks.
 */

const TABS = [
  { key: "photos", label: "Reference photos" },
  { key: "brands", label: "Logos & branding" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const IMAGE = /^image\/(png|jpe?g|webp)$/i;

function readFile(file: File): Promise<File | null> {
  return Promise.resolve(IMAGE.test(file.type) ? file : null);
}

export function References() {
  const { tab: raw } = useParams();
  const navigate = useNavigate();
  const tab: Tab = raw === "brands" ? "brands" : "photos";
  const { state } = useStore();
  const ventures = state.ventures;

  return (
    <PageShell
      title="References"
      wide
      sub="What the generators are handed before they make anything: the pictures, and the brand. Nothing here posts anywhere."
    >
      <Tabs value={tab} onValueChange={(v) => navigate(v === "brands" ? "/references/brands" : "/references")} className="mb-5">
        <TabsList variant="line">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="flex-none px-2.5">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {ventures.length === 0 ? (
        <p className="text-muted-foreground text-[14px]">
          There are no ventures yet. A reference belongs to one, and a brand is one. Add a venture first.
        </p>
      ) : tab === "photos" ? (
        <RefLibrary ventures={ventures} />
      ) : (
        <Brands ventures={ventures} />
      )}
    </PageShell>
  );
}

/* ------------------------------------------------------------ photos */

type Venture = ReturnType<typeof useStore>["state"]["ventures"][number];

function VentureChips({ ventures, value, onChange }: { ventures: Venture[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ventures.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onChange(v.id)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[12.5px] transition-colors",
            value === v.id ? "border-foreground bg-foreground/5" : "text-muted-foreground hover:border-line-strong",
          )}
        >
          {v.name}
        </button>
      ))}
    </div>
  );
}

function RefLibrary({ ventures }: { ventures: Venture[] }) {
  const lib = useApi(() => publishingApi.assets({}), []);
  const [ventureId, setVentureId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlText, setUrlText] = useState("");

  /* The photos: everything but the logos, which live on the other tab. */
  const refs = useMemo(() => (lib.data?.assets ?? []).filter((a) => a.kind !== "logo"), [lib.data]);
  const reload = lib.reload;

  /*
    Many at once, one request each, in order. Sequential because each is
    megabytes into the same process and ten at once would fight for the same
    socket for no gain. A failure part-way keeps what already landed and names
    what did not: the alternative is discarding six good uploads because the
    seventh was a HEIC.
  */
  async function onFiles(list: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    if (!ventureId) { setError("Pick the venture these are for first."); return; }
    setError(null);
    const failed: string[] = [];
    for (const [i, file] of files.entries()) {
      setBusy(`${i + 1} of ${files.length}`);
      const ok = await readFile(file);
      if (!ok) { failed.push(`${file.name} (png, jpeg or webp only)`); continue; }
      try {
        await publishingApi.uploadAsset({ ventureId, kind: "reference", file, name: file.name });
      } catch (err) {
        failed.push(`${file.name} (${err instanceof Error ? err.message : String(err)})`);
      }
      reload();
    }
    setBusy(null);
    if (failed.length) setError(`Could not add: ${failed.join(", ")}`);
  }

  /** A pasted URL: the server fetches it once and keeps the bytes, so the
   *  reference outlives whatever site it came from. */
  async function importUrl(url: string) {
    if (!ventureId) { setError("Pick the venture this is for first."); return; }
    setError(null);
    setBusy("fetching the URL");
    try {
      await publishingApi.importAsset({ ventureId, kind: "reference", url });
      setUrlText("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /*
    Ctrl+V anywhere on the tab. An image on the clipboard uploads it; a URL on
    the clipboard fetches it — unless you are typing in a field, because
    pasting a sentence into a prompt box must stay pasting a sentence.
  */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (busy !== null) return;
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && IMAGE.test(it.type))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length) { e.preventDefault(); void onFiles(files); return; }
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const text = e.clipboardData?.getData("text")?.trim() ?? "";
      if (/^https?:\/\/\S+$/i.test(text)) { e.preventDefault(); void importUrl(text); }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ventureId, busy]);

  return (
    <div>
      <div className="bg-card grid gap-3 rounded-[14px] p-4.5">
        <div>
          <div className="text-[14.5px] font-medium">Reference images</div>
          <p className="text-muted-foreground text-[13px]">
            The look you want, plus a prompt that travels with it. The image model sees the picture where it can take one, and is told about it in words where it cannot.
          </p>
        </div>
        <div className="border-line-soft grid gap-2.5 rounded-[12px] border border-dashed p-3.5">
          <VentureChips ventures={ventures} value={ventureId} onChange={setVentureId} />
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            disabled={busy !== null}
            onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }}
            className="text-muted-foreground file:border-line-soft file:bg-card file:text-foreground block w-full text-[12.5px] file:mr-3 file:rounded-md file:border file:px-3 file:py-1.5 file:text-[12.5px]"
          />
          <div className="flex gap-2">
            <Input
              value={urlText}
              onChange={(e) => setUrlText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && urlText.trim()) void importUrl(urlText.trim()); }}
              placeholder="…or paste an image URL"
              spellCheck={false}
              disabled={busy !== null}
              className="min-w-0 flex-1 font-mono text-[12px]"
            />
            <Button variant="outline" disabled={busy !== null || !urlText.trim()} onClick={() => void importUrl(urlText.trim())}>
              Fetch
            </Button>
          </div>
          <p className="text-muted-foreground text-[12.5px]">
            {busy
              ? busy.startsWith("fetching") ? "Fetching the URL…" : `Uploading ${busy}…`
              : "Tick the venture first, then add pictures any way you like — the picker, a URL, or just Ctrl+V an image or an image link anywhere on this tab. png, jpeg or webp."}
          </p>
          {error && <p className="text-destructive text-[12.5px]">{error}</p>}
        </div>
      </div>

      {lib.error && <p className="text-destructive mt-4 text-[13px]">{lib.error}</p>}
      {!lib.loading && refs.length === 0 && (
        <p className="text-muted-foreground mt-4 text-[13.5px]">No reference pictures yet.</p>
      )}
      {refs.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {refs.map((r) => (
            <RefCard key={r.id} refItem={r} ventures={ventures} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One reference, editable in place. The instruction is written HERE rather
 * than at upload, and saves on blur so there is no button to forget — with a
 * "saved" that shows briefly, so a silent write is still visible.
 */
function RefCard({ refItem, ventures, onChanged }: { refItem: Asset; ventures: Venture[]; onChanged: () => void }) {
  const [prompt, setPrompt] = useState(refItem.prompt ?? "");
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function patch(p: { prompt?: string; ventureId?: string }) {
    setProblem(null);
    try {
      await publishingApi.patchAsset(refItem.id, p);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="bg-card grid content-start gap-2 rounded-[14px] p-3">
      {/* The whole picture, at its own shape. A reference is chosen for its
          look, and a crop shows you a different look than the model will get. */}
      {refItem.onDisk ? (
        <img src={refItem.url} alt={refItem.name ?? ""} loading="lazy" className="border-line-soft w-full rounded-[11px] border" />
      ) : (
        <div className="text-muted-foreground border-line-soft grid h-32 place-items-center rounded-[11px] border text-[12px]">file gone</div>
      )}
      <Textarea
        value={prompt}
        rows={3}
        placeholder="Prompt — passed to the image model whenever this is used. “Focus on the hands, keep the palette cold, wide crop with lots of air.”"
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={() => prompt !== (refItem.prompt ?? "") && void patch({ prompt })}
        className="text-[12.5px]"
      />
      {/* Which venture this belongs to, and a way to move it. A select
          rather than nineteen chips on every card. */}
      <select
        value={refItem.ventureId}
        onChange={(e) => { if (e.target.value !== refItem.ventureId) void patch({ ventureId: e.target.value }); }}
        className="border-line-soft h-7 rounded-[8px] border bg-transparent px-1.5 text-[12px]"
      >
        {ventures.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      <div className="text-muted-foreground flex items-center justify-between text-[12px]">
        <span>{saved ? "saved" : problem ? <span className="text-destructive">{problem}</span> : `used ${refItem.usedCount} time${refItem.usedCount === 1 ? "" : "s"}`}</span>
        <button type="button" className="hover:text-foreground hover:underline" onClick={() => void publishingApi.removeAsset(refItem.id).then(onChanged)}>
          Remove
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ brands */

function Brands({ ventures }: { ventures: Venture[] }) {
  const overview = useApi(() => referencesApi.overview(), []);
  const logos = useApi(() => publishingApi.assets({ kind: "logo" }), []);
  const reload = () => { overview.reload(); logos.reload(); };
  const rows = overview.data?.ventures ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  return (
    <div>
      {overview.error && <p className="text-destructive mb-3 text-[13px]">{overview.error}</p>}
      <p className="text-muted-foreground mb-4 text-[13px]">
        One card per venture. A colour shows what was read off the site until you type over it; the tag beside it says which is in force, and an emptied field goes back to the measurement. The look and feel goes to the image model word for word.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {ventures.map((v) => {
          const row = byId.get(v.id);
          return row ? (
            <BrandCard key={v.id} venture={v} row={row} logos={(logos.data?.assets ?? []).filter((a) => a.ventureId === v.id)} onSaved={reload} />
          ) : (
            <div key={v.id} className="bg-card text-muted-foreground rounded-[14px] p-4 text-[13px]">
              {overview.loading ? <Loader2 className="size-4 animate-spin" /> : `${v.name} is not in the references document.`}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const COLOURS = [
  ["primary", "Primary"],
  ["secondary", "Secondary"],
  ["background", "Background"],
  ["ink", "Text"],
] as const;
type ColourKey = (typeof COLOURS)[number][0];

function measuredOf(brand: VentureBrand, key: ColourKey): string | null {
  return brand.palette[key] ?? null;
}

function Swatch({ hex }: { hex: string | null }) {
  const ok = !!hex && /^#[0-9A-Fa-f]{6}$/.test(hex);
  return <span className="border-line-soft inline-block size-4 shrink-0 rounded-[5px] border" style={{ background: ok ? hex! : "transparent" }} title={hex ?? "none"} />;
}

/** Which value is in force: the owner's, the site's, or nothing. */
function Tag({ children, title }: { children: string; title: string }) {
  return <span className="border-line-soft text-muted-foreground rounded-full border px-1.5 py-px text-[9.5px]" title={title}>{children}</span>;
}

type Draft = Record<ColourKey, string> & { style: string; audience: string; language: string; summary: string; tone: string; dos: string; donts: string; colours: string; fonts: string; notes: string };

function draftOf(guide: StyleGuide, brand: VentureBrand): Draft {
  return {
    primary: guide.primary ?? measuredOf(brand, "primary") ?? "",
    secondary: guide.secondary ?? measuredOf(brand, "secondary") ?? "",
    background: guide.background ?? measuredOf(brand, "background") ?? "",
    ink: guide.ink ?? measuredOf(brand, "ink") ?? "",
    style: guide.style ?? "",
    audience: guide.audience ?? "",
    language: guide.language ?? brand.lang ?? "",
    summary: guide.summary ?? "",
    tone: guide.tone ?? "",
    dos: guide.dos ?? "",
    donts: guide.donts ?? "",
    colours: guide.colours ?? "",
    fonts: guide.fonts ?? "",
    notes: guide.notes ?? "",
  };
}

/** One brand, editable in place. Saves per venture, because the server
 *  validates and stores per venture. */
function BrandCard({ venture, row, logos, onSaved }: { venture: Venture; row: ReferencesRow; logos: Asset[]; onSaved: () => void }) {
  const guide = row.style;
  const brand = row.brand;
  const [draft, setDraft] = useState<Draft>(() => draftOf(guide, brand));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reading, setReading] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showMore, setShowMore] = useState(false);

  const base = draftOf(guide, brand);
  const keys = Object.keys(base) as (keyof Draft)[];
  const dirty = keys.some((k) => draft[k] !== base[k]);

  /* The card follows the server after a save or a re-read, but only when
     nothing is half-typed: a measured colour that landed while this card was
     open should appear, and a sentence the owner is mid-way through must not
     vanish under it. */
  useEffect(() => {
    if (!dirty) setDraft(draftOf(guide, brand));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide.updatedAt, brand.enrichedAt, guide.logo]);

  const field = (k: keyof Draft, value: string) => setDraft((d) => ({ ...d, [k]: value }));
  const active = guide.logo && logos.some((l) => l.id === guide.logo) ? guide.logo : null;

  async function save(patch: GuidePatch) {
    setState("saving");
    setMessage(null);
    try {
      await referencesApi.saveGuide(venture.slug, patch);
      setState("saved");
      onSaved();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  function saveAll() {
    /* Only what changed. A colour typed back to the measurement is sent as
       "" — the owner's word withdrawn, not a second copy of the reading. */
    const patch: GuidePatch = {};
    for (const [key] of COLOURS) {
      if (draft[key] === base[key]) continue;
      const measured = measuredOf(brand, key) ?? "";
      patch[key] = draft[key].trim().toUpperCase() === measured.toUpperCase() ? "" : draft[key].trim();
    }
    for (const k of ["style", "audience", "language", "summary", "tone", "dos", "donts", "colours", "fonts", "notes"] as const) {
      if (draft[k] !== base[k]) patch[k] = draft[k];
    }
    void save(patch);
  }

  async function onLogoFile(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const out = await publishingApi.uploadAsset({ ventureId: venture.id, kind: "logo", file, name: file.name });
      /* Uploading IS choosing: the reason to upload a logo is to use it, so
         it becomes the active mark in the same motion. */
      await referencesApi.saveGuide(venture.slug, { logo: out.asset.id });
      setState("idle");
      onSaved();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function reextract() {
    setReading(true);
    setMessage(null);
    try {
      await api.ventures.enrich(venture.slug);
      onSaved();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  }

  const source = (key: ColourKey) =>
    guide[key] ? <Tag title="typed here — clear the field to go back to the measurement">yours</Tag>
      : measuredOf(brand, key) ? <Tag title={`measured off ${venture.website ?? "the site"}${brand.enrichedAt ? ` on ${brand.enrichedAt.slice(0, 10)}` : ""}`}>site</Tag>
        : null;

  const bg = draft.background || "#F1F1F1";
  const ink = draft.ink || "#111111";

  return (
    <div className="bg-card grid content-start gap-3 rounded-[14px] p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] text-[12px] font-semibold" style={{ background: bg, color: ink }}>
          {venture.name.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-[14px] font-medium"><VentureMark venture={venture} size={14} />{venture.name} <StagePill stage={venture.stage} /></div>
          <div className="text-muted-foreground truncate text-[12px]">{venture.website ?? venture.slug}</div>
        </div>
        <Button size="sm" variant="ghost" disabled={reading || !venture.website} onClick={() => void reextract()} title={venture.website ? `read the colours, fonts and tone off ${venture.website} again` : "no website to read"}>
          {reading ? "Reading…" : "Re-extract"}
        </Button>
      </div>

      {!brand.enrichedAt && (
        <p className="text-muted-foreground border-line-soft rounded-[10px] border px-3 py-2 text-[12px] leading-relaxed">
          Never read from the site. Press Re-extract to measure the colours and fonts off {venture.website ?? "its website"}, or type the four colours in below.
        </p>
      )}

      {/* The logo first — it is the brand, and the active one goes into
          every post. Click a thumbnail to switch; + uploads and selects. */}
      <div className="text-[12px]">
        <span className="text-muted-foreground">Logo</span>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {logos.map((l) => (
            <div key={l.id} className={cn("relative rounded-[9px] border p-1", active === l.id ? "border-foreground" : "border-line-soft")}>
              <button type="button" title={active === l.id ? "the active logo" : `use ${l.name ?? "this logo"}`} onClick={() => active !== l.id && void save({ logo: l.id })} className="block">
                {l.onDisk ? <img src={l.url} alt={l.name ?? ""} loading="lazy" className="size-12 rounded object-contain" /> : <span className="text-muted-foreground grid size-12 place-items-center text-[10px]">gone</span>}
              </button>
              {active === l.id ? (
                <span className="bg-foreground text-background absolute -top-1.5 -right-1.5 rounded-full px-1.5 text-[9px] font-medium">in use</span>
              ) : (
                <button
                  type="button"
                  title="remove this logo"
                  onClick={() => void publishingApi.removeAsset(l.id).then(onSaved)}
                  className="border-line-soft bg-card text-muted-foreground hover:text-destructive absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full border text-[10px]"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {!logos.length && brand.favicon && (
            <div className="border-line-soft rounded-[9px] border p-1" title="the site's own icon, as measured — upload a logo to use one">
              <img src={brand.favicon} alt="" className="size-12 rounded object-contain opacity-70" />
            </div>
          )}
          <label title="upload a logo — it becomes the active one" className={cn("border-line-soft text-muted-foreground hover:text-foreground grid size-14 cursor-pointer place-items-center rounded-[10px] border border-dashed text-lg", uploading && "animate-pulse")}>
            {uploading ? "…" : "+"}
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(e) => { void onLogoFile(e.target.files); e.target.value = ""; }} className="hidden" />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {COLOURS.map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-[12px]">
            <Swatch hex={draft[key] || null} />
            <span className="text-muted-foreground flex w-[6.2rem] shrink-0 items-center gap-1">
              {label}
              {source(key)}
            </span>
            <Input value={draft[key]} onChange={(e) => field(key, e.target.value.toUpperCase())} spellCheck={false} placeholder="#RRGGBB" className="h-7 px-1.5 font-mono text-[11.5px]" />
          </label>
        ))}
      </div>

      <label className="block text-[12px]">
        <span className="text-muted-foreground">Look and feel — the model gets this verbatim</span>
        <Textarea value={draft.style} onChange={(e) => field("style", e.target.value)} rows={3} placeholder="Flat vector, cold palette, lots of air. Photographic, warm, hands at work." className="mt-1 text-[12.5px]" />
      </label>
      <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
        <label className="block text-[12px]">
          <span className="text-muted-foreground">Audience</span>
          <Input value={draft.audience} onChange={(e) => field("audience", e.target.value)} className="mt-1 text-[12.5px]" />
        </label>
        <label className="block text-[12px]">
          <span className="text-muted-foreground flex items-center gap-1">Language {!guide.language && brand.lang && <Tag title="the site's own <html lang>">site</Tag>}</span>
          <Input value={draft.language} onChange={(e) => field("language", e.target.value)} spellCheck={false} placeholder="en" className="mt-1 font-mono text-[12.5px]" />
        </label>
      </div>

      <button type="button" onClick={() => setShowMore((v) => !v)} className="text-muted-foreground w-fit text-[11.5px] hover:underline">
        {showMore ? "Hide the writers' guide" : "More for the writers — tone, dos and don'ts"}
      </button>
      {showMore && (
        <div className="grid gap-2">
          {([
            ["summary", "What this business is, in your words", 2],
            ["tone", "Tone of voice", 2],
            ["dos", "Do", 3],
            ["donts", "Never", 3],
            ["colours", "About colour, in a sentence", 1],
            ["fonts", "About type, in a sentence", 1],
            ["notes", "Notes to yourself — not given to any model", 2],
          ] as const).map(([k, label, rows]) => (
            <label key={k} className="block text-[12px]">
              <span className="text-muted-foreground">{label}</span>
              <Textarea value={draft[k]} onChange={(e) => field(k, e.target.value)} rows={rows} className="mt-1 text-[12.5px]" />
            </label>
          ))}
        </div>
      )}

      {brand.enrichedAt && (
        <>
          <button type="button" onClick={() => setShowEvidence((v) => !v)} className="text-muted-foreground w-fit text-[11.5px] hover:underline">
            {showEvidence ? "Hide what was read" : "What was read off the site"}
          </button>
          {showEvidence && (
            <div className="border-line-soft text-muted-foreground grid gap-1.5 rounded-[10px] border p-3 text-[11.5px]">
              <p>Read from <span className="font-mono">{venture.website}</span> {ago(brand.enrichedAt)}.</p>
              {brand.palette.ranked.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5">
                  <span>Colours it uses most:</span>
                  {brand.palette.ranked.slice(0, 6).map((c) => (
                    <span key={c.hex} className="flex items-center gap-1"><Swatch hex={c.hex} /><span className="font-mono">{c.hex}</span></span>
                  ))}
                </p>
              )}
              {brand.fonts.length > 0 && <p>Type: {brand.fonts.join(", ")}</p>}
              {brand.title && <p>Title: {brand.title}</p>}
              {brand.description && <p>Description: {brand.description}</p>}
              {brand.lang && <p>Language: {brand.lang}</p>}
              {brand.themeColor && <p className="flex items-center gap-1">Theme colour: <Swatch hex={brand.themeColor} /> <span className="font-mono">{brand.themeColor}</span></p>}
              {brand.notes?.map((n) => <p key={n} className="opacity-80">{n}</p>)}
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={saveAll} disabled={!dirty || state === "saving"}>
          {state === "saving" ? "Saving…" : dirty ? "Save brand" : "Saved"}
        </Button>
        {state === "saved" && !dirty && <span className="text-muted-foreground text-[12px]">stored{guide.updatedAt ? ` · ${ago(guide.updatedAt)}` : ""}</span>}
        {state === "error" && <span className="text-destructive text-[12px]">{message}</span>}
        <Link to={`/ventures/${venture.slug}`} className="text-muted-foreground ml-auto text-[12px] underline decoration-dotted">the venture</Link>
      </div>
    </div>
  );
}
