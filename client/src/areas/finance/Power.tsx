import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Input } from "@/components/ui/input";
import { finance } from "@/lib/api/finance";
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

  if (doc.error) return <p className="text-muted-foreground text-[13px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[13px]">Reading profiles…</p>;
  const d = doc.data;

  return (
    <>
      <p className="text-muted-foreground mb-4 text-[12.5px] leading-relaxed">
        Electricity for {d.month}. The price per kWh comes from the Finance integration's settings
        ({d.tariff.perKwh === null ? "not set — every line below is unpriced" : `${d.tariff.perKwh} ${d.tariff.currency}`}),
        unless a machine carries one of its own.
      </p>

      {d.machines.length === 0 && (
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          No workstation is connected, so there is no machine to profile. Connect one under Integrations → Workstation
          and its uptime will be sampled every collection; the hours come from those samples.
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
            <div key={key} className="bg-card rounded-[10px] border px-3.5 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[13px] font-medium">{m.label}</span>
                {line && (
                  <>
                    <span className="text-[16px] tabular-nums">{amount(line.amount, line.currency)}</span>
                    <span className="text-muted-foreground text-[11.5px]">
                      {line.kwh === null ? "" : `${line.kwh} kWh · `}
                      {line.confidence ? `${line.confidence} hours` : "no hours observed"}
                    </span>
                  </>
                )}
                {!p && <span className="text-muted-foreground text-[11.5px]">no profile yet</span>}
              </div>
              {line && <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">{line.note}</p>}

              <div className="mt-2.5 flex flex-wrap items-end gap-2">
                <label className="text-[11px]">
                  <div className="text-muted-foreground mb-1">Idle watts</div>
                  <Input value={form.idle} onChange={(e) => setDraft({ ...draft, [key]: { ...form, idle: e.target.value } })} className="h-8 w-24 text-[12.5px]" />
                </label>
                <label className="text-[11px]">
                  <div className="text-muted-foreground mb-1">Busy watts</div>
                  <Input value={form.busy} onChange={(e) => setDraft({ ...draft, [key]: { ...form, busy: e.target.value } })} className="h-8 w-24 text-[12.5px]" />
                </label>
                <label className="text-[11px]">
                  <div className="text-muted-foreground mb-1">Its own price/kWh</div>
                  <Input value={form.rate} placeholder="use the tariff" onChange={(e) => setDraft({ ...draft, [key]: { ...form, rate: e.target.value } })} className="h-8 w-32 text-[12.5px]" />
                </label>
                <label className="text-[11px]">
                  <div className="text-muted-foreground mb-1">Currency</div>
                  <Input value={form.currency} onChange={(e) => setDraft({ ...draft, [key]: { ...form, currency: e.target.value } })} className="h-8 w-20 text-[12.5px]" />
                </label>
                <label className="mb-1.5 flex items-center gap-1.5 text-[11.5px]">
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
                  className="hover:bg-accent h-8 rounded-lg border px-3 text-[12px]"
                >
                  Save
                </button>
                {p && (
                  <button
                    onClick={() => void finance.removePower(key).then(() => doc.reload())}
                    className="text-muted-foreground hover:bg-accent h-8 rounded-lg border px-3 text-[12px]"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="text-destructive mt-2 text-[12px]">{error}</p>}

      <p className="text-muted-foreground mt-4 border-t pt-2 text-[11px] leading-relaxed">
        {d.note} Idle is what the machine draws at the wall doing nothing; busy is what it draws with the GPU
        working. A plug-in power meter is the only way to know either — a figure from the manufacturer's spec sheet
        is a ceiling, not a measurement.
      </p>
    </>
  );
}
