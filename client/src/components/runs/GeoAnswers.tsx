import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { runsApi, type GeoAnswer } from "@/lib/api/runs";
import type { Venture } from "@/lib/store";

/**
 * WHAT THE MODELS ALREADY BELIEVE ABOUT THIS BUSINESS.
 *
 * The GEO run asks the active provider a handful of plain questions with NO
 * TOOLS AND NO WEB and keeps the answers. The point is not to find out
 * anything true; it is to find out what a model says to somebody who asks it
 * about you, which is now a real distribution channel and is invisible from
 * every analytics product on this box.
 *
 * THE QUESTIONS COME IN THREE KINDS AND THE PANEL SAYS WHICH. A `direct`
 * question names the product — "What is X?" — and a model that answers it well
 * has heard of you; that is worth knowing and it is not what sends anybody. A
 * `generic` one is what a stranger with the problem actually types — "what's
 * the best tool for X" — and those are GENERATED per run from the venture
 * record, never naming the product, because a question carrying the name tells
 * the model the answer. `extra` is what the owner typed into the form. The
 * per-run line counts the generic ones and only those: "mentioned in 4 of 5"
 * over questions that all contained the name is not a finding.
 *
 * THREE PILLS, AND THEY ARE THREE DIFFERENT KINDS OF CLAIM.
 *
 *   MENTIONED is mechanical and certain: the venture's name or its host
 *   appeared in the answer, decided by string presence and nothing cleverer.
 *   It is the only one of the three this box can be sure of.
 *
 *   ACCURATE and RECOMMENDED are one model's judgement of another model's
 *   answer, and they are NULL when that judgement was not made. Null is drawn
 *   as a hollow pill and never as a no. The distinction is the whole reason
 *   there are three pills instead of a score out of ten: a composite would
 *   silently turn "nobody checked" into "it failed".
 *
 * FOUR PARTS PER ANSWER, IN THE ORDER SOMEBODY READS THEM. The prompt as it
 * was asked, the response verbatim, what the judge made of it, and the one
 * thing to do so that this prompt's answer improves. The response is clamped
 * because a page of six full answers is the wall of text this panel replaced —
 * but it is clamped, never summarised, and the whole of it is one click away.
 *
 * ROWS FROM BEFORE THE RUN RECORDED ANY OF THIS (migration 077) have no kind
 * and no reading, and they say "not recorded" rather than drawing a blank or
 * guessing a kind from the wording of the question.
 */
export function GeoAnswers({
  venture,
  refreshKey,
}: {
  venture: Venture | null;
  /** The id of the run that just settled — see `RunApp`'s `extras`. */
  refreshKey: string;
}) {
  const doc = useApi(
    () => (venture ? runsApi.geo(venture.id) : Promise.resolve(null)),
    [venture?.id ?? null, refreshKey],
  );
  /* Which responses have been opened out, by row. State rather than a details
     element because the toggle sits in the card's own layout and the closed
     state is a line clamp, not a hidden block — the first lines stay on
     screen, which is what makes six answers skimmable at all. */
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!venture)
    return (
      <p className="text-muted-foreground text-[14px]">
        Pick a venture to see what the models say about it.
      </p>
    );

  const answers = doc.data?.answers ?? [];

  /* GROUPED BY RUN, NEWEST FIRST, THEN BY PROVIDER INSIDE IT. The server
     already returns the rows newest-first, so encounter order is run order and
     nothing here re-sorts by date. A run is the unit because the generic
     questions are generated fresh each time: two runs asked different things,
     and interleaving them would put a tally over questions that were never a
     set. Provider is the split inside it because "which model does not know
     you exist" is the question this data answers. */
  const runs: { runId: string; rows: GeoAnswer[] }[] = [];
  for (const a of answers) {
    const last = runs.find((r) => r.runId === a.runId);
    if (last) last.rows.push(a);
    else runs.push({ runId: a.runId, rows: [a] });
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          What the models say
        </div>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {doc.loading && !doc.data
            ? "loading…"
            : doc.error
              ? doc.error
              : answers.length === 0
                ? "nothing asked yet"
                : `${answers.length} ${answers.length === 1 ? "answer" : "answers"} · ${runs.length} ${
                    runs.length === 1 ? "run" : "runs"
                  }`}
        </span>
      </div>

      {answers.length === 0 ? (
        <p className="text-muted-foreground text-[14px]">
          Nothing has been asked about {venture.name} yet. A run puts the
          questions a stranger would ask — and a few that name the product — to
          the active provider with no tools and no web, and keeps whatever
          comes back.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {runs.map(({ runId, rows }) => (
            <div key={runId}>
              <RunTally rows={rows} />
              <div className="flex flex-col gap-4">
                {[...byProvider(rows)].map(([provider, prows]) => (
                  <div key={provider}>
                    <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                      <span className="text-[14px] font-medium tracking-tight">
                        {provider}
                      </span>
                      <span className="text-muted-foreground text-[12.5px]">
                        {prows[0]?.model ?? "model not recorded"} ·{" "}
                        {prows.filter((r) => r.mentioned).length} of{" "}
                        {prows.length} mentioned it
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {ordered(prows).map((a, i) => {
                        const key = `${a.runId}:${provider}:${i}`;
                        return (
                          <AnswerCard
                            key={key}
                            a={a}
                            open={open[key] === true}
                            onToggle={() =>
                              setOpen((o) => ({ ...o, [key]: !o[key] }))
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Generic first — the ones a buyer who has never heard of the product would
 *  type — then the ones that name it, then the owner's own. Rows written
 *  before the kind was recorded keep their place at the end. */
function ordered(rows: GeoAnswer[]): GeoAnswer[] {
  const rank = (k: GeoAnswer["kind"]) =>
    k === "generic" ? 0 : k === "direct" ? 1 : k === "extra" ? 2 : 3;
  return [...rows].sort((a, b) => rank(a.kind) - rank(b.kind));
}

function byProvider(rows: GeoAnswer[]): Map<string, GeoAnswer[]> {
  const map = new Map<string, GeoAnswer[]>();
  for (const a of rows) {
    const list = map.get(a.provider);
    if (list) list.push(a);
    else map.set(a.provider, [a]);
  }
  return map;
}

/**
 * THE ONE LINE THAT IS THE RUN'S FINDING, and it counts generic asks only.
 * Where the judge never answered it says so instead of printing a zero: "0 of
 * 5" and "nobody scored the 5" are different facts and the first is the one a
 * failed judge would otherwise be reported as.
 */
function RunTally({ rows }: { rows: GeoAnswer[] }) {
  const generic = rows.filter((r) => r.kind === "generic");
  const judged = generic.filter((r) => r.recommended !== null);
  const rec = generic.filter((r) => r.recommended === true).length;
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-2">
      <span className="text-[13px] font-medium tracking-tight">
        {generic.length === 0
          ? "No generic asks recorded for this run"
          : judged.length === 0
            ? `${generic.length} generic ${generic.length === 1 ? "ask" : "asks"}, none judged for recommendation`
            : `Recommended in ${rec} of ${judged.length} generic ${judged.length === 1 ? "ask" : "asks"}`}
      </span>
      <span className="text-muted-foreground text-[12.5px]">
        {ago(rows[0]?.ts ?? null)} · {rows.length}{" "}
        {rows.length === 1 ? "question" : "questions"} in the run
      </span>
    </div>
  );
}

/** THE FOUR PARTS, IN THE ORDER SOMEBODY READS THEM. The same four the run's
 *  own HTML report draws, so the panel and the report do not disagree about
 *  what an answer is. */
function AnswerCard({
  a,
  open,
  onToggle,
}: {
  a: GeoAnswer;
  open: boolean;
  onToggle: () => void;
}) {
  /* Long enough that the clamp actually hides something. Below this the
     toggle would open a card that was already whole, which reads as a
     control that does nothing. */
  const clampable = a.answer.length > 260 || a.answer.split("\n").length > 5;
  /* "not recorded" is a row from before the reading was stored; "not judged"
     is a row the judge was asked about and did not answer for. Same blank on
     screen, entirely different thing to do about it. */
  const missing = a.kind === null ? "not recorded" : "not judged";

  return (
    <div className="bg-card rounded-[14px] p-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <KindBadge kind={a.kind} />
        <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
          <Pill label="mentioned" value={a.mentioned} />
          <Pill label="accurate" value={a.accurate} />
          <Pill label="recommended" value={a.recommended} />
        </span>
      </div>

      {a.rivals && a.rivals.length > 0 && (
        <div className="mb-2.5 flex flex-wrap items-baseline gap-1">
          <Label>named instead</Label>
          {a.rivals.map((r) => (
            <span
              key={r}
              className="bg-muted rounded-[6px] px-1.5 py-px text-[11.5px] leading-[1.6]"
            >
              {r}
            </span>
          ))}
        </div>
      )}

      <div className="mb-2.5">
        <Label>prompt</Label>
        <p className="text-[14px] font-medium tracking-tight">{a.question}</p>
      </div>

      <div className="mb-2.5">
        <Label>response</Label>
        <p
          className={cn(
            "text-muted-foreground text-[13.5px] leading-relaxed whitespace-pre-wrap",
            clampable && !open && "line-clamp-4",
          )}
        >
          {a.answer}
        </p>
        {clampable && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="text-muted-foreground hover:text-foreground mt-1 text-[12.5px] underline underline-offset-2"
          >
            {open ? "show less" : "show more"}
          </button>
        )}
      </div>

      <div className="mb-2.5">
        <Label>what this means</Label>
        <p
          className={cn(
            "text-[13.5px] leading-relaxed",
            !a.explanation && "text-muted-foreground italic",
          )}
        >
          {a.explanation ?? missing}
        </p>
      </div>

      <div>
        <Label>what to do</Label>
        <p
          className={cn(
            "text-[13.5px] leading-relaxed",
            !a.action && "text-muted-foreground italic",
          )}
        >
          {a.action ?? missing}
        </p>
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <span className="text-muted-foreground mb-0.5 block text-[10.5px] tracking-[0.08em] uppercase">
      {children}
    </span>
  );
}

/** Generic is the kind that matters, so it is the one with the colour on it. */
function KindBadge({ kind }: { kind: GeoAnswer["kind"] }) {
  return (
    <span
      title={
        kind === "generic"
          ? "A question a stranger with this problem would ask, generated for this run and never naming the product"
          : kind === "direct"
            ? "A question that names the product or its host"
            : kind === "extra"
              ? "A question the owner typed into the form"
              : "Asked before the run recorded what each question was for"
      }
      className={cn(
        "rounded-[8px] border px-1.5 py-px text-[10.5px] tracking-[0.06em] uppercase",
        kind === "generic"
          ? "bg-accent text-accent-foreground border-transparent font-medium"
          : "text-muted-foreground",
      )}
    >
      {kind ?? "not recorded"}
    </span>
  );
}

/** Filled for yes, outlined-and-struck for no, hollow and dashed for a
 *  judgement nobody made. Three states because there are three. */
function Pill({ label, value }: { label: string; value: boolean | null }) {
  return (
    <span
      title={
        value === null
          ? `${label}: not judged — no second turn scored this answer`
          : value
            ? label
            : `not ${label}`
      }
      className={cn(
        "rounded-[8px] border px-1.5 py-px text-[11.5px] leading-[1.5] whitespace-nowrap",
        value === null && "text-muted-foreground border-dashed opacity-70",
        value === true && "text-ok border-ok/40",
        value === false && "text-muted-foreground",
      )}
    >
      {value === null ? `${label}?` : value ? label : `not ${label}`}
    </span>
  );
}
