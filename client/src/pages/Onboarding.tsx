import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  Upload,
  Plus,
  X,
  Search,
  RefreshCw,
  Grid2X2,
  Sparkles,
  Bot,
  Loader2,
  CircleAlert,
  LockKeyhole,
} from "lucide-react";
import { call, ApiError, type AgentsDoc } from "@/lib/api";
import { randomId } from "@/lib/id";
import { BUSINESS_TYPE_ICONS } from "@/data/businessTypeIcons";
import { PLUGINS } from "@/data/plugins";
import { BRAND_ICONS } from "@/data/brandIcons";
import { COLOR_SERVICE_MARKS } from "@/components/onboarding/serviceBrandMarks";
import { WIDGETS } from "@/data/widgets";
import {
  BUSINESS_TYPES,
  STAGE_LABELS,
  JOURNEY_STAGES,
  journeyTasks,
  emptyJourney,
  type BusinessType,
  type JourneyStage,
} from "../../../shared/ventureJourney";
import {
  ONBOARDING_STEPS,
  emptySetup,
  envTemplate,
  credentialEnv,
  accountEnv,
  type SetupDraft,
  type SetupAccount,
  type ConnectionSchema,
  type ConnectionResult,
} from "../../../shared/onboarding";
import {
  SERVICE_CAPABILITIES,
  SETUP_CAPABILITIES,
  planDashboards,
  type SetupBoard,
} from "../../../shared/onboardingPlan";
import { Field } from "@/components/onboarding/Field";
import {
  businessTypesOf,
  toggleBusinessType,
} from "../../../shared/businessTypes";
import { Welcome } from "@/components/onboarding/Welcome";
import { useScreenTransition } from "@/components/onboarding/useScreenTransition";
import {
  WORKSPACE_FIELDS,
  workspaceStepErrors,
  detectTimezone,
} from "@/components/onboarding/workspaceSteps";
import {
  workspaceFieldErrors,
  ventureFieldErrors,
  accountFieldErrors,
  requireValidFields,
  SetupValidationError,
  type SetupFieldErrors,
} from "../../../shared/onboardingValidation";
import "./onboarding.css";

type Snapshot = {
  revision: number;
  draft: SetupDraft;
  completed: boolean;
  connections: ConnectionResult[];
  schemas: ConnectionSchema[];
  boards: SetupBoard[];
};
type VentureInput = {
  name: string;
  website: string;
  businessTypes: BusinessType[];
  stage: JourneyStage;
};
const freshVenture = (): VentureInput => ({
  name: "",
  website: "",
  businessTypes: ["web"],
  stage: "idea",
});
const key = randomId;
const plugin = (id: string) => PLUGINS.find((p) => p.id === id);

function Mark({ id }: { id: string }) {
  const p = plugin(id);
  const brand = p?.icon ? BRAND_ICONS[p.icon] : null;
  const colorMark = p?.icon ? COLOR_SERVICE_MARKS[p.icon] : null;
  return (
    <span
      className="ob-mark"
      style={{
        backgroundColor:
          colorMark?.background ?? brand?.hex ?? p?.tint ?? "#595953",
        color: "#ffffff",
      }}
      aria-hidden="true"
    >
      {brand ? (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: colorMark?.svg ?? brand.svg }}
        />
      ) : (
        <span>{p?.mono ?? p?.name[0] ?? "+"}</span>
      )}
    </span>
  );
}
function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const descriptions: Record<string, string> = {
  stripe: "Revenue & subscriptions",
  github: "Code & releases",
  umami: "Traffic & visitors",
  hetzner: "Servers & costs",
  openai: "Models & usage",
  openrouter: "Models & usage",
  appstore: "App revenue & performance",
  playstore: "Downloads & revenue",
  gmail: "Email & inbox",
  cloudflare: "Domains & traffic",
  local: "Models on your machine",
  freellmapi: "Your model gateway",
  hermes: "Existing agent connection",
  openclaw: "Existing agent gateway",
};

export function Onboarding() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [draft, setDraft] = useState<SetupDraft>(emptySetup),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [venture, setVenture] = useState<VentureInput>(freshVenture),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("all");
  const [entry, setEntry] = useState<"env" | "fields">("env"),
    [env, setEnv] = useState<string | null>(null),
    [fields, setFields] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<ConnectionResult[]>([]),
    [checking, setChecking] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentsDoc | null>(null),
    [agentBusy, setAgentBusy] = useState(false);
  const [preview, setPreview] = useState("workspace");
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [workspaceStep, setWorkspaceStep] = useState(0);
  const { flow, transitioning, transition } = useScreenTransition();
  const working = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<SetupFieldErrors>({});
  const showWelcome =
    !!snapshot && snapshot.revision === 0 && !welcomeDismissed;
  const revision = useRef(0);
  const file = useRef<HTMLInputElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    container = useRef<HTMLDivElement>(null);
  const loaded = !!snapshot;
  const schemas = snapshot?.schemas ?? [];
  const template = envTemplate(draft.accounts, schemas);
  const eligible = PLUGINS.filter(
    (p) => schemas.some((s) => s.id === p.id) && SERVICE_CAPABILITIES[p.id],
  );
  const models = [
    ...new Set(
      results
        .filter(
          (r) =>
            r.capabilities.includes("chat") &&
            (r.status === "connected" || r.status === "limited"),
        )
        .map((r) => r.plugin),
    ),
  ];
  const boards = planDashboards(results, [], [], draft.excludedDashboards);
  const allBoards = planDashboards(results, [], []);
  const ready = results.filter(
    (r) => r.status === "connected" || r.status === "limited",
  ).length;
  const attention = draft.accounts.filter(
    (a) => results.find((r) => r.key === a.key)?.status !== "connected",
  ).length;
  function accept(doc: Snapshot) {
    revision.current = doc.revision;
    setSnapshot(doc);
    setDraft(
      doc.revision === 0
        ? {
            ...doc.draft,
            timezone: detectTimezone(),
          }
        : doc.draft,
    );
    setResults(doc.connections);
  }
  async function load() {
    try {
      accept(await call<Snapshot>("/onboarding"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    let active = true;
    void call<Snapshot>("/onboarding")
      .then((doc) => {
        if (active) accept(doc);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (transitioning || !loaded) return;
    flow.current?.scrollTo(0, 0);
    const target =
      draft.step === 0 && !showWelcome
        ? container.current?.querySelector<HTMLInputElement>(
            ".ob-workspace-field input:not([type=hidden])",
          )
        : container.current?.querySelector("h1");
    target?.focus({ preventScroll: true });
  }, [draft.step, showWelcome, workspaceStep, transitioning, loaded, flow]);
  async function acceptScreen(doc: Snapshot) {
    if (doc.draft.step !== draft.step) await transition(() => accept(doc));
    else accept(doc);
  }
  useEffect(() => {
    if (draft.step !== 5) return;
    let live = true;
    const refresh = () => {
      void call<AgentsDoc>("/agents")
        .then((d) => {
          if (live) setAgents(d);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [draft.step]);
  function edit<K extends keyof SetupDraft>(field: K, value: SetupDraft[K]) {
    setDraft((d) => ({ ...d, [field]: value }));
  }
  async function save(next: SetupDraft) {
    requireValidFields(accountFieldErrors(next.accounts));
    const doc = await call<Snapshot>("/onboarding", {
      method: "PUT",
      body: JSON.stringify({ revision: revision.current, draft: next }),
    });
    await acceptScreen(doc);
    return doc;
  }
  function clearField(name: string) {
    setFieldErrors((previous) => {
      if (!previous[name]) return previous;
      const next = { ...previous };
      delete next[name];
      return next;
    });
  }
  function showFieldErrors(errors: SetupFieldErrors) {
    if (draft.step === 0) {
      const invalidStep = WORKSPACE_FIELDS.findIndex((field) => errors[field]);
      if (invalidStep >= 0) setWorkspaceStep(invalidStep);
    }
    setFieldErrors(errors);
    setError("");
    requestAnimationFrame(() => {
      const input = container.current?.querySelector<HTMLInputElement>(
        '[aria-invalid="true"]',
      );
      let parent = input?.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      input?.focus();
    });
  }
  function reportError(error: unknown) {
    if (
      (error instanceof SetupValidationError || error instanceof ApiError) &&
      Object.keys(error.fieldErrors).length
    )
      showFieldErrors(error.fieldErrors);
    else setError(error instanceof Error ? error.message : String(error));
  }
  async function work(fn: () => Promise<void>) {
    if (working.current || transitioning) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      reportError(e);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function addVenture() {
    requireValidFields({
      ...ventureFieldErrors(venture),
      ...(!venture.businessTypes.length
        ? { "venture-types": "Choose at least one business type." }
        : {}),
    });
    clearField("venture-name");
    clearField("venture-website");
    clearField("venture-types");
    const next = {
      ...draft,
      ventures: [
        ...draft.ventures,
        {
          key: key(),
          ...venture,
          businessType: venture.businessTypes[0]!,
          name: venture.name.trim(),
        },
      ],
    };
    setDraft(next);
    setVenture(freshVenture());
    return next;
  }
  function credentials() {
    if (entry === "env") {
      try {
        return accountEnv(env ?? template, draft.accounts, schemas);
      } catch (error) {
        throw new SetupValidationError({
          env: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return fields;
  }
  async function connect(list = draft.accounts) {
    const values = credentials();
    await save({ ...draft, step: 4 });
    setChecking(list.map((a) => a.key));
    // Two providers at a time: a slow API does not hold every other connection up.
    const queue = [...list];
    async function worker() {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const account = a;
        try {
          const { result } = await call<{ result: ConnectionResult }>(
            `/onboarding/connect/${account.key}`,
            {
              method: "POST",
              body: JSON.stringify({ fields: values[account.key] ?? {} }),
            },
          );
          setResults((rows) => [
            ...rows.filter((r) => r.key !== account.key),
            result,
          ]);
        } catch (e) {
          setResults((rows) => [
            ...rows.filter((r) => r.key !== account.key),
            {
              key: account.key,
              plugin: account.plugin,
              label: account.label,
              accountId: null,
              status: "failed",
              error: e instanceof Error ? e.message : String(e),
              capabilities: [],
              checkedAt: null,
            },
          ]);
        } finally {
          setChecking((keys) => keys.filter((k) => k !== account.key));
        }
      }
    }
    await Promise.all([worker(), worker()]);
    const latest = await call<Snapshot>("/onboarding");
    accept(latest);
    setFields({});
    setEnv(null);
  }
  async function next() {
    await work(async () => {
      if (draft.step === 0) {
        requireValidFields(workspaceStepErrors(workspaceStep, draft, password));
        if (workspaceStep < WORKSPACE_FIELDS.length - 1) {
          await transition(() => setWorkspaceStep((step) => step + 1));
          return;
        }
        requireValidFields(workspaceFieldErrors(draft, password));
        const doc = await call<Snapshot>("/onboarding/start", {
          method: "POST",
          body: JSON.stringify({ draft, password }),
        });
        await acceptScreen(doc);
        setPassword("");
        return;
      }
      if (draft.step === 1) {
        const next =
          venture.name.trim() || venture.website.trim() ? addVenture() : draft;
        if (!next.ventures.length)
          throw new SetupValidationError({
            "venture-name": "Name your venture, or add it later.",
          });
        await save({ ...next, step: 2 });
        return;
      }
      if (draft.step === 3) {
        await connect();
        return;
      }
      if (draft.step === 5) {
        await save({ ...draft, step: 5 });
        await call("/onboarding/assistant", { method: "POST", body: "{}" });
        await save({ ...draft, step: 6 });
        return;
      }
      if (draft.step === 6) {
        await save(draft);
        await call("/onboarding/complete", { method: "POST", body: "{}" });
        setFields({});
        setEnv(null);
        window.location.replace("/dashboards/overview");
        return;
      }
      await save({
        ...draft,
        step: draft.step === 2 && !draft.accounts.length ? 5 : draft.step + 1,
      });
    });
  }
  function chooseService(id: string) {
    const current = draft.accounts.filter((a) => a.plugin === id);
    if (
      current.some((a) => results.some((r) => r.key === a.key && r.accountId))
    ) {
      setNotice(
        "This service is connected. You can manage it in Integrations after setup.",
      );
      return;
    }
    changeAccounts(
      current.length
        ? draft.accounts.filter((a) => a.plugin !== id)
        : [
            ...draft.accounts,
            { key: key(), plugin: id, label: "Main account", slot: 1 },
          ],
    );
  }
  function switchEntry(mode: "env" | "fields") {
    try {
      if (mode === "fields") setFields(credentials());
      else setEnv(credentialEnv(draft.accounts, schemas, fields));
      setEntry(mode);
      setError("");
    } catch (e) {
      reportError(
        e instanceof SetupValidationError
          ? e
          : new SetupValidationError({
              env: e instanceof Error ? e.message : String(e),
            }),
      );
    }
  }
  function changeAccounts(accounts: SetupAccount[]) {
    try {
      const values = credentials();
      const selected = Object.fromEntries(
        accounts.map((a) => [a.key, values[a.key] ?? {}]),
      );
      setEnv(credentialEnv(accounts, schemas, selected));
      setFields(selected);
      edit("accounts", accounts);
    } catch (e) {
      reportError(
        e instanceof SetupValidationError
          ? e
          : new SetupValidationError({
              env: e instanceof Error ? e.message : String(e),
            }),
      );
    }
  }

  async function agentAction(action: "install" | "start") {
    setAgentBusy(true);
    setError("");
    try {
      await save(draft);
      await call("/onboarding/assistant", { method: "POST", body: "{}" });
      await call(`/agents/${draft.assistant}/${action}`, {
        method: "POST",
        body: "{}",
      });
      setAgents(await call("/agents"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAgentBusy(false);
    }
  }
  const titles = [
    "Your workspace.",
    "What are you building?",
    "Choose your tools.",
    "Connect your tools.",
    "Connected once. Ready everywhere.",
    "Choose your assistant.",
    "Make yourself at home.",
  ];
  const subtitles = [
    "A few details to make it yours.",
    "Start with one venture. Add more anytime.",
    "Only the services you need.",
    "One ENV file. All your keys.",
    "Shared across your workspace. Set up around each venture.",
    "An agent, powered by your preferred LLM.",
    "Your tools, your ventures, your workspace.",
  ];
  const agent = agents?.agents.find((a) => a.id === draft.assistant);
  const runtimeReady =
    agent?.state === "running" ||
    results.some(
      (r) => r.plugin === draft.assistant && r.status === "connected",
    );
  const currentPreview = draft.ventures.find((v) => v.key === preview);
  const checklist = currentPreview
    ? journeyTasks(
        emptyJourney(),
        currentPreview.stage,
        businessTypesOf(currentPreview),
      )
    : [];
  return (
    <div className={`ob ${showWelcome ? "ob--welcome" : ""}`} ref={container}>
      <header className="ob-top">
        <span className="ob-logo">1</span>
        <span>One Person Company</span>
      </header>
      <div
        className="ob-flow"
        ref={flow}
        inert={transitioning}
        aria-busy={transitioning || undefined}
      >
        {snapshot?.completed ? (
          <section className="ob-stage">
            <h1>Your workspace is ready.</h1>
            <p>Manage your connections and preferences in the app.</p>
            <a className="ob-primary" href="/dashboards/overview">
              Open workspace <ArrowRight size={16} />
            </a>
          </section>
        ) : showWelcome ? (
          <Welcome
            onStart={() =>
              void work(() => transition(() => setWelcomeDismissed(true)))
            }
          />
        ) : (
          <>
            {draft.step > 0 && (
              <nav className="ob-progress" aria-label="Setup progress">
                {ONBOARDING_STEPS.map((name, i) => (
                  <button
                    key={name}
                    disabled={
                      busy ||
                      !snapshot ||
                      i > draft.step ||
                      (i === 0 && snapshot.revision > 0)
                    }
                    aria-current={draft.step === i ? "step" : undefined}
                    className={
                      draft.step === i
                        ? "current"
                        : i < draft.step
                          ? "done"
                          : ""
                    }
                    onClick={() =>
                      void work(async () => {
                        if (i === draft.step) return;
                        await save({ ...draft, step: i });
                      })
                    }
                  >
                    <span />
                    {name}
                  </button>
                ))}
              </nav>
            )}
            <main
              className={`ob-stage ${draft.step === 0 ? "ob-stage--workspace" : ""} ${[2, 3, 6].includes(draft.step) ? "wide" : ""}`}
            >
              {snapshot && (
                <div className="ob-heading">
                  <div className="ob-eyebrow">
                    {draft.step === 0 ? (
                      <>
                        Your workspace <span>·</span> {workspaceStep + 1} / 3
                      </>
                    ) : (
                      <>
                        0{draft.step + 1} <span>/</span> 07
                      </>
                    )}
                  </div>
                  <h1 ref={heading} tabIndex={-1}>
                    {draft.step === 0
                      ? [
                          "First, your name.",
                          "Name your workspace.",
                          "Secure your workspace.",
                        ][workspaceStep]
                      : titles[draft.step]}
                  </h1>
                  <p>
                    {draft.step === 0
                      ? [
                          "A little introduction.",
                          "One home for everything you’re building.",
                          "A password to keep your company private.",
                        ][workspaceStep]
                      : subtitles[draft.step]}
                  </p>
                </div>
              )}
              {!snapshot ? (
                <div className="ob-center">
                  <Loader2 className="animate-spin" />
                  <span>Loading your setup…</span>
                  {error && (
                    <button onClick={() => void load()}>Try again</button>
                  )}
                </div>
              ) : (
                <>
                  {draft.step === 0 && (
                    <form
                      id="ob-workspace-form"
                      className="ob-panel ob-workspace-field"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        void next();
                      }}
                    >
                      <Field
                        key={WORKSPACE_FIELDS[workspaceStep]}
                        label={
                          ["Your name", "Workspace name", "Owner password"][
                            workspaceStep
                          ]
                        }
                        error={fieldErrors[WORKSPACE_FIELDS[workspaceStep]]}
                        clearError={() =>
                          clearField(WORKSPACE_FIELDS[workspaceStep])
                        }
                      >
                        <input
                          name={WORKSPACE_FIELDS[workspaceStep]}
                          type={workspaceStep === 2 ? "password" : "text"}
                          autoComplete={
                            ["given-name", "organization", "new-password"][
                              workspaceStep
                            ]
                          }
                          value={
                            workspaceStep === 0
                              ? draft.owner
                              : workspaceStep === 1
                                ? draft.workspace
                                : password
                          }
                          onChange={(event) =>
                            workspaceStep === 0
                              ? edit("owner", event.target.value)
                              : workspaceStep === 1
                                ? edit("workspace", event.target.value)
                                : setPassword(event.target.value)
                          }
                          maxLength={[80, 100, 512][workspaceStep]}
                          minLength={workspaceStep === 2 ? 10 : undefined}
                          aria-describedby={
                            workspaceStep === 2 ? "ob-password-hint" : undefined
                          }
                          enterKeyHint={workspaceStep === 2 ? "done" : "next"}
                        />
                      </Field>
                      {workspaceStep === 2 && (
                        <p id="ob-password-hint" className="ob-hint">
                          At least 10 characters.
                        </p>
                      )}
                    </form>
                  )}
                  {draft.step === 1 && (
                    <>
                      <div className="ob-tags">
                        {draft.ventures.map((v) => (
                          <span key={v.key}>
                            {v.name}
                            <small>{STAGE_LABELS[v.stage]}</small>
                            <button
                              aria-label={`Remove ${v.name}`}
                              onClick={() =>
                                edit(
                                  "ventures",
                                  draft.ventures.filter((x) => x.key !== v.key),
                                )
                              }
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="ob-panel">
                        <div className="ob-form-grid">
                          <Field
                            error={fieldErrors["venture-name"]}
                            clearError={() => clearField("venture-name")}
                            label={
                              draft.ventures.length
                                ? "Another venture"
                                : "Venture name"
                            }
                          >
                            <input
                              value={venture.name}
                              maxLength={100}
                              onChange={(e) =>
                                setVenture((v) => ({
                                  ...v,
                                  name: e.target.value,
                                }))
                              }
                            />
                          </Field>
                          <Field
                            label="Website · optional"
                            error={fieldErrors["venture-website"]}
                            clearError={() => clearField("venture-website")}
                          >
                            <input
                              value={venture.website}
                              type="url"
                              placeholder="https://"
                              onChange={(e) =>
                                setVenture((v) => ({
                                  ...v,
                                  website: e.target.value,
                                }))
                              }
                            />
                          </Field>
                        </div>
                        <div className="ob-field-heading ob-label">
                          <span id="ob-business-types-label">
                            Business types{" "}
                            <small>· Select all that apply</small>
                          </span>
                          {fieldErrors["venture-types"] && (
                            <span
                              className="ob-field-error"
                              id="ob-business-types-error"
                              role="alert"
                            >
                              {fieldErrors["venture-types"]}
                            </span>
                          )}
                        </div>
                        <div
                          className="ob-types"
                          role="group"
                          aria-labelledby="ob-business-types-label"
                          aria-describedby={
                            fieldErrors["venture-types"]
                              ? "ob-business-types-error"
                              : undefined
                          }
                        >
                          {BUSINESS_TYPES.map((t) => {
                            const Icon = BUSINESS_TYPE_ICONS[t.id];
                            return (
                              <button
                                key={t.id}
                                aria-pressed={venture.businessTypes.includes(
                                  t.id,
                                )}
                                aria-invalid={
                                  !!fieldErrors["venture-types"] || undefined
                                }
                                onClick={() => {
                                  clearField("venture-types");
                                  setVenture((v) => ({
                                    ...v,
                                    businessTypes: toggleBusinessType(
                                      v.businessTypes,
                                      t.id,
                                    ),
                                  }));
                                }}
                              >
                                <Icon size={16} />
                                {t.label}
                                {venture.businessTypes.includes(t.id) && (
                                  <Check size={12} />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="ob-label">Stage</div>
                      <div className="ob-stages">
                        {JOURNEY_STAGES.map((stage) => (
                          <button
                            key={stage}
                            aria-pressed={venture.stage === stage}
                            onClick={() => setVenture((v) => ({ ...v, stage }))}
                          >
                            <span>{STAGE_LABELS[stage]}</span>
                            <small>
                              {stage === "idea"
                                ? "Validate demand."
                                : stage === "pre-launch"
                                  ? "Prepare to launch."
                                  : "Track performance."}
                            </small>
                            {venture.stage === stage && <Check size={14} />}
                          </button>
                        ))}
                      </div>
                      <button
                        className="ob-text"
                        onClick={() => {
                          try {
                            addVenture();
                            setError("");
                          } catch (e) {
                            reportError(e);
                          }
                        }}
                      >
                        <Plus size={14} /> Add another venture
                      </button>
                    </>
                  )}
                  {draft.step === 2 && (
                    <>
                      <div className="ob-between">
                        <label className="ob-search">
                          <Search size={16} />
                          <input
                            aria-label="Search integrations"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search your services…"
                          />
                        </label>
                        <small>
                          {new Set(draft.accounts.map((a) => a.plugin)).size}{" "}
                          selected
                        </small>
                      </div>
                      <div className="ob-filters">
                        {[
                          ["all", "All"],
                          ["revenue", "Revenue"],
                          ["seo", "Analytics"],
                          ["infra", "Infrastructure"],
                          ["ai", "AI"],
                          ["comms", "Communication"],
                          ["media", "Media"],
                          ["signals", "Research"],
                        ].map(([id, name]) => (
                          <button
                            key={id}
                            aria-pressed={category === id}
                            onClick={() => setCategory(id!)}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                      <div className="ob-services">
                        {eligible
                          .filter(
                            (p) =>
                              (category === "all" || p.cat === category) &&
                              `${p.name} ${descriptions[p.id] ?? p.desc}`
                                .toLowerCase()
                                .includes(query.toLowerCase()),
                          )
                          .sort((a, b) => {
                            const order = [
                              "stripe",
                              "umami",
                              "github",
                              "hetzner",
                              "openai",
                              "gmail",
                              "appstore",
                              "playstore",
                              "cloudflare",
                            ];
                            return (
                              (order.includes(a.id)
                                ? order.indexOf(a.id)
                                : 99) -
                              (order.includes(b.id) ? order.indexOf(b.id) : 99)
                            );
                          })
                          .map((p) => (
                            <button
                              key={p.id}
                              aria-pressed={draft.accounts.some(
                                (a) => a.plugin === p.id,
                              )}
                              className="ob-service"
                              onClick={() => chooseService(p.id)}
                            >
                              <Mark id={p.id} />
                              <span className="ob-checkbox">
                                {draft.accounts.some(
                                  (a) => a.plugin === p.id,
                                ) && <Check size={12} />}
                              </span>
                              <strong>{p.name}</strong>
                              <p>
                                {descriptions[p.id] ??
                                  SERVICE_CAPABILITIES[p.id]
                                    ?.map((c) => SETUP_CAPABILITIES[c]?.label)
                                    .join(" · ")}
                              </p>
                            </button>
                          ))}
                      </div>
                    </>
                  )}
                  {draft.step === 3 && (
                    <div className="ob-credentials">
                      <section>
                        <div className="ob-between">
                          <div className="ob-segment">
                            <button
                              aria-pressed={entry === "env"}
                              onClick={() => switchEntry("env")}
                            >
                              Paste together
                            </button>
                            <button
                              aria-pressed={entry === "fields"}
                              onClick={() => switchEntry("fields")}
                            >
                              Individual fields
                            </button>
                          </div>
                          <span
                            className="ob-field-error"
                            id="ob-env-error"
                            role={fieldErrors.env ? "alert" : undefined}
                          >
                            {fieldErrors.env || <small>ENV</small>}
                          </span>
                        </div>
                        {entry === "env" ? (
                          <div className="ob-editor">
                            <div>connections.env</div>
                            <textarea
                              aria-label="Connection ENV file"
                              aria-invalid={!!fieldErrors.env}
                              aria-describedby={
                                fieldErrors.env ? "ob-env-error" : undefined
                              }
                              autoCapitalize="none"
                              autoComplete="off"
                              spellCheck={false}
                              value={env ?? template}
                              onChange={(e) => {
                                setEnv(e.target.value);
                                clearField("env");
                              }}
                            />
                          </div>
                        ) : (
                          <div className="ob-panel ob-field-accounts">
                            {draft.accounts.map((a) => (
                              <section id={`ob-fields-${a.key}`} key={a.key}>
                                <div className="ob-between">
                                  <h3>{plugin(a.plugin)?.name}</h3>
                                  <small>{a.label}</small>
                                </div>
                                {(
                                  schemas.find((s) => s.id === a.plugin)
                                    ?.fields ?? []
                                ).map((f) => {
                                  const meta = plugin(a.plugin)?.fields.find(
                                    (x) => x.key === f,
                                  );
                                  const label =
                                    (meta?.label ?? f).replace(
                                      / \(optional\)$/,
                                      "",
                                    ) +
                                    (schemas
                                      .find((s) => s.id === a.plugin)
                                      ?.optional.includes(f)
                                      ? " · optional"
                                      : "");
                                  const value = fields[a.key]?.[f] ?? "";
                                  const change = (value: string) =>
                                    setFields((all) => ({
                                      ...all,
                                      [a.key]: { ...all[a.key], [f]: value },
                                    }));
                                  return (
                                    <Field
                                      key={f}
                                      error={
                                        fieldErrors[`credential:${a.key}:${f}`]
                                      }
                                      clearError={() =>
                                        clearField(`credential:${a.key}:${f}`)
                                      }
                                      label={`${label}${a.slot > 1 ? ` · ${a.label}` : ""}`}
                                    >
                                      {/json|\.p8/.test(f) ? (
                                        <>
                                          <textarea
                                            value={value}
                                            autoComplete="off"
                                            spellCheck={false}
                                            onChange={(e) =>
                                              change(e.target.value)
                                            }
                                          />
                                          <input
                                            aria-label={`Upload ${label}`}
                                            type="file"
                                            accept=".json,.p8,.pem,.txt"
                                            onChange={async (e) => {
                                              const file = e.target.files?.[0];
                                              e.target.value = "";
                                              if (!file) return;
                                              if (file.size > 100000) {
                                                showFieldErrors({
                                                  [`credential:${a.key}:${f}`]:
                                                    "Use a file smaller than 100 KB.",
                                                });
                                                return;
                                              }
                                              change(await file.text());
                                            }}
                                          />
                                        </>
                                      ) : (
                                        <input
                                          type={
                                            meta?.kind === "secret"
                                              ? "password"
                                              : "text"
                                          }
                                          autoComplete="off"
                                          value={value}
                                          onChange={(e) =>
                                            change(e.target.value)
                                          }
                                        />
                                      )}
                                    </Field>
                                  );
                                })}
                              </section>
                            ))}
                          </div>
                        )}
                        <div className="ob-between ob-env-actions">
                          <button
                            className="ob-text"
                            onClick={() => file.current?.click()}
                          >
                            <Upload size={14} /> Upload ENV
                          </button>
                          <button
                            className="ob-text"
                            onClick={() =>
                              saveFile("connections.env", template)
                            }
                          >
                            <Download size={14} /> Download template
                          </button>
                        </div>
                        <input
                          ref={file}
                          hidden
                          type="file"
                          accept=".env,.txt,text/plain"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (!f) return;
                            try {
                              if (f.size > 200000)
                                throw Error(
                                  "Use an ENV file smaller than 200 KB.",
                                );
                              const value = await f.text();
                              const parsed = accountEnv(
                                value,
                                draft.accounts,
                                schemas,
                              );
                              setEnv(value);
                              setFields(parsed);
                              clearField("env");
                              setNotice("ENV file imported.");
                            } catch (e) {
                              showFieldErrors({ env: (e as Error).message });
                            }
                          }}
                        />
                        <details className="ob-details">
                          <summary>
                            <ChevronRight /> More than one account
                          </summary>
                          {draft.accounts.map((a) => (
                            <div className="ob-account-name" key={a.key}>
                              <Mark id={a.plugin} />
                              <span>{plugin(a.plugin)?.name}</span>
                              <div className="ob-account-control">
                                <Field
                                  label={`Account ${a.slot} name`}
                                  error={fieldErrors[`account-label:${a.key}`]}
                                  clearError={() =>
                                    clearField(`account-label:${a.key}`)
                                  }
                                >
                                  <input
                                    aria-label={`${plugin(a.plugin)?.name} account ${a.slot} name`}
                                    value={a.label}
                                    onChange={(e) =>
                                      edit(
                                        "accounts",
                                        draft.accounts.map((x) =>
                                          x.key === a.key
                                            ? { ...x, label: e.target.value }
                                            : x,
                                        ),
                                      )
                                    }
                                  />
                                </Field>
                              </div>
                            </div>
                          ))}
                          <div className="ob-add-account">
                            <select
                              aria-label="Service for another account"
                              id="ob-account-service"
                            >
                              {[
                                ...new Set(draft.accounts.map((a) => a.plugin)),
                              ].map((id) => (
                                <option key={id} value={id}>
                                  {plugin(id)?.name}
                                </option>
                              ))}
                            </select>
                            <button
                              className="ob-text"
                              onClick={() => {
                                const id = (
                                  document.getElementById(
                                    "ob-account-service",
                                  ) as HTMLSelectElement
                                ).value;
                                const slot =
                                  Math.max(
                                    ...draft.accounts
                                      .filter((a) => a.plugin === id)
                                      .map((a) => a.slot),
                                  ) + 1;
                                changeAccounts([
                                  ...draft.accounts,
                                  {
                                    key: key(),
                                    plugin: id,
                                    label: `Account ${slot}`,
                                    slot,
                                  },
                                ]);
                              }}
                            >
                              <Plus size={14} /> Add account
                            </button>
                          </div>
                        </details>
                        <p className="ob-hint">
                          <LockKeyhole size={12} /> Keys are encrypted on your
                          server. They are never saved in browser storage.
                        </p>
                      </section>
                      <aside>
                        <h3>Find your keys</h3>
                        {[...new Set(draft.accounts.map((a) => a.plugin))].map(
                          (id) => {
                            const p = plugin(id)!;
                            return (
                              <details className="ob-guide" key={id}>
                                <summary>
                                  <Mark id={id} />
                                  {p.name}
                                  <ChevronRight size={13} />
                                </summary>
                                <p>{p.help}</p>
                                {p.fields.map((f) => (
                                  <div key={f.key}>
                                    <strong>{f.label}</strong>
                                  </div>
                                ))}
                                {p.docs && (
                                  <a
                                    href={p.docs}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open {p.name} guide <ArrowRight size={12} />
                                  </a>
                                )}
                              </details>
                            );
                          },
                        )}
                        <p className="ob-hint">
                          Missing a key? Finish it later.
                        </p>
                      </aside>
                    </div>
                  )}
                  {draft.step === 4 && (
                    <>
                      <div className="ob-shared">
                        <Grid2X2 size={23} />
                        <div>
                          <strong>Available to every venture</strong>
                          <p>We’ll use what fits, within your access.</p>
                        </div>
                        <Check size={16} />
                      </div>
                      <div className="ob-between ob-summary">
                        <small aria-live="polite">
                          {checking.length
                            ? "Checking read access…"
                            : `${ready} connected · ${attention} need attention`}
                        </small>
                        <button
                          className="ob-text"
                          disabled={busy}
                          onClick={() => void work(() => connect())}
                        >
                          <RefreshCw size={13} /> Check again
                        </button>
                      </div>
                      <div className="ob-status-list">
                        {draft.accounts.map((a) => {
                          const r = results.find((r) => r.key === a.key);
                          return (
                            <section key={a.key}>
                              <div className="ob-status-heading">
                                <Mark id={a.plugin} />
                                <div>
                                  <strong>{plugin(a.plugin)?.name}</strong>
                                  <small>{a.label}</small>
                                </div>
                                <span
                                  className={`ob-pill ${r?.status === "failed" ? "bad" : r?.status === "limited" ? "limited" : ""}`}
                                >
                                  {checking.includes(a.key) ? (
                                    <>
                                      <Loader2
                                        size={12}
                                        className="animate-spin"
                                      />{" "}
                                      Checking
                                    </>
                                  ) : r?.status === "connected" ? (
                                    <>
                                      <Check size={12} /> Connected
                                    </>
                                  ) : r?.status === "limited" ? (
                                    "Limited access"
                                  ) : r?.status === "failed" ? (
                                    "Needs attention"
                                  ) : (
                                    "Not connected"
                                  )}
                                </span>
                              </div>
                              {r?.capabilities.length ? (
                                <details className="ob-access">
                                  <summary>
                                    {r.capabilities
                                      .map((c) => SETUP_CAPABILITIES[c]?.label)
                                      .join(" · ")}
                                    <ChevronRight size={12} />
                                  </summary>
                                  <p>
                                    Available across the workspace. Venture data
                                    is linked only when a resource can be
                                    identified.
                                  </p>
                                </details>
                              ) : null}
                              {r?.error && (
                                <p className="ob-connection-error">{r.error}</p>
                              )}
                              {!r || r.status !== "connected" ? (
                                <button
                                  className="ob-text ob-fix"
                                  disabled={busy}
                                  onClick={() =>
                                    void work(async () => {
                                      setEntry("fields");
                                      await save({ ...draft, step: 3 });
                                      requestAnimationFrame(() =>
                                        document
                                          .getElementById(`ob-fields-${a.key}`)
                                          ?.querySelector<HTMLInputElement>(
                                            "input,textarea",
                                          )
                                          ?.focus(),
                                      );
                                    })
                                  }
                                >
                                  Fix connection <ArrowRight size={12} />
                                </button>
                              ) : null}
                            </section>
                          );
                        })}
                      </div>
                      <details className="ob-details">
                        <summary>
                          <ChevronRight /> What gets set up automatically
                        </summary>
                        {[
                          ...new Set(draft.ventures.flatMap(businessTypesOf)),
                        ].map((type) => {
                          const Icon = BUSINESS_TYPE_ICONS[type];
                          return (
                            <div className="ob-auto-rule" key={type}>
                              <Icon size={18} />
                              <div>
                                <strong>
                                  {
                                    BUSINESS_TYPES.find((t) => t.id === type)
                                      ?.label
                                  }
                                </strong>
                                <p>
                                  {Object.values(SETUP_CAPABILITIES)
                                    .filter((c) => c.types?.includes(type))
                                    .slice(0, 3)
                                    .map((c) => c.label)
                                    .join(" · ") ||
                                    "Payments, business metrics, and a venture checklist"}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                        <p>
                          Each venture gets a checklist for its stage. Only
                          permitted reads feed its widgets. Unmatched account
                          data stays at workspace level.
                        </p>
                      </details>
                    </>
                  )}
                  {draft.step === 5 && (
                    <>
                      <div className="ob-label">Agent</div>
                      <div className="ob-runners">
                        {(["hermes", "openclaw"] as const).map((id) => (
                          <button
                            key={id}
                            aria-pressed={draft.assistant === id}
                            onClick={() => edit("assistant", id)}
                          >
                            {id === "hermes" ? (
                              <Sparkles size={25} />
                            ) : (
                              <Bot size={25} />
                            )}
                            <div>
                              <strong>
                                {id === "hermes" ? "Hermes" : "OpenClaw"}
                              </strong>
                              <small>Your personal agent.</small>
                            </div>
                            {draft.assistant === id && <Check size={15} />}
                          </button>
                        ))}
                      </div>
                      <div className="ob-between ob-label">
                        <span>LLM provider</span>
                        <button
                          className="ob-text"
                          onClick={() =>
                            void work(async () => {
                              setCategory("ai");
                              await save({ ...draft, step: 2 });
                            })
                          }
                        >
                          <Plus size={12} /> Add provider
                        </button>
                      </div>
                      {models.length ? (
                        <div className="ob-models">
                          {models.map((id) => (
                            <button
                              key={id}
                              aria-pressed={draft.provider === id}
                              onClick={() => edit("provider", id)}
                            >
                              <Mark id={id} />
                              <strong>{plugin(id)?.name}</strong>
                              {draft.provider === id && <Check size={14} />}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="ob-panel">
                          <strong>Connect an LLM provider.</strong>
                          <p>
                            OpenAI, OpenRouter, FreeLLMAPI, or a local model.
                          </p>
                        </div>
                      )}
                      <details className="ob-details">
                        <summary>
                          <ChevronRight /> Preferred model
                        </summary>
                        <Field
                          label="Model ID · optional"
                          error={fieldErrors["model"]}
                          clearError={() => clearField("model")}
                        >
                          <input
                            value={draft.model}
                            onChange={(e) => edit("model", e.target.value)}
                            placeholder="Use provider default"
                            maxLength={120}
                          />
                        </Field>
                      </details>
                      {draft.provider && (
                        <div className="ob-panel ob-runtime">
                          <div className="ob-between">
                            <strong>
                              {draft.assistant === "hermes"
                                ? "Hermes"
                                : "OpenClaw"}{" "}
                              runtime
                            </strong>
                            <small>
                              {results.some(
                                (r) =>
                                  r.plugin === draft.assistant &&
                                  r.status === "connected",
                              )
                                ? "Connected remotely"
                                : (agent?.state ?? "Checking…")}
                            </small>
                          </div>
                          {agent?.pointed && (
                            <p>Powered by {agent.pointed.providerLabel}</p>
                          )}
                          {results.some(
                            (r) =>
                              r.plugin === draft.assistant &&
                              r.status === "connected",
                          ) ? (
                            <p>
                              Your existing agent connection is ready. It keeps
                              its own model settings.
                            </p>
                          ) : (
                            <>
                              <p>
                                {agent?.state === "running"
                                  ? "Your agent is running."
                                  : agent?.state === "installing"
                                    ? (agent.step ?? "Installing…")
                                    : "Install your agent or connect one that is already running. Until then, chat uses your LLM provider directly."}
                              </p>
                              <div className="ob-between">
                                {agent?.state !== "running" && (
                                  <button
                                    className="ob-text"
                                    disabled={
                                      busy ||
                                      agentBusy ||
                                      agent?.state === "installing" ||
                                      !draft.provider
                                    }
                                    onClick={() =>
                                      void agentAction(
                                        agent?.installedAt
                                          ? "start"
                                          : "install",
                                      )
                                    }
                                  >
                                    {agentBusy ? (
                                      <Loader2
                                        size={14}
                                        className="animate-spin"
                                      />
                                    ) : (
                                      <Plus size={14} />
                                    )}{" "}
                                    {agent?.installedAt
                                      ? "Start agent"
                                      : "Install agent here"}
                                  </button>
                                )}
                                <button
                                  className="ob-text"
                                  onClick={() =>
                                    void work(async () => {
                                      const id = draft.assistant;
                                      if (
                                        !draft.accounts.some(
                                          (a) => a.plugin === id,
                                        )
                                      )
                                        await save({
                                          ...draft,
                                          step: 3,
                                          accounts: [
                                            ...draft.accounts,
                                            {
                                              key: key(),
                                              plugin: id,
                                              label: "Main account",
                                              slot: 1,
                                            },
                                          ],
                                        });
                                      else await save({ ...draft, step: 3 });
                                      setEnv(null);
                                    })
                                  }
                                >
                                  Connect existing <ArrowRight size={13} />
                                </button>
                              </div>
                              {agent?.lastError && (
                                <p className="ob-connection-error">
                                  {agent.lastError}
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      <p className="ob-hint">
                        Scheduled work and spending limits are available in
                        Settings after setup.
                      </p>
                    </>
                  )}
                  {draft.step === 6 && (
                    <>
                      <div className="ob-preview-tabs">
                        <button
                          aria-pressed={preview === "workspace"}
                          onClick={() => setPreview("workspace")}
                        >
                          <Grid2X2 size={12} /> Workspace
                        </button>
                        {draft.ventures.map((v) => (
                          <button
                            key={v.key}
                            aria-pressed={preview === v.key}
                            onClick={() => setPreview(v.key)}
                          >
                            {v.name}
                          </button>
                        ))}
                      </div>
                      <div className="ob-preview">
                        <aside>
                          <div className="ob-mini-brand">
                            <span className="ob-logo">1</span>
                            {draft.workspace}
                          </div>
                          {[
                            "Dashboards",
                            "Ventures",
                            "Sub-agents",
                            "Board",
                            "Alerts",
                          ].map((x) => (
                            <div key={x}>{x}</div>
                          ))}
                        </aside>
                        <section>
                          <div className="ob-eyebrow">
                            {currentPreview
                              ? `${businessTypesOf(currentPreview)
                                  .map(
                                    (type) =>
                                      BUSINESS_TYPES.find((t) => t.id === type)
                                        ?.label,
                                  )
                                  .join(
                                    " + ",
                                  )} · ${STAGE_LABELS[currentPreview.stage]}`
                              : "Everything, briefly"}
                          </div>
                          <h2>{currentPreview?.name ?? "Overview"}</h2>
                          <div className="ob-mini-grid">
                            {currentPreview ? (
                              currentPreview.stage !== "launched" ? (
                                <>
                                  <div className="ob-mini-card">
                                    <small>
                                      {currentPreview.stage === "idea"
                                        ? "Your next experiment"
                                        : "Launch essentials"}
                                    </small>
                                    <strong>
                                      {currentPreview.stage === "idea"
                                        ? "Talk to 3 potential customers."
                                        : `0 / ${checklist.length}`}
                                    </strong>
                                    <p>A clear path to your first customer.</p>
                                  </div>
                                  <div className="ob-mini-card">
                                    {checklist.slice(0, 3).map((t) => (
                                      <p className="ob-mini-task" key={t.key}>
                                        <span />
                                        {t.title}
                                      </p>
                                    ))}
                                  </div>
                                </>
                              ) : (
                                <div className="ob-mini-card full">
                                  <Sparkles size={20} />
                                  <strong>Ready for your first sync.</strong>
                                  <p>
                                    We’ll add widgets as connected resources
                                    match this venture. Account totals stay in
                                    your workspace overview.
                                  </p>
                                </div>
                              )
                            ) : (
                              boards[0]?.widgets.slice(0, 4).map((w) => (
                                <div className="ob-mini-card" key={w.id}>
                                  <small>
                                    {WIDGETS[w.type]?.name ?? w.type}
                                  </small>
                                  <strong>
                                    {w.type === "overview.shots"
                                      ? `${draft.ventures.length} ventures`
                                      : w.type === "overview.attention"
                                        ? "Your priorities"
                                        : "—"}
                                  </strong>
                                  <p>
                                    {w.type.startsWith("overview.")
                                      ? "A place for your next move."
                                      : "Connected data, ready to read."}
                                  </p>
                                </div>
                              ))
                            )}
                          </div>
                        </section>
                      </div>
                      <div className="ob-ready-line">
                        <span>
                          <Check size={13} />
                          {draft.ventures.length} ventures
                        </span>
                        <span>
                          <Check size={13} />
                          {ready} shared connections
                        </span>
                        <span>
                          <Check size={13} />
                          {draft.provider
                            ? runtimeReady
                              ? `${draft.assistant === "hermes" ? "Hermes" : "OpenClaw"} connected`
                              : `${plugin(draft.provider)?.name} ready · agent setup pending`
                            : "Planning tools ready"}
                        </span>
                      </div>
                      <details className="ob-details">
                        <summary>
                          <ChevronRight /> Dashboards
                        </summary>
                        <div className="ob-dashboards">
                          {allBoards.map((b) => (
                            <button
                              key={b.id}
                              disabled={b.slug === "overview"}
                              aria-pressed={
                                !draft.excludedDashboards.includes(b.slug)
                              }
                              onClick={() =>
                                edit(
                                  "excludedDashboards",
                                  draft.excludedDashboards.includes(b.slug)
                                    ? draft.excludedDashboards.filter(
                                        (x) => x !== b.slug,
                                      )
                                    : [...draft.excludedDashboards, b.slug],
                                )
                              }
                            >
                              <Check size={12} />
                              {b.name}
                            </button>
                          ))}
                        </div>
                      </details>
                      {attention > 0 && (
                        <p className="ob-hint">
                          <CircleAlert size={13} />
                          {attention}{" "}
                          {attention === 1 ? "connection" : "connections"} to
                          finish later.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
              {error && (
                <p role="alert" className="ob-error">
                  {error}
                </p>
              )}
              {notice && (
                <p role="status" className="ob-hint">
                  {notice}
                </p>
              )}
            </main>
          </>
        )}
      </div>
      {snapshot && !showWelcome && !snapshot.completed && (
        <footer className="ob-actions" aria-label="Setup navigation">
          <div
            className={`ob-actions-inner ${[2, 3, 6].includes(draft.step) ? "wide" : ""}`}
          >
            <div>
              {draft.step === 0 && (
                <button
                  className="ob-text"
                  disabled={busy || transitioning}
                  onClick={() =>
                    void work(() =>
                      transition(() => {
                        setFieldErrors({});
                        if (workspaceStep > 0)
                          setWorkspaceStep((step) => step - 1);
                        else setWelcomeDismissed(false);
                      }),
                    )
                  }
                >
                  <ArrowLeft size={14} /> Back
                </button>
              )}
              {draft.step > 1 && (
                <button
                  className="ob-text"
                  disabled={busy || transitioning}
                  onClick={() =>
                    void work(async () => {
                      await save({ ...draft, step: draft.step - 1 });
                    })
                  }
                >
                  <ArrowLeft size={14} /> Back
                </button>
              )}
              {[1, 3, 5].includes(draft.step) && (
                <button
                  className="ob-text"
                  disabled={busy || transitioning}
                  onClick={() =>
                    void work(async () => {
                      if (draft.step === 5) {
                        const next = { ...draft, provider: "" };
                        await save(next);
                        await call("/onboarding/assistant", {
                          method: "POST",
                          body: "{}",
                        });
                        await save({ ...next, step: 6 });
                      } else await save({ ...draft, step: draft.step + 1 });
                    })
                  }
                >
                  Set up later
                </button>
              )}
            </div>
            <button
              className="ob-primary"
              disabled={busy || agentBusy || transitioning}
              type={draft.step === 0 ? "submit" : "button"}
              form={draft.step === 0 ? "ob-workspace-form" : undefined}
              onClick={draft.step === 0 ? undefined : () => void next()}
            >
              {busy && !transitioning ? (
                <>
                  <Loader2 size={15} className="animate-spin" />{" "}
                  {checking.length ? "Checking…" : "Saving…"}
                </>
              ) : (
                <>
                  {draft.step === 3
                    ? "Check connections"
                    : draft.step === 6
                      ? "Open my workspace"
                      : "Continue"}
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </footer>
      )}
      {(showWelcome || snapshot?.completed) && (
        <footer className="ob-bottom">One workspace. Your company.</footer>
      )}
    </div>
  );
}
