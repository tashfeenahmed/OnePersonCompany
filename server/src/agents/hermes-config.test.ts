import assert from "node:assert/strict";
import test from "node:test";
import { hermesAuxiliaryYaml } from "./instance.ts";

test("Hermes helper calls inherit the workspace model's timeout", () => {
  const local = hermesAuxiliaryYaml(600_000, "local").join("\n");
  assert.match(local, /approval:\n    timeout: 600\n/);
  assert.match(local, /enable_thinking: false/);
  assert.match(local, /title_generation:\n    enabled: false/);

  const hosted = hermesAuxiliaryYaml(120_000, "openrouter").join("\n");
  assert.match(hosted, /timeout: 120\n/);
  assert.doesNotMatch(hosted, /extra_body/);

  /* Never below Hermes' own thirty seconds, whatever the policy row says. */
  assert.match(hermesAuxiliaryYaml(5_000, "openai").join("\n"), /timeout: 30\n/);
});
