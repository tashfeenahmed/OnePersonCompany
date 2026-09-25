import { useSearchParams } from "react-router-dom";
import { RunApp } from "@/components/runs/RunApp";
import { DossierShelf } from "@/components/runs/DossierShelf";
import { UNFILED } from "@/components/org/Watchlist";
import { attaches } from "@/components/org/dossiers";
import { useApi } from "@/hooks/useApi";
import { peopleApi } from "@/lib/api/people";

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
  /* THE RAIL BESIDE THIS PAGE LISTS PEOPLE, NOT VENTURES — see PeopleRail in
     pages/Outputs.tsx — and `?person=` is what it writes: a watchlist id, or
     `unfiled` for the dossiers that name nobody on the list. The join is the
     same title rule the server counts with, so the list here and the count
     in the rail agree. */
  const [params] = useSearchParams();
  const personId = params.get("person");
  const watch = useApi(() => (personId ? peopleApi.watch() : Promise.resolve(null)), [personId]);
  const people = watch.data?.people ?? [];
  const person = personId && personId !== UNFILED ? people.find((p) => p.id === personId) : null;

  const narrow = !personId || !watch.data
    ? null
    : personId === UNFILED
      ? { label: "unfiled", match: (r: { title: string }) => !people.some((p) => attaches(r.title, p.name)) }
      : person
        ? { label: person.name, match: (r: { title: string }) => attaches(r.title, person.name), preset: { person: person.name } }
        : { label: "nobody on the list", match: () => false };

  return (
    <RunApp
      kind="dossier"
      slug="dossier"
      name="People"
      narrow={narrow}
      extras={({ settled }) => <DossierShelf refreshKey={settled} />}
    />
  );
}
