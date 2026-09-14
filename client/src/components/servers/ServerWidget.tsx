import { InspectButton } from "@/components/interactions/InspectButton";
import { AnimatedDetails } from "@/components/interactions/AnimatedDetails";
import { useState, type HTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, Banknote, Check, ChevronDown, Copy, Globe2, Search, Server, Trash2, UnfoldHorizontal, X } from "lucide-react";
import type { Widget } from "@/data/widgets";
import type { PlacedWidget } from "@/lib/store";
import type { ServerCardData, ServerFleetData, ServerMeter, ServerStatus } from "@/lib/serverWidgets";
import { ago } from "@/lib/format";
import { countryFlag, countryName } from "@/lib/serverRegions";
import { widgetSpan, widgetSpanClass } from "@/lib/widgetLayout";
import { cn } from "@/lib/utils";
import { ServerLoadChart } from "./ServerLoadChart";
import "./servers.css";

const statusClass:Record<ServerStatus,string>={healthy:"text-ok",degraded:"text-warn",down:"text-destructive",unknown:"text-muted-foreground"};
const statusDot:Record<ServerStatus,string>={healthy:"bg-ok",degraded:"bg-warn",down:"bg-destructive",unknown:"bg-muted-foreground"};
const statIcons={"servers.cpu":Activity,"servers.worst":AlertTriangle,"servers.containers":Server,"servers.cost":Banknote};
const pct=(value:number|null)=>value===null?"—":`${Math.round(value)}%`;

function Meter({meter}:{meter:ServerMeter}) {
  const {value,warn,critical}=meter;
  const tone=value===null?"var(--muted-foreground)":value>=critical?"var(--destructive)":value>=warn?"var(--warn)":"var(--ok)";
  return <div className="min-w-0" title={meter.detail}>
    <dt className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{meter.label}</dt>
    <dd className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span className="text-[25px] font-semibold leading-tight tracking-tight tabular-nums">{pct(value)}</span>
      {meter.change!==null && <span className="text-[10px] tabular-nums text-muted-foreground" title="Change between first and last available samples, in percentage points">{Math.abs(meter.change)<.5?"flat":`${meter.change>0?"+":"−"}${Math.round(Math.abs(meter.change))} pts`}</span>}
    </dd>
    <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${meter.label}: ${pct(value)} used, watch at ${warn}%, act at ${critical}%`}>
      {value!==null && <span className="absolute inset-y-0 left-0 rounded-full" style={{width:`${Math.max(0,Math.min(100,value))}%`,background:tone}}/>}
      {[warn,critical].map(n=><span key={n} className="absolute inset-y-0 w-px bg-foreground/45" style={{left:`${n}%`}}/>)}
    </div>
    <p className="mt-1.5 truncate text-[10px] text-muted-foreground">{meter.detail}</p>
  </div>;
}

function HostCard({card, inspection = false}:{card:ServerCardData; inspection?: boolean}) {
  const [copied,setCopied]=useState(false);
  const [copyError,setCopyError]=useState(false);
  const flag=countryFlag(card.country);
  const regionLabel=[countryName(card.country),card.location].filter(Boolean).join(" · ") || "Region not reported";
  async function copy() {
    if(!card.address)return;
    try {await navigator.clipboard.writeText(card.address);setCopied(true);setCopyError(false);}
    catch {setCopyError(true);}
  }
  return <article className={cn("group relative server-host-card",card.status==="down"&&"ring-1 ring-destructive/35")} aria-label={card.name}>
    <div className={cn("flex items-start gap-2.5", !inspection && "pr-7")}>
      <span role="img" aria-label={regionLabel} title={regionLabel} data-server-region={card.country ?? "unknown"} className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted text-[22px] leading-none text-muted-foreground">{flag ?? <Globe2 aria-hidden="true" className="size-5" strokeWidth={1.6}/>}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h3 className="min-w-0 flex-1 text-[15px] font-semibold tracking-tight">{card.name}</h3><span className={cn("inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium",statusClass[card.status])}><span className={cn("size-1.5 rounded-full",statusDot[card.status])}/>{card.statusLabel}</span></div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          {card.address && <button type="button" onClick={()=>void copy()} aria-label={`Copy IP address for ${card.name}`} className="inline-flex items-center gap-1 font-mono hover:text-foreground">{card.address}{copied?<Check className="size-3"/>:<Copy className="size-3"/>}</button>}
          {card.hostname && <span className="min-w-0 truncate font-mono">· {card.hostname}</span>}
        </div>
        {copyError && <p role="status" className="mt-1 text-[11px] text-warn">Couldn’t copy. Select the address above.</p>}
        <p className="mt-1 flex flex-wrap gap-x-1.5 text-[11px] text-muted-foreground"><span>up {card.uptime}</span><span>·</span><span>{card.docker?.installed?`${card.docker.running} container${card.docker.running===1?"":"s"}`:card.docker?"Docker not installed":"Docker not measured"}</span><span>·</span><span>{card.cost}</span></p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{[card.location,card.provider,card.specs].filter(Boolean).join(" · ")}</p>
      </div>
    </div>
    {!inspection && <div className="absolute right-3 top-3"><InspectButton title={card.name} description={`Last probe ${ago(card.seenAt)} · ${card.loadSpan}`}><HostCard card={card} inspection/></InspectButton></div>}
    {card.note && <p className={cn("mt-3 rounded-xl bg-muted/60 px-3 py-2 text-[11px] leading-relaxed",statusClass[card.status])}>{card.note}</p>}
    <dl className="mt-4 grid grid-cols-3 gap-x-3 gap-y-3">{card.meters.filter((m,i)=>i<3 || !m.label.startsWith("/boot") || (m.value!==null && m.value>=m.warn)).map(m=><Meter key={m.label} meter={m}/>)}</dl>
    <div className="mt-4 border-t pt-3">
      <div className="mb-1 flex flex-wrap justify-between gap-1 text-[10px] text-muted-foreground"><span className="font-medium">CPU over time</span><span>{card.loadSpan}</span></div>
      <ServerLoadChart points={card.load} label={`${card.name} CPU`}/>
      <p className="mt-2 text-[10px] text-muted-foreground">{card.loadSource} · last probe {ago(card.seenAt)}</p>
    </div>
    <AnimatedDetails open={inspection || undefined} className="server-disclosure mt-3 border-t pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs"><ChevronDown className="size-3.5 text-muted-foreground"/><span>Containers</span><span className="ml-auto text-[11px] text-muted-foreground">{card.docker?.installed?`${card.docker.running} running`:card.docker?"not installed":"not measured"}</span></summary>
      <div className="mt-3 space-y-2.5">{card.containers.map(c=><div key={c.name} className="min-w-0"><div className="flex flex-wrap justify-between gap-1 text-[11px]"><span className="break-all font-medium">{c.name}</span><span className={/unhealthy|restarting/i.test(c.status ?? "")?"text-warn":"text-muted-foreground"}>{c.status ?? "unknown"}</span></div><p className="mt-0.5 break-all text-[10px] text-muted-foreground">{c.image}{c.since?` · ${c.since}`:""}</p></div>)}
        <p className="text-[10px] leading-relaxed text-muted-foreground">{card.docker?.installed?"Running Docker containers only. Stopped containers and host processes are not included.":card.docker?"This box does not have Docker installed. Host processes are not measured here.":"The probe has not reported whether Docker is installed."}</p>
      </div>
    </AnimatedDetails>
    <AnimatedDetails open={inspection || undefined} className="server-disclosure mt-3 border-t pt-3"><summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs"><ChevronDown className="size-3.5 text-muted-foreground"/>System details & counters</summary><dl className="mt-3 space-y-2">{[...card.facts,...card.counters.map(c=>[c.label,c.value===null?c.note ?? "Not measured":String(c.value)])].map(([label,value])=><div key={label} className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px]"><dt className="text-muted-foreground">{label}</dt><dd className="break-all text-right tabular-nums">{value}</dd></div>)}</dl></AnimatedDetails>
  </article>;
}

function FleetCards({fleet}:{fleet:ServerFleetData}) {
  const [filter,setFilter]=useState<ServerStatus|"all">("all");
  const [query,setQuery]=useState("");
  const counts=(status:ServerStatus)=>fleet.cards.filter(c=>c.status===status).length;
  const needle=query.trim().toLowerCase();
  const visible=fleet.cards.filter(c=>(filter==="all"||c.status===filter) && (!needle || [c.name,c.address,c.hostname,c.location,c.country,countryName(c.country),c.provider,...c.containers.map(x=>`${x.name} ${x.image ?? ""}`),...c.counters.map(x=>x.label)].some(s=>s?.toLowerCase().includes(needle))));
  return <>
    <div className="mb-3 flex flex-wrap items-center gap-2.5">
      <div role="group" aria-label="Filter servers by status" className="flex max-w-full flex-wrap rounded-full bg-muted p-1">
        {([["all","All"],["healthy","Healthy"],["degraded","Degraded"],["down","Not reporting"],["unknown","Unknown"]] as const).filter(([s])=>s!=="unknown"||counts("unknown")>0).map(([value,label])=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>setFilter(value)} className={cn("rounded-full px-2.5 py-1.5 text-[11px] transition-colors",filter===value?"bg-card text-foreground shadow-sm":"text-muted-foreground hover:text-foreground")}>{label}</button>)}
      </div>
      <label className="flex min-w-[170px] flex-1 items-center gap-2 rounded-full bg-muted px-3 py-2.5 sm:max-w-[240px]"><Search className="size-3.5 shrink-0 text-muted-foreground"/><input type="search" aria-label="Filter servers" placeholder="Name, region, IP or container…" value={query} onChange={e=>setQuery(e.target.value)} className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"/></label>
      <div className="ml-auto flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground" role="status">{(["healthy","degraded","down","unknown"] as const).filter(s=>counts(s)>0).map(s=><span key={s} className="inline-flex items-center gap-1"><span className={cn("size-1.5 rounded-full",statusDot[s])}/>{counts(s)} {s==="down"?"not reporting":s}</span>)}<span>{visible.length} shown</span></div>
    </div>
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">{[["var(--ok)","fine"],["var(--warn)","watch"],["var(--destructive)","act"]].map(([color,label])=><span key={label} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{background:color}}/>{label}</span>)}<span>Watch / act: CPU {fleet.thresholds.cpu.warn}/{fleet.thresholds.cpu.critical}%, memory {fleet.thresholds.memory.warn}/{fleet.thresholds.memory.critical}%, disk {fleet.thresholds.disk.warn}/{fleet.thresholds.disk.critical}%.</span></div>
    <p className="mb-4 text-[10px] leading-relaxed text-muted-foreground">Meters show the latest probe. Changes are percentage points between available samples; disks have no stored trend. CPU charts show evenly spaced readings; hover for exact times.</p>
    {visible.length ? <div className="server-host-grid">{visible.map(c=><HostCard key={c.id} card={c}/>)}</div> : <div className="rounded-3xl bg-card px-4 py-14 text-center"><p className="text-sm font-medium">No servers match</p><button type="button" onClick={()=>{setQuery("");setFilter("all");}} className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><X className="size-3"/>Clear filters</button></div>}
    <div className="mt-4 flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground"><span>{fleet.cards.length} servers · probed every {fleet.cadenceMinutes} minutes</span><Link to="/ops?tab=snapshots" className="underline underline-offset-4 hover:text-foreground">Open diagnostic snapshots</Link></div>
  </>;
}

export function ServerWidget({def,placed,empty,stale,error,editing,onCycleWidth,onRemove,onMove,onToggleDetail,dragHandlers,dragging,dropSide,portfolioWide}: {
  def:Widget;placed:PlacedWidget;empty:string|null;stale:boolean;error?:string|null;editing:boolean;
  onCycleWidth:()=>void;onRemove:()=>void;onMove?:(direction:-1|1)=>void;
  onToggleDetail?:()=>void;
  portfolioWide?:boolean;
  dragHandlers?:HTMLAttributes<HTMLDivElement>;dragging?:boolean;dropSide?:"before"|"after"|null;
}) {
  const Icon=statIcons[placed.type as keyof typeof statIcons] ?? Server;
  const cards=def.presentation==="server-fleet";
  const controls=editing && <div className="widget-action ml-auto flex shrink-0 gap-0.5">{[[ArrowLeft,()=>onMove?.(-1),"Move earlier"],[ArrowRight,()=>onMove?.(1),"Move later"],[UnfoldHorizontal,onCycleWidth,"Resize"],[Trash2,onRemove,"Remove"]].map(([Glyph,action,label])=>{const G=Glyph as typeof ArrowLeft;return <button type="button" key={String(label)} aria-label={`${label} ${def.name}`} title={`${label} ${def.name}`} onClick={action as ()=>void} onPointerDown={e=>e.stopPropagation()} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><G className="size-3.5"/></button>;})}</div>;
  return <section {...dragHandlers} aria-label={def.name} data-span={widgetSpan(placed,def)} className={cn("group server-widget min-w-0",widgetSpanClass(placed,def),cards?"server-fleet-widget":def.presentation==="server-stat"?"server-summary-card":"server-load-card",editing&&"cursor-grab touch-none select-none",dragging&&"opacity-35",dropSide&&"drag-destination")}>
    {portfolioWide && <p className="mb-2 text-[10px] text-muted-foreground">All servers · portfolio-wide</p>}
    {editing && onToggleDetail && <button type="button" className="mb-2 text-[10px] text-muted-foreground" aria-label={`${placed.detail ? "Show on main dashboard" : "Move to details"}: ${def.name}`} onClick={onToggleDetail}>{placed.detail ? "Show on main dashboard" : "Move to details"}</button>}
    {(!cards||editing) && <div className="mb-2 flex items-center gap-2">{def.presentation==="server-stat"&&<Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.6}/>}<h2 className={cn("min-w-0",def.presentation==="server-stat"?"text-[11px] text-muted-foreground":"text-sm font-semibold")}>{def.name}</h2>{def.presentation==="server-load"&&<span className="ml-auto text-[10px] text-muted-foreground">{def.serverFleet?.span}</span>}{controls}</div>}
    {empty ? <p className="py-5 text-xs text-muted-foreground">{empty}</p> : cards && def.serverFleet ? <FleetCards fleet={def.serverFleet}/> : def.presentation==="server-load" && def.serverFleet ? <>
      <ServerLoadChart points={def.serverFleet.points} label="Fleet mean CPU" height={104}/>
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{def.caption}</p>
      <AnimatedDetails className="server-disclosure mt-3"><summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground"><ChevronDown className="size-3"/>Figures</summary><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-[11px]"><thead><tr>{["Server","CPU now","Memory","Root disk","Mean CPU","Peak"].map(h=><th key={h} className="border-b py-2 pr-3 font-medium text-muted-foreground">{h}</th>)}</tr></thead><tbody>{def.serverFleet.cards.map(c=><tr key={c.id} className="border-b last:border-0"><td className="py-2.5 pr-3">{c.name}</td>{[c.meters[0]?.value ?? null,c.meters[1]?.value ?? null,c.meters[2]?.value ?? null,c.load.length?c.load.reduce((n,p)=>n+p.value,0)/c.load.length:null,c.load.length?Math.max(...c.load.map(p=>p.value)):null].map((v,i)=><td key={i} className="py-2.5 pr-3 tabular-nums text-muted-foreground">{pct(v)}</td>)}</tr>)}</tbody></table></div></AnimatedDetails>
    </> : <><p className="mt-3 break-words text-[29px] font-semibold leading-none tracking-tight tabular-nums">{def.value ?? "—"}</p><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{def.sub}</p><AnimatedDetails className="server-disclosure mt-auto pt-2"><summary className="cursor-pointer text-[10px] text-muted-foreground">Details</summary><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{def.caption}</p>{def.rows?.map(([k,v])=><div key={k} className="mt-2 flex flex-wrap justify-between gap-1 text-[10px]"><span className="text-muted-foreground">{k}</span><span>{v}</span></div>)}</AnimatedDetails></>}
    {stale && <p role="status" title={error ?? undefined} className="mt-2 text-[11px] text-warn">Refresh failed · showing the last reading</p>}
  </section>;
}
