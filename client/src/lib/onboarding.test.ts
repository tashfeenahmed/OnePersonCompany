import {
  workspaceFieldErrors,
  ventureFieldErrors,
  accountFieldErrors,
  requireValidFields,
  SetupValidationError,
} from "../../../shared/onboardingValidation.ts";
import { call, ApiError } from "./api.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { WIDGETS } from "../data/widgets.ts";
import { PLUGINS } from "../data/plugins.ts";
import {
  SERVICE_CAPABILITIES,
  planDashboards,
} from "../../../shared/onboardingPlan.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";
import {
  BUSINESS_TYPES,
  emptyJourney,
  journeyTasks,
} from "../../../shared/ventureJourney.ts";

test("every onboarding service and generated widget exists in the actual app", () => {
  const connections = Object.entries(SERVICE_CAPABILITIES).map(
    ([plugin, capabilities], i) => ({
      key: plugin,
      plugin,
      capabilities,
      accountId: i + 1,
      label: "Account",
      status: "connected" as const,
      error: null,
      checkedAt: null,
    }),
  );
  for (const connection of connections)
    assert(
      PLUGINS.some((p) => p.id === connection.plugin),
      connection.plugin,
    );
  const dashboards = planDashboards(connections, [], []);
  for (const board of dashboards)
    for (const widget of board.widgets)
      assert(WIDGETS[widget.type], widget.type);
  assert(
    isWorkspacePreferences({
      seedVersion: 27,
      workspace: { name: "Workspace", owner: "Owner", defaultVentureId: null },
      dashboards,
      sessions: [],
      appOrder: [],
      navOrder: [],
      favoritePaths: [],
      pinnedItems: [],
    }),
  );
});
test("all seven business types have actionable idea and pre-launch paths", () => {
  for (const type of BUSINESS_TYPES)
    for (const stage of ["idea", "pre-launch"] as const) {
      const tasks = journeyTasks(emptyJourney(), stage, type.id);
      assert(tasks.length >= 5, `${type.id} ${stage}`);
      assert(tasks.every((t) => t.title && t.key));
    }
  const mobile = journeyTasks(emptyJourney(), "pre-launch", "mobile");
  const goods = journeyTasks(emptyJourney(), "pre-launch", "goods");
  assert(mobile.some((t) => /store listings/i.test(t.title)));
  assert(!goods.some((t) => /store listings/i.test(t.title)));
});

test("workspace validation identifies each field without echoing private values", () => {
  const short = "short";
  const errors = workspaceFieldErrors(
    { owner: "", workspace: "", timezone: "Not/AZone" },
    short,
  );
  assert.deepEqual(errors, {
    owner: "Enter your name.",
    workspace: "Name your workspace.",
    timezone: "Choose a valid timezone.",
    password: "Use at least 10 characters.",
  });
  assert(!JSON.stringify(errors).includes(short));
  const valid = { owner: "Owner", workspace: "Company", timezone: "UTC" };
  assert.deepEqual(workspaceFieldErrors(valid, "ten-chars!"), {});
  assert.deepEqual(workspaceFieldErrors(valid), {});
  assert.equal(
    workspaceFieldErrors(valid, "x".repeat(513)).password,
    "Use no more than 512 characters.",
  );
  assert.throws(() => requireValidFields(errors), SetupValidationError);
});
test("venture validation attaches URL and missing-name problems to their controls", () => {
  assert.deepEqual(ventureFieldErrors({ name: "", website: "example.test" }), {
    "venture-name": "Name your venture, or add it later.",
    "venture-website": "Use a website starting with https:// or http://.",
  });
  assert.deepEqual(ventureFieldErrors({ name: "Project", website: "" }), {});
  assert.deepEqual(
    ventureFieldErrors({ name: "Project", website: "https://example.test" }),
    {},
  );
});
test("API errors retain structured field details for inline display", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "Check the highlighted fields.",
          fieldErrors: { password: "Use at least 10 characters.", invalid: 42 },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    await assert.rejects(
      call("/onboarding/start", { method: "POST", body: "{}" }),
      (error) =>
        error instanceof ApiError &&
        error.status === 400 &&
        error.fieldErrors.password === "Use at least 10 characters." &&
        !("invalid" in error.fieldErrors),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("account name errors identify both duplicates within the same service", () => {
  const errors = accountFieldErrors([
    { key: "first", plugin: "stripe", label: "Main" },
    { key: "second", plugin: "stripe", label: " Main " },
    { key: "other", plugin: "umami", label: "Main" },
    { key: "blank", plugin: "local", label: "" },
  ]);
  assert.deepEqual(Object.keys(errors).sort(), [
    "account-label:blank",
    "account-label:first",
    "account-label:second",
  ]);
});
