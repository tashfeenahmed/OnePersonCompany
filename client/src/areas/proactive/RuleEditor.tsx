import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VentureSelect } from "@/components/VentureSelect";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  alertsApi,
  type AlertRule,
  type CatalogueSkill,
  type Operator,
  type OperatorInfo,
  type RuleWrite,
} from "@/lib/api/proactive";

/**
 * WRITING A RULE, WITH THE NUMBER IN FRONT OF YOU.
 *
 * THE PREVIEW IS THE WHOLE POINT OF THIS FORM. A rule is a path into a JSON
 * document that this page has never seen, typed by hand, and the failure mode
 * of getting it wrong is silent: `summary.dowm` does not throw, it produces an
 * "unreadable" event once every half hour that most people will read as "all
 * quiet". So the path field reads the real document as you type and shows what
 * it resolves to — or the route's own sentence about why it does not, which
 * names the keys the document actually has.
 *
 * THE PICKERS ARE THE LIVE CATALOGUE AND NOT A LIST IN THIS FILE. Skills,
 * views and each view's parameters come from `GET /api/skills`, which is the
 * same document the server validates against — so the form cannot offer
 * something the server will refuse, and an integration added next year appears
 * here with no client release.
 *
 * WHAT IS DELIBERATELY NOT HERE: any notion of severity, priority or urgency.
 * A rule is a comparison the owner configured. Adding a "critical" flag would
 * be this form inviting somebody to grade a fact.
 */

const BLANK: RuleWrite = {
  name: "",
  skill: "",
  view: "",
  params: {},
  path: "",
  op: ">",
  threshold: 0,
  windowMinutes: null,
  ventureId: null,
  enabled: true,
  cooldownMinutes: 360,
};

type Form = Required<Omit<RuleWrite, "params">> & { params: Record<string, string> };

function toForm(r: AlertRule | null): Form {
  if (!r)
    return {
      ...(BLANK as Required<Omit<RuleWrite, "params">>),
      params: {},
    };
  return {
    name: r.name,
    skill: r.skill,
    view: r.view,
    params: { ...r.params },
    path: r.path,
    op: r.op,
    threshold: r.threshold,
    windowMinutes: r.windowMinutes,
    ventureId: r.ventureId,
    enabled: r.enabled,
    cooldownMinutes: r.cooldownMinutes,
  };
}

/** An answer from the preview route, tagged with the probe it answers. See
 *  `probeKey` below: an answer whose key is not the current one is a stale
 *  read and is never drawn. */
type Preview = { key: string } & (
  | { state: "ok"; value: number }
  | { state: "bad"; why: string }
);

const selectClass =
  "border-input bg-background h-8 rounded-lg border px-2 text-[13px] min-w-0";

export function RuleEditor({
  rule,
  skills,
  operators,
  onSaved,
  onCancel,
}: {
  /** Null for a new rule. */
  rule: AlertRule | null;
  skills: CatalogueSkill[];
  operators: OperatorInfo[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { state } = useStore();
  const [form, setForm] = useState<Form>(() => toForm(rule));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const chosen = skills.find((s) => s.id === form.skill) ?? null;
  const view = chosen?.views.find((v) => v.key === form.view) ?? chosen?.views[0] ?? null;
  const opInfo = operators.find((o) => o.op === form.op) ?? null;

  /* Choosing a skill resets the view and the parameters: last skill's `hours`
     is not this skill's, and carrying it over would send a parameter the new
     view does not take — a 400 the owner did not cause. */
  function chooseSkill(id: string) {
    const s = skills.find((x) => x.id === id) ?? null;
    setForm((f) => ({ ...f, skill: id, view: s?.views[0]?.key ?? "", params: {} }));
  }

  /* ------------------------------------------------------------ preview */

  const [preview, setPreview] = useState<Preview | null>(null);

  /*
    WHICH READ THE ANSWER ON SCREEN BELONGS TO.

    The probe is identified by everything it depends on, and the stored answer
    carries that identity. Rendering compares the two, so an answer for a path
    the owner has already changed is simply not the current one and is drawn as
    "reading" — which is what it is. The alternative, a sequence number and a
    synchronous reset, has the same effect and needs a setState inside the
    effect to get there; this derives it during render instead, and makes
    "reading, with a stale value still on screen" unrepresentable.
  */
  const ready = !!form.skill && !!form.path.trim();
  const probeKey = ready
    ? JSON.stringify([form.skill, form.view, form.params, form.path.trim()])
    : "";
  const shown = preview && preview.key === probeKey ? preview : null;

  /* Debounced: a keystroke in the path field is not a request, a pause is. */
  useEffect(() => {
    if (!ready) return;
    const skill = form.skill;
    const view = form.view;
    const params = form.params;
    const path = form.path.trim();
    const key = probeKey;
    const t = setTimeout(() => {
      void alertsApi
        .preview({ skill, view, params, path })
        .then((r) =>
          setPreview(
            r.readable && r.value !== null
              ? { key, state: "ok", value: r.value }
              : { key, state: "bad", why: r.why ?? "That path could not be read." },
          ),
        )
        .catch((e: unknown) =>
          setPreview({ key, state: "bad", why: e instanceof Error ? e.message : String(e) }),
        );
    }, 450);
    return () => clearTimeout(t);
  }, [ready, probeKey, form.skill, form.view, form.params, form.path]);

  /* ------------------------------------------------------------- saving */

  async function save() {
    setSaving(true);
    setError(null);
    const body: RuleWrite = {
      name: form.name.trim(),
      skill: form.skill,
      view: form.view || undefined,
      params: form.params,
      path: form.path.trim(),
      op: form.op,
      /* `changed` takes no threshold, and the two windowed operators take a
         percentage rather than an absolute — the server checks both, and
         sending the wrong shape here would be an error message about
         something the form already knows. */
      threshold: opInfo && !opInfo.needsThreshold ? null : Number(form.threshold ?? 0),
      windowMinutes: opInfo?.needsWindow ? Number(form.windowMinutes ?? 10080) : null,
      ventureId: form.ventureId,
      enabled: form.enabled,
      cooldownMinutes: Number(form.cooldownMinutes ?? 360),
    };
    try {
      if (rule) await alertsApi.update(rule.id, body);
      else await alertsApi.create(body);
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const ventures = useMemo(() => state.ventures, [state.ventures]);

  return (
    <div className="bg-card border-line-soft mt-1 mb-2 rounded-[10px] border p-3.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label="Name" hint="One line. It is what every event this raises is called.">
          <Input
            autoFocus
            value={form.name}
            placeholder="A payment failed today"
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>

        <Field label="For which venture" hint="A label on the finding, not a filter on the document — the figure still comes from wherever the document takes it from.">
          <VentureSelect
            ventures={ventures}
            value={form.ventureId}
            onChange={(id) => set("ventureId", id)}
            none="The whole business"
          />
        </Field>

        <Field label="Which document" hint="From the live skills catalogue — the same list the agent reads.">
          <select
            value={form.skill}
            onChange={(e) => chooseSkill(e.target.value)}
            className={selectClass}
          >
            <option value="">Choose a document…</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — {s.title.split("—")[1]?.trim() ?? s.title}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Which view" hint="Most documents have one. Some are several cuts of the same data.">
          <select
            value={form.view}
            onChange={(e) => setForm((f) => ({ ...f, view: e.target.value, params: {} }))}
            className={selectClass}
            disabled={!chosen}
          >
            {(chosen?.views ?? []).map((v) => (
              <option key={v.key} value={v.key}>
                {v.key}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* The view's own parameters, drawn from the catalogue. Each one's
          `about` carries the clamp the route applies, which is the sentence an
          owner needs before they type 5000 into a field that means 400. */}
      {view?.params.length ? (
        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
          {view.params.map((p) => (
            <Field
              key={p.name}
              label={p.name}
              hint={`${p.about}${p.default !== null ? ` Default ${p.default}.` : ""}`}
            >
              <Input
                value={form.params[p.name] ?? ""}
                placeholder={p.default !== null ? String(p.default) : ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    params: { ...f.params, [p.name]: e.target.value },
                  }))
                }
              />
            </Field>
          ))}
        </div>
      ) : null}

      <div className="mt-2.5">
        <Field
          label="Path into the document"
          hint="Dots between keys, [0] for an array index, @count(list) for how many items a list has."
        >
          <Input
            value={form.path}
            placeholder="charges[0].failed"
            onChange={(e) => set("path", e.target.value)}
            className="font-mono text-[12.5px]"
          />
        </Field>
        {/* THE LIVE READING. It is the reason to trust the rule before saving
            it, and the failure sentence is the route's own — it names the keys
            the document really has. */}
        <div className="mt-1.5 text-[11.5px]">
          {!ready ? (
            <span className="text-muted-foreground">
              Choose a document and type a path to see what it reads right now.
            </span>
          ) : !shown ? (
            <span className="text-muted-foreground inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" strokeWidth={1.6} /> reading…
            </span>
          ) : shown.state === "ok" ? (
            <span className="text-foreground">
              Reads{" "}
              <span className="tabular-nums font-medium">{shown.value}</span>{" "}
              <span className="text-muted-foreground">right now.</span>
            </span>
          ) : (
            <span className="text-destructive">{shown.why}</span>
          )}
        </div>
      </div>

      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">
        <Field label="Trips when" hint={opInfo?.about ?? ""}>
          <select
            value={form.op}
            onChange={(e) => set("op", e.target.value as Operator)}
            className={selectClass}
          >
            {operators.map((o) => (
              <option key={o.op} value={o.op}>
                {o.op}
              </option>
            ))}
          </select>
        </Field>

        {opInfo?.needsThreshold ? (
          <Field
            label={opInfo.needsWindow ? "Percent" : "Threshold"}
            hint={
              opInfo.needsWindow
                ? "How far it has to have moved, in percent."
                : "The number the reading is compared against."
            }
          >
            <Input
              type="number"
              value={form.threshold ?? ""}
              onChange={(e) => set("threshold", e.target.value === "" ? 0 : Number(e.target.value))}
            />
          </Field>
        ) : (
          <Field label="Threshold" hint="This operator compares with the previous reading, so it takes none.">
            <div className="text-muted-foreground flex h-8 items-center text-[12.5px]">
              not used
            </div>
          </Field>
        )}

        {opInfo?.needsWindow ? (
          <Field
            label="Window (minutes)"
            hint="How far back the earlier reading is taken from. 1440 is a day, 10080 a week. It says nothing at all until this box has a reading that old."
          >
            <Input
              type="number"
              value={form.windowMinutes ?? 10080}
              onChange={(e) => set("windowMinutes", Number(e.target.value) || 10080)}
            />
          </Field>
        ) : (
          <Field
            label="Cooldown (minutes)"
            hint="How long before this rule may raise another trip. The condition still holds; you are simply not told twice."
          >
            <Input
              type="number"
              value={form.cooldownMinutes}
              onChange={(e) => set("cooldownMinutes", Number(e.target.value) || 0)}
            />
          </Field>
        )}
      </div>

      {opInfo?.needsWindow && (
        <div className="mt-2.5 max-w-[240px]">
          <Field label="Cooldown (minutes)" hint="How long before this rule may raise another trip.">
            <Input
              type="number"
              value={form.cooldownMinutes}
              onChange={(e) => set("cooldownMinutes", Number(e.target.value) || 0)}
            />
          </Field>
        </div>
      )}

      {error && <p className="text-destructive mt-2.5 text-[12.5px]">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <Button
          onClick={() => void save()}
          disabled={saving || !form.name.trim() || !form.skill || !form.path.trim()}
          className="h-8 text-[12.5px]"
        >
          {saving ? "Saving…" : rule ? "Save changes" : "Create rule"}
        </Button>
        <Button variant="ghost" onClick={onCancel} className="h-8 text-[12.5px]">
          Cancel
        </Button>
        {shown?.state === "bad" && (
          <span className="text-muted-foreground text-[11.5px]">
            You can still save it — it will report as unreadable rather than trip.
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-[11px] tracking-[0.04em] uppercase">
        {label}
      </span>
      {children}
      {hint && (
        <span className={cn("text-muted-foreground text-[11px] leading-[1.45]")}>{hint}</span>
      )}
    </label>
  );
}
