import { useId, useState } from "react";
import type { ServerPoint } from "@/lib/serverWidgets";
import { ChartTip, TipRow } from "@/components/overview/charts/ChartTip";
import { clamp, niceScale } from "@/components/overview/charts/scale";
import { useMeasuredWidth } from "@/components/overview/charts/useMeasuredWidth";

const stamp = (ts:string) => new Date(ts).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
const pct = (n:number) => `${Math.round(n*10)/10}%`;

/** WorkDash's compact LoadArea treatment: evenly spaced recorded samples. */
export function ServerLoadChart({points,label,height=72}: {
  points:ServerPoint[];label:string;height?:number;
}) {
  const id=useId().replaceAll(":","");
  const [ref,width]=useMeasuredWidth<HTMLDivElement>();
  const [active,setActive]=useState<number|null>(null);
  const [pinned, setPinned] = useState(false);
  const nextKey = JSON.stringify(points);
  const [readingKey, setReadingKey] = useState(nextKey);
  if (readingKey !== nextKey) { setReadingKey(nextKey); setPinned(false); setActive(null); }
  const first=points[0], last=points.at(-1);
  if (!first || !last || points.length<2) return <div ref={ref}><p className="py-6 text-xs text-muted-foreground">Not enough CPU history yet.</p></div>;

  // Four pixels on each side keep both markers inside the SVG viewport.
  const plotWidth=Math.max(1,width-8), baseline=height-14, plotHeight=height-30;
  const peak=points.reduce((best,p,i)=>p.value>points[best]!.value?i:best,0);
  const scale=niceScale(Math.max(4,points[peak]!.value),2);
  const mean=points.reduce((sum,p)=>sum+p.value,0)/points.length;
  const x=(i:number)=>4+i*plotWidth/(points.length-1);
  const y=(value:number)=>baseline-value/scale.max*plotHeight;
  const line=points.map((p,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const selectedIndex=active===null?null:clamp(active,0,points.length-1);
  const selected=selectedIndex===null?null:points[selectedIndex]!;
  const tip=selected && selectedIndex!==null ? {x:x(selectedIndex),y:y(selected.value),title:stamp(selected.ts),rows:<TipRow label="CPU" value={pct(selected.value)}/>} : null;

  const unpin = () => { setPinned(false); setActive(null); };
  const pick = (e: { clientX: number; currentTarget: SVGSVGElement }) => { const r = e.currentTarget.getBoundingClientRect(); return clamp(Math.round(((e.clientX-r.left)*width/r.width-4)/plotWidth*(points.length-1)),0,points.length-1); };
  return <div ref={ref} className="relative min-w-0" data-server-chart>
    {width>0 && <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0}
      aria-label={`${label}: ${pct(last.value)} latest, ${pct(points[peak]!.value)} peak, ${pct(mean)} average. ${points.length} evenly spaced readings from ${stamp(first.ts)} to ${stamp(last.ts)}. Use left and right arrows for values, Enter to pin and Escape to clear.`}
      className="block w-full rounded-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
      onPointerMove={e=>{if(!pinned)setActive(pick(e));}}
      onClick={e=>{const i=pick(e);if(pinned && active===i)unpin();else {setActive(i);setPinned(true);}}}
      onPointerLeave={()=>{if(!pinned)setActive(null);}} onBlur={()=>{if(!pinned)setActive(null);}}
      onFocus={e=>{if(!pinned && e.currentTarget.matches(":focus-visible"))setActive(points.length-1);}}
      onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();setActive(i=>clamp((i ?? points.length-1)+(e.key==="ArrowLeft"?-1:1),0,points.length-1));}else if(e.key==="Home"||e.key==="End"){e.preventDefault();setActive(e.key==="Home"?0:points.length-1);}else if(e.key==="Escape"){e.stopPropagation();unpin();}else if(e.key==="Enter" || e.key===" "){e.preventDefault();if(pinned)unpin();else{setActive(i=>i ?? points.length-1);setPinned(true);}}}}>
      <defs><linearGradient id={`cpu-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-line-2)" stopOpacity=".22"/><stop offset="100%" stopColor="var(--chart-line-2)" stopOpacity=".02"/></linearGradient></defs>
      <line x1="4" x2={width-4} y1={baseline} y2={baseline} stroke="var(--border)"/>
      <path d={`${line} L${x(points.length-1)},${baseline} L${x(0)},${baseline} Z`} fill={`url(#cpu-${id})`}/>
      <path data-cpu-line d={line} fill="none" stroke="var(--chart-line-2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={x(peak)} cy={y(points[peak]!.value)} r="3" fill="var(--chart-line-2)" stroke="var(--card)" strokeWidth="2"/>
      <text x={clamp(x(peak),24,Math.max(24,width-24))} y={Math.max(10,y(points[peak]!.value)-7)} textAnchor="middle" className="fill-muted-foreground text-[10px] font-medium tabular-nums">{pct(points[peak]!.value)}</text>
      <circle cx={x(points.length-1)} cy={y(last.value)} r="2.5" fill="var(--chart-line-2)" stroke="var(--card)" strokeWidth="2"/>
      {tip && <line x1={tip.x} x2={tip.x} y1="16" y2={baseline} stroke="var(--chart-line-2)" strokeOpacity=".35"/>}
    </svg>}
    <div className="-mt-3 flex justify-between gap-2 font-mono text-[10px] tabular-nums text-muted-foreground"><span>{stamp(first.ts)}</span><span>{stamp(last.ts)}</span></div>
    <ChartTip pinned={pinned} onUnpin={unpin} tip={tip} width={width}/>
    {selected && <span role="status" className="sr-only">{label}: {stamp(selected.ts)}, {pct(selected.value)}</span>}
  </div>;
}
