import { useId, useState } from "react";
import type { ServerPoint } from "@/lib/serverWidgets";
import { useMeasuredWidth } from "@/components/overview/charts/useMeasuredWidth";

const stamp = (ts:string) => new Date(ts).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
const pct = (n:number) => `${Math.round(n*10)/10}%`;

/** Time-proportional CPU trend; dashed connectors distinguish unsampled intervals. */
export function ServerLoadChart({points,label,height=100,cadenceMinutes=30}: {
  points:ServerPoint[];label:string;height?:number;cadenceMinutes?:number;
}) {
  const id=useId().replaceAll(":","");
  const [ref,width]=useMeasuredWidth<HTMLDivElement>();
  const [active,setActive]=useState<number|null>(null);
  const first=points[0], last=points.at(-1);
  if (!first || !last || points.length<2) return <div ref={ref}><p className="py-6 text-xs text-muted-foreground">Not enough CPU history yet.</p></div>;
  const from=Date.parse(first.ts), to=Date.parse(last.ts);
  const max=Math.max(4,...points.map(p=>p.value));
  const peak=points.reduce((best,p,i)=>p.value>points[best]!.value?i:best,0);
  const x=(p:ServerPoint)=>3+(Date.parse(p.ts)-from)/Math.max(1,to-from)*Math.max(1,width-6);
  const y=(v:number)=>18+(height-36)*(1-v/(max*1.15));
  const baseline=height-18;
  const segments:ServerPoint[][]=[];
  for(const p of points) {
    const previous=segments.at(-1)?.at(-1);
    if (!previous || (cadenceMinutes>0 && Date.parse(p.ts)-Date.parse(previous.ts)>cadenceMinutes*150_000)) segments.push([p]);
    else segments.at(-1)!.push(p);
  }
  const path=(values:ServerPoint[])=>values.map((p,i)=>`${i?"L":"M"}${x(p).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const gaps=segments.slice(1).map((segment,i)=>[segments[i]!.at(-1)!,segment[0]!]);
  const selected=active===null?null:points[Math.min(active,points.length-1)];
  return <div ref={ref} className="relative min-w-0" data-server-chart>
    {width>0 && <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0}
      aria-label={`${label}: ${pct(last.value)} latest, ${pct(points[peak]!.value)} peak. ${points.length} readings from ${stamp(first.ts)} to ${stamp(last.ts)}.${gaps.length?" Dashed lines connect readings across periods without samples.":""} Use left and right arrows for values.`}
      className="block w-full rounded-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
      onPointerMove={e=>{const rect=e.currentTarget.getBoundingClientRect();const ts=from+(e.clientX-rect.left)/rect.width*(to-from);setActive(points.reduce((best,p,i)=>Math.abs(Date.parse(p.ts)-ts)<Math.abs(Date.parse(points[best]!.ts)-ts)?i:best,0));}}
      onPointerLeave={()=>setActive(null)} onBlur={()=>setActive(null)}
      onFocus={()=>setActive(points.length-1)}
      onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();setActive(i=>Math.max(0,Math.min(points.length-1,(i ?? points.length-1)+(e.key==="ArrowLeft"?-1:1))));}else if(e.key==="Escape")setActive(null);}}>
      <defs><linearGradient id={`cpu-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-line-2)" stopOpacity=".26"/><stop offset="100%" stopColor="var(--chart-line-2)" stopOpacity=".025"/></linearGradient></defs>
      <line x1="0" x2={width} y1={baseline} y2={baseline} stroke="var(--border)"/>
      <path d={`${path(points)} L${x(last)},${baseline} L${x(first)},${baseline} Z`} fill={`url(#cpu-${id})`}/>
      {gaps.map((gap,i)=><path key={i} data-sample-gap d={path(gap)} fill="none" stroke="var(--chart-line-2)" strokeWidth="1.6" strokeDasharray="4 4" strokeLinecap="round" opacity=".75"/>)}
      {segments.map((segment,i)=>{
        return <g key={i}><path d={path(segment)} fill="none" stroke="var(--chart-line-2)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"/>{segment.length===1 && <circle cx={x(segment[0]!)} cy={y(segment[0]!.value)} r="2" fill="var(--chart-line-2)"/>}</g>;
      })}
      <text x={Math.max(20,Math.min(width-22,x(points[peak]!)))} y={Math.max(10,y(points[peak]!.value)-6)} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">{pct(points[peak]!.value)}</text>
      <circle cx={x(last)} cy={y(last.value)} r="2" fill="var(--chart-line-2)"/>
      {selected && <line x1={x(selected)} x2={x(selected)} y1="14" y2={baseline} stroke="var(--chart-line-2)" strokeDasharray="3 3"/>}
    </svg>}
    <div className="-mt-3 flex justify-between gap-2 text-[10px] tabular-nums text-muted-foreground"><span>{stamp(first.ts)}</span><span>{stamp(last.ts)}</span></div>
    {gaps.length>0 && <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground"><span aria-hidden="true" className="w-4 border-t border-dashed border-[var(--chart-line-2)]"/>Dashed: no samples between readings</p>}
    {selected && <div role="status" className="pointer-events-none absolute right-1 top-0 rounded-lg border bg-popover px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-md">{stamp(selected.ts)} <strong className="ml-2">{pct(selected.value)}</strong></div>}
  </div>;
}
