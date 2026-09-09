/**
 * POSTS — what actually went out, read back from the platform.
 *
 * THIS PAGE IS NOW A FRAME AROUND ONE COMPONENT. The timeline itself moved to
 * `PublishedTimeline` because it belongs beside the queue that made it:
 * Publishing shows it as its own "Published" tab, and a screen the owner
 * reaches two ways must be the same screen both times, not a copy that drifts.
 * What is left here is the header, the venture picker this page has always had,
 * and the same component — so the old address keeps working, unchanged, for as
 * long as it is pointed at.
 */
import { PageShell } from "@/components/PageShell";
import { useState } from "react";
import { Link } from "react-router-dom";
import { VentureSelect } from "@/components/VentureSelect";
import { useStore } from "@/lib/store";
import { PublishedTimeline } from "./PublishedTimeline";

export function Posts() {
  const { state } = useStore();
  const ventures = state.ventures;
  const [ventureId, setVentureId] = useState<string | null>(null);

  return (
    <PageShell
      title="Posts"
      sub={
        <>
          The timeline read back from Meta. A post marked <em>from a draft</em> came out of
          something this box made and filed under{" "}
          <Link to="/social/studio/publishing" className="underline decoration-dotted">
            Publishing
          </Link>
          ; everything else was posted somewhere else.
        </>
      }
      wide
    >
      <PublishedTimeline
        ventureId={ventureId}
        lead={
          <VentureSelect
            ventures={ventures}
            value={ventureId}
            onChange={setVentureId}
            none="Every venture"
          />
        }
      />
    </PageShell>
  );
}
