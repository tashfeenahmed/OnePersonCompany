import type { Widget } from "../data/widgets.ts";

type Placement = { w: 1 | 2 | 4; span?: Widget["span"] };
const spans = [3, 4, 5, 6, 7, 8, 9, 12] as const;
export function widgetSpan(placed: Placement, def?: Pick<Widget, "span">): number {
  return placed.span ?? def?.span ?? placed.w * 3;
}
export function cycleWidgetWidth(placed: Placement, def?: Pick<Widget, "span">): Placement {
  const current = widgetSpan(placed, def);
  const span = spans[(spans.indexOf(current as typeof spans[number]) + 1) % spans.length]!;
  return { w: span === 12 ? 4 : span <= 4 ? 1 : 2, span };
}
const classes: Record<number, string> = {
  3: "col-span-12 sm:col-span-6 xl:col-span-3",
  4: "col-span-12 sm:col-span-6 xl:col-span-4",
  5: "col-span-12 xl:col-span-5",
  6: "col-span-12 xl:col-span-6",
  7: "col-span-12 xl:col-span-7",
  8: "col-span-12 xl:col-span-8",
  9: "col-span-12 xl:col-span-9",
  12: "col-span-12",
};
export const widgetSpanClass = (placed: Placement, def?: Pick<Widget,"span">) => classes[widgetSpan(placed,def)] ?? classes[12]!;
