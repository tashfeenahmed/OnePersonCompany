import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Film, Loader2, Play, Sparkles, Trash2, Wand2 } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { motionApi, type PreviewDoc, type SpecDetail, type SpecSummary } from "@/lib/api/motion";

/**
 * THE SCENE-SPEC EDITOR — the one page in this app where the owner writes the
 * video rather than describing it.
 *
 * A JSON BOX AND A FORM, NOT ONE OR THE OTHER. The spec is a small structured
 * document and the honest way to show it is as itself: five scene kinds with
 * different fields, which any form general enough to hold all of them would
 * flatten into a wall of empty inputs. So the JSON is the document and the form
 * beside it covers only the fields EVERY scene has — its kind, how long it
 * holds, its kicker, and the line a narrator would read. Those four are the
 * ones somebody adjusts ten times while getting the pacing right, and clicking
 * into a text area to change `3.2` to `4` ten times is how a good tool becomes
 * an annoying one.
 *
 * THE FORM WRITES BACK INTO THE JSON RATHER THAN INTO A SECOND STATE. There is
 * one source of truth on this page — the text in the box — and the form parses
 * it, changes one field and re-serialises. That is slightly more work per
 * keystroke and it makes the two halves incapable of disagreeing, which is the
 * failure mode of every "form and raw view" editor that keeps them apart.
 *
 * `problems` IS DRAWN AS PROMINENTLY AS AN ERROR AND IS NOT ONE. The server
 * clamps rather than argues: a heading too long is cut, a nine-item list
 * becomes six, a scene too long becomes the ceiling. Those changes come back
 * with the saved spec and they are the difference between a tool that did what
 * you asked and one that did something near it.
 *
 * THE PREVIEW IS THE REAL RENDERER. One browser launch draws the first frame
 * of every scene at a third of the size — the same CSS, the same fonts, the
 * same colours as the video. It is not a mock-up of what the video might look
 * like, and it takes a few seconds, which is why it is a button rather than
 * something that happens on every keystroke.
 *
 * RENDERING IS A QUEUED RUN AND THE PAGE SAYS SO. The button hands back a run
 * id and a link; the frames are drawn on the queue, under the same lease every
 * other video takes on this machine.
 */

const EXAMPLE = {
  title: "A new scene list",
  scenes: [
    { kind: "title", kicker: "Introducing", title: "Write the line here", subtitle: "And a shorter one under it", seconds: 3.2, say: "" },
    { kind: "list", heading: "What it does", items: ["The first thing", "The second thing", "The third thing"], seconds: 5, say: "" },
    { kind: "cta", headline: "Have a look", action: "Start free", url: null, seconds: 3, say: "" },
  ],
};

export function Motion() {
  const { state } = useStore();
  const [ventureId, setVentureId] = useState<string | null>(null);
  /* THE OPEN SPEC IS IN THE ADDRESS. A spec somebody is editing is a place,
     the way a dashboard and a run are: `?spec=<id>` means the link they send
     themselves opens the thing they were looking at rather than the list. */
  const [params, setParams] = useSearchParams();
  const openId = params.get("spec");
  const setOpenId = (id: string | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set("spec", id);
    else p.delete("spec");
    setParams(p, { replace: true });
  };

  const list = useApi(() => motionApi.list(ventureId), [ventureId]);
  const d = list.data;

  return (
    <PageShell
      title="Motion"
      sub={
        <>
          A motion video is a <em>scene list</em>: four to eight cards of typography — a title, a
          number, a before-and-after, a list, a call to action — drawn in the venture&rsquo;s own
          measured colours and typeface. Rendering one is a{" "}
          <Link to="/social/video" className="underline decoration-dotted">
            video run
          </Link>
          ; nothing here is published anywhere.
        </>
      }
      wide
    >
      {/* ------------------------------------------------------ readiness */}
      {d && (
        <div className="bg-card border-line-soft mb-4 grid gap-1.5 rounded-[10px] border p-3.5 text-[12.5px]">
          <Capability label="Renderer" ready={d.readiness.renderer.ready} note={d.readiness.renderer.note} />
          <Capability label="Encoder" ready={d.readiness.encoder.ready} note={d.readiness.encoder.note} />
          <Capability label="Scene writer" ready={d.readiness.writer.ready} note={d.readiness.writer.note} />
        </div>
      )}

      {/* -------------------------------------------------------- ventures */}
      <div className="mb-4 flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground mr-1 text-[12px]">Venture</span>
        <PickButton on={ventureId === null} onClick={() => setVentureId(null)}>
          All
        </PickButton>
        {state.ventures.map((v) => (
          <PickButton key={v.id} on={ventureId === v.id} onClick={() => setVentureId(v.id)}>
            {v.name}
          </PickButton>
        ))}
      </div>

      <Draft ventureId={ventureId} onDone={(id) => { setOpenId(id); list.reload(); }} />

      {list.error && (
        <p className="text-muted-foreground mb-4 text-[13px]">
          The motion API did not answer. <span className="text-destructive">{list.error}</span>
        </p>
      )}
      {!d && !list.error && <p className="text-muted-foreground text-[13px]">Reading the scene specs…</p>}

      {d && !d.specs.length && (
        <p className="text-muted-foreground text-[13px]">
          No scene specs yet. Draft one from a brief above, or press <em>New</em> to write one by hand.
        </p>
      )}

      {d && (
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void motionApi
                  .create({ name: "New scene list", venture: ventureId, spec: EXAMPLE })
                  .then((r) => {
                    setOpenId(r.id);
                    list.reload();
                  });
              }}
            >
              <Sparkles className="size-[14px]" strokeWidth={1.8} /> New, from the example
            </Button>
            <span className="text-muted-foreground text-[12px]">
              {d.specs.length} spec{d.specs.length === 1 ? "" : "s"}
            </span>
          </div>

          {d.specs.map((s) => (
            <SpecRow
              key={s.id}
              summary={s}
              open={openId === s.id}
              onToggle={() => setOpenId(openId === s.id ? null : s.id)}
              onChanged={() => list.reload()}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function PickButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={on ? "page" : undefined}
      className={cn("hover:bg-accent rounded-lg px-2.5 py-1.5 text-[12.5px]", on && "bg-accent font-medium")}
    >
      {children}
    </button>
  );
}

function Capability({ label, ready, note }: { label: string; ready: boolean; note: string }) {
  return (
    <div className="flex gap-2">
      <span className={cn("mt-[5px] size-[7px] shrink-0 rounded-full", ready ? "bg-ok" : "bg-warn")} />
      <span className="w-[92px] shrink-0">{label}</span>
      <span className="text-muted-foreground">{note}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ draft */

function Draft({ ventureId, onDone }: { ventureId: string | null; onDone: (id: string) => void }) {
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  return (
    <div className="bg-card border-line-soft mb-4 rounded-[10px] border p-3.5">
      <div className="mb-2 text-[12.5px] font-medium">Draft a scene list from a brief</div>
      <div className="flex flex-wrap gap-2">
        <input
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="What the video is for. Empty makes the general case for the venture."
          className="border-line-soft min-w-[280px] flex-1 rounded-[8px] border bg-transparent px-2.5 py-1.5 text-[13px]"
        />
        <Button
          disabled={busy}
          onClick={() => {
            /* A draft is one call to the model provider. Same convention as the
               two buttons in the editor below. */
            if (!confirm("Ask the model provider for a scene list? It is one call on your account.")) return;
            setBusy(true);
            setSaid(null);
            motionApi
              .draft({ venture: ventureId, brief, name: brief.slice(0, 60) || "Draft", aspect: "9:16" })
              .then((r) => {
                setSaid(r.problems.length ? `Saved, with ${r.problems.length} thing(s) changed on the way in.` : "Saved.");
                onDone(r.id);
              })
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : <Wand2 className="size-[14px]" strokeWidth={1.8} />}
          Draft
        </Button>
      </div>
      <p className="text-muted-foreground mt-2 text-[11.5px]">
        A drafted spec is a DRAFT: every number on a stat card is a claim about your business that
        nothing here can check. The writer is told to use no stat scene when the brief gives it no
        number — read what comes back before you render it.
      </p>
      {said && <p className="mt-1.5 text-[12px]">{said}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------- spec */

function SpecRow({
  summary,
  open,
  onToggle,
  onChanged,
}: {
  summary: SpecSummary;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <div className="bg-card border-line-soft rounded-[10px] border">
      <button onClick={onToggle} className="hover:bg-accent/40 flex w-full flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-[10px] px-3.5 py-2.5 text-left">
        <Film className="size-[14px] shrink-0 self-center" strokeWidth={1.8} />
        <span className="text-[13.5px] font-medium">{summary.name}</span>
        <span className="text-muted-foreground text-[11.5px]">
          {summary.scenes} scene{summary.scenes === 1 ? "" : "s"}
          {summary.seconds !== null && ` · ${summary.seconds.toFixed(1)}s of scene list`}
          {" · "}
          {summary.aspect}
          {summary.ventureName && ` · ${summary.ventureName}`}
          {summary.source === "model" && " · drafted by a model"}
        </span>
      </button>
      {open && <Editor id={summary.id} onChanged={onChanged} />}
    </div>
  );
}

/** A rough wall-clock estimate, in the words a person would use. Never "1
 *  minutes", and never a decimal for something this approximate. */
function minutes(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  const m = Math.round(seconds / 60);
  return `about ${m} minute${m === 1 ? "" : "s"}`;
}

function Editor({ id, onChanged }: { id: string; onChanged: () => void }) {
  const doc = useApi(() => motionApi.get(id), [id]);
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewDoc | null>(null);
  const [voiceover, setVoiceover] = useState(false);
  const [run, setRun] = useState<string | null>(null);

  const detail: SpecDetail | null = doc.data;
  const body = text ?? (detail?.spec ? JSON.stringify(detail.spec, null, 2) : "");

  /* The parsed document, or null while it is mid-edit and not valid JSON. The
     per-scene form is hidden in that state rather than throwing away the
     owner's half-typed text. */
  const parsed = useMemo(() => {
    try {
      const v = JSON.parse(body) as { scenes?: unknown[] };
      return Array.isArray(v.scenes) ? v : null;
    } catch {
      return null;
    }
  }, [body]);

  function patchScene(index: number, key: string, value: unknown) {
    if (!parsed) return;
    const next = structuredClone(parsed) as { scenes: Record<string, unknown>[] };
    next.scenes[index] = { ...next.scenes[index], [key]: value };
    setText(JSON.stringify(next, null, 2));
  }

  if (doc.error) return <p className="text-destructive px-3.5 pb-3 text-[12.5px]">{doc.error}</p>;
  if (!detail) return <p className="text-muted-foreground px-3.5 pb-3 text-[12.5px]">Reading…</p>;
  if (!detail.readable)
    return <p className="text-destructive px-3.5 pb-3 text-[12.5px]">This spec is no longer readable as a scene list.</p>;

  return (
    <div className="border-line-soft grid gap-3 border-t px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name ?? detail.name}
          onChange={(e) => setName(e.target.value)}
          className="border-line-soft rounded-[8px] border bg-transparent px-2.5 py-1.5 text-[13px]"
        />
        {detail.cost && (
          <span className="text-muted-foreground text-[11.5px]">
            {detail.cost.frames} frames at {detail.cost.fps}/s · {detail.cost.sheets} browser launches,{" "}
            {/* A BROWSER LAUNCH IS ABOUT TWO AND A HALF SECONDS ON THIS
                MACHINE, measured. It is shown as a rough time because "24
                browser launches" is not a unit anybody plans around, and it is
                said as "about" because the encode and the model are on top. */}
            {minutes(detail.cost.sheets * 2.6)} of this machine
          </span>
        )}
      </div>

      {/* --------------------------------------------- the per-scene form */}
      {parsed ? (
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">The scenes</div>
          {(parsed.scenes as Record<string, unknown>[]).map((scene, i) => (
            <div key={i} className="border-line-soft flex flex-wrap items-center gap-2 border-l-2 pl-2.5 py-1">
              <span className="text-muted-foreground w-[18px] text-[11.5px]">{i + 1}</span>
              <select
                value={String(scene.kind ?? "")}
                onChange={(e) => patchScene(i, "kind", e.target.value)}
                className="border-line-soft rounded-[8px] border bg-transparent px-2 py-1 text-[12px]"
              >
                {["title", "stat", "compare", "list", "cta"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <label className="text-muted-foreground flex items-center gap-1 text-[11.5px]">
                seconds
                <input
                  type="number"
                  step="0.1"
                  value={typeof scene.seconds === "number" ? scene.seconds : ""}
                  onChange={(e) => patchScene(i, "seconds", Number(e.target.value))}
                  className="border-line-soft w-[62px] rounded-[8px] border bg-transparent px-1.5 py-1 text-[12px]"
                />
              </label>
              <input
                value={typeof scene.kicker === "string" ? scene.kicker : ""}
                onChange={(e) => patchScene(i, "kicker", e.target.value)}
                placeholder="kicker"
                className="border-line-soft w-[130px] rounded-[8px] border bg-transparent px-2 py-1 text-[12px]"
              />
              <input
                value={typeof scene.say === "string" ? scene.say : ""}
                onChange={(e) => patchScene(i, "say", e.target.value)}
                placeholder="what a narrator would read"
                className="border-line-soft min-w-[180px] flex-1 rounded-[8px] border bg-transparent px-2 py-1 text-[12px]"
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-warn text-[12px]">
          The JSON below is not currently valid, so the per-scene fields are hidden rather than
          rewriting what you are typing.
        </p>
      )}

      {/* ------------------------------------------------------- the JSON */}
      <textarea
        value={body}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={16}
        className="border-line-soft rounded-[8px] border bg-transparent px-2.5 py-2 font-mono text-[11.5px] leading-[1.5]"
      />

      {!!problems.length && (
        <div className="border-line-soft grid gap-1 border-l-2 pl-2.5 text-[12px]">
          <span className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
            What was changed on the way in
          </span>
          {problems.map((p, i) => (
            <span key={i} className="text-muted-foreground">
              {p}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy !== null}
          onClick={() => {
            setBusy("save");
            setSaid(null);
            let raw: unknown;
            try {
              raw = JSON.parse(body) as unknown;
            } catch (err) {
              setSaid(`That is not JSON: ${err instanceof Error ? err.message : String(err)}`);
              setBusy(null);
              return;
            }
            motionApi
              .update(id, { name: name ?? detail.name, spec: raw })
              .then((r) => {
                setProblems(r.problems);
                setSaid(r.problems.length ? "Saved — with the changes listed above." : "Saved.");
                setText(r.spec ? JSON.stringify(r.spec, null, 2) : body);
                doc.reload();
                onChanged();
              })
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          }}
        >
          {busy === "save" ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : null}
          Save
        </Button>

        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            setBusy("preview");
            setSaid(null);
            motionApi
              .preview(id)
              .then(setPreview)
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          }}
        >
          {busy === "preview" ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : null}
          Preview the scenes
        </Button>

        <label className="text-muted-foreground flex items-center gap-1.5 text-[12px]">
          <input type="checkbox" checked={voiceover} onChange={(e) => setVoiceover(e.target.checked)} />
          Narrate the scene lines
        </label>

        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            /* CONFIRMED BEFORE IT IS QUEUED, on the repo's own convention for
               anything that spends money or the machine (RunApp's "This may
               repeat paid work", the sidebar's delete). The number of browser
               launches is already on screen above; it is repeated here because
               a dialog is read and the line above it often is not. */
            const cost = detail.cost
              ? `${detail.cost.sheets} browser launches (${minutes(detail.cost.sheets * 2.6)} of this machine)`
              : "minutes of this machine";
            if (!confirm(`Render “${detail.name}”? It queues a video run and costs ${cost}${voiceover ? ", plus a speech call for every narrated scene" : ""}.`))
              return;
            setBusy("render");
            setSaid(null);
            motionApi
              .render(id, voiceover)
              .then((r) => {
                setRun(r.run.id);
                setSaid(r.note);
              })
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          }}
        >
          {busy === "render" ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : <Play className="size-[14px]" strokeWidth={1.8} />}
          Render
        </Button>

        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            if (!confirm(`Delete “${detail.name}”? The scene list and its preview frames go with it. A video already rendered from it keeps its own copy and is not affected.`))
              return;
            setBusy("delete");
            motionApi
              .remove(id)
              .then(onChanged)
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          }}
        >
          <Trash2 className="size-[14px]" strokeWidth={1.8} />
        </Button>
      </div>

      {said && <p className="text-[12px]">{said}</p>}
      {run && (
        <p className="text-[12px]">
          <Link to={`/social/video/${run}`} className="underline decoration-dotted">
            Open the run
          </Link>{" "}
          — the frames are drawn on the queue, not in this page.
        </p>
      )}

      {/* ---------------------------------------------------- the preview */}
      {preview && (
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
            The first frame of each scene
          </div>
          {preview.error && <p className="text-destructive text-[12px]">{preview.error}</p>}
          <div className="flex flex-wrap gap-2">
            {preview.frames.map((f) => (
              <div key={f.index} className="grid w-[128px] gap-1">
                {f.image ? (
                  <img
                    src={f.image}
                    alt={`Scene ${f.index}, ${f.kind}`}
                    className="border-line-soft w-full rounded-[6px] border bg-black"
                  />
                ) : (
                  <div className="border-line-soft text-muted-foreground grid h-[180px] place-items-center rounded-[6px] border px-1 text-center text-[10.5px]">
                    {f.error ?? "not drawn"}
                  </div>
                )}
                <span className="text-muted-foreground text-[11px]">
                  {f.index}. {f.kind} · {f.seconds}s
                </span>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-[11.5px]">{preview.note}</p>
        </div>
      )}
    </div>
  );
}
