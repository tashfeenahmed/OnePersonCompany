import { SelectField, SelectOption } from "@/components/ui/select-field";
import { useState, type PointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, Copy, Database, GripVertical, LayoutList, Mail, Plus, Save, Settings2, ShieldCheck, Sparkles, Trash2, Workflow } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import { randomId } from "@/lib/id";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RoleIcon } from "@/components/org/RoleIcon";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BLOCK_KINDS, BLOCK_LABELS, BLOCK_DESCRIPTIONS, newBlock, type WorkflowBlock, type WorkflowDefinition, type WorkflowDocument } from "../../../../shared/workflow";
import { BUSINESS_TYPES } from "../../../../shared/ventureJourney";

type EditorDoc = WorkflowDocument & { roles: { id: string; title: string }[]; ventures: { id: string; name: string }[] };
const control = "border-line-soft bg-background w-full rounded-xl border px-3 py-2 text-sm";
const icons = { collect: Database, alerts: ShieldCheck, agent: Bot, triage: Mail, synthesis: Sparkles, board: LayoutList, "seo-ops": Sparkles, relationships: Mail, memory: Database, briefing: Mail };

export function WorkflowEditor({ onSaved, currentStage }: { onSaved: () => void; currentStage?: string | null }) {
  const doc = useApi(() => call<EditorDoc>("/pipeline/workflow"), []);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  if (!doc.data) return <p className="text-sm text-muted-foreground">{doc.error || "Loading workflow…"}</p>;
  const data = doc.data, definition = draft ?? data.definition;
  const changed = !data.saved || JSON.stringify(definition) !== JSON.stringify(data.definition);
  const edit = (next: WorkflowDefinition) => { setDraft(next); setMessage(null); setError(null); };
  const patch = (id: string, fields: Partial<WorkflowBlock>) => edit({ ...definition, blocks:definition.blocks.map(b => b.id === id ? { ...b,...fields } : b) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= definition.blocks.length || from === to) return;
    const blocks = [...definition.blocks]; const [b] = blocks.splice(from,1); blocks.splice(to,0,b!);
    const order = new Map(blocks.map((b,i) => [b.id,i]));
    if (blocks.some((b,i) => b.dependsOn.some(d => (order.get(d) ?? Infinity) >= i))) { setError("Move this block's dependencies first, or edit its ‘After’ settings."); return; }
    edit({ ...definition,blocks }); setMessage(`${b!.title} moved to position ${to + 1}.`);
  };
  const dragMove = (e: PointerEvent) => {
    if (!drag) return;
    const target = document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>("[data-workflow-id]")?.dataset.workflowId ?? null;
    if (target !== drag.over) setDrag({ ...drag,over:target });
    let scroller = e.currentTarget.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const bottom = scroller?.getBoundingClientRect().bottom ?? window.innerHeight;
    const delta = e.clientY > bottom - 90 ? 20 : e.clientY < top + 90 ? -20 : 0;
    if (delta) (scroller ?? window).scrollBy(0, delta);
  };
  const finishDrag = (e: PointerEvent) => {
    if (!drag) return;
    const target = document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>("[data-workflow-id]")?.dataset.workflowId;
    if (target) move(definition.blocks.findIndex(b => b.id === drag.id),definition.blocks.findIndex(b => b.id === target));
    setDrag(null);
  };
  const selected = definition.blocks.find(b => b.id === editing);
  return <section className="space-y-4" aria-label="Workflow builder">
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1 basis-full sm:basis-auto"><div className="mb-1 flex items-center gap-2"><Workflow className="size-4 text-muted-foreground" /><span className="text-xs uppercase tracking-wider text-muted-foreground">Your workflow</span></div>
        <Input aria-label="Workflow name" value={definition.name} onChange={e => edit({ ...definition,name:e.target.value })} className="h-auto border-0 bg-transparent p-0 text-xl font-medium shadow-none" /></div>
      <Button variant="outline" onClick={() => setAdding(true)}><Plus className="size-4" />Add block</Button>
      <Button disabled={!changed || saving} onClick={async () => {
        setSaving(true); setError(null);
        try {
          const saved = await call<WorkflowDocument>("/pipeline/workflow",{ method:"PUT",body:JSON.stringify({ revision:data.revision,definition }) });
          doc.setData({ ...data,...saved });
          setDraft(current => current === draft ? null : current);
          setMessage("Saved the submitted version. Any newer edits still need saving."); onSaved();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setSaving(false); }
      }}>{changed ? <Save className="size-4" /> : <Check className="size-4" />}{saving ? "Saving…" : changed ? "Save workflow" : "Saved"}</Button>
    </div>
    <p className="text-sm text-muted-foreground">{definition.blocks.filter(b => b.enabled).length} active blocks · Runs from top to bottom. Specialists finish before findings are assembled.</p>
    {(error || doc.error) && <div role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error || doc.error}<Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(null); doc.reload(); }}>Reload saved workflow</Button></div>}
    <p role="status" className="text-xs text-muted-foreground">{message || (changed ? "Unsaved changes" : `Revision ${data.revision}`)}</p>
    <div className="relative space-y-3 before:absolute before:bottom-8 before:left-7 before:top-8 before:w-px before:bg-border">
      {definition.blocks.map((b,i) => {
        const Icon = icons[b.kind], active = currentStage === b.id;
        return <div key={b.id} data-workflow-id={b.id} className={`relative flex items-center gap-3 rounded-2xl border bg-card p-3 transition-colors sm:p-4 ${drag?.over === b.id || active ? "border-blue-400" : "border-line-soft"} ${!b.enabled || drag?.id === b.id ? "opacity-50" : ""}`}>
          <button aria-label={`Move ${b.title}`} title="Drag to move; Alt + Up or Down also moves this block" className="touch-none cursor-grab rounded-lg p-1 text-muted-foreground active:cursor-grabbing focus-visible:outline-2" onPointerDown={e => { if(e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag({ id:b.id,over:b.id }); }} onPointerMove={dragMove} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={e => { if (e.altKey && ["ArrowUp","ArrowDown"].includes(e.key)) { e.preventDefault(); move(i,i + (e.key === "ArrowUp" ? -1 : 1)); } }}><GripVertical className="size-4" /></button>
          <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${b.kind === "agent" ? "bg-blue-500/10 text-blue-400" : "bg-muted text-muted-foreground"}`}>{b.agent ? <RoleIcon role={b.agent.role} className="size-9" /> : <Icon className="size-5" />}</span>
          <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(b.id)} aria-label={`Edit ${b.title}`}>
            <span className="mb-1 block text-sm font-medium">{b.title}{active && <span className="ml-2 text-xs text-blue-400">Running…</span>}</span>
            <span className="block text-xs leading-relaxed text-muted-foreground">{b.kind === "agent" ? `${b.agent!.limit} ventures · ${b.agent!.daysBetween}d between reviews · ${data.roles.find(r => r.id === b.agent!.role)?.title ?? b.agent!.role}` : BLOCK_DESCRIPTIONS[b.kind]}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">{i + 1 < 10 ? `0${i+1}` : i+1} · {b.cadence} · Up to {b.maxMinutes} min</span>
          </button>
          <Switch aria-label={`Enable ${b.title}`} checked={b.enabled} onCheckedChange={enabled => patch(b.id,{ enabled })} />
          <button className="hidden rounded-lg p-2 text-muted-foreground hover:bg-muted sm:block" aria-label={`Configure ${b.title}`} onClick={() => setEditing(b.id)}><Settings2 className="size-4" /></button>
        </div>;
      })}
    </div>
    <Button variant="ghost" className="w-full" onClick={() => setAdding(true)}><Plus className="size-4" />Add another block</Button>
    <Dialog open={adding} onOpenChange={setAdding}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>Add a block</DialogTitle><DialogDescription>Choose the work this step should do.</DialogDescription></DialogHeader>
      <div className="grid gap-2 sm:grid-cols-2">{BLOCK_KINDS.map(kind => { const Icon = icons[kind]; return <button key={kind} className="rounded-xl border border-line-soft p-4 text-left hover:bg-muted" onClick={() => {
        const b = newBlock(kind,`wf-${randomId()}`), blocks = [...definition.blocks];
        let at = kind === "briefing" ? blocks.length : blocks.findIndex(v => v.kind === "briefing");
        if (kind === "agent") { const findings = blocks.findIndex(v => v.kind === "synthesis"); if(findings >= 0) at = findings; }
        blocks.splice(at < 0 ? blocks.length : at,0,b); edit({ ...definition,blocks }); setAdding(false); setEditing(b.id);
      }}><Icon className="mb-2 size-5 text-muted-foreground" /><span className="block text-sm font-medium">{BLOCK_LABELS[kind]}</span><span className="mt-1 block text-xs text-muted-foreground">{BLOCK_DESCRIPTIONS[kind]}</span></button>; })}</div>
    </DialogContent></Dialog>
    <Dialog open={!!selected} onOpenChange={value => { if(!value) setEditing(null); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>Edit block</DialogTitle><DialogDescription>{selected ? BLOCK_DESCRIPTIONS[selected.kind] : ""}</DialogDescription></DialogHeader>
      {selected && <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Field label="Block name"><Input value={selected.title} onChange={e => patch(selected.id,{ title:e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Run cadence"><SelectField aria-label="Run cadence" className={control} value={selected.cadence} onValueChange={(value) => patch(selected.id,{ cadence:value as WorkflowBlock["cadence"] })}>{["daily","weekly","monthly"].map(c => <SelectOption key={c} value={c}>{c}</SelectOption>)}</SelectField></Field><Field label="Time limit (minutes)"><Input type="number" min={1} max={240} value={selected.maxMinutes} onChange={e => patch(selected.id,{ maxMinutes:Number(e.target.value) })} /></Field></div>
        {selected.agent && <>
          <Field label="Sub-agent role"><SelectField aria-label="Sub-agent role" className={control} value={selected.agent.role} onValueChange={(value) => patch(selected.id,{ agent:{ ...selected.agent!,role:value } })}>{data.roles.map(r => <SelectOption value={r.id} key={r.id}>{r.title}</SelectOption>)}</SelectField></Field>
          <Field label="Instructions"><Textarea rows={4} value={selected.agent.instructions} onChange={e => patch(selected.id,{ agent:{ ...selected.agent!,instructions:e.target.value } })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Ventures per run"><Input type="number" min={1} max={20} value={selected.agent.limit} onChange={e => patch(selected.id,{ agent:{ ...selected.agent!,limit:Number(e.target.value) } })} /></Field><Field label="Days between reviews"><Input type="number" min={0} max={365} value={selected.agent.daysBetween} onChange={e => patch(selected.id,{ agent:{ ...selected.agent!,daysBetween:Number(e.target.value) } })} /></Field></div>
          <Choices label="Venture stages" options={[{ id:"idea",name:"Idea" },{ id:"pre-launch",name:"Pre-launch" },{ id:"launched",name:"Launched" }]} selected={selected.agent.stages} onChange={stages => patch(selected.id,{ agent:{ ...selected.agent!,stages } })} />
          <Choices label="Business types · empty means all" options={BUSINESS_TYPES.map(t => ({ id:t.id,name:t.label }))} selected={selected.agent.businessTypes} onChange={businessTypes => patch(selected.id,{ agent:{ ...selected.agent!,businessTypes } })} />
          <details className="rounded-xl border border-line-soft p-3"><summary className="cursor-pointer text-sm">Ventures · {selected.agent.ventureIds.length ? `${selected.agent.ventureIds.length} selected` : "All matching ventures"}</summary><div className="mt-3"><Choices label="Select ventures, or leave empty for automatic matching" options={data.ventures} selected={selected.agent.ventureIds} onChange={ventureIds => patch(selected.id,{ agent:{ ...selected.agent!,ventureIds } })} /></div></details>
        </>}
        <details className="rounded-xl border border-line-soft p-3"><summary className="flex cursor-pointer items-center gap-2 text-sm"><ChevronDown className="size-4" />Dependencies and failure handling</summary><div className="mt-3 space-y-3"><Choices label="After these blocks" options={definition.blocks.slice(0,definition.blocks.findIndex(b => b.id === selected.id)).map(b => ({ id:b.id,name:b.title }))} selected={selected.dependsOn} onChange={dependsOn => patch(selected.id,{ dependsOn })} /><label className="flex items-center justify-between gap-3 text-sm">Require dependencies to succeed<Switch checked={selected.requireSuccess} onCheckedChange={requireSuccess => patch(selected.id,{ requireSuccess })} /></label></div></details>
        <div className="flex flex-wrap gap-2 border-t border-line-soft pt-4">
          <Button variant="outline" size="sm" aria-label="Move block up" onClick={() => { const i=definition.blocks.findIndex(b => b.id===selected.id); move(i,i-1); }}><ArrowUp className="size-4" /></Button>
          <Button variant="outline" size="sm" aria-label="Move block down" onClick={() => { const i=definition.blocks.findIndex(b => b.id===selected.id); move(i,i+1); }}><ArrowDown className="size-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => { const b={ ...structuredClone(selected),id:`wf-${randomId()}`,title:`${selected.title} copy` }; const blocks=[...definition.blocks]; blocks.splice(blocks.findIndex(v => v.id===selected.id)+1,0,b); edit({ ...definition,blocks }); setEditing(b.id); }}><Copy className="size-4" />Duplicate</Button>
          <Button variant="ghost" size="sm" onClick={() => { edit({ ...definition,blocks:definition.blocks.filter(b => b.id!==selected.id).map(b => ({ ...b,dependsOn:b.dependsOn.filter(d => d!==selected.id) })) }); setEditing(null); }}><Trash2 className="size-4" />Remove</Button>
          <Button size="sm" className="ml-auto" onClick={() => setEditing(null)}>Done</Button>
        </div>
      </div>}
    </DialogContent></Dialog>
  </section>;
}
function Field({ label,children }: { label:string;children:ReactNode }) { return <label className="block space-y-1.5 text-sm"><span className="text-muted-foreground">{label}</span>{children}</label>; }
function Choices({ label,options,selected,onChange }: { label:string;options:{id:string;name:string}[];selected:string[];onChange:(next:string[])=>void }) {
  return <fieldset><legend className="mb-2 text-xs text-muted-foreground">{label}</legend><div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto">{options.map(o => <button type="button" key={o.id} aria-pressed={selected.includes(o.id)} onClick={() => onChange(selected.includes(o.id) ? selected.filter(v => v!==o.id) : [...selected,o.id])} className={`rounded-lg border px-2.5 py-1.5 text-xs ${selected.includes(o.id) ? "border-foreground/30 bg-accent" : "border-line-soft text-muted-foreground"}`}>{o.name}</button>)}</div></fieldset>;
}
