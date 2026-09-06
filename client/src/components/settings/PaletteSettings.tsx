import { Check } from "lucide-react";
import { Section } from "@/components/settings/Section";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { DEFAULT_PALETTE, PALETTES, swatch, type PaletteId } from "@/lib/palettes";

/**
 * PALETTE — the second appearance axis, chosen from a preview of itself.
 *
 * EVERY TILE DRAWS THE PALETTE IT IS OFFERING, IN BOTH MODES, AND THAT IS THE
 * WHOLE DESIGN. A list of names with the current theme's chrome behind them
 * asks somebody to pick a colour scheme from the word "Coral", which means
 * choosing, looking, changing back — three round trips for a decision that
 * should take one glance. So each tile paints four of that palette's own
 * colours: its page, its card, its ink and its primary — twice, once for light
 * and once for dark — read straight out of lib/palettes.ts rather than out of
 * the applied stylesheet, so a tile shows what it WOULD look like and not what
 * the page looks like now.
 *
 * THE MODE THE READER IS IN IS MARKED rather than the other one hidden. A
 * palette is two blocks and the point of the axis is that both exist; showing
 * only the current one would hide half of what is being chosen from somebody
 * whose laptop will switch at sunset anyway.
 *
 * THE CHOICE IS IN THE WORKSPACE, NOT IN THIS BROWSER — see StoreState.palette
 * — so it follows the owner to every browser, and the sentence under the
 * heading says so, because a preference that syncs and does not say it will
 * surprise somebody exactly once, on a machine they did not expect it on.
 */
export function PaletteSettings() {
  const { state, setPalette } = useStore();
  const { resolved } = useTheme();
  const chosen: PaletteId = state.palette ?? DEFAULT_PALETTE;

  return (
    <Section
      title="Palette"
      hint="Colour only — the type scale, the spacing and the radius are the same in every one. The palette is independent of light and dark: each ships both, so switching mode keeps the palette. It is saved with your workspace and follows you to other browsers, unlike light/dark, which stays on this one."
    >
      <div className="grid max-w-[760px] gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {PALETTES.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPalette(p.id)}
            aria-pressed={chosen === p.id}
            className={cn(
              "bg-card rounded-[10px] border p-3 text-left transition-colors",
              chosen === p.id ? "border-foreground" : "hover:border-line-strong",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{p.label}</span>
              {chosen === p.id && <Check className="ml-auto size-4" strokeWidth={2} />}
            </div>

            <div className="mt-2 grid gap-1">
              {(["light", "dark"] as const).map((mode) => (
                <div key={mode} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "w-[30px] shrink-0 text-[10px] tabular-nums",
                      mode === resolved ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {mode === "light" ? "light" : "dark"}
                  </span>
                  <span
                    className="border-line-soft flex h-5 flex-1 overflow-hidden rounded-[5px] border"
                    /* Four bands: page, card, ink, primary. Decorative — the
                       label above already names the palette, and a screen
                       reader reading out four hexes would be noise. */
                    aria-hidden
                  >
                    {swatch(p.id, mode).map((c, i) => (
                      <span key={i} className="flex-1" style={{ background: c }} />
                    ))}
                  </span>
                </div>
              ))}
            </div>

            <p className="text-muted-foreground mt-2 text-[11.5px] leading-snug">{p.hint}</p>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground max-w-[560px] text-[11.5px]">
        The seven palettes beside Paper are checked against WCAG AA (4.5:1) by a
        unit test — every ink against every surface, in both modes — so none of
        them can ship type you cannot read. Paper is this app's existing design
        and is measured rather than gated: its body and button text clear AA,
        and four of its quietest greys sit between 3.8:1 and 4.4:1.
      </p>
    </Section>
  );
}
