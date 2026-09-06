import type { Widget } from "../data/widgets";
/** Only presentation metadata survives when measured data replaces a sample. */
export function measuredWidget(base: Widget, patch: Partial<Widget> | null | undefined): Widget {
  return { src: base.src, name: base.name, kind: base.kind, live: base.live,
    invert: base.invert, unit: base.unit, thresholds: base.thresholds, ...patch };
}
