import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";

/**
 * THE SETTINGS OF ONE PSEUDO-PLUGIN, RENDERED FROM WHAT THE SERVER SAYS IT
 * ACCEPTS.
 *
 * `backups`, `capture` and `studio` have no catalog entry and no credential —
 * they are three settings registries hanging off a foreign key. The keys, the
 * labels and the hints all come off `GET /api/plugins/<id>/config`, which is
 * also the thing that refuses a key it does not know: a form that offered a
 * setting the route would reject would be this page inventing a feature.
 *
 * VALUES READ BACK, unlike anything in the vault, and that is the whole
 * difference. A backup directory or a model name is a thing the owner
 * maintains by hand, and a write-only field you can never check is a field
 * that holds a typo forever.
 *
 * THE EMPTY STRING IS A REAL ANSWER HERE and the placeholder says what it
 * means — "leave it empty and this looks for a browser itself", "empty means
 * flux-schnell". So a blank field is never drawn as unset-and-broken, and
 * saving a blank one is how a setting is taken back off.
 */
export function PluginSettingsForm({
  plugin,
  onSaved,
  saveLabel = "Save settings",
}: {
  plugin: string;
  onSaved?: () => void;
  saveLabel?: string;
}) {
  const settings = useApi(() => api.pluginConfig(plugin), [plugin]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const keys = settings.data?.keys ?? [];

  if (settings.error)
    return (
      <p className="text-muted-foreground text-[12.5px]">
        The API did not answer, so these settings cannot be read or changed.{" "}
        <span className="text-destructive">{settings.error}</span>
      </p>
    );
  if (!keys.length) return null;

  const value = (key: string) =>
    typed[key] ?? keys.find((k) => k.key === key)?.value ?? "";

  async function save() {
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      await api.savePluginConfig(
        plugin,
        Object.fromEntries(keys.map((k) => [k.key, value(k.key)])),
      );
      setTyped({});
      setSaved(true);
      settings.reload();
      onSaved?.();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="grid max-w-[560px] gap-3.5">
        {keys.map((k) => (
          <div key={k.key} className="grid gap-1.5">
            <Label htmlFor={`${plugin}-cfg-${k.key}`}>{k.label}</Label>
            <Input
              id={`${plugin}-cfg-${k.key}`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={k.ph ?? undefined}
              value={value(k.key)}
              onChange={(e) =>
                setTyped((v) => ({ ...v, [k.key]: e.target.value }))
              }
              className="font-mono text-[12.5px]"
            />
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {k.hint}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button onClick={() => void save()} disabled={saving} variant="outline">
          {saving ? "Saving…" : saveLabel}
        </Button>
        {saved && !problem && (
          <span className="text-ok flex items-center gap-1.5 text-[12px]">
            <Check className="size-3.5" strokeWidth={2} />
            Saved
          </span>
        )}
        {problem && (
          <span className="text-destructive text-[12px]">{problem}</span>
        )}
      </div>
    </>
  );
}
