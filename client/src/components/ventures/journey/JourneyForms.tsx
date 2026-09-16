import { SelectField, SelectOption } from "@/components/ui/select-field";
import { businessTypesOf } from "../../../../../shared/businessTypes";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { JOURNEY_STAGES, STAGE_LABELS, PROFILE_FIELDS, journeyReadiness, journeyTasks, type BusinessType, type JourneyCommand, type JourneyDocument, type JourneyProfile, type JourneyStage, type JourneyTask, type NameCandidate, type TaskProgress, type TaskStatus } from "../../../../../shared/ventureJourney";
import type { Venture } from "@/lib/api";
export type SaveJourney = (command: JourneyCommand) => Promise<boolean>;
type FormProps = { save: SaveJourney; close: () => void; busy: boolean; error: string | null; reload: () => void };
export function JourneyModal({ title, description, close, children }: { title: string; description: string; close: () => void; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="venture-journey journey-modal sm:max-w-[610px]"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>;
}
export function ErrorNotice({ error, reload }: { error: string | null; reload?: () => void }) { return error ? <div role="alert" className="journey-error"><p>{error}</p>{reload && error.includes("another window") && <button type="button" className="mt-2 underline" onClick={reload}>Reload saved plan and keep my draft</button>}</div> : null; }
export function ProfileEditor({ profile, fields, ...props }: FormProps & { profile: JourneyProfile; fields: (keyof JourneyProfile)[] }) {
  const [draft, setDraft] = useState(profile);
  return <JourneyModal title="Make the plan yours" description="Keep the assumptions specific. Update them as you learn." close={props.close}>
    <form onSubmit={async e => { e.preventDefault(); if (await props.save({ kind: "profile", values: Object.fromEntries(fields.map(f => [f, draft[f] ?? ""])) })) props.close(); }}>
      {fields.map(field => <label key={field} className="journey-field">{PROFILE_FIELDS[field]}{field.endsWith("Date") ? <input type="date" value={draft[field] ?? ""} onInput={e => setDraft({ ...draft, [field]: e.currentTarget.value })} onChange={e => setDraft({ ...draft, [field]: e.target.value })} /> : <textarea maxLength={4000} value={draft[field] ?? ""} onChange={e => setDraft({ ...draft, [field]: e.target.value })} />}</label>)}
      <ErrorNotice error={props.error} reload={props.reload} /><div className="journey-modal-footer"><Button type="button" variant="ghost" onClick={props.close}>Cancel</Button><Button disabled={props.busy}>{props.busy ? "Saving…" : "Save plan"}</Button></div>
    </form>
  </JourneyModal>;
}
export function TaskEditor({ task, progress, ...props }: FormProps & { task: JourneyTask; progress?: TaskProgress }) {
  const [status, setStatus] = useState<TaskStatus>(progress?.status ?? "todo");
  const [evidence, setEvidence] = useState(progress?.evidence ?? "");
  const [remove, setRemove] = useState(false);
  return <JourneyModal title={task.title} description={task.detail || "Your own checklist step."} close={props.close}>
    <form onSubmit={async e => { e.preventDefault(); if (await props.save({ kind: "task", key: task.key, status, evidence })) props.close(); }}>
      <label className="journey-field">Status<SelectField aria-label="Task status" value={status} onValueChange={(value) => setStatus(value as TaskStatus)}><SelectOption value="todo">To do</SelectOption><SelectOption value="done">Done</SelectOption><SelectOption value="skipped">Does not apply</SelectOption></SelectField></label>
      <label className="journey-field">{status === "skipped" ? "Why does this not apply?" : "Evidence & notes"}<textarea rows={6} maxLength={8000} required={status === "skipped"} placeholder={task.evidenceHint} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
      <p className="journey-muted">{task.required ? "Essential step" : "Suggested step"} · {task.tool}</p>
      <ErrorNotice error={props.error} reload={props.reload} /><div className="journey-modal-footer">{task.custom && <Button type="button" variant="ghost" disabled={props.busy} onClick={async () => { if (!remove) setRemove(true); else if (await props.save({ kind: "delete-task", key: task.key })) props.close(); }}>{remove ? "Confirm remove step & evidence" : "Remove step"}</Button>}<Button type="button" variant="ghost" onClick={props.close}>Cancel</Button><Button disabled={props.busy}>{props.busy ? "Saving…" : "Save step"}</Button></div>
    </form>
  </JourneyModal>;
}
export function CustomTaskEditor({ stage, businessType, ...props }: FormProps & { stage: JourneyStage; businessType: BusinessType | null }) {
  const [title, setTitle] = useState(""), [detail, setDetail] = useState(""), [required, setRequired] = useState(false), [allTypes, setAllTypes] = useState(false);
  return <JourneyModal title="Add your own step" description={`For ${STAGE_LABELS[stage].toLowerCase()}. Shape the plan around how your business actually works.`} close={props.close}>
    <form onSubmit={async e => { e.preventDefault(); if (await props.save({ kind: "add-task", stage, businessType: allTypes ? null : businessType, title, detail, required })) props.close(); }}>
      <label className="journey-field">Step title<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="journey-field">What does done look like?<textarea maxLength={4000} value={detail} onChange={e => setDetail(e.target.value)} /></label>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} />Treat this as an essential</label>
      {businessType && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allTypes} onChange={e => setAllTypes(e.target.checked)} />Keep this step visible for every business type</label>}
      <ErrorNotice error={props.error} reload={props.reload} /><div className="journey-modal-footer"><Button type="button" variant="ghost" onClick={props.close}>Cancel</Button><Button disabled={props.busy}>Add step</Button></div>
    </form>
  </JourneyModal>;
}
export function NameEditor({ candidate, ...props }: FormProps & { candidate?: NameCandidate }) {
  const [name, setName] = useState(candidate?.name ?? ""), [domain, setDomain] = useState(candidate?.domain ?? ""), [evidence, setEvidence] = useState(candidate?.evidence ?? "");
  const [status, setStatus] = useState<NameCandidate["status"]>(candidate?.status ?? "unchecked"), [remove, setRemove] = useState(false);
  return <JourneyModal title={candidate ? "Review a name" : "Add a name candidate"} description="A shortlist records your research. It does not check availability or register a domain." close={props.close}>
    <form onSubmit={async e => { e.preventDefault(); if (await props.save({ kind: "name", id: candidate?.id, name, domain, status, evidence })) props.close(); }}>
      <label className="journey-field">Candidate name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="journey-field">Domain to check<input placeholder="example.com" maxLength={253} value={domain} onChange={e => setDomain(e.target.value)} /></label>
      <label className="journey-field">Decision<SelectField aria-label="Name decision" value={status} onValueChange={(value) => setStatus(value as NameCandidate["status"])}><SelectOption value="unchecked">Unchecked</SelectOption><SelectOption value="shortlisted">Shortlisted</SelectOption><SelectOption value="ruled-out">Ruled out</SelectOption><SelectOption value="chosen">Chosen</SelectOption></SelectField></label>
      <label className="journey-field">Research & checks<textarea required={status === "chosen"} maxLength={4000} placeholder="Domain, existing brands, handles, links to checks and the date you checked." value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
      <ErrorNotice error={props.error} reload={props.reload} /><div className="journey-modal-footer">{candidate && <Button type="button" variant="ghost" disabled={props.busy} onClick={async () => { if (!remove) setRemove(true); else if (await props.save({ kind: "delete-name", id: candidate.id })) props.close(); }}>{remove ? "Confirm remove candidate" : "Remove"}</Button>}<Button type="button" variant="ghost" onClick={props.close}>Cancel</Button><Button disabled={props.busy}>Save candidate</Button></div>
    </form>
  </JourneyModal>;
}
export function StageEditor({ venture, doc, target, close, busy, error, change }: { venture: Venture; doc: JourneyDocument; target: JourneyStage; close: () => void; busy: boolean; error: string | null; change: (stage: JourneyStage, note: string, expectedAt: string) => Promise<boolean> }) {
  const [stage, setStage] = useState(target), [note, setNote] = useState(""), [expectedAt] = useState(venture.updatedAt);
  const readiness = journeyReadiness(journeyTasks(doc.state, venture.stage, businessTypesOf(venture)), doc.state.tasks);
  const forward = JOURNEY_STAGES.indexOf(stage) > JOURNEY_STAGES.indexOf(venture.stage);
  return <JourneyModal title="Change venture status" description="Your business can move forwards or back. Checklists, evidence, connections and dashboards stay saved." close={close}>
    <form onSubmit={async e => { e.preventDefault(); if (await change(stage, note, expectedAt)) close(); }}>
      <label className="journey-field">Venture status<SelectField aria-label="Venture status" value={stage} onValueChange={(value) => setStage(value as JourneyStage)}>{JOURNEY_STAGES.map(s => <SelectOption key={s} value={s}>{STAGE_LABELS[s]}</SelectOption>)}</SelectField></label>
      {forward && readiness.requiredOpen.length > 0 && <div className="journey-note mb-4">{readiness.requiredOpen.length} essentials remain open in {STAGE_LABELS[venture.stage].toLowerCase()}. You can still move forward.<ul className="mt-2 list-disc pl-4">{readiness.requiredOpen.map(t => <li key={t.key}>{t.title}</li>)}</ul></div>}
      {!businessTypesOf(venture).length && <p className="journey-muted mb-3">Choose a business type to include its specific launch checks. Only common steps are currently shown.</p>}
      <label className="journey-field">Decision note<textarea maxLength={4000} placeholder="What changed? What have you learned or decided?" value={note} onChange={e => setNote(e.target.value)} /></label>
      <ErrorNotice error={error} /><div className="journey-modal-footer"><Button type="button" variant="ghost" onClick={close}>Cancel</Button><Button disabled={busy || stage === venture.stage}>{busy ? "Saving…" : `Move to ${STAGE_LABELS[stage]}`}</Button></div>
    </form>
  </JourneyModal>;
}
