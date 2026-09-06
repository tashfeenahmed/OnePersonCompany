import { useState } from "react";
import { Loader2, Paintbrush } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago } from "@/components/integrations/format";
import { seoopsApi, type BrandField } from "@/lib/api/seoops";

/**
 * THE SAME BRAND, READ THREE WAYS, WITH THE METHOD ON EVERY FIELD.
 *
 * The venture record already carries a brand parsed out of the site's HTML and
 * stylesheets. That reading counts a colour whether or not anything is painted
 * with it, and cannot see a palette a framework applies at runtime — so on a
 * real site it can name a blue that appears nowhere on screen. The RENDERED
 * reading measures computed styles in a headless browser and ranks colours by
 * painted AREA, which is what a person means when they say what colour a site
 * is. Neither overwrites the other.
 *
 * `effective` IS THE ONE A CALLER SHOULD USE AND IT SHOWS ITS WORKING. Every
 * swatch carries a small word — override, rendered, static — because three
 * sources collapsed into one hex with no provenance is how a page ends up
 * showing a colour nobody can explain.
 *
 * THE OVERRIDE IS PER FIELD AND CLEARING IT RESTORES THE MEASUREMENT. A field
 * left empty is not overridden; emptying every field deletes the override
 * entirely and both readings stand again.
 */
const METHOD_LABEL: Record<BrandField["method"], string> = {
  override: "yours",
  rendered: "browser",
  static: "html",
  none: "not measured",
};

function Swatch({ label, field }: { label: string; field: BrandField }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "border-line-soft size-6 shrink-0 rounded-[6px] border",
          !field.value && "border-dashed",
        )}
        style={paint(field.value) ? { background: paint(field.value) } : undefined}
      />
      <span className="text-[12px]">
        <span className="text-muted-foreground">{label}</span>{" "}
        <span className="font-mono">{field.value ?? "—"}</span>{" "}
        <span className="text-muted-foreground text-[11px]">{METHOD_LABEL[field.method]}</span>
      </span>
    </div>
  );
}

const OVERRIDABLE = ["primary", "secondary", "accent", "background", "ink"] as const;

/**
 * A COLOUR THIS PAGE IS WILLING TO PUT IN A `style` ATTRIBUTE.
 *
 * The server already refuses anything that is not six hex digits before it
 * stores a rendered reading — see `validateRaw` in the seoops area — and this
 * is the same check at the place where the consequence actually lands. A
 * `background: url(http://…)` here would be a request fired from the owner's
 * dashboard to somebody else's server every time this tab is opened, and a
 * guard on both sides of that costs one regex.
 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const paint = (hex: string | null | undefined): string | undefined =>
  hex && HEX6.test(hex) ? hex : undefined;

export function BrandMeasuredSection({ venture }: { venture: string }) {
  const doc = useApi(() => seoopsApi.brand(venture), [venture]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function act(fn: () => Promise<unknown>, key: string) {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
      doc.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (doc.error) return <p className="text-muted-foreground text-[12.5px]">Brand is not answering: {doc.error}</p>;
  if (!doc.data) return null;
  const d = doc.data;

  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">Measured brand</div>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
            {editing ? "Done" : "Override"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "measure" || !d.website}
            onClick={() => void act(() => seoopsApi.measureBrand(venture), "measure")}
          >
            {busy === "measure" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Paintbrush className="size-3.5" strokeWidth={1.8} />
            )}
            Measure in a browser
          </Button>
        </div>
      </div>

      {problem && <p className="text-destructive mb-2 text-[12.5px]">{problem}</p>}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Swatch label="primary" field={d.effective.primary} />
        <Swatch label="secondary" field={d.effective.secondary} />
        <Swatch label="accent" field={d.effective.accent} />
        <Swatch label="background" field={d.effective.background} />
        <Swatch label="ink" field={d.effective.ink} />
      </div>

      <div className="mt-3 space-y-1 text-[12px]">
        <div>
          <span className="text-muted-foreground">body font </span>
          <span className="font-mono">{d.effective.bodyFont.value ?? "—"}</span>{" "}
          <span className="text-muted-foreground text-[11px]">{METHOD_LABEL[d.effective.bodyFont.method]}</span>
        </div>
        <div>
          <span className="text-muted-foreground">heading font </span>
          <span className="font-mono">{d.effective.headingFont.value ?? "—"}</span>{" "}
          <span className="text-muted-foreground text-[11px]">{METHOD_LABEL[d.effective.headingFont.method]}</span>
        </div>
      </div>

      {editing && (
        <div className="border-line-soft mt-3 rounded-[8px] border px-3 py-2.5">
          <p className="text-muted-foreground mb-2 text-[11.5px] leading-relaxed">
            A hex like <code>#2F7D4F</code>, or empty to drop the override and let the measurement stand. Nothing typed
            here changes either reading.
          </p>
          <div className="flex flex-wrap gap-2">
            {OVERRIDABLE.map((key) => (
              <input
                key={key}
                className="border-line-soft bg-card w-[150px] rounded-[6px] border px-2 py-1 font-mono text-[12px]"
                placeholder={key}
                defaultValue={(d.override?.[key] as string | undefined) ?? ""}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next === ((d.override?.[key] as string | undefined) ?? "")) return;
                  void act(
                    () => seoopsApi.setBrandOverride(venture, { ...(d.override ?? {}), [key]: next || null }),
                    `ov-${key}`,
                  );
                }}
              />
            ))}
          </div>
        </div>
      )}

      {d.rendered && !d.rendered.error && (
        <div className="mt-4">
          <div className="text-muted-foreground mb-1.5 text-[11px]">
            Browser reading {ago(d.rendered.at ?? d.rendered.readAt)} — {d.rendered.elementsMeasured} visible elements,
            colours ranked by painted area
          </div>
          <div className="flex flex-wrap gap-1.5">
            {d.rendered.colours.slice(0, 10).map((c) => (
              <span
                key={`${c.hex}-${c.kind}`}
                title={`${c.hex} · ${c.kind} · ${c.share}% of the painted area`}
                className="border-line-soft flex items-center gap-1.5 rounded-[6px] border px-1.5 py-0.5 text-[11px]"
              >
                <span className="size-3 rounded-[3px]" style={{ background: paint(c.hex) }} />
                <span className="font-mono">{c.hex}</span>
                <span className="text-muted-foreground">{c.share}%</span>
              </span>
            ))}
          </div>
          {d.rendered.notes.map((n) => (
            <p key={n} className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
              {n}
            </p>
          ))}
        </div>
      )}

      {d.renderedError && (
        <p className="text-muted-foreground mt-3 text-[11.5px] leading-relaxed">
          The last browser reading failed: {d.renderedError} The HTML reading is unchanged and is what the swatches
          above fall back to.
        </p>
      )}
      {!d.rendered && (
        <p className="text-muted-foreground mt-3 text-[11.5px] leading-relaxed">
          This site has never been read in a browser. The swatches above come from the HTML parse, which counts a colour
          whether or not anything is painted with it.
        </p>
      )}

      <div className="mt-3">
        {d.notes.map((n) => (
          <p key={n} className="text-muted-foreground mb-1.5 max-w-[760px] text-[11.5px] leading-relaxed">
            {n}
          </p>
        ))}
      </div>
    </div>
  );
}
