import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db, upsertPlugin, appendChatMessage } from "../db.ts";
import { ownerGate } from "../integrations/security/gate.ts";
import { onboardingRoutes } from "../routes/onboarding.ts";
import { models } from "../routes/models.ts";
import { setupRow, setupResults, needsOnboarding } from "./store.ts";
import { exactAssignments, reconcileOnboarding } from "./reconcile.ts";
import {
  emptySetup,
  accountEnv,
  envTemplate,
  credentialEnv,
  parseSetupDraft,
  readEnv,
  type SetupDraft,
  type ConnectionResult,
} from "../../../shared/onboarding.ts";
import { planDashboards } from "../../../shared/onboardingPlan.ts";
import { entries } from "../vault.ts";
import { readModelProvider, readChatBackend } from "../routes/pluginConfig.ts";
import * as accounts from "../accounts.ts";
const app = new Hono()
  .use("/api/*", ownerGate)
  .route("/api/onboarding", onboardingRoutes)
  .route("/api/models", models);
const origin = {
  origin: "http://localhost:5180",
  "content-type": "application/json",
};
const request = (path: string, body?: unknown, cookie?: string) =>
  app.request("http://localhost:8787/api/onboarding" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...origin, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  db.exec(
    "DELETE FROM onboarding_provisioned_boards; DELETE FROM onboarding_auto_links; DELETE FROM onboarding_connections; DELETE FROM onboarding_state; DELETE FROM workspace_preferences; DELETE FROM ventures; DELETE FROM plugin_accounts; DELETE FROM security_sessions; DELETE FROM security_owner; DELETE FROM chat_messages;",
  );
  globalThis.fetch = async () => {
    throw Error("Network disabled in unit tests");
  };
});
const draft = () => ({
  ...emptySetup(),
  owner: "Owner",
  workspace: "Workshop",
  timezone: "Europe/Dublin",
});
async function start() {
  const res = await request("/start", {
    draft: draft(),
    password: "a-long-local-test-password",
  });
  assert.equal(res.status, 201, await res.clone().text());
  return {
    doc: (await res.json()) as { revision: number; draft: SetupDraft },
    cookie: res.headers.get("set-cookie")!.split(";")[0]!,
  };
}
test("first-run gate distinguishes new and existing workspaces without replacing anything", async () => {
  assert.equal(needsOnboarding(), true);
  const preferences = {
    workspace: { owner: "Saved", name: "Saved", defaultVentureId: null },
    dashboards: [{ id: "custom", slug: "custom", name: "Custom", widgets: [] }],
    sessions: [],
  };
  db.prepare("INSERT INTO workspace_preferences VALUES(1,7,?,?)").run(
    JSON.stringify(preferences),
    new Date().toISOString(),
  );
  assert.equal(needsOnboarding(), false);
  const res = await request("/start", {
    draft: draft(),
    password: "a-long-local-test-password",
  });
  assert.equal(res.status, 409);
  assert.equal(
    (
      db.prepare("SELECT revision FROM workspace_preferences").get() as {
        revision: number;
      }
    ).revision,
    7,
  );
});
test("a background briefing does not dismiss welcome before the owner starts setup", () => {
  appendChatMessage({
    sessionId: "briefing",
    role: "assistant",
    content: "No sources connected yet.",
    channel: "briefing",
  });
  assert.equal(needsOnboarding(), true);
  appendChatMessage({
    sessionId: "conversation",
    role: "user",
    content: "Help me plan my business.",
    channel: "web",
  });
  assert.equal(
    needsOnboarding(),
    false,
    "a real legacy conversation is still preserved",
  );
});
test("owner setup is atomic and resumable; status does not expose preferences", async () => {
  const { doc, cookie } = await start();
  assert.equal(doc.draft.step, 1);
  assert.equal(doc.draft.owner, "Owner");
  assert(!JSON.stringify(doc).includes("local-test-password"));
  assert.equal((await request("")).status, 401);
  const status = (await (await request("/status")).json()) as {
    authenticated: boolean;
    needed: boolean;
  };
  assert.equal(status.authenticated, false);
  assert.equal(status.needed, true);
  assert(!("draft" in status));
  assert.equal((await request("", undefined, cookie)).status, 200);
  assert.equal(
    (
      await request(
        "/start",
        { draft: draft(), password: "a-long-local-test-password" },
        cookie,
      )
    ).status,
    409,
  );
});
test("owner-only setup cannot be invoked by a foreign page or agent key", async () => {
  const res = await app.request("http://localhost:8787/api/onboarding/start", {
    method: "POST",
    headers: { ...origin, origin: "https://foreign.invalid" },
    body: JSON.stringify({
      draft: draft(),
      password: "a-long-local-test-password",
    }),
  });
  assert.equal(res.status, 403);
  assert.equal(setupRow(), undefined);
});
test("draft revision conflicts do not silently overwrite progress", async () => {
  const { doc, cookie } = await start();
  const next = {
    ...doc.draft,
    step: 2,
    ventures: [
      {
        key: "one",
        name: "App",
        website: "",
        businessType: "mobile",
        stage: "pre-launch",
      },
    ],
    secret: "not-saved",
  };
  const put = (revision: number) =>
    app.request("http://localhost:8787/api/onboarding", {
      method: "PUT",
      headers: { ...origin, cookie },
      body: JSON.stringify({ revision, draft: next }),
    });
  assert.equal((await put(doc.revision)).status, 200);
  assert.equal((await put(doc.revision)).status, 409);
  assert(!setupRow()!.draft.includes("not-saved"));
});
test("real verification stores encrypted credentials, failed credentials never become connections", async () => {
  const { doc, cookie } = await start();
  const accounts = [
    { key: "good", plugin: "local", label: "Model", slot: 1 },
    { key: "bad", plugin: "local", label: "Offline", slot: 2 },
    { key: "missing", plugin: "stripe", label: "Stripe", slot: 1 },
  ];
  const put = await app.request("http://localhost:8787/api/onboarding", {
    method: "PUT",
    headers: { ...origin, cookie },
    body: JSON.stringify({
      revision: doc.revision,
      draft: { ...doc.draft, accounts, step: 3 },
    }),
  });
  assert.equal(put.status, 200);
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("http://127.0.0.1:19091"))
      return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
        headers: { "content-type": "application/json" },
      });
    throw Error("Endpoint unavailable");
  };
  const good = await request(
    "/connect/good",
    {
      fields: {
        "base-url": "http://127.0.0.1:19091/v1",
        key: "memory-only-credential",
      },
    },
    cookie,
  );
  assert.equal(good.status, 200);
  const r = (await good.json()) as { result: ConnectionResult };
  assert.equal(r.result.status, "connected", JSON.stringify(r));
  assert(r.result.capabilities.includes("chat"));
  assert(seen.some((x) => x.includes("/models")));
  assert(!JSON.stringify(r).includes("memory-only-credential"));
  assert(r.result.accountId !== null);
  assert(entries(r.result.accountId).length > 0);
  const bad = await request(
    "/connect/bad",
    { fields: { "base-url": "http://127.0.0.1:19092/v1" } },
    cookie,
  );
  assert.equal(
    ((await bad.json()) as { result: ConnectionResult }).result.status,
    "failed",
  );
  const missing = await request("/connect/missing", { fields: {} }, cookie);
  assert.equal(
    ((await missing.json()) as { result: ConnectionResult }).result.status,
    "failed",
  );
  assert.equal(setupResults().filter((r) => r.status === "failed").length, 2);
  const repeat = await request("/connect/good", { fields: {} }, cookie);
  assert.equal(
    ((await repeat.json()) as { result: ConnectionResult }).result.accountId,
    r.result.accountId,
  );
  assert.equal(
    (
      db.prepare("SELECT count(*) n FROM plugin_accounts").get() as {
        n: number;
      }
    ).n,
    1,
  );
});
test("completion creates real typed ventures and minimal boards once", async () => {
  const { doc, cookie } = await start();
  const next = {
    ...doc.draft,
    step: 6,
    ventures: [
      {
        key: "mobile",
        name: "Pocket",
        website: "",
        businessType: "mobile",
        businessTypes: ["mobile", "web"],
        stage: "pre-launch",
      },
      {
        key: "goods",
        name: "Goods",
        website: "",
        businessType: "goods",
        stage: "idea",
      },
    ],
  };
  assert.equal(
    (
      await app.request("http://localhost:8787/api/onboarding", {
        method: "PUT",
        headers: { ...origin, cookie },
        body: JSON.stringify({ revision: doc.revision, draft: next }),
      })
    ).status,
    200,
  );
  const completed = await request("/complete", {}, cookie);
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal(needsOnboarding(), false);
  const ventures = db
    .prepare("SELECT business_type,business_types,stage FROM ventures ORDER BY position")
    .all();
  assert.equal(ventures.length, 2);
  assert.equal(ventures[0]!.business_type, "mobile");
  assert.deepEqual(JSON.parse(String(ventures[0]!.business_types)), ["mobile", "web"]);
  assert.equal(ventures[0]!.stage, "pre-launch");
  const pref = JSON.parse(
    (
      db.prepare("SELECT data FROM workspace_preferences").get() as {
        data: string;
      }
    ).data,
  );
  assert.equal(pref.workspace.name, "Workshop");
  assert.equal(pref.dashboards.length, 1);
  assert.equal(pref.dashboards[0].slug, "overview");
  assert.equal((await request("/complete", {}, cookie)).status, 200);
  assert.equal(
    (db.prepare("SELECT count(*) n FROM ventures").get() as { n: number }).n,
    2,
  );
});
test("ENV import rejects unknown and duplicate names, and preserves multiline private keys", () => {
  const accounts = [{ key: "a", plugin: "local", slot: 1, label: "Main" }];
  const schemas = [
    {
      id: "local",
      fields: ["base-url", "key"],
      optional: ["key"],
      verifiable: true,
    },
  ];
  assert(envTemplate(accounts, schemas).includes("LOCAL_MODEL_API_KEY="));
  const fields = accountEnv(
    'LOCAL_MODEL_BASE_URL=http://127.0.0.1:1/v1\nLOCAL_MODEL_API_KEY="a=b#c"',
    accounts,
    schemas,
  );
  assert.equal(fields.a!.key, "a=b#c");
  assert.equal(readEnv("PRIVATE='first\nsecond'\n").PRIVATE, "first\nsecond");
  assert.throws(() => readEnv("KEY=x\nKEY=y"));
  assert.throws(() => accountEnv("UNSELECTED_KEY=x", accounts, schemas));
  assert.throws(() => readEnv('KEY="unclosed'));
});
test("shared plans gate capability, business type, and ownership separately", () => {
  const c = [
    {
      key: "a",
      plugin: "stripe",
      label: "Account",
      accountId: 1,
      status: "connected" as const,
      error: null,
      capabilities: ["payments"],
      checkedAt: null,
    },
  ];
  const ventures = [
    {
      id: "a",
      slug: "a",
      name: "A",
      businessType: "web" as const,
      stage: "launched" as const,
      host: "a.invalid",
    },
    {
      id: "b",
      slug: "b",
      name: "B",
      businessType: "web" as const,
      stage: "launched" as const,
      host: "b.invalid",
    },
  ];
  let boards = planDashboards(c, ventures, []);
  assert(!boards.some((b) => b.ventureId));
  assert(
    !boards.flatMap((b) => b.widgets).some((w) => w.type === "stripe.mrr"),
  );
  boards = planDashboards(c, ventures, [
    { ventureId: "a", plugin: "stripe", entity: "p" },
  ]);
  assert(
    !boards.some((b) => b.ventureId),
    "Stripe totals remain workspace-wide",
  );
  boards = planDashboards(
    [{ ...c[0]!, plugin: "umami", capabilities: ["traffic"] }],
    ventures,
    [{ ventureId: "a", plugin: "umami", entity: "site" }],
  );
  assert(boards.some((b) => b.ventureId === "a"));
  assert(!boards.some((b) => b.ventureId === "b"));
  assert.equal(
    exactAssignments(
      [{ plugin: "umami", entity: "site", label: "Site", host: "a.invalid" }],
      ventures,
    )[0]!.ventureId,
    "a",
  );
  assert.equal(
    exactAssignments(
      [{ plugin: "umami", entity: "site", label: "A", host: "a.invalid" }],
      [...ventures, { ...ventures[0]!, id: "duplicate" }],
    ).length,
    0,
  );
  assert.equal(
    exactAssignments(
      [{ plugin: "appstore", entity: "app", label: "A", host: "a.invalid" }],
      ventures,
    ).length,
    0,
  );
  assert.equal(
    exactAssignments(
      [
        {
          plugin: "umami",
          entity: "site",
          label: "A",
          host: "a.invalid.evil.invalid",
        },
      ],
      ventures,
    ).length,
    0,
  );
});
test("preferences reject invalid URLs and duplicate account slots", () => {
  assert.throws(() =>
    parseSetupDraft({
      ...draft(),
      ventures: [
        {
          key: "a",
          name: "A",
          website: "javascript:alert(1)",
          businessType: "web",
          stage: "idea",
        },
      ],
    }),
  );
  assert.throws(() =>
    parseSetupDraft({
      ...draft(),
      accounts: [
        { key: "a", plugin: "local", slot: 1, label: "One" },
        { key: "b", plugin: "local", slot: 1, label: "Two" },
      ],
    }),
  );
});

test("ENV round trips preserve pasted JSON, newlines, and account suffixes", () => {
  const selected = [
    { key: "one", plugin: "local", label: "One", slot: 1 },
    { key: "two", plugin: "local", label: "Two", slot: 2 },
  ];
  const schema = [
    {
      id: "local",
      fields: ["base-url", "key"],
      optional: ["key"],
      verifiable: true,
    },
  ];
  const values = {
    one: {
      "base-url": "http://localhost:1234/v1",
      key: JSON.stringify({ private_key: "line one\nline two" }),
    },
    two: { key: "literal'quote\\n#secret" },
  };
  const parsed = accountEnv(
    credentialEnv(selected, schema, values),
    selected,
    schema,
  );
  assert.deepEqual(parsed, values);
});
test("resource discovery works for later connections and never resurrects owner deletions", async () => {
  const { doc, cookie } = await start();
  const draft = {
    ...doc.draft,
    step: 6,
    ventures: [
      {
        key: "web",
        name: "Web",
        website: "https://scope.example",
        businessType: "web",
        stage: "launched",
      },
    ],
  };
  await app.request("http://localhost:8787/api/onboarding", {
    method: "PUT",
    headers: { ...origin, cookie },
    body: JSON.stringify({ revision: doc.revision, draft }),
  });
  assert.equal((await request("/complete", {}, cookie)).status, 200);
  upsertPlugin("umami", false, null);
  const account = accounts.create("umami", "Added after onboarding");
  accounts.writeCredentials(account, "umami", ["url", "token"], {
    url: "https://test.invalid",
    token: "fixture-only",
  });
  accounts.markOk(account.id);
  const discover = async () => ({
    entities: [
      { plugin: "umami", entity: "site", label: "Site", host: "scope.example" },
      {
        plugin: "umami",
        entity: "future",
        label: "Future",
        host: "future.example",
      },
    ],
    sources: [],
  });
  await reconcileOnboarding(discover);
  const read = () =>
    JSON.parse(
      (
        db.prepare("SELECT data FROM workspace_preferences").get() as {
          data: string;
        }
      ).data,
    );
  assert(
    read().dashboards.some(
      (b: { ventureId?: string }) => b.ventureId === "v-setup-web",
    ),
  );
  const edited = read();
  edited.dashboards = edited.dashboards.filter(
    (b: { ventureId?: string }) => !b.ventureId,
  );
  edited.dashboards[0].name = "My custom overview";
  db.prepare("UPDATE workspace_preferences SET data=?").run(
    JSON.stringify(edited),
  );
  await reconcileOnboarding(discover);
  assert.deepEqual(read(), edited);
  db.prepare(
    "DELETE FROM venture_links WHERE plugin='umami' AND entity='site'",
  ).run();
  await reconcileOnboarding(discover);
  assert.equal(
    db
      .prepare(
        "SELECT 1 FROM venture_links WHERE plugin='umami' AND entity='site'",
      )
      .get(),
    undefined,
  );
  db.exec(
    "INSERT INTO ventures(id,slug,name,description,website,host,stage,color,color_source,position,brand,created_at,updated_at,business_type) SELECT 'future','future','Future',description,'https://future.example','future.example',stage,color,color_source,1,brand,created_at,updated_at,business_type FROM ventures WHERE id='v-setup-web'",
  );
  await reconcileOnboarding(discover);
  assert(
    read().dashboards.some(
      (b: { ventureId?: string }) => b.ventureId === "future",
    ),
  );
  assert.equal(read().dashboards[0].name, "My custom overview");
  await reconcileOnboarding(async () => ({ entities: [], sources: [] }));
  assert(
    db.prepare("SELECT 1 FROM venture_links WHERE entity='future'").get(),
    "temporary discovery outages keep previous links",
  );
});
test("malformed credential values return a safe validation failure", async () => {
  const { doc, cookie } = await start();
  await app.request("http://localhost:8787/api/onboarding", {
    method: "PUT",
    headers: { ...origin, cookie },
    body: JSON.stringify({
      revision: doc.revision,
      draft: {
        ...doc.draft,
        accounts: [{ key: "one", plugin: "local", label: "One", slot: 1 }],
      },
    }),
  });
  const response = await request(
    "/connect/one",
    { fields: { key: null } },
    cookie,
  );
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { result: ConnectionResult }).result.status,
    "failed",
  );
});

test("an inference-only account enables models without inventing access to billing or an installed agent", async () => {
  const { doc, cookie } = await start();
  const next = {
    ...doc.draft,
    step: 5,
    provider: "openai",
    assistant: "hermes",
    accounts: [{ key: "model", plugin: "openai", label: "Models", slot: 1 }],
  };
  await app.request("http://localhost:8787/api/onboarding", {
    method: "PUT",
    headers: { ...origin, cookie },
    body: JSON.stringify({ revision: doc.revision, draft: next }),
  });
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const response = await request(
    "/connect/model",
    { fields: { "chat-key": "inference-only-fixture" } },
    cookie,
  );
  const { result } = (await response.json()) as { result: ConnectionResult };
  assert.equal(result.status, "connected");
  assert.deepEqual(result.capabilities, ["chat"]);
  assert(!seen.some((url) => url.includes("organization/costs")));
  const assistant = await request("/assistant", {}, cookie);
  assert.equal(assistant.status, 200);
  const state = (await assistant.json()) as {
    ready: boolean;
    providerReady: boolean;
  };
  assert.equal(state.ready, false);
  assert.equal(state.providerReady, true);
  assert.equal(readModelProvider(), "openai");
  assert.equal(readChatBackend(), null);
  const setup = (await (await request("", undefined, cookie)).json()) as {
    boards: { slug: string }[];
  };
  assert(!setup.boards.some((b) => b.slug === "ai-usage"));
});
test("unsupported website addresses fail before completion and leave the draft intact", async () => {
  const { doc, cookie } = await start();
  const response = await app.request("http://localhost:8787/api/onboarding", {
    method: "PUT",
    headers: { ...origin, cookie },
    body: JSON.stringify({
      revision: doc.revision,
      draft: {
        ...doc.draft,
        ventures: [
          {
            key: "private",
            name: "Private",
            website: "http://127.0.0.1:1234",
            businessType: "web",
            stage: "idea",
          },
        ],
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(setupRow()!.revision, doc.revision);
});

test("invalid owner details return field errors and never create a workspace", async () => {
  const response = await request("/start", {
    draft: draft(),
    password: "short",
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    fieldErrors: Record<string, string>;
    error: string;
  };
  assert.deepEqual(body.fieldErrors, {
    password: "Use at least 10 characters.",
  });
  assert.equal(setupRow(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM security_owner").get(), undefined);
  const missing = await request("/start", {
    draft: { ...draft(), owner: "", workspace: "" },
    password: "a-valid-test-password",
  });
  const fields = (
    (await missing.json()) as { fieldErrors: Record<string, string> }
  ).fieldErrors;
  assert.equal(fields.owner, "Enter your name.");
  assert.equal(fields.workspace, "Name your workspace.");
});
