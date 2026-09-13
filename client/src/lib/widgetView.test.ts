import test from "node:test";
import assert from "node:assert/strict";
import { measuredWidget } from "./widgetView.ts";
test("a measured value cannot inherit the catalog's fabricated trend or chart", () => {
  const base = { src: "stripe", name: "Churn", kind: "metric" as const, value: "3.1%", delta: -1.3, series: [4.4,4,3.1], bars: [2,5], rows: [["sample", "$500"]] as [string,string][], caption: "Yesterday's sample" };
  const live = measuredWidget(base, { value: "0.0%" });
  assert.equal(live.value, "0.0%"); assert.equal(live.series, undefined); assert.equal(live.delta, undefined);
  assert.equal(live.rows, undefined); assert.equal(live.bars, undefined); assert.equal(live.caption, undefined);
  assert.equal(measuredWidget(base, null).value, undefined);
});
test("insight widgets retain their renderer while replacing their measured data", () => {
  const base = { src: "insights", name: "Pace", kind: "profile" as const, insightView: "pace" as const };
  assert.equal(measuredWidget(base, {}).insightView, "pace");
  assert.equal(measuredWidget(base, null).insightData, undefined);
});
