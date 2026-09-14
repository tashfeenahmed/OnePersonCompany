import test from "node:test";
import assert from "node:assert/strict";
import { detectTimezone, workspaceStepErrors } from "./workspaceSteps.ts";
import { workspaceFieldErrors } from "../../../../shared/onboardingValidation.ts";

test("each workspace question validates independently, while final submission still checks everything", () => {
  const draft = { owner: "Taylor", workspace: "", timezone: "UTC" };
  assert.deepEqual(workspaceStepErrors(0, draft, ""), {});
  assert.deepEqual(workspaceStepErrors(1, draft, ""), {
    workspace: "Name your workspace.",
  });
  assert.deepEqual(workspaceStepErrors(2, draft, "short"), {
    password: "Use at least 10 characters.",
  });
  assert.deepEqual(workspaceStepErrors(2, draft, "a-valid-test-password"), {});
  assert(workspaceFieldErrors(draft, "a-valid-test-password").workspace);
  assert(workspaceStepErrors(0, { ...draft, owner: "  " }, "").owner);
});
test("automatic timezone uses the browser's zone and safely falls back to UTC", () => {
  assert.equal(
    detectTimezone(() => "Asia/Kolkata"),
    "Asia/Kolkata",
  );
  assert.equal(
    detectTimezone(() => "Europe/Dublin"),
    "Europe/Dublin",
  );
  assert.equal(
    detectTimezone(() => "Invalid/Zone"),
    "UTC",
  );
  assert.equal(
    detectTimezone(() => ""),
    "UTC",
  );
  assert.equal(
    detectTimezone(() => {
      throw new Error("unavailable");
    }),
    "UTC",
  );
});
