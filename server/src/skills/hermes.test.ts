import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SKILL_ASSIGNMENT_RULE, TASK_AUTHORIZATION_RULE } from "./assignment.ts";
import { syncHermesSkills } from "./hermes.ts";
import { skills } from "./registry.ts";

test("installed tool packs preserve the handoff policy before procedural instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "opc-skill-policy-"));
  try {
    const first = syncHermesSkills(dir);
    const packs = first.written.filter(path => !path.endsWith("/rich-answers"));
    assert.equal(packs.length, skills().length);
    assert.ok(packs.includes("marketing/seo-audit"));
    assert.ok(packs.includes("productivity/sub-agents"));
    for (const path of packs) {
      const text = readFileSync(join(dir, path, "SKILL.md"), "utf8");
      assert.ok(text.includes(SKILL_ASSIGNMENT_RULE), path);
      assert.ok(text.indexOf(SKILL_ASSIGNMENT_RULE) < text.indexOf("## How to read it"), path);
      assert.match(text.split("\n").find(line => line.startsWith("description:"))!, /check sub-agents before new specialist work/);
      assert.doesNotMatch(text, /Use this whenever the owner asks|Do none of these unless he asked for that exact change/);
      if (text.includes("## Acting on it")) assert.ok(text.includes(TASK_AUTHORIZATION_RULE), path);
    }
    assert.equal(syncHermesSkills(dir).changed, false, "unchanged policies must not restart the agent");

    // Upgrading a generated pack should repair old guidance without touching a
    // user-installed skill alongside it.
    const generated = join(dir, "marketing/seo-audit/SKILL.md");
    writeFileSync(generated, "old instructions");
    const customDir = join(dir, "marketing/custom-skill");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, "SKILL.md"), "owner's instructions");
    const updated = syncHermesSkills(dir);
    assert.deepEqual(updated.written, ["marketing/seo-audit"]);
    assert.ok(readFileSync(generated, "utf8").includes(SKILL_ASSIGNMENT_RULE));
    assert.equal(readFileSync(join(customDir, "SKILL.md"), "utf8"), "owner's instructions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
