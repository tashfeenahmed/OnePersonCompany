import { businessTypesOf, toggleBusinessType } from "../../../../../shared/businessTypes";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, Check, Download, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoleIcon } from "@/components/org/RoleIcon";
import { useApi } from "@/hooks/useApi";
import { journeyApi } from "@/lib/api/ventureJourney";
import { useStore } from "@/lib/store";
import type { Venture } from "@/lib/api";
import { appPage } from "../../../../../shared/navigation";
import { businessLabel, BUSINESS_TYPES, JOURNEY_STAGES, STAGE_LABELS, PROFILE_FIELDS, journeyTasks, journeyReadiness, journeyExport, type BusinessType, type JourneyCommand, type JourneyProfile, type JourneyStage, type JourneyTask, type NameCandidate } from "../../../../../shared/ventureJourney";
import { CustomTaskEditor, ErrorNotice, JourneyModal, NameEditor, ProfileEditor, StageEditor, TaskEditor } from "./JourneyForms";
import { JourneyPerformance } from "./JourneyPerformance";
import "./journey.css";
const COPY = {
  idea: { eyebrow: "Explore & validate", title: "Give the idea a little more shape.", sub: "Find the right customer, test the problem, and decide what is worth building.", checklist: "Your idea-to-evidence plan", focus: "A little evidence beats a lot of guessing.", focusText: "Choose one assumption that could change your decision. Test it with a real person before building more." },
  "pre-launch": { eyebrow: "Build & prepare", title: "Make the first day a good one.", sub: "Bring the essentials together. Know what is ready, what needs work, and what can wait.", checklist: "Your launch checklist", focus: "A smaller launch can still be a complete launch.", focusText: "Prioritize a working customer experience, a reliable way to serve people, and a way to learn." },
  launched: { eyebrow: "Run & improve", title: "Know what needs you today.", sub: "Revenue, customer signals and your next useful action — just for this venture.", checklist: "Keep the good weeks coming", focus: "Keep the business healthy. Then make it better.", focusText: "Choose one customer problem and one improvement. Give the change a measure and a review date." },
};
const FIELDS: Record<JourneyStage, (keyof JourneyProfile)[]> = {
  idea: ["customer", "problem", "promise", "revenueModel", "experiment", "successMeasure"],
  "pre-launch": ["promise", "launchDate", "launchAudience", "firstWeek", "successMeasure", "reviewDate"],
  launched: ["weeklyFocus", "successMeasure", "reviewDate", "decision"],
};
const TOOL_HINTS: Record<BusinessType, string> = {
  web: "GitHub · Stripe · Umami · Uptime", mobile: "App Store Connect · Google Play · App users",
  desktop: "GitHub · Stripe · App users", website: "Search Console · Umami · AdSense · Uptime",
  shop: "Calendar · Gmail · Imported sales & stock metrics", goods: "Stripe · Resend · Imported order & inventory metrics", service: "Calendar · Gmail · Stripe · Product knowledge",
};
type Editor = { kind: "profile"; fields: (keyof JourneyProfile)[] } | { kind: "task"; task: JourneyTask } | { kind: "custom" } | { kind: "name"; candidate?: NameCandidate } | { kind: "stage"; target: JourneyStage } | { kind: "review" } | { kind: "history"; id: number };
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), a = document.createElement("a");
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function VentureJourney({ venture, children }: { venture: Venture; children: ReactNode }) {
  const request = useApi(() => journeyApi.read(venture.id), [venture.id]);
  const { updateVenture } = useStore();
  const [busy, setBusy] = useState(false), saving = useRef(false);
  const [error, setError] = useState<string | null>(null), [editor, setEditor] = useState<Editor | null>(null);
  const [filter, setFilter] = useState("all");
  const doc = request.data, stage = venture.stage, types = businessTypesOf(venture), type = types[0] ?? null, copy = COPY[stage];
  async function mutate(action: () => Promise<void>) {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setError(null);
    try { await action(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  const save = (command: JourneyCommand) => mutate(async () => { if (!doc) throw new Error("Load the plan before saving."); request.setData(await journeyApi.update(venture.id, doc.revision, command)); });
  const close = () => { if (!saving.current) { setEditor(null); setError(null); } };
  const edit = (next: Editor) => { setError(null); setEditor(next); };
  const change = (target: JourneyStage, note: string, expectedUpdatedAt: string) => mutate(async () => {
    await updateVenture(venture.id, { stage: target, stageChangeNote: note, expectedUpdatedAt });
    setFilter("all"); request.reload();
  });
  const setType = (value: BusinessType) => mutate(async () => { await updateVenture(venture.id, { businessTypes: toggleBusinessType(types, value), expectedUpdatedAt: venture.updatedAt }); setFilter("all"); request.reload(); });
  if (!doc) return <div className="venture-journey p-6"><ErrorNotice error={request.error} />{request.loading ? "Loading your venture plan…" : <Button variant="outline" onClick={request.reload}>Retry</Button>}</div>;
  const tasks = journeyTasks(doc.state, stage, types), readiness = journeyReadiness(tasks, doc.state.tasks), profile = doc.state.profile;
  const evidence = tasks.filter(t => doc.state.tasks[t.key]?.evidence.trim()).length;
  const shown = tasks.filter(t => filter === "all" || (filter === "open" ? !doc.state.tasks[t.key] || doc.state.tasks[t.key]!.status === "todo" : t.required));
  const groups = [...new Set(shown.map(t => t.group))];
  const next = JOURNEY_STAGES[JOURNEY_STAGES.indexOf(stage) + 1];
  const formProps = { save, close, busy, error, reload: request.reload };
  const brief = `Venture: ${venture.name}. Stage: ${STAGE_LABELS[stage]}. Types: ${types.map(businessLabel).join(", ") || "Not chosen"}. Read its venture journey using venture ID ${venture.id} before making recommendations. Use the saved assumptions and evidence; distinguish unknowns from facts.`;
  const ask = (prompt: string) => `/?venture=${encodeURIComponent(venture.id)}&q=${encodeURIComponent(`${brief}\n\n${prompt}`)}`;
  return <div className="venture-journey min-h-0 flex-1 overflow-y-auto px-5 pb-16 md:px-8"><div className="mx-auto w-full max-w-[1220px]">
    <div className="journey-top"><div><div className="journey-eyebrow">{venture.name} / {copy.eyebrow}</div><h1>{copy.title}</h1><p className="journey-muted max-w-[660px]">{copy.sub}</p></div><div className="flex shrink-0 flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => download(`${venture.slug}-journey.json`, journeyExport(venture.name, doc))}><Download className="size-3.5" />Export plan</Button><Button size="sm" disabled={busy} onClick={() => edit({ kind: "stage", target: next ?? "idea" })}>Change status</Button></div></div>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2" role="group" aria-label="Business types"><span className="text-xs text-muted-foreground">Business types</span>{BUSINESS_TYPES.map(t => <button key={t.id} className={`rounded-lg border px-2.5 py-1.5 text-xs ${types.includes(t.id) ? "bg-accent text-foreground" : "text-muted-foreground"}`} aria-pressed={types.includes(t.id)} disabled={busy || request.loading} onClick={() => { void setType(t.id); }}>{t.label}</button>)}</div><span className="journey-muted" role="status">{busy ? "Saving…" : doc.updatedAt ? "Plan saved" : "Your plan is ready to start"}</span></div>
    <nav className="journey-steps" aria-label="Venture stages">{JOURNEY_STAGES.map((s, i) => <button key={s} className="journey-step" aria-current={s === stage ? "step" : undefined} disabled={busy} onClick={() => { if (s !== stage) edit({ kind: "stage", target: s }); }}><span className="journey-step-number">{s === stage ? <span>{i + 1}</span> : i + 1}</span><span><strong className="font-medium">{STAGE_LABELS[s]}</strong><span className="journey-muted block text-xs!">{COPY[s].eyebrow}</span></span>{s === stage && <span className="journey-tag ml-auto hidden sm:inline-flex">Current</span>}</button>)}</nav>
    {!editor && <ErrorNotice error={error} />}<ErrorNotice error={request.error} />{(error || request.error) && <button className="journey-muted mb-4 underline" disabled={busy} onClick={() => { request.reload(); }}>Reload saved plan</button>}
    {stage === "launched" ? <JourneyPerformance key={venture.id} venture={venture} /> : <div className="journey-stats">
      <div className="journey-stat"><p className="journey-muted">{stage === "idea" ? "Evidence plan" : "Launch preparation"}</p><div className="journey-stat-value">{readiness.done}<span className="text-muted-foreground text-lg"> / {readiness.total} complete</span></div><p className="journey-muted">{readiness.requiredOpen.length} essentials open{readiness.skipped ? ` · ${readiness.skipped} do not apply` : ""}</p><div className="journey-progress" role="progressbar" aria-label="Checklist completion" aria-valuenow={readiness.percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${readiness.percent}%` }} /></div></div>
      <div className="journey-stat"><p className="journey-muted">{stage === "idea" ? "Steps with evidence" : "Target launch"}</p><div className="journey-stat-value">{stage === "idea" ? evidence : profile.launchDate || "Not set"}</div><p className="journey-muted">{stage === "idea" ? "Outcomes and notes you have recorded" : "Your intended date; change it as you learn"}</p></div>
      <div className="journey-stat"><p className="journey-muted">{stage === "idea" ? "Names in consideration" : "Next review"}</p><div className="journey-stat-value">{stage === "idea" ? doc.state.names.filter(n => n.status !== "ruled-out").length : profile.reviewDate || "Not set"}</div><p className="journey-muted">{stage === "idea" ? "Availability checks are recorded manually" : "Review the launch with actual customer feedback"}</p></div>
    </div>}
    <div className="journey-grid"><div className="journey-stack">
      <section className="journey-card"><div className="journey-card-header"><h2>{stage === "idea" ? "Start with the problem, then the product." : stage === "pre-launch" ? "The first week, thought through." : "One useful focus for this week."}</h2><button onClick={() => edit({ kind: "profile", fields: FIELDS[stage] })}>Edit plan</button></div><dl className="journey-brief">{FIELDS[stage].map(field => <div key={field}><dt>{PROFILE_FIELDS[field]}</dt><dd>{profile[field] || <button className="text-muted-foreground text-left" onClick={() => edit({ kind: "profile", fields: FIELDS[stage] })}>Add {PROFILE_FIELDS[field].toLowerCase()} <span aria-hidden>↗</span></button>}</dd></div>)}</dl></section>
      <section className="journey-card"><div className="journey-card-header"><div><h2>{copy.checklist}</h2><p className="journey-muted mt-1">{types.length ? types.map(businessLabel).join(" + ") : "Common foundations"} · {readiness.done} complete{readiness.skipped ? ` · ${readiness.skipped} skipped with a reason` : ""}</p></div><button onClick={() => edit({ kind: "custom" })} className="flex items-center gap-1"><Plus className="size-3.5" />Add step</button></div>
        {!type && <p className="journey-note">Choose a business type above to add the right steps for your venture.</p>}
        <div className="mt-4 flex gap-2" aria-label="Checklist filter">{[["all", "All steps"], ["open", "To do"], ["required", "Essentials"]].map(([value, label]) => <button key={value} className={`rounded-lg px-3 py-1.5 text-xs ${filter === value ? "bg-accent text-foreground" : "text-muted-foreground"}`} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{label}</button>)}</div>
        {groups.map(group => <div key={group}><h3 className="journey-group">{group}</h3>{shown.filter(t => t.group === group).map(task => {
          const progress = doc.state.tasks[task.key]; return <div className="journey-task" data-done={progress?.status === "done"} key={task.key}>
            <input className="journey-check" type="checkbox" aria-label={`Complete: ${task.title}`} checked={progress?.status === "done"} disabled={busy || request.loading} onChange={e => { void save({ kind: "task", key: task.key, status: e.target.checked ? "done" : "todo", evidence: progress?.evidence ?? "" }); }} />
            <div className="min-w-0 flex-1"><button className="journey-task-title" onClick={() => edit({ kind: "task", task })}>{task.title}</button><p className="journey-task-note">{progress?.evidence ? progress.evidence.slice(0, 140) + (progress.evidence.length > 140 ? "…" : "") : task.detail}</p><div className="mt-2 flex flex-wrap gap-1.5">{task.required && <span className="journey-tag">Essential</span>}{progress?.status === "skipped" && <span className="journey-tag">Does not apply</span>}{progress?.evidence && <span className="journey-tag"><Check className="size-3" />Evidence saved</span>}<button className="text-muted-foreground ml-auto text-[11px]" onClick={() => edit({ kind: "task", task })}>{progress?.evidence ? "Review evidence" : "Add evidence"}</button></div></div>
          </div>;
        })}</div>)}
        {!shown.length && <p className="journey-muted mt-5">No steps in this view. Add your own or choose another filter.</p>}
        {stage === "launched" && <div className="mt-6 border-t pt-4"><Button variant="outline" size="sm" onClick={() => edit({ kind: "review" })} disabled={busy || (!readiness.done && !readiness.skipped)}>Start next review</Button><p className="journey-muted mt-2">Archives this review before reopening the operating checklist.</p></div>}
      </section>
      {children && <details className="journey-card"><summary className="text-sm font-medium">Work, team, chats & saved dashboards</summary><div className="mt-6">{children}</div></details>}
    </div><aside className="journey-stack journey-stack-aside">
      <section className="journey-card"><div className="journey-eyebrow">The next useful move</div><h2 className="leading-snug">{copy.focus}</h2><p className="journey-muted mt-3">{copy.focusText}</p><p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">{stage === "idea" ? profile.experiment || "Write down the riskiest assumption and one small test." : stage === "pre-launch" ? readiness.requiredOpen[0]?.title || "Review the experience end to end, then decide when to launch." : profile.weeklyFocus || "Choose this week's priority in your plan."}</p><Link to={ask(stage === "idea" ? "Design one low-cost validation experiment for my riskiest assumption." : stage === "pre-launch" ? "Review my launch readiness. Prioritize blockers and suggest a small first launch." : "Review my linked business data and suggest one useful action this week.")} className="mt-5 flex items-center gap-2 text-sm"><Sparkles className="size-4" />Think it through with the agent <ArrowUpRight className="ml-auto size-4" /></Link></section>
      {stage === "idea" && <section className="journey-card"><div className="journey-card-header"><h2>A name to build on.</h2><button onClick={() => edit({ kind: "name" })}><Plus className="size-4" aria-label="Add name candidate" /></button></div>{doc.state.names.length ? doc.state.names.map(n => <button className="journey-name block w-full text-left" key={n.id} onClick={() => edit({ kind: "name", candidate: n })}><div className="flex items-center justify-between gap-2"><strong className="font-medium">{n.name}</strong><span className="journey-tag">{n.status}</span></div><div className="journey-muted mt-1">{n.domain || "No domain noted"}</div></button>) : <p className="journey-muted">Keep a shortlist. Compare memorability, domain options and existing brands before committing.</p>}<Link to={ask("Suggest distinctive venture names and candidate domains based on my brief. Do not claim availability without a current check. Present options for me to review; do not register anything.")} className="mt-4 flex items-center gap-2 text-sm"><Sparkles className="size-3.5" />Explore names</Link><p className="journey-muted mt-3 text-xs!">Domain and brand checks need current evidence. Choosing a candidate here records your decision.</p></section>}
      <section className="journey-card"><div className="journey-card-header"><h2>Bring the right help.</h2></div>{(stage === "idea" ? [["researcher", "Research the opportunity", "research"], ["competitors", "Understand the alternatives", "competitors"]] : stage === "pre-launch" ? [["writer", "Prepare the launch story", "chat"], ["seo", "Review discoverability", "seo"]] : [["people", "Understand your customers", "people"], ["chief-of-staff", "Choose the next improvement", "chat"]]).map(([role, title, slug]) => <Link className="journey-action" key={role} to={slug === "chat" || slug === "people" ? ask(`${title}. Use the saved journey and venture-linked evidence.`) : `${appPage(slug!)}?venture=${encodeURIComponent(venture.id)}`}><RoleIcon role={role!} className="size-10" /><strong>{title}</strong><ArrowUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" /></Link>)}<p className="journey-muted mt-4 text-xs!">Review the brief before starting agent work.</p>{stage === "launched" && <Link className="mt-3 block text-sm underline underline-offset-4" to="/activity/journal">Write in your work journal</Link>}</section>
      <section className="journey-card"><h2>Connect what you use.</h2><p className="journey-muted mt-3">{types.length ? [...new Set(types.flatMap(type => TOOL_HINTS[type].split(" · ")))].join(" · ") : "Choose a business type to see relevant tools."}</p><p className="journey-muted mt-3">{types.includes("shop") || types.includes("goods") ? "Sales, stock and order metrics can be imported in Insights. Native POS and inventory connections are not included." : "Link the relevant entities to this venture so its data stays specific."}</p><div className="mt-4 flex flex-wrap gap-3"><Link to={`/ventures/${venture.slug}/connections`} className="text-sm underline underline-offset-4">Venture connections</Link><Link to="/integrations" className="text-sm underline underline-offset-4">All integrations</Link></div></section>
      {next && <section className="journey-card"><h2>{stage === "idea" ? "Ready to start building?" : "Your launch, on your terms."}</h2><p className="journey-muted mt-3">{readiness.requiredOpen.length} essentials still open. Move forward when the evidence supports your decision.</p><Button className="mt-4 w-full" variant="outline" onClick={() => edit({ kind: "stage", target: next })}>Review {STAGE_LABELS[next].toLowerCase()} handoff<ArrowRight className="size-4" /></Button></section>}
      {(doc.history.length > 0 || doc.reviews.length > 0) && <section className="journey-card"><h2>Decisions & reviews</h2>{doc.history.slice(0, 4).map(h => <div className="journey-name" key={h.id}><p className="text-xs">{STAGE_LABELS[h.fromStage]} → {STAGE_LABELS[h.toStage]}</p><p className="journey-muted text-xs!">{new Date(h.at).toLocaleDateString()}{h.note ? ` · ${h.note}` : ""}</p></div>)}{doc.reviews.slice(0, 5).map(r => <button className="journey-name block w-full text-left text-xs" key={`review-${r.id}`} onClick={() => edit({ kind: "history", id: r.id })}>Review · {new Date(r.at).toLocaleDateString()}<span className="journey-muted block text-xs!">{r.done}/{r.total} complete · {businessTypesOf(r).map(businessLabel).join(" + ") || "Common foundations"}</span></button>)}<p className="journey-muted mt-3 text-xs!">Recent activity shown. Export the plan for more stage history.</p></section>}
    </aside></div>
    {editor?.kind === "profile" && <ProfileEditor profile={profile} fields={editor.fields} {...formProps} />}
    {editor?.kind === "task" && <TaskEditor task={editor.task} progress={doc.state.tasks[editor.task.key]} {...formProps} />}
    {editor?.kind === "custom" && <CustomTaskEditor stage={stage} businessType={types.length === 1 ? type : null} {...formProps} />}
    {editor?.kind === "name" && <NameEditor candidate={editor.candidate} {...formProps} />}
    {editor?.kind === "stage" && <StageEditor venture={venture} doc={doc} target={editor.target} change={change} close={close} busy={busy} error={error} />}
    {editor?.kind === "review" && <JourneyModal title="Start the next operating review" description="The current checklist and its evidence will be archived. Its steps will reopen for the next review; other stages and unselected business types stay saved." close={close}><ErrorNotice error={error} /><div className="journey-modal-footer"><Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={busy} onClick={async () => { if (await save({ kind: "start-review", businessType: type, businessTypes: types })) close(); }}>Archive & start next review</Button></div></JourneyModal>}
    {editor?.kind === "history" && <ReviewHistory venture={venture} id={editor.id} close={close} />}
  </div></div>;
}
function ReviewHistory({ venture, id, close }: { venture: Venture; id: number; close: () => void }) {
  const request = useApi(() => journeyApi.review(venture.id, id), [venture.id, id]);
  return <JourneyModal title="Saved operating review" description="The checklist and evidence as they stood when you started the next review." close={close}><ErrorNotice error={request.error} />{request.loading ? <p>Loading review…</p> : request.data?.tasks.map(t => <div className="journey-name" key={t.key}><p>{t.title} · {request.data?.progress[t.key]?.status ?? "todo"}</p><p className="journey-muted whitespace-pre-wrap">{request.data?.progress[t.key]?.evidence || "No evidence recorded"}</p></div>)}{request.data && <Button variant="outline" onClick={() => download(`${venture.slug}-review-${id}.json`, request.data)}>Export review</Button>}</JourneyModal>;
}
