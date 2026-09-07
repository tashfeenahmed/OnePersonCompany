import { RunApp } from "@/components/runs/RunApp";
import { DossierShelf } from "@/components/runs/DossierShelf";

/**
 * THE ONE THAT IS ABOUT A PERSON.
 *
 * A dossier is written by the People analyst — the only worker on this org
 * that belongs to no venture — and it is filed under no venture either. The
 * picker still offers one, because "who is this person to US" is a question
 * somebody may want answered about a particular business; picking nothing is
 * the ordinary case and the run carries on its own brief.
 *
 * THE SHELF IS THIS APP'S WHOLE POINT, which is why it is the `extras`. The
 * flat history under it lists runs; the shelf lists PEOPLE, and a second
 * dossier on the same person is the file getting thicker rather than a job
 * repeated. See `DossierShelf` for how the two are told apart.
 */
export function Dossiers() {
  return (
    <RunApp
      kind="dossier"
      slug="dossier"
      name="People"
      extras={({ settled }) => <DossierShelf refreshKey={settled} />}
    />
  );
}
