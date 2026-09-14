import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBusinessTypes,
  businessTypesOf,
  storedBusinessTypes,
  toggleBusinessType,
} from "../../../shared/businessTypes.ts";
import { emptySetup, parseSetupDraft } from "../../../shared/onboarding.ts";
import { journeyTasks, emptyJourney } from "../../../shared/ventureJourney.ts";
import { planDashboards } from "../../../shared/onboardingPlan.ts";

test("business types preserve legacy choices, deduplicate selections, and reject malformed values", () => {
  assert.deepEqual(parseBusinessTypes(undefined, "mobile"), ["mobile"]);
  assert.deepEqual(parseBusinessTypes(["web", "mobile", "web"]), [
    "web",
    "mobile",
  ]);
  assert.deepEqual(businessTypesOf({ businessType: "shop" }), ["shop"]);
  assert.deepEqual(
    storedBusinessTypes({ business_type: "web", business_types: "[]" }),
    ["web"],
  );
  assert.deepEqual(
    storedBusinessTypes({
      business_type: "web",
      business_types: '["web","mobile"]',
    }),
    ["web", "mobile"],
  );
  assert.deepEqual(toggleBusinessType(["web", "mobile"], "web"), ["mobile"]);
  assert.deepEqual(toggleBusinessType(["mobile"], "desktop"), [
    "mobile",
    "desktop",
  ]);
  for (const value of [null, "mobile", ["invented"], ["web", 2], {}])
    assert.throws(() => parseBusinessTypes(value));
});

test("onboarding saves all selected types and rejects an empty selection", () => {
  const draft = {
    ...emptySetup(),
    owner: "Owner",
    workspace: "Studio",
    ventures: [
      {
        key: "one",
        name: "Planner",
        website: "",
        stage: "idea",
        businessTypes: ["web", "mobile"],
      },
    ],
  };
  const parsed = parseSetupDraft(draft);
  assert.deepEqual(parsed.ventures[0]?.businessTypes, ["web", "mobile"]);
  assert.equal(parsed.ventures[0]?.businessType, "web");
  assert.throws(
    () =>
      parseSetupDraft({
        ...draft,
        ventures: [{ ...draft.ventures[0], businessTypes: [] }],
      }),
    /at least one/,
  );
});

test("combined checklists include every selected track and common steps only once", () => {
  const tasks = journeyTasks(emptyJourney(), "pre-launch", ["web", "mobile"]);
  assert(tasks.some((t) => t.businessType === "web"));
  assert(tasks.some((t) => t.businessType === "mobile"));
  assert(!tasks.some((t) => t.businessType === "goods"));
  assert.equal(tasks.length, new Set(tasks.map((t) => t.key)).size);
});

test("automatic widgets match any selected type while still requiring a resource link", () => {
  const venture = {
    id: "one",
    slug: "one",
    name: "Planner",
    businessType: "mobile" as const,
    businessTypes: ["mobile", "web"] as ("mobile" | "web")[],
    stage: "launched" as const,
    host: "example.test",
  };
  const connection = {
    key: "traffic",
    plugin: "umami",
    accountId: 1,
    label: "Traffic",
    status: "connected" as const,
    error: null,
    capabilities: ["traffic"],
    checkedAt: null,
  };
  const boards = planDashboards(
    [connection],
    [venture],
    [{ ventureId: "one", plugin: "umami", entity: "site" }],
  );
  assert(
    boards
      .find((b) => b.ventureId === "one")
      ?.widgets.some((w) => w.type === "umami.pageviews"),
  );
  assert(!planDashboards([connection], [venture], []).some((b) => b.ventureId));
});
