import assert from "node:assert/strict";
import test from "node:test";
import { isChatRunView, runLinkFromChat } from "./runNavigation.ts";

test("chat entry links retain the exact run and view through reload and new tabs", () => {
  for (const path of ["/ventures/cedar/team/seo/runs/r-one", "/team/people/runs/r-two"]) {
    const linked = runLinkFromChat(path);
    const url = new URL(linked, "https://opc.invalid");
    assert.equal(url.pathname, path);
    assert.ok(isChatRunView(url.searchParams));
    assert.equal(runLinkFromChat(linked), linked);
  }
});

test("chat links preserve other query values and report fragments", () => {
  const url = new URL(runLinkFromChat("/team/people/runs/r-two?person=unfiled&view=history#findings"), "https://opc.invalid");
  assert.equal(url.searchParams.get("person"), "unfiled");
  assert.equal(url.hash, "#findings");
  assert.equal(url.searchParams.get("view"), "chat");
});

test("normal worker entry and unrelated or external links keep their existing behavior", () => {
  for (const href of ["/ventures/cedar/team/seo", "/team/people", "/chat/one", "/outputs/seo/r-one", "https://example.test/team/people/runs/r-two", "//example.test/team/people/runs/r-two", "mailto:owner@example.test", "#findings"]) {
    assert.equal(runLinkFromChat(href), href);
  }
  assert.equal(isChatRunView(new URLSearchParams()), false);
  assert.equal(isChatRunView(new URLSearchParams("view=history")), false);
});
