import { useParams } from "react-router-dom";
import { RunApp } from "@/components/runs/RunApp";
import { VideoResult } from "@/areas/video/VideoResult";

/**
 * THE ONE APP HERE THAT PRODUCES A FILE.
 *
 * It is `RunApp` like the other run pages — the form, the queue, the steps and
 * the history are the same page they are for research — and what it adds is
 * the artefact, in the `extras` slot, keyed on the run that is settled. That
 * is what the slot is for: Competitors puts a profile table there, Papers puts
 * a shelf, and this puts the video, the script and the credits.
 *
 * `settled` IS THE RIGHT KEY AND `runId` WOULD BE THE WRONG ONE. The video row
 * does not exist until the run finishes; fetching it on every poll of a
 * running run would be a request every 1.5 seconds for a 404 with a paragraph
 * in it. The moment the run stops moving, `settled` becomes its id and the
 * panel fetches once.
 */
export function Video() {
  return (
    <RunApp
      kind="video"
      slug="video"
      name="Video"
      extras={({ settled }) => <VideoExtras settled={settled} />}
    />
  );
}

function VideoExtras({ settled }: { settled: string }) {
  const { runId } = useParams();
  /* Only for the run that is OPEN at this address, and only once it has
     stopped. A settled id from a previous visit is not what this page is
     showing. */
  if (!settled || settled !== runId) return null;
  return <VideoResult runId={settled} />;
}
