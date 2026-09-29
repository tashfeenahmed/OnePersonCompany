import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Input } from "@/components/ui/input";
import { finance } from "@/lib/api/finance";
import { api } from "@/lib/api";
import { amount } from "./format";

/**
 * POWER PROFILES — what the machine under the desk draws, so local inference
 * can be priced beside the providers it is supposed to be cheaper than.
 *
 * THE FORM ASKS FOR TWO WATTAGES AND NOTHING ELSE CAN SUPPLY THEM. ssh can
 * read a GPU's own draw; it cannot read a wall socket, which is what the
 * electricity bill charges for. So this page asks, explains what to type, and
 * says on every line that the wattage is an estimate even when the hours are
 * measured.
 *
 * A MACHINE WITH NO SAMPLES GETS A DASH, NOT A ZERO. "We have not been
 * watching long enough to say" and "it cost nothing" are different answers and
 * only one of them is ever true on the first day.
 */
export function Power() {
  const doc = useApi(() => finance.power(), []);
  const [draft, setDraft] = useState<Record<string, { idle: string; busy: string; rate: string; currency: string; alwaysOn: boolean }>>({});
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState<string | null>(null);
  const [home, setHome] = useState({ label: "", idle: "", busy: "" });

  if (doc.error) return <p className="text-muted-foreground text-[14px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14px]">Reading profiles…</p>;
  const d = doc.data;

  return (
    <>
      <p className="text-muted-foreground mb-3 text-[13.5px] leading-relaxed">
        Electricity for {d.month}, priced per kWh at the tariff below unless a machine carries a price of its own.
      </p>

      {/* THE TARIFF, editable here: it is the one number every line is multiplied by. */}
      <div className="bg-card mb-4 flex flex-wrap items-end gap-2 rounded-[14px] px-4.5 py-3.5">
        <label className="text-[12px]">
          <div className="text-muted-foreground mb-1">Price per kWh (EUR)</div>
          <Input
            value={rate ?? (d.tariff.source === "typed" && d.tariff.perKwh !== null ? String(d.tariff.perKwh) : "")}
            placeholder={d.tariff.source === "irish-average" ? `${d.tariff.perKwh} — Irish standard rate` : "0.36"}
            onChange={(e) => setRate(e.target.value)}
            className="h-8 w-56 text-[13.5px]"
          />
        </label>
        <button
          onClick={async () => {
            setError(null);
            try {
              await api.savePluginConfig("finance", { kwh_rate: (rate ?? "").trim(), kwh_currency: "EUR" });
              setRate(null);
              await finance.refresh().catch(() => null);
              doc.reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          className="hover:bg-accent h-8 rounded-lg border px-3 text-[13px]"
        >
          Save rate
        </button>
        <span className="text-muted-foreground mb-1.5 text-[12.5px]">
          {d.tariff.source === "irish-average"
            ? "Using the Irish standard unit rate (incl. VAT). Type your supplier's rate to replace it; empty goes back to the Irish rate."
            : `Your rate: ${d.tariff.perKwh} ${d.tariff.currency}/kWh. Empty it to use the Irish standard rate.`}
        </span>
      </div>

      {d.machines.length === 0 && (
        <p className="text-muted-foreground mb-3 text-[14px] leading-relaxed">
          No machine yet. Add a home machine below — priced as always on — or connect a workstation under
          Integrations → Workstation so its hours are measured.
        </p>
      )}

      <div className="space-y-2">
        {d.machines.map((m) => {
          const line = d.lines.find((l) => l.machineId === m.machineId);
          const p = d.profiles.find((x) => x.machineId === m.machineId);
          const key = m.machineId;
          const form = draft[key] ?? {
            idle: p ? String(p.idleWatts) : "",
            busy: p ? String(p.busyWatts) : "",
            rate: p?.ratePerKwh !== null && p?.ratePerKwh !== undefined ? String(p.ratePerKwh) : "",
            currency: p?.currency ?? d.tariff.currency,
            alwaysOn: p?.alwaysOn ?? false,
          };
          return (
            <div key={key} className="bg-card rounded-[14px] px-4.5 py-3.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[14px] font-medium">{m.label}</span>
                {line && (
                  <>
                    <span className="text-[17px] tabular-nums">{amount(line.amount, line.currency)}</span>
                    <span className="text-muted-foreground text-[12.5px]">
                      {line.kwh === null ? "" : `${line.kwh} kWh · `}
                      {line.confidence ? `${line.confidence} hours` : "no hours observed"}
                    </span>
                  </>
                )}
                {!p && <span className="text-muted-foreground text-[12.5px]">no profile yet</span>}
                {m.home && <span className="text-muted-foreground text-[12.5px]">home machine · always on</span>}
                {m.gone && (
                  <span className="text-muted-foreground text-[12.5px]">
                    this workstation account no longer exists — the profile is still priced into the ledger until you remove it
                  </span>
                )}
              </div>
              {line && <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">{line.note}</p>}

              <div className="mt-2.5 flex flex-wrap items-end gap-2">
                <label className="text-[12px]">
                  <div className="text-muted-foreground mb-1">Idle watts</div>
                  <Input value={form.idle} onChange={(e) => setDraft({ ...draft, [key]: { ...form, idle: e.target.value } })} className="h-8 w-24 text-[13.5px]" />
                </label>
                <label className="text-[12px]">
                  <div className="text-muted-foreground mb-1">Busy watts</div>
                  <Input value={form.busy} onChange={(e) => setDraft({ ...draft, [key]: { ...form, busy: e.target.value } })} className="h-8 w-24 text-[13.5px]" />
                </label>
                <label className="text-[12px]">
                  <div className="text-muted-foreground mb-1">Its own price/kWh</div>
                  <Input value={form.rate} placeholder="use the tariff" onChange={(e) => setDraft({ ...draft, [key]: { ...form, rate: e.target.value } })} className="h-8 w-32 text-[13.5px]" />
                </label>
                <label className="text-[12px]">
                  <div className="text-muted-foreground mb-1">Currency</div>
                  <Input value={form.currency} onChange={(e) => setDraft({ ...draft, [key]: { ...form, currency: e.target.value } })} className="h-8 w-20 text-[13.5px]" />
                </label>
                <label className="mb-1.5 flex items-center gap-1.5 text-[12.5px]">
                  <input type="checkbox" checked={form.alwaysOn} onChange={(e) => setDraft({ ...draft, [key]: { ...form, alwaysOn: e.target.checked } })} />
                  never sleeps
                </label>
                <button
                  onClick={async () => {
                    setError(null);
                    try {
                      await finance.savePower(key, {
                        label: m.label,
                        idleWatts: Number(form.idle),
                        busyWatts: Number(form.busy),
                        ratePerKwh: form.rate.trim() === "" ? null : Number(form.rate),
                        currency: form.currency,
                        alwaysOn: form.alwaysOn,
                      });
                      doc.reload();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  className="hover:bg-accent h-8 rounded-lg border px-3 text-[13px]"
                >
                  Save
                </button>
                {p && (
                  <button
                    onClick={() => void finance.removePower(key).then(() => doc.reload())}
                    className="text-muted-foreground hover:bg-accent h-8 rounded-lg border px-3 text-[13px]"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* A HOME MACHINE: anything plugged in at home that nothing samples — the
          Pi, the inference box, a mini PC. Priced always-on at its idle watts. */}
      <div className="bg-card mt-3 flex flex-wrap items-end gap-2 rounded-[14px] px-4.5 py-3.5">
        <div className="w-full text-[13.5px] font-medium">Add a home machine</div>
        <label className="text-[12px]">
          <div className="text-muted-foreground mb-1">Name</div>
          <Input value={home.label} placeholder="Home Pi" onChange={(e) => setHome({ ...home, label: e.target.value })} className="h-8 w-44 text-[13.5px]" />
        </label>
        <label className="text-[12px]">
          <div className="text-muted-foreground mb-1">Idle watts</div>
          <Input value={home.idle} onChange={(e) => setHome({ ...home, idle: e.target.value })} className="h-8 w-24 text-[13.5px]" />
        </label>
        <label className="text-[12px]">
          <div className="text-muted-foreground mb-1">Busy watts</div>
          <Input value={home.busy} placeholder="same as idle" onChange={(e) => setHome({ ...home, busy: e.target.value })} className="h-8 w-28 text-[13.5px]" />
        </label>
        <button
          disabled={!home.label.trim() || !home.idle.trim()}
          onClick={async () => {
            setError(null);
            const slug = home.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "machine";
            try {
              await finance.savePower(`home:${slug}`, {
                label: home.label.trim(),
                idleWatts: Number(home.idle),
                busyWatts: Number(home.busy.trim() || home.idle),
                ratePerKwh: null,
                currency: "EUR",
                alwaysOn: true,
              });
              setHome({ label: "", idle: "", busy: "" });
              doc.reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          className="hover:bg-accent h-8 rounded-lg border px-3 text-[13px] disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {error && <p className="text-destructive mt-2 text-[13px]">{error}</p>}

      <p className="text-muted-foreground mt-4 border-t pt-2 text-[12px] leading-relaxed">
        {d.note} Idle is what the machine draws at the wall doing nothing; busy is what it draws with the GPU
        working. A plug-in power meter is the only way to know either — a figure from the manufacturer's spec sheet
        is a ceiling, not a measurement.
      </p>
    </>
  );
}
