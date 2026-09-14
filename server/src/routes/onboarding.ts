import { Hono } from "hono";
import { db, now, setConfig } from "../db.ts";
import {
  needsOnboarding,
  setupRow,
  setupDraft,
  setupResults,
  saveSetupResult,
  initialiseSetup,
  saveSetup,
  completeSetup,
  setupPlan,
} from "../onboarding/store.ts";
import { reconcileOnboarding } from "../onboarding/reconcile.ts";
import {
  parseSetupDraft,
  accountEnv,
  type ConnectionResult,
} from "../../../shared/onboarding.ts";
import { SERVICE_CAPABILITIES } from "../../../shared/onboardingPlan.ts";
import { setupConnectionSchemas, connectSetupAccount } from "./plugins.ts";
import {
  checkPassword,
  passwordSet,
  setPassword,
  createSession,
  setCookie,
} from "../integrations/security/owner.ts";
import {
  authenticatedRequest,
  requireBrowser,
} from "../integrations/security/gate.ts";
import { writeChatBackend, writeModelProvider } from "./pluginConfig.ts";
import { providers } from "../models/provider.ts";
import type { ProviderId } from "../models/provider.ts";
import { normaliseWebsite } from "../ventures/enrich.ts";
import { isRunning, writeMode } from "../agents/instance.ts";
import {
  workspaceFieldErrors,
  requireValidFields,
  SetupValidationError,
} from "../../../shared/onboardingValidation.ts";

export const onboardingRoutes = new Hono();
onboardingRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") return requireBrowser(c, next);
  return next();
});
const pending = new Set<string>();
async function body(c: { req: { text(): Promise<string> } }) {
  const text = await c.req.text();
  if (text.length > 250_000) throw new Error("Setup request is too large.");
  return JSON.parse(text) as Record<string, unknown>;
}
function snapshot() {
  const row = setupRow();
  return {
    revision: row?.revision ?? 0,
    draft: setupDraft(),
    completed: !!row?.completed_at,
    connections: setupResults(),
    schemas: setupConnectionSchemas().filter(
      (s) => !!SERVICE_CAPABILITIES[s.id],
    ),
    boards: setupPlan(),
  };
}
function checkedDraft(raw: unknown) {
  requireValidFields(workspaceFieldErrors(raw));
  const draft = parseSetupDraft(raw);
  for (const venture of draft.ventures)
    if (venture.website && !normaliseWebsite(venture.website))
      throw new Error(
        `${venture.name}: use a public website address, or leave it empty for now.`,
      );
  return draft;
}
function writable() {
  const r = setupRow();
  if (!r) throw new Error("Start setup first.");
  if (r.completed_at)
    throw new Error(
      "This workspace is already set up. Manage it in Settings and Integrations.",
    );
}
function safeError(error: unknown, fields: Record<string, string> = {}) {
  let message =
    error instanceof Error ? error.message : "Connection check failed.";
  for (const value of Object.values(fields))
    if (typeof value === "string" && value.length >= 3)
      message = message.split(value).join("[redacted]");
  return message.slice(0, 700);
}

onboardingRoutes.get("/status", (c) =>
  c.json({
    needed: needsOnboarding(),
    started: !!setupRow(),
    completed: !!setupRow()?.completed_at,
    authenticated: !passwordSet() || authenticatedRequest(c),
  }),
);
onboardingRoutes.get("/", (c) => c.json(snapshot()));
onboardingRoutes.post("/start", async (c) => {
  try {
    const raw = await body(c);
    const password = typeof raw.password === "string" ? raw.password : "";
    requireValidFields(workspaceFieldErrors(raw.draft, password));
    const draft = checkedDraft(raw.draft);
    const problem = checkPassword(password);
    if (problem) throw new SetupValidationError({ password: problem });
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!needsOnboarding() || setupRow() || passwordSet())
        throw new Error(
          "This workspace has already been started. Sign in to continue.",
        );
      initialiseSetup({ ...draft, step: 1 });
      setPassword(password);
      const session = createSession(c.req.header("user-agent") ?? null);
      db.exec("COMMIT");
      c.header("set-cookie", setCookie(session.token));
    } catch (error) {
      db.exec("ROLLBACK");
      return c.json({ error: safeError(error) }, 409);
    }
    return c.json(snapshot(), 201);
  } catch (error) {
    return c.json(
      {
        error: safeError(error),
        ...(error instanceof SetupValidationError
          ? { fieldErrors: error.fieldErrors }
          : {}),
      },
      400,
    );
  }
});
onboardingRoutes.put("/", async (c) => {
  try {
    writable();
    const raw = await body(c);
    const draft = checkedDraft(raw.draft);
    if (!Number.isInteger(raw.revision))
      throw new Error("A setup revision is required.");
    const schema = setupConnectionSchemas();
    for (const a of draft.accounts)
      if (
        !SERVICE_CAPABILITIES[a.plugin] ||
        !schema.some((s) => s.id === a.plugin)
      )
        throw new Error(`Unsupported service: ${a.plugin}.`);
    if (pending.size)
      return c.json(
        { error: "Wait for the current connection checks to finish." },
        409,
      );
    if (!saveSetup(draft, Number(raw.revision)))
      return c.json(
        {
          error: "Setup changed in another tab. Reload to continue.",
          ...snapshot(),
        },
        409,
      );
    return c.json(snapshot());
  } catch (error) {
    return c.json(
      {
        error: safeError(error),
        ...(error instanceof SetupValidationError
          ? { fieldErrors: error.fieldErrors }
          : {}),
      },
      400,
    );
  }
});
onboardingRoutes.post("/connect/:key", async (c) => {
  let ownsPending = false;
  let fields: Record<string, string> = {};
  const key = c.req.param("key");
  try {
    writable();
    const draft = setupDraft();
    const account = draft.accounts.find((a) => a.key === key);
    if (!account)
      return c.json({ error: "No selected account with that ID." }, 404);
    if (pending.has(key))
      return c.json({ error: "This account is already being checked." }, 409);
    pending.add(key);
    ownsPending = true;
    const raw = await body(c);
    if (typeof raw.env === "string")
      fields =
        accountEnv(raw.env, draft.accounts, setupConnectionSchemas())[key] ??
        {};
    else if (
      raw.fields &&
      typeof raw.fields === "object" &&
      !Array.isArray(raw.fields)
    )
      fields = raw.fields as Record<string, string>;
    else
      throw new Error("Paste an ENV file or enter this account’s credentials.");
    const previous = setupResults().find((r) => r.key === key);
    let result: ConnectionResult;
    try {
      const connected = await connectSetupAccount(
        account.plugin,
        account.label,
        fields,
        previous?.accountId,
      );
      let capabilities = SERVICE_CAPABILITIES[account.plugin] ?? [];
      if (["openai", "openrouter"].includes(account.plugin))
        capabilities = capabilities.filter((cap) =>
          cap === "chat"
            ? connected.fields.includes("chat-key")
            : connected.fields.includes("key") && connected.collected === true,
        );
      else if (connected.collected === false) capabilities = [];
      result = {
        key,
        plugin: account.plugin,
        label: account.label,
        accountId: connected.accountId,
        status: connected.error ? "limited" : "connected",
        error: connected.error
          ? safeError(new Error(connected.error), fields)
          : null,
        capabilities,
        checkedAt: now(),
      };
    } catch (error) {
      result = {
        key,
        plugin: account.plugin,
        label: account.label,
        accountId: previous?.accountId ?? null,
        status: "failed",
        error: safeError(error, fields),
        capabilities: [],
        checkedAt: now(),
      };
    }
    saveSetupResult(result);
    return c.json({ result });
  } catch (error) {
    return c.json({ error: safeError(error, fields) }, 400);
  } finally {
    if (ownsPending) pending.delete(key);
  }
});
onboardingRoutes.post("/assistant", async (c) => {
  try {
    writable();
    const d = setupDraft();
    if (!d.provider) {
      writeModelProvider(null);
      writeChatBackend(null);
      return c.json({ ok: true, ready: false });
    }
    if (!providers().some((p) => p.id === d.provider && p.connected))
      return c.json(
        {
          error:
            "Connect a working inference key or model endpoint before choosing this provider.",
        },
        400,
      );
    writeModelProvider(d.provider as ProviderId);
    setConfig(d.provider, "model", d.model);
    const remote = setupResults().some(
      (r) => r.plugin === d.assistant && r.status === "connected",
    );
    const ready = remote || isRunning(d.assistant);
    if (remote) writeMode(d.assistant, "remote");
    writeChatBackend(ready ? d.assistant : null);
    return c.json({ ok: true, ready, providerReady: true });
  } catch (error) {
    return c.json({ error: safeError(error) }, 400);
  }
});
onboardingRoutes.post("/complete", async (c) => {
  try {
    if (pending.size)
      return c.json({ error: "Wait for connection checks to finish." }, 409);
    const result = completeSetup();
    await reconcileOnboarding();
    return c.json({
      ...result,
      boards: setupPlan(),
      next: "/dashboards/overview",
    });
  } catch (error) {
    return c.json({ error: safeError(error) }, 409);
  }
});
