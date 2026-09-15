import { useApi } from "@/hooks/useApi";
import { Section } from "@/components/settings/Section";
import { PluginSettingsForm } from "@/components/settings/PluginSettingsForm";
import { studioApi } from "@/lib/api/studio";

/** One image model setting shared by Studio posts and UGC stills. */
export function StudioSettings() {
  const doc = useApi(() => studioApi.readiness(), []);
  const r = doc.data;

  return (
    <Section
      title="Studio"
      hint="The image model behind the Studio app. Captions come from whichever model provider is live; only the picture is a setting."
    >
      <PluginSettingsForm
        plugin="studio"
        onSaved={() => doc.reload()}
        saveLabel="Save image model"
      />

      {doc.error && (
        <p className="text-muted-foreground text-[13.5px]">
          The API did not answer, so this cannot say which model is in use.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      )}

      {r && (
        <div className="bg-card grid gap-1 rounded-[14px] px-4.5 py-3.5">
          <div className="text-[14px]">
            {r.image.ready
              ? `${r.image.label} through ${r.image.providerLabel}`
              : `Connect ${r.image.providerLabel} to create images`}
            {r.image.ready && r.image.isDefault && (
              <span className="text-muted-foreground"> — the default</span>
            )}
          </div>
          <p className="text-muted-foreground text-[12.5px] leading-relaxed">
            {r.image.note}
          </p>
          <p className="text-muted-foreground text-[12.5px] leading-relaxed">
            {r.caption.note}
          </p>
        </div>
      )}
    </Section>
  );
}
