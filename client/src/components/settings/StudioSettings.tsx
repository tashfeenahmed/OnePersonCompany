import { useApi } from "@/hooks/useApi";
import { Section } from "@/components/settings/Section";
import { PluginSettingsForm } from "@/components/settings/PluginSettingsForm";
import { studioApi } from "@/lib/api/studio";

/**
 * STUDIO — which Replicate model draws the pictures.
 *
 * ONE SETTING, AND IT IS HERE RATHER THAN ON THE STUDIO PAGE because it is
 * changed once and read every time. The studio app's readiness banner already
 * SAYS which model is in use; this is where it is chosen, beside the other two
 * settings that decide what the box does with its own disk.
 *
 * THE CHECK UNDER THE FIELD IS THE POINT. A model name is a string this app
 * cannot validate — `owner/name` is the only shape the route insists on, and
 * whether that model exists, takes a prompt, or returns an image is something
 * only Replicate knows. So instead of a fake green tick, the line under the
 * field reads back what the SERVER resolved: the model it will actually call,
 * and whether that is the default or something typed here. A typo shows up as
 * a model name nobody recognises, which is the honest failure.
 *
 * NO PRICE IS SHOWN, and none can be: Replicate publishes no price anywhere in
 * its API and a prediction record carries no rate. "A fraction of a cent" is
 * true of the default model and is said about that model by name, never as a
 * figure this page computed.
 */
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
              ? `Pictures will be asked of ${r.image.model}`
              : "No picture will be made — Replicate is not connected"}
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
