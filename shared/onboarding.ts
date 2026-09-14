import {
  isJourneyStage,
  type BusinessType,
  type JourneyStage,
} from "./ventureJourney.ts";
import { parseBusinessTypes } from "./businessTypes.ts";

export const ONBOARDING_STEPS = [
  "Workspace",
  "Venture",
  "Services",
  "Connect",
  "Organise",
  "Assistant",
  "Ready",
] as const;
export const MODEL_SERVICES = [
  "openai",
  "openrouter",
  "local",
  "freellmapi",
] as const;
export type SetupAccount = {
  key: string;
  plugin: string;
  label: string;
  slot: number;
};
export type SetupVenture = {
  key: string;
  name: string;
  website: string;
  businessType: BusinessType;
  businessTypes?: BusinessType[];
  stage: JourneyStage;
};
export type SetupDraft = {
  step: number;
  owner: string;
  workspace: string;
  timezone: string;
  currency: string;
  ventures: SetupVenture[];
  accounts: SetupAccount[];
  assistant: "hermes" | "openclaw";
  provider: string;
  model: string;
  alerts: boolean;
  excludedDashboards: string[];
};
export const emptySetup = (): SetupDraft => ({
  step: 0,
  owner: "",
  workspace: "",
  timezone: "UTC",
  currency: "USD",
  ventures: [],
  accounts: [],
  assistant: "hermes",
  provider: "",
  model: "",
  alerts: true,
  excludedDashboards: [],
});
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown, max: number) =>
  typeof x === "string" && x.length <= max;
const key = (x: unknown) =>
  typeof x === "string" && /^[a-zA-Z0-9-]{1,70}$/.test(x);
/** Whitelist preferences. Credentials and unknown properties never reach persistence. */
export function parseSetupDraft(raw: unknown): SetupDraft {
  if (!record(raw)) throw new Error("Expected setup preferences.");
  const d = emptySetup();
  for (const field of [
    "owner",
    "workspace",
    "timezone",
    "currency",
    "model",
    "provider",
  ] as const) {
    if (!text(raw[field], field === "model" ? 120 : 150))
      throw new Error(`Invalid ${field}.`);
    d[field] = (raw[field] as string).trim();
  }
  if (!d.owner || !d.workspace)
    throw new Error("Add your name and workspace name.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: d.timezone }).format();
  } catch {
    throw new Error("Choose a valid timezone.");
  }
  if (!/^[A-Z]{3}$/.test(d.currency))
    throw new Error("Choose a three-letter currency code.");
  if (
    !Number.isInteger(raw.step) ||
    Number(raw.step) < 0 ||
    Number(raw.step) > 6
  )
    throw new Error("Invalid setup step.");
  d.step = Number(raw.step);
  if (!Array.isArray(raw.ventures) || raw.ventures.length > 20)
    throw new Error("Use up to 20 ventures during setup.");
  d.ventures = raw.ventures.map((v) => {
    if (
      !record(v) ||
      !key(v.key) ||
      !text(v.name, 100) ||
      !(v.name as string).trim() ||
      !text(v.website, 500) ||
      !isJourneyStage(v.stage)
    )
      throw new Error("Check each venture’s name, type, and stage.");
    const businessTypes = parseBusinessTypes(v.businessTypes, v.businessType);
    if (!businessTypes.length)
      throw new Error("Choose at least one business type.");
    const website = (v.website as string).trim();
    if (website) {
      try {
        const u = new URL(website);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw Error();
      } catch {
        throw new Error("Use a website starting with https:// or http://.");
      }
    }
    return {
      key: v.key as string,
      name: (v.name as string).trim(),
      website,
      businessType: businessTypes[0]!,
      businessTypes,
      stage: v.stage,
    };
  });
  if (!Array.isArray(raw.accounts) || raw.accounts.length > 80)
    throw new Error("Use up to 80 accounts during setup.");
  d.accounts = raw.accounts.map((a) => {
    if (
      !record(a) ||
      !key(a.key) ||
      !key(a.plugin) ||
      !text(a.label, 80) ||
      !(a.label as string).trim() ||
      !Number.isInteger(a.slot) ||
      Number(a.slot) < 1 ||
      Number(a.slot) > 9999
    )
      throw new Error("Check each connection’s service and account name.");
    return {
      key: a.key as string,
      plugin: a.plugin as string,
      label: (a.label as string).trim(),
      slot: Number(a.slot),
    };
  });
  for (const rows of [d.ventures, d.accounts])
    if (new Set(rows.map((x) => x.key)).size !== rows.length)
      throw new Error("Duplicate setup identifier.");
  if (
    new Set(d.accounts.map((a) => `${a.plugin}:${a.slot}`)).size !==
      d.accounts.length ||
    new Set(d.accounts.map((a) => `${a.plugin}:${a.label}`)).size !==
      d.accounts.length
  )
    throw new Error("Give accounts of the same service different names.");
  if (!["hermes", "openclaw"].includes(String(raw.assistant)))
    throw new Error("Choose Hermes or OpenClaw.");
  d.assistant = raw.assistant as SetupDraft["assistant"];
  if (
    d.provider &&
    !MODEL_SERVICES.includes(d.provider as (typeof MODEL_SERVICES)[number])
  )
    throw new Error("Choose a supported LLM provider.");
  if (d.model.includes("\n")) throw new Error("Use one model ID.");
  d.alerts = raw.alerts !== false;
  if (
    !Array.isArray(raw.excludedDashboards) ||
    raw.excludedDashboards.length > 30 ||
    !raw.excludedDashboards.every(
      (x) => typeof x === "string" && /^[a-z-]{1,40}$/.test(x),
    )
  )
    throw new Error("Invalid dashboard choices.");
  d.excludedDashboards = [...new Set(raw.excludedDashboards)] as string[];
  return d;
}

export type ConnectionResult = {
  key: string;
  plugin: string;
  label: string;
  accountId: number | null;
  status: "connected" | "limited" | "failed" | "pending";
  error: string | null;
  capabilities: string[];
  checkedAt: string | null;
};
export type ConnectionSchema = {
  id: string;
  fields: string[];
  optional: string[];
  verifiable: boolean;
};
export const ENV_FIELDS: Record<string, Record<string, string>> = {
  stripe: { key: "STRIPE_API_KEY" },
  github: { token: "GITHUB_TOKEN" },
  hetzner: { token: "HETZNER_API_TOKEN" },
  openai: { key: "OPENAI_ADMIN_KEY", "chat-key": "OPENAI_API_KEY" },
  openrouter: {
    key: "OPENROUTER_MANAGEMENT_KEY",
    "chat-key": "OPENROUTER_API_KEY",
  },
  appstore: {
    "key-id": "APP_STORE_KEY_ID",
    "issuer-id": "APP_STORE_ISSUER_ID",
    vendor: "APP_STORE_VENDOR_NUMBER",
    "key.p8": "APP_STORE_PRIVATE_KEY",
  },
  playstore: {
    "key.json": "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
    "developer-id": "GOOGLE_PLAY_DEVELOPER_ID",
  },
  gsc: { "key.json": "GOOGLE_SEARCH_CONSOLE_SERVICE_ACCOUNT_JSON" },
  local: { "base-url": "LOCAL_MODEL_BASE_URL", key: "LOCAL_MODEL_API_KEY" },
};
export function envName(account: SetupAccount, field: string) {
  const name =
    ENV_FIELDS[account.plugin]?.[field] ??
    `${account.plugin}_${field}`.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  return name + (account.slot > 1 ? `__${account.slot}` : "");
}
export function envTemplate(
  accounts: SetupAccount[],
  schema: ConnectionSchema[],
) {
  return (
    "# One Person Company connections. Keep this file private.\n" +
    accounts
      .map(
        (a) =>
          `\n# ${a.plugin} · ${a.label.replace(/[\r\n]/g, " ")}\n` +
          (schema.find((s) => s.id === a.plugin)?.fields ?? [])
            .map((f) => `${envName(a, f)}=`)
            .join("\n"),
      )
      .join("\n") +
    "\n"
  );
}
/** Serialize values without changing escaped JSON or private-key text. */
export function credentialEnv(
  accounts: SetupAccount[],
  schema: ConnectionSchema[],
  fields: Record<string, Record<string, string>>,
) {
  return (
    "# One Person Company connections. Keep this file private.\n" +
    accounts
      .map(
        (a) =>
          `\n# ${a.plugin} · ${a.label.replace(/[\r\n]/g, " ")}\n` +
          (schema.find((s) => s.id === a.plugin)?.fields ?? [])
            .map((f) => {
              const value = fields[a.key]?.[f] ?? "";
              let encoded = value;
              if (/[\s#'"`]/.test(value)) {
                const quote = ["'", "`", '"'].find(
                  (q) =>
                    !value.includes(q) && !(q === '"' && /\\[nr]/.test(value)),
                );
                if (!quote)
                  throw new Error(
                    "This value needs individual fields to preserve its exact text.",
                  );
                encoded = quote + value + quote;
              }
              return `${envName(a, f)}=${encoded}`;
            })
            .join("\n"),
      )
      .join("\n") +
    "\n"
  );
}
/** dotenv syntax only: no interpolation, shell execution, or process.env mutation. */
export function readEnv(input: string): Record<string, string> {
  if (input.length > 200_000)
    throw new Error("Use an ENV file smaller than 200 KB.");
  const out: Record<string, string> = Object.create(null);
  const source = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let at = 0;
  while (at < source.length) {
    while (at < source.length && /\s/.test(source[at]!)) at++;
    if (source[at] === "#") {
      while (at < source.length && source[at] !== "\n") at++;
      continue;
    }
    if (at >= source.length) break;
    const match =
      /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(
        source.slice(at),
      );
    if (!match) throw new Error("Each ENV entry needs NAME=value.");
    const name = match[1]!;
    if (Object.hasOwn(out, name))
      throw new Error(`Duplicate ENV entry: ${name}.`);
    at += match[0].length;
    let value = "";
    const quote = source[at];
    if (quote === '"' || quote === "'" || quote === "`") {
      at++;
      let closed = false;
      while (at < source.length) {
        const c = source[at++]!;
        if (c === quote) {
          closed = true;
          break;
        }
        value += c;
      }
      if (!closed) throw new Error(`Close the quoted value for ${name}.`);
      if (quote === '"')
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      while (source[at] === " " || source[at] === "\t") at++;
      if (source[at] === "#")
        while (at < source.length && source[at] !== "\n") at++;
      else if (at < source.length && source[at] !== "\n")
        throw new Error(`Unexpected text after ${name}.`);
    } else {
      while (at < source.length && source[at] !== "\n" && source[at] !== "#")
        value += source[at++];
      value = value.trim();
      if (source[at] === "#")
        while (at < source.length && source[at] !== "\n") at++;
    }
    out[name] = value;
  }
  return out;
}
export function accountEnv(
  input: string,
  accounts: SetupAccount[],
  schema: ConnectionSchema[],
) {
  const values = readEnv(input);
  const names = new Set(
    accounts.flatMap((a) =>
      (schema.find((s) => s.id === a.plugin)?.fields ?? []).map((f) =>
        envName(a, f),
      ),
    ),
  );
  for (const name of Object.keys(values))
    if (!names.has(name))
      throw new Error(`Unknown ENV entry: ${name}. Select its service first.`);
  return Object.fromEntries(
    accounts.map((a) => [
      a.key,
      Object.fromEntries(
        (schema.find((s) => s.id === a.plugin)?.fields ?? [])
          .filter((f) => values[envName(a, f)]?.trim())
          .map((f) => [f, values[envName(a, f)]!]),
      ),
    ]),
  );
}
