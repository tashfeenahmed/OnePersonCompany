import { test } from "node:test";
import assert from "node:assert/strict";
import { DASHBOARD_PRESETS, WIDGETS, presetWidgetType } from "./widgets.ts";
import { BOARD_TEMPLATES } from "./boardTemplates.ts";

test("every live board is offered as a template, with preset ids unique", () => {
  const ids = DASHBOARD_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of BOARD_TEMPLATES) assert.ok(ids.includes(t.id), t.id);
});

test("live templates place only catalogued widgets, and a pinned card at most once", () => {
  for (const t of BOARD_TEMPLATES) {
    for (const w of t.widgets)
      assert.ok(
        WIDGETS[presetWidgetType(w)],
        `${t.id}: ${presetWidgetType(w)}`,
      );
    const pinned = t.widgets
      .map(presetWidgetType)
      .filter((type) => WIDGETS[type]?.perProject || WIDGETS[type]?.perParam);
    assert.equal(new Set(pinned).size, pinned.length, t.id);
  }
});
