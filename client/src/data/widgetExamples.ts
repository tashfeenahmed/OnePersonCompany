import type { Widget } from "./widgets.ts";

/** Entirely synthetic catalog previews. Live builders supply account data. */
export function widgetExample(widget: Widget): Partial<Widget> {
  const series = [10, 15, 12, 20, 18, 25, 30];
  const parts = [{ label: "Example A", value: 60, text: "60" }, { label: "Example B", value: 40, text: "40" }];
  const base = { sub: "Illustrative example", caption: "Synthetic preview data" };
  switch (widget.kind) {
    case "domain-search": return { sub: "Search across TLDs or check domains in bulk." };
    case "metric": return { ...base, value: "100", series };
    case "bars": return { ...base, bars: series, labels: "Example observations" };
    case "rows": return { ...base, rows: [["Example A", "60"], ["Example B", "40"]] };
    case "statuses": return { ...base, statuses: [["Example service", "ok"]] };
    case "chart": return { ...base, chart: [{ label: "Example observations", points: series.map((value, i) => ({ ts: `2025-01-0${i + 1}T00:00:00Z`, value })) }] };
    case "meters": return { ...base, meters: [{ label: "Example utilisation", value: 40, warn: 80, crit: 90 }] };
    case "table": return { ...base, table: [(widget.headers ?? ["Example", "Value"]).map((_, i) => i ? "10" : "Example item")] };
    case "runway": return { ...base, runway: [{ label: "Example deadline", days: 30 }] };
    case "donut": return { ...base, slices: parts, center: { value: "100", note: "Example total" } };
    case "ranked": return { ...base, ranked: parts };
    case "dumbbell": return { ...base, names: ["Before", "After"], dumbbell: [{ label: "Example item", a: 20, b: 30, text: "20 → 30" }] };
    case "profile": return { ...base, figures: [{ label: "Example total", value: "100" }], series };
    case "proportion": return { ...base, value: "100", parts };
    case "waterfall": return { ...base, steps: [{ label: "Added", value: 30, text: "30" }, { label: "Removed", value: -10, text: "10" }, { label: "Net", value: 20, text: "20", total: true }] };
    case "feed": return { ...base, feed: [{ title: "Example update", text: "An illustrative item for this widget." }] };
  }
}
