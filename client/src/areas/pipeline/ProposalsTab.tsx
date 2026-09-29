import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { VentureMark } from "@/components/VentureChrome";
import { cn } from "@/lib/utils";
import { synthesisApi, type SynthesisDoc } from "./api";
import { humanWhen, relative } from "./explain";

/**
 * THE PROPOSALS THE "FIND THE NEXT ACTIONS" STEP MADE, BOTH HALVES.
 *
 * The refused ideas are shown beside the filed ones, and that is the point of
 * the tab: a pass that files two out of nine and hides the seven is one the
 * owner cannot calibrate — he cannot tell whether it considered the obvious
 * thing and refused it, or never thought of it.
 */
export function ProposalsTab() {
  const doc = useApi(() => synthesisApi.all({ limit: 60 }), []);
  const { state } = useStore();
  const [showDropped, setShowDropped] = useState(true);

  if (doc.error) return <p className="text-destructive text-[14.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14.5px]">Reading the proposals…</p>;
  const { proposals, next, coverage, notes, filed, dropped } = doc.data;
  const shown = showDropped ? proposals : proposals.filter((p) => p.verdict === "filed");

  return (
    <div className="flex flex-col gap-4">
      <section className="border-line-soft bg-card flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl p-4 sm:p-5">
        <Stat label="Filed to the board" value={filed} tone="text-ok" />
        <Stat label="Refused by the checks" value={dropped} tone="text-muted-foreground" />
        <Stat label="Ventures reviewed so far" value={`${coverage.filter((c) => c.lastPassAt).length} of ${coverage.length}`} />
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-muted-foreground text-[11.5px] tracking-wide uppercase">Next in line</p>
          <p className="text-[13.5px]">{next.map((n) => n.name).join(", ") || "nothing"}</p>
        </div>
        <Link
          to="/workflows/editor"
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
        >
          <Settings2 className="size-3.5" /> Proposal settings
        </Link>
      </section>

      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-muted-foreground min-w-0 flex-1 text-[12.5px]">{notes.dropped}</p>
        <label className="text-muted-foreground flex items-center gap-1.5 text-[12.5px]">
          <input type="checkbox" checked={showDropped} onChange={(e) => setShowDropped(e.target.checked)} />
          Show what was refused
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="text-muted-foreground text-[14.5px]">
          Nothing has been proposed yet. The Find-the-next-actions step proposes ideas each night, and it can be run for
          one venture from that venture's page.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {shown.map((p) => {
            const v = state.ventures.find((x) => x.id === p.ventureId);
            return (
              <div key={p.id} className="border-line-soft bg-card flex flex-col gap-1 rounded-[14px] px-4 py-2.5 text-[13.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "h-5 shrink-0 rounded-full px-2 text-[11.5px] leading-5 font-medium",
                      p.verdict === "filed" ? "bg-ok-bg text-ok" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {p.verdict === "filed" ? "Filed" : "Refused"}
                  </span>
                  <span className="font-medium">{p.title}</span>
                  <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[12.5px]">
                    {v && <VentureMark venture={v} size={14} />}
                    {p.venture ?? "venture deleted"}
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px]" title={humanWhen(p.at)}>
                    {relative(p.at)}
                  </span>
                </div>
                {p.why && <p className="text-[12.5px] leading-relaxed">{p.why}</p>}
                {p.evidenceLine && <p className="text-muted-foreground text-[12.5px]">Evidence: {p.evidenceLine}</p>}
                {p.reason && <p className="text-muted-foreground text-[12.5px]">Refused because {p.reason}</p>}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-muted-foreground text-[12.5px]">
        {coverage.filter((c) => !c.proposalsOn).length} ventures have proposals switched off.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-[11.5px] tracking-wide uppercase">{label}</p>
      <p className={cn("text-[20px] font-medium tabular-nums", tone)}>{value}</p>
    </div>
  );
}

/**
 * THE DIALS, ON THE STEPS & SCHEDULE TAB. They are settings on the
 * `synthesis` pseudo-plugin, which has no entry on the Integrations page
 * because it holds no credential — so they live beside the workflow step
 * they govern.
 */
export function SynthesisSettings() {
  const doc = useApi(() => synthesisApi.all({ limit: 1 }), []);
  if (doc.error) return <p className="text-destructive text-[13.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[13.5px]">Reading…</p>;
  const { config } = doc.data;
  return (
    <SynthesisForm
      key={`${config.venturesPerNight}:${config.perVenture}:${config.perNight}:${config.repeatDays}:${config.model}`}
      config={config}
      onSaved={() => doc.reload()}
    />
  );
}

function Field({ label, width, children }: { label: string; width: string; children: React.ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1", width)}>
      <span className="text-muted-foreground text-[12.5px]">{label}</span>
      {children}
    </label>
  );
}

/**
 * THE SYNTHESIS DIALS.
 *
 * Four values, all of them decisions rather than credentials, all of them about
 * how much of the owner's morning this pass is allowed to fill. They are stored
 * on the `synthesis` pseudo-plugin and validated once on the server, which is
 * why this form does no checking of its own beyond keeping the boxes small —
 * a second validator here would be a second set of rules to keep in step.
 */
function SynthesisForm({
  config,
  onSaved,
}: {
  config: SynthesisDoc["config"];
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    "ventures-per-night": String(config.venturesPerNight),
    "per-venture": String(config.perVenture),
    "per-night": String(config.perNight),
    "repeat-days": String(config.repeatDays),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const set = (k: string, v: string) => setValues((old) => ({ ...old, [k]: v }));

  return (
    <fieldset disabled={saving} className="flex min-w-0 flex-wrap items-end gap-3">
      <Field label="Ventures a night" width="w-24">
        <Input value={values["ventures-per-night"]} onChange={(e) => set("ventures-per-night", e.target.value)} />
      </Field>
      <Field label="Most per venture" width="w-24">
        <Input value={values["per-venture"]} onChange={(e) => set("per-venture", e.target.value)} />
      </Field>
      <Field label="Most in one night" width="w-24">
        <Input value={values["per-night"]} onChange={(e) => set("per-night", e.target.value)} />
      </Field>
      <Field label="Days before repeating an idea" width="w-32">
        <Input value={values["repeat-days"]} onChange={(e) => set("repeat-days", e.target.value)} />
      </Field>
      <Button
        size="sm"
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setError(null);
          synthesisApi
            .saveConfig(values)
            .then((r) => {
              setConnected(r.connected);
              onSaved();
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setSaving(false));
        }}
      >
        {saving && <Loader2 className="size-3.5 animate-spin" />}
        Save
      </Button>
      <span className="text-muted-foreground w-full text-[12.5px]">
        Each venture in the rotation costs one model call over its whole evidence packet, so the first
        box is the main dial on what a night spends. Defaults:{" "}
        {config.defaults.venturesPerNight} / {config.defaults.perVenture} / {config.defaults.perNight} /{" "}
        {config.defaults.repeatDays} days. Uses your shared LLM selection from the sidebar.
      </span>
      {error && <p className="text-destructive w-full text-[13.5px]">{error}</p>}
      {connected === false && (
        <p className="text-warn w-full text-[13.5px]">
          Saved, but the synthesis plugin still reads as not connected — no venture will be read
          until it is.
        </p>
      )}
    </fieldset>
  );
}
