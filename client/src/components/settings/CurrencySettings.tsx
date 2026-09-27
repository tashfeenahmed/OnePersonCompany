import { useState } from "react";
import { Check } from "lucide-react";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Section } from "@/components/settings/Section";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";

/**
 * THE ONE CURRENCY EVERY COMBINED FIGURE IS DRAWN IN.
 *
 * It is the finance integration's `display_currency`, the same key its own
 * page edits — one setting with two doors, not two settings. Unset means USD
 * (the server says so), so the Overview no longer picks "whichever currency
 * has the biggest number", which is how 2,054 rubles out-shouted 126 dollars
 * and the ARR tile went RUB.
 *
 * Figures earned in another currency are converted at the rate typed on the
 * Finance page, or the day's reference rate, and wear "≈".
 */
const CURRENCIES: [string, string][] = [
  ["USD", "US dollar"],
  ["EUR", "Euro"],
  ["GBP", "British pound"],
  ["CAD", "Canadian dollar"],
  ["AUD", "Australian dollar"],
  ["NZD", "New Zealand dollar"],
  ["CHF", "Swiss franc"],
  ["JPY", "Japanese yen"],
  ["CNY", "Chinese yuan"],
  ["HKD", "Hong Kong dollar"],
  ["SGD", "Singapore dollar"],
  ["INR", "Indian rupee"],
  ["PKR", "Pakistani rupee"],
  ["AED", "UAE dirham"],
  ["SAR", "Saudi riyal"],
  ["TRY", "Turkish lira"],
  ["SEK", "Swedish krona"],
  ["NOK", "Norwegian krone"],
  ["DKK", "Danish krone"],
  ["PLN", "Polish złoty"],
  ["BRL", "Brazilian real"],
  ["MXN", "Mexican peso"],
  ["ZAR", "South African rand"],
];

export function CurrencySettings() {
  const cfg = useApi(() => api.pluginConfig("finance"), []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const current = (cfg.data?.config.display_currency ?? "").trim().toUpperCase() || "USD";
  const options = CURRENCIES.some(([c]) => c === current) ? CURRENCIES : [[current, current] as [string, string], ...CURRENCIES];

  async function choose(code: string) {
    setSaving(true);
    setSaved(false);
    setProblem(null);
    try {
      await api.savePluginConfig("finance", { display_currency: code });
      setSaved(true);
      cfg.reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Currency"
      hint="Combined ARR, revenue by source, costs and the Overview's money cards are all shown in this currency. Money earned in other currencies is converted at the day's reference rate (or a rate you typed on the Finance page) and marked ≈."
    >
      <div className="flex flex-wrap items-center gap-2">
        <SelectField
          aria-label="Display currency"
          className="w-[260px]"
          value={current}
          disabled={saving || (!cfg.data && !cfg.error)}
          onValueChange={(code) => void choose(code)}
        >
          {options.map(([code, name]) => (
            <SelectOption key={code} value={code}>
              {code} · {name}
            </SelectOption>
          ))}
        </SelectField>
        {saving && <span className="text-muted-foreground text-[13px]">Saving…</span>}
        {saved && !problem && !saving && (
          <span className="text-ok flex items-center gap-1.5 text-[13px]">
            <Check className="size-3.5" strokeWidth={2} />
            Saved — dashboards pick it up on their next refresh
          </span>
        )}
        {(problem || cfg.error) && <span className="text-destructive text-[13px]">{problem ?? cfg.error}</span>}
      </div>
    </Section>
  );
}
