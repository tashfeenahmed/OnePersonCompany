import { appPage } from "../../../../shared/navigation";
import { Link, useParams } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { ago, day } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isLive, runsApi, type RunSummary } from "@/lib/api/runs";

/**
 * WHO HAS BEEN LOOKED UP, AND EVERY TIME THEY HAVE BEEN.
 *
 * ---------------------------------------------------------------------------
 * A DOSSIER IS NOT A ONE-OFF REPORT, AND THIS IS THE SHAPE THAT SAYS SO. The
 * other run apps list their history as a flat log because a second SEO sweep
 * of the same site is a second reading of a moving thing. A dossier is not:
 * it is a FILE ON A PERSON, and the second one exists precisely to say what
 * changed since the first. Drawn as a flat log, "Dossier — Jane Doe" three
 * times over reads as the same job run three times by mistake.
 *
 * So the runs are grouped by the person they name and each person gets one
 * card: their name, how many dossiers there are, when the newest landed, and
 * a row of dated pills — one per dossier, newest first — to move between
 * them. That is Workdash's people room, which is where this idea comes from
 * and which has been read this way for a year.
 *
 * THE PERSON IS THE TITLE WITH ITS PREFIX TAKEN OFF, and that is the whole
 * join. The server titles a dossier run `Dossier — <first line of the
 * brief>`; there is no person table on this side and there should not be one,
 * because inventing an identity out of free text is how two spellings of one
 * name become two people who have never met. Grouping on the words the owner
 * typed is exactly as strong as the words the owner typed, which is honest.
 *
 * THE PILLS ARE LINKS, NOT BUTTONS. A dossier has an address —
 * /outputs/dossier/<run id> — and the report above this shelf is whatever is
 * at it. Switching between two dossiers on one person is therefore ordinary
 * navigation, with a back button and a copyable URL, rather than a piece of
 * state that vanishes on refresh.
 */

/** `Dossier — Jane Doe` → `Jane Doe`. The em dash is what the server writes;
 *  the en dash and the hyphen are accepted because a title typed or migrated
 *  by hand is the case where this quietly stops grouping. A title that is
 *  only the prefix keeps the whole string rather than becoming "". */
const PREFIX = /^dossier\s*[—–-]\s*/i;
const personOf = (title: string) => title.replace(PREFIX, "").trim() || title.trim();

type Person = { name: string; runs: RunSummary[] };

/** Newest first, within a person and between people. The list arrives in the
 *  server's order and this does not trust it: the pills' order IS the claim
 *  that the leftmost one is the current file. */
function shelve(runs: RunSummary[]): Person[] {
  const at = (r: RunSummary) => r.finishedAt ?? r.startedAt ?? r.queuedAt;
  const by = new Map<string, Person>();
  for (const run of [...runs].sort((a, b) => at(b).localeCompare(at(a)))) {
    const name = personOf(run.title);
    /* Keyed case-insensitively so "jane doe" and "Jane Doe" are one file, and
       displayed with the spelling of the NEWEST run — the owner's latest
       intent about how to write it. */
    const key = name.toLowerCase();
    const found = by.get(key);
    if (found) found.runs.push(run);
    else by.set(key, { name, runs: [run] });
  }
  return [...by.values()];
}

export function DossierShelf({ refreshKey }: { refreshKey: string }) {
  /* Which dossier is open, from the address — see the header. `runId` is the
     run app's own route parameter, so this needs nothing passed to it. */
  const { runId } = useParams();
  /* 200 rather than the history's 40: this is the whole shelf, and a person
     whose file fell off the end of a page would look like a person nobody has
     ever looked up. */
  const list = useApi(() => runsApi.list({ kind: "dossier", limit: 200 }), [refreshKey]);
  const people = shelve(list.data?.runs ?? []);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          People
        </div>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {list.loading && !list.data
            ? "loading…"
            : list.error
              ? list.error
              : people.length === 0
                ? "nobody on file"
                : `${people.length} ${people.length === 1 ? "person" : "people"}`}
        </span>
      </div>

      {people.length === 0 ? (
        <p className="text-muted-foreground text-[14px]">
          No dossiers yet. Give the People analyst a name and it writes the
          first one; a re-run opens with what changed since the last.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {people.map((p) => (
            <PersonCard key={p.name.toLowerCase()} person={p} openId={runId ?? null} />
          ))}
        </div>
      )}
    </>
  );
}

/** One person's file: who they are, how thick the file is, and every dated
 *  dossier in it. */
function PersonCard({ person, openId }: { person: Person; openId: string | null }) {
  const newest = person.runs[0]!;
  const working = person.runs.find((r) => isLive(r.status)) ?? null;
  const n = person.runs.length;

  return (
    <div className="bg-card rounded-[14px] p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        {/* A DOT ONLY WHILE SOMETHING IS MOVING. Every other state of a
            dossier is already on its own pill and on the report above; a
            permanent status light on a file that is simply finished would be
            a colour nobody has to read. */}
        {working && (
          <span className="bg-ok mt-[7px] size-1.5 shrink-0 animate-pulse self-start rounded-full" />
        )}
        <span className="text-[14px] leading-snug font-medium tracking-tight">
          {person.name}
        </span>
        <span className="text-muted-foreground text-[12.5px]">
          {n} {n === 1 ? "dossier" : "dossiers"} · newest{" "}
          {ago(newest.finishedAt ?? newest.queuedAt)}
          {working && " · one being written now"}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {person.runs.map((r) => (
          <Link
            key={r.id}
            to={appPage("dossier", r.id)}
            title={`${r.title} — ${isLive(r.status) ? r.status : r.status === "failed" ? "failed" : "written"}`}
            className={cn(
              "rounded-[9px] border px-2 py-0.5 text-[12px] tabular-nums transition-colors",
              r.id === openId
                ? "border-foreground text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground border-transparent",
            )}
          >
            {day(r.finishedAt ?? r.queuedAt)}
          </Link>
        ))}
      </div>
    </div>
  );
}
