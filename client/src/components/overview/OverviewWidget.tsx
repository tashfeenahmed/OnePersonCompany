import { InspectButton } from "@/components/interactions/InspectButton";
import { useDetailDrawer } from "@/components/interactions/DetailDrawer";
import { InboxItems } from "@/components/interactions/InboxItems";
import { useLive } from "@/lib/live";
import { useStore } from "@/lib/store";
import type { InboxItem } from "@/lib/api/inbox";
import { Link } from "react-router-dom";
import { windowWords } from "@/lib/window";
import { AnimatedDetails } from "@/components/interactions/AnimatedDetails";
import { PacePanel, DormantPanel, InfrastructurePanel } from "@/components/insights/InsightPanels";
import { Activity, BarChart3, Globe2, ChevronDown, ArrowLeft, ArrowRight, UnfoldHorizontal, Trash2 } from "lucide-react";
import { useState, type HTMLAttributes } from "react";
import type { Widget } from "@/data/widgets";
import type { PlacedWidget } from "@/lib/store";
import { widgetSpanClass } from "@/lib/widgetLayout";
import { cn } from "@/lib/utils";
import { AreaChart } from "./charts/AreaChart";
import { Donut } from "./charts/Donut";
import { Dumbbell } from "./charts/Dumbbell";
import { Meters } from "./charts/Meters";
import { ProportionBar } from "./charts/ProportionBar";
import { RankedBars } from "./charts/RankedBars";
import { Sparkline } from "./charts/Sparkline";
import { Waterfall, type WaterfallBar } from "./charts/Waterfall";
import "./overview.css";

const colors = ["var(--chart-line-1)", "var(--chart-line-2)", "var(--chart-line-3)", "var(--chart-line-4)", "var(--chart-3)"];
// Stable identity colors, independent of a source's revenue/traffic rank.
function color(label: string) {
  const known: Record<string, number> = { Stripe:0, "Google Play":1, "App Store":2, AdSense:3, Servers:0, Domains:1, Services:2, Other:3, Electricity:4 };
  const index = known[label] ?? Array.from(label).reduce((n,c)=>(n*31+c.charCodeAt(0)) >>> 0,0)%colors.length;
  return colors[index]!;
}
const shortMoney = (s: string) => s.replaceAll("US$", "$");
const compact = (n: number) => Intl.NumberFormat("en", {notation:"compact",maximumFractionDigits:1}).format(n);
function formatNumber(def: Widget) {
  const unit = def.currency ?? (def.unit === "usd" ? "USD" : "count");
  if (/^[a-z]{3}$/i.test(unit)) {
    try { const f = new Intl.NumberFormat("en",{style:"currency",currency:unit.toUpperCase(),maximumFractionDigits:0}); return (n:number)=>f.format(n); } catch { /* A non-currency unit uses plain numbers. */ }
  }
  return compact;
}
function Details({def}:{def:Widget}) {
  if (!def.caption && !def.rows?.length) return null;
  return <AnimatedDetails className="brief-details mt-auto border-t pt-2">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground"><ChevronDown className="size-3"/>About these figures</summary>
    {def.caption && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{def.caption}</p>}
    {def.rows?.map(([k,v],i)=><div key={`${k}-${i}`} className="mt-2 flex flex-wrap justify-between gap-2 text-xs"><span className="text-muted-foreground">{k}</span><span>{v}</span></div>)}
  </AnimatedDetails>;
}
function Table({def}:{def:Widget}) {
  return <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-xs"><thead><tr>{def.headers?.map(h=><th key={h} className="border-b px-2 py-2 font-medium text-muted-foreground">{h}</th>)}</tr></thead>
    <tbody>{def.table?.map((row,i)=><tr key={i} className="border-b last:border-0 hover:bg-accent/30">{row.map((v,j)=><td key={j} className={cn("px-2 py-3 align-top",j>0 && "tabular-nums text-muted-foreground")}>
      {j===0 && def.rowTones?.[i] && <span className={cn("mr-2 inline-block size-1.5 rounded-full",def.rowTones[i]==="bad"?"bg-destructive":"bg-ok")} />}{v}</td>)}</tr>)}</tbody></table>
    {!def.table?.length && <p className="py-4 text-xs text-muted-foreground">{def.caption ?? "No rows reported."}</p>}
  </div>;
}
function WebsiteImage({src, title}: {src?: string | null; title: string}) {
  const [failed, setFailed] = useState(false);
  return <div className="aspect-[16/10] overflow-hidden bg-muted">
    {src && !failed ? <img src={src} alt={`${title} website`} loading="lazy" className="h-full w-full object-cover object-top" onError={()=>setFailed(true)}/> :
      <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground"><Globe2 className="size-4 shrink-0"/>{failed ? "Preview unavailable · capture will retry" : "No capture yet"}</div>}
  </div>;
}
function Body({def, items}:{def:Widget; items?: InboxItem[]}) {
  const open = useDetailDrawer();
  const { state } = useStore();
  if (def.live?.inbox && items) return <InboxItems items={items}/>;
  if (def.figures) return <dl className="space-y-4">{def.figures.map(f=><div key={f.label}><dt className="text-xs text-muted-foreground">{f.label}</dt><dd className="mt-1 text-xl font-semibold">{f.value}</dd><p className="mt-1 text-xs text-muted-foreground">{f.sub}</p></div>)}</dl>;
  if (def.presentation === "insight") return <p className="text-sm leading-relaxed">{def.sub}</p>;
  if (def.insightData && def.insightView === "pace") return <PacePanel pace={def.insightData.pace} />;
  if (def.insightData && def.insightView === "dormant") return <DormantPanel ventures={def.insightData.dormancy} costs={def.insightData.dormantCosts} complete={def.insightData.dormantCostsComplete} />;
  if (def.insightData && def.insightView === "infrastructure") return <InfrastructurePanel events={def.insightData.infrastructure} />;
  const format=formatNumber(def);
  if (def.presentation==="arr" || def.presentation==="summary" || def.kind==="proportion") {
    const parts=def.parts ?? [];
    return <>
      <div className={cn("brief-number mt-2 font-semibold leading-none tracking-[-0.04em] tabular-nums",def.presentation==="arr" && "brief-arr-value")}>
        {shortMoney(def.value ?? "—")}{def.presentation==="arr" && <span className="ml-1 text-xl font-normal tracking-normal text-muted-foreground">/yr</span>}
      </div>
      {def.sub && <p className="mt-2 text-xs leading-[1.4] text-muted-foreground">{shortMoney(def.sub)}</p>}
      {parts.length>0 && <div className="mt-3">
        <ProportionBar label={def.partsLabel ?? def.name} height={8} minLabelPct={101} parts={parts.map(p=>({key:p.label,label:p.label,value:p.value,color:p.tone==="ok"?"var(--ok)":color(p.label)}))}/>
        <div className="mt-2 space-y-1.5">{(def.presentation==="arr" ? def.rows ?? parts.map(p=>[p.label,p.text ?? compact(p.value)] as [string,string]) : parts.slice(0,2).map(p=>[p.label,p.text ?? compact(p.value)] as [string,string])).map(([label,value])=><div key={label} className="flex items-start gap-1.5 text-[11.5px] leading-[1.45]">
          <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{background:parts.find(p=>p.label===label)?.tone==="ok"?"var(--ok)":color(label)}}/>
          <span className="min-w-0 flex-1 text-muted-foreground">{label}</span><span className="max-w-[65%] text-right tabular-nums">{shortMoney(value)}</span>
        </div>)}</div>
      </div>}
    </>;
  }
  if (def.kind==="chart") return <>
    {def.sub && <p className="mb-4 text-xs text-muted-foreground">{shortMoney(def.sub)}</p>}
    <AreaChart label={def.name} data={(def.chart?.[0]?.points ?? []).map(p=>({date:p.ts.slice(0,10),value:p.value}))} height={250} format={format} axisFormat={format} color="var(--chart-line-1)" mean/>
    <AnimatedDetails className="brief-details mt-1"><summary className="text-[11px] text-muted-foreground cursor-pointer">Show daily figures</summary><Table def={{...def,headers:["Date",def.chart?.[0]?.label ?? "Amount"],table:def.chart?.[0]?.points.map(p=>[p.ts.slice(0,10),format(p.value)])}}/></AnimatedDetails>
  </>;
  if (def.kind==="waterfall") {
    const {bars}=(def.steps ?? []).reduce<{running:number;bars:WaterfallBar[]}>((state,p,i)=>{
      const from=p.total?0:state.running;
      const to=p.total?p.value:state.running+p.value;
      return {running:to,bars:[...state.bars,{key:String(i),label:p.label,sub:p.sub,from,to,value:p.value,
        color:p.total?"var(--chart-line-1)":p.value<0?"var(--destructive)":"var(--ok)",connect:!p.total}]};
    },{running:0,bars:[]});
    return <Waterfall bars={bars} label={def.name} height={236} format={format} axisFormat={format}/>;
  }
  if (def.kind==="donut") return <div className="grid items-center gap-4 sm:grid-cols-[minmax(150px,0.9fr)_1.1fr]">
    <Donut slices={(def.slices ?? []).map((s,i)=>({...s,key:String(i),color:color(s.label)}))} label={def.name} height={225} centerFormat={()=>def.center?.value ?? "—"} centerNote={def.center?.note ?? "per month"} format={n=>def.slices?.find(s=>s.value===n)?.text ?? compact(n)}/>
    <div className="space-y-3">{def.slices?.map((s,i)=><div key={i} className="flex items-start gap-2"><span className="mt-1 size-2.5 shrink-0 rounded-full" style={{background:color(s.label)}}/><div className="min-w-0 flex-1"><div className="flex justify-between gap-2 text-xs"><span>{s.label}</span><span className="font-medium tabular-nums">{s.text}</span></div><p className="mt-0.5 text-[11px] text-muted-foreground">{s.sub}</p></div></div>)}</div>
  </div>;
  if (def.kind==="dumbbell") return <Dumbbell label={def.name} rows={(def.dumbbell ?? []).map((r,i)=>({...r,key:String(i)}))} names={def.names ?? ["Visitors","Pageviews"]} log={def.log} colorA="var(--chart-line-1)" colorB="var(--chart-line-2)"/>;
  if (def.kind==="meters") return <Meters hosts={(def.hosts ?? []).map((h,i)=>({key:String(i),name:h.name,metrics:h.metrics}))} thresholds={def.thresholds} colors={{ok:"var(--ok)",warn:"var(--warn)",crit:"var(--destructive)"}}/>;
  if (def.kind==="ranked") return def.ranked?.length ? <RankedBars label={def.name} bars={def.ranked.map((r,i)=>({...r,key:String(i),color:color(r.label)}))} format={n=>def.ranked?.find(r=>r.value===n)?.text ?? compact(n)}/> : def.rows?.length ? <Table def={{...def,headers:["App · currency","Payout"],table:def.rows}}/> : <p className="py-8 text-center text-xs text-muted-foreground">No payouts reported yet.</p>;
  if (def.kind==="table") return <Table def={def}/>;
  if (def.kind==="feed") return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{def.feed?.map((item,i)=><button key={i} type="button" aria-label={`Inspect ${item.title}`} onClick={() => {
    const venture = state.ventures.find(v => v.name === item.title || (v.website && v.website === item.href));
    open({ title: item.title, description: item.at ? `Website capture · ${item.at}` : "Venture details", content: <div className="space-y-5">
      <div className="overflow-hidden rounded-xl"><WebsiteImage src={item.image} title={item.title}/></div>
      <p className="break-words text-sm text-muted-foreground">{item.text}</p>
      <dl className="grid grid-cols-2 gap-4">{item.meta?.map(([k,v])=><div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-1 font-medium tabular-nums">{v}</dd></div>)}</dl>
      <div className="flex flex-wrap gap-4 text-sm">{venture && <Link className="underline underline-offset-4" to={`/ventures/${venture.slug}`}>Open venture</Link>}{item.href && <a className="underline underline-offset-4" href={item.href} target="_blank" rel="noreferrer">Visit website ↗</a>}</div>
    </div> });
  }} className="overflow-hidden rounded-xl border text-left transition hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-primary">
    <WebsiteImage key={item.image} src={item.image} title={item.title}/>
    <div className="p-3"><div className="flex justify-between gap-2 text-sm font-medium"><span>{item.title}</span><span className="text-[10px] font-normal text-muted-foreground">{item.at}</span></div><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.text}</p><div className="mt-2 flex flex-wrap gap-3 text-xs">{item.meta?.map(([k,v])=><span key={k}><b className="font-medium">{v}</b> <span className="text-muted-foreground">{k}</span></span>)}</div></div>
  </button>)}</div>;
  return null;
}
export function OverviewWidget({def,title,placed,empty,stale,error,editing,onCycleWidth,onRemove,onMove,onToggleDetail,dragHandlers,dragging,dropSide}: {
  def:Widget; title:string; placed:PlacedWidget; empty:string|null; stale:boolean; error?:string|null; editing:boolean;
  onCycleWidth:()=>void; onRemove:()=>void; onMove?:(direction:-1|1)=>void;
  onToggleDetail?:()=>void;
  dragHandlers?:HTMLAttributes<HTMLDivElement>; dragging?:boolean; dropSide?:"before"|"after"|null;
}) {
  const live = useLive();
  const insight=def.presentation==="insight";
  const figures=def.presentation==="figures";
  const Icon=placed.type==="brief.paceInsight"?BarChart3:placed.type==="brief.trafficInsight"?Globe2:Activity;
  const controls=editing ? <div className="widget-action ml-auto flex shrink-0 gap-0.5">
    {onToggleDetail && <button type="button" className="p-1 text-muted-foreground" title={placed.detail ? "Show on main dashboard" : "Move to details"} aria-label={`${placed.detail ? "Show on main dashboard" : "Move to details"}: ${title}`} onClick={onToggleDetail}><ChevronDown className={cn("size-3.5",placed.detail && "rotate-180")}/></button>}
    {[[ArrowLeft,()=>onMove?.(-1),`Move ${title} earlier`],[ArrowRight,()=>onMove?.(1),`Move ${title} later`],[UnfoldHorizontal,onCycleWidth,`Resize ${title}`],[Trash2,onRemove,`Remove ${title}`]].map(([Glyph,action,label])=>{
      const G=Glyph as typeof ArrowLeft;return <button key={String(label)} type="button" aria-label={String(label)} title={String(label)} onClick={action as ()=>void} onPointerDown={e=>e.stopPropagation()} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><G className="size-3.5"/></button>;
    })}
  </div> : <InspectButton title={title} description={`${windowWords(live.window)} · reading at time of opening`}><div className="space-y-5">{empty ? <p className="text-sm text-muted-foreground">{empty}</p> : <Body def={def} items={live.inbox?.items}/>}<p className="text-xs leading-relaxed text-muted-foreground">{def.caption}</p>{def.rows && <Table def={{...def,headers:["Measure","Value"],table:def.rows}}/>}</div></InspectButton>;
  return <article {...dragHandlers} className={cn("group workdash-widget min-w-0",widgetSpanClass(placed,def),insight?"brief-insight":figures?"brief-figures":"brief-card",def.presentation==="arr"&&"brief-arr",editing&&"cursor-grab touch-none select-none",dragging&&"opacity-35",dropSide&&"drag-destination")}>
    {figures ? <><div className="flex justify-end">{controls}</div><AnimatedDetails className="brief-details"><summary className="flex cursor-pointer list-none items-center gap-2 py-1 font-mono text-[11px] text-muted-foreground"><ChevronDown className="size-3.5"/>{def.figures?.length ?? 9} more numbers · audience, search, rates</summary><div className="mt-3 grid gap-3 sm:grid-cols-3">{empty ? <p className="text-xs text-muted-foreground">{empty}</p>:def.figures?.map(f=><div key={f.label} className="rounded-2xl bg-card p-4"><p className="text-xs text-muted-foreground">{f.label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{f.value}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.sub}</p></div>)}</div></AnimatedDetails></> : insight ? <><div className="flex items-start gap-3"><div className="brief-insight-icon"><Icon className="size-4" strokeWidth={1.7}/></div><div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-snug">{empty ? title : shortMoney(def.value ?? "—")}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{shortMoney(empty ?? def.sub ?? "")}</p></div></div>{controls}</> : <>
      <div className="mb-1 flex items-center gap-2"><h2 className={cn("min-w-0 flex-1",def.presentation==="summary"||def.presentation==="arr"?"text-xs font-medium text-muted-foreground":"text-sm font-semibold tracking-tight")}>{title}</h2>
        {def.series && def.series.length>1 && <Sparkline label={`${title} trend`} data={def.series.map(value=>({value}))} color="var(--chart-line-1)" width={62} height={20}/>}
        {def.kind==="chart" && def.value && <span className="text-xs font-medium tabular-nums">{def.value}</span>}{controls}
      </div>
      {empty ? <p className="py-6 text-xs leading-relaxed text-muted-foreground">{empty}</p> : <><div className="mt-2"><Body def={def} items={live.inbox?.items}/></div><Details def={def}/></>}
    </>}
    {stale && !empty && <p role="status" title={error ?? undefined} className="mt-2 text-[11px] text-warn">Refresh failed · showing the last reading</p>}
  </article>;
}
