import type { FleetBox, FleetReport } from "./api/reports.ts";
import type { HetznerServer } from "./api.ts";
import type { Widget } from "../data/widgets.ts";
import type { LiveInputs } from "./liveWidgets.ts";
import { bytes, durationS, money } from "./format.ts";

export type ServerStatus = "healthy" | "degraded" | "down" | "unknown";
export type ServerPoint = { ts: string; value: number };
export type ServerMeter = {
  label: string; value: number | null; warn: number; critical: number;
  detail: string; change: number | null;
};
export type ServerCardData = {
  id: string; name: string; address: string | null; hostname: string | null;
  provider: string; location: string | null; specs: string | null;
  status: ServerStatus; statusLabel: string; note: string | null; seenAt: string | null;
  uptime: string; cost: string; meters: ServerMeter[]; load: ServerPoint[];
  loadSource: string; loadSpan: string; cadenceMinutes: number;
  docker: FleetBox["docker"]; containers: FleetBox["containers"];
  counters: { label: string; value: number | null; note: string | null }[];
  facts: [string, string][];
};
export type ServerFleetData = {
  cards: ServerCardData[]; points: ServerPoint[]; cadenceMinutes: number;
  span: string; mean: number | null; peak: number | null; caption: string;
  thresholds: { cpu: {warn:number;critical:number}; memory: {warn:number;critical:number}; disk: {warn:number;critical:number} };
};

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const percent = (n: number | null | undefined) => finite(n) && n >= 0 && n <= 100 ? n : null;
const round = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number | null) => n === null ? "—" : `${Math.round(n)}%`;
export function serverAddress(box: Pick<FleetBox, "target">): string | null {
  const host = box.target?.split("@").at(-1)?.trim();
  if (!host) return null;
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":").length <= 2 ? host.split(":")[0]! : host;
}
function vendorFor(box: FleetBox, fleet: HetznerServer[]) {
  const address = serverAddress(box)?.toLowerCase();
  return fleet.find(s => address && s.ipv4?.toLowerCase() === address)
    ?? fleet.find(s => box.hostname && s.name?.toLowerCase() === box.hostname.toLowerCase());
}
export function serverThresholds(report?: FleetReport | null) {
  return {
    cpu: report?.thresholds.cpu ?? {warn:75,critical:90},
    memory: report?.thresholds.memory ?? {warn:80,critical:92},
    disk: report?.thresholds.disk ?? {warn:report?.thresholds.warn ?? 80,critical:report?.thresholds.critical ?? 90},
  };
}
function cleanPoints(points: ServerPoint[]): ServerPoint[] {
  return [...new Map(points.filter(p => finite(Date.parse(p.ts)) && percent(p.value) !== null)
    .map(p => [Date.parse(p.ts), {ts:p.ts,value:round(p.value)}])).values()]
    .sort((a,b) => Date.parse(a.ts)-Date.parse(b.ts));
}
export function serverHistorySpan(points: ServerPoint[]) {
  if (points.length < 2) return "not enough history";
  const hours = (Date.parse(points.at(-1)!.ts)-Date.parse(points[0]!.ts))/3_600_000;
  return hours < 1 ? `${Math.round(hours*60)} min recorded` : hours < 48 ? `${round(hours)}h recorded` : `${round(hours/24)}d recorded`;
}
function change(points: ServerPoint[]): number | null {
  return points.length > 1 && Date.parse(points.at(-1)!.ts)-Date.parse(points[0]!.ts) >= 3_600_000
    ? round(points.at(-1)!.value-points[0]!.value) : null;
}

/** Each box contributes once per collection interval. Missing boxes never become zeros. */
export function meanServerLoad(boxes: readonly {id:string;load:ServerPoint[]}[], cadenceMinutes: number): ServerPoint[] {
  const width = Math.max(1,cadenceMinutes)*60_000;
  const buckets = new Map<number, Map<string, number[]>>();
  for (const box of boxes) for (const p of cleanPoints(box.load)) {
    const bucket = Math.floor(Date.parse(p.ts)/width)*width;
    const hosts = buckets.get(bucket) ?? new Map<string,number[]>();
    const values = hosts.get(box.id) ?? [];
    values.push(p.value); hosts.set(box.id,values); buckets.set(bucket,hosts);
  }
  return [...buckets].sort(([a],[b])=>a-b).map(([ts,hosts])=>{
    const means = [...hosts.values()].map(v=>v.reduce((n,x)=>n+x,0)/v.length);
    return {ts:new Date(ts).toISOString(),value:round(means.reduce((n,x)=>n+x,0)/means.length)};
  });
}

export function serverCard(box: FleetBox, input: LiveInputs, now = Date.now()): ServerCardData {
  const limits = serverThresholds(input.boxes);
  const cadenceMinutes = input.boxes?.cadenceMinutes ?? 30;
  const hz = vendorFor(box,input.fleet ?? []);
  const hypervisor = hz ? input.load?.servers.find(s=>s.id===hz.id && s.cpuScaled) : undefined;
  const guest = cleanPoints(box.samples.flatMap(s=>percent(s.cpuPercent) === null ? [] : [{ts:s.ts,value:s.cpuPercent!}]));
  const memory = cleanPoints(box.samples.flatMap(s=>finite(s.memUsed) && s.memTotal && s.memTotal>0 ? [{ts:s.ts,value:s.memUsed/s.memTotal*100}] : []));
  const useGuest = guest.length > 1 || !hypervisor?.cpu.points.length;
  const load = useGuest ? guest : cleanPoints(hypervisor!.cpu.points);
  const cpu = percent(box.sample?.cpuPercent) ?? percent(hypervisor?.cpu.now);
  const root = box.disks.find(d=>d.mount==="/");
  const meter = (label:string,value:number|null,threshold:{warn:number;critical:number},detail:string,delta:number|null=null):ServerMeter =>
    ({label,value,...threshold,detail,change:delta});
  const meters = [
    meter("CPU",cpu,limits.cpu,percent(box.sample?.cpuPercent)!==null ? "in the guest" : cpu!==null ? "Hetzner hypervisor" : "not measured",useGuest?change(guest):null),
    meter("Memory",percent(box.sample?.memory?.percent),limits.memory,box.sample?.memory ? `${bytes(box.sample.memory.used)} / ${bytes(box.sample.memoryTotal)}` : "not measured",change(memory)),
    meter("Disk",percent(root?.meter?.percent),limits.disk,root ? `/ · ${bytes(root.avail)} free` : "root not reported"),
    ...box.disks.filter(d=>d.mount!=="/").map(d=>meter(d.mount,percent(d.meter?.percent),limits.disk,`${bytes(d.avail)} free / ${bytes(d.size)}`)),
  ];
  const gap = box.seenAt ? now-Date.parse(box.seenAt) : null;
  let status: ServerStatus = "healthy";
  let statusLabel = "Healthy";
  const notes: string[] = [];
  if (box.error || (gap!==null && gap>cadenceMinutes*3*60_000)) {
    status="down"; statusLabel="Not reporting"; notes.push(box.error ?? "The last reading is more than three collection intervals old.");
  } else if (!box.sample) {
    status="unknown"; statusLabel="Not measured"; notes.push("This server has not returned a sample yet.");
  } else {
    const critical = meters.find(m=>m.value!==null && m.value>=m.critical);
    const warning = meters.find(m=>m.value!==null && m.value>=m.warn);
    if (critical || warning) {
      const m = (critical ?? warning)!;
      status="degraded"; statusLabel=critical?"Needs attention":"Watch";
      notes.push(`${m.label} is at ${pct(m.value)} · ${critical?"act":"watch"} at ${critical?m.critical:m.warn}%.`);
    }
    if ((box.sample.swap?.percent ?? 0)>=80) {
      status="degraded"; statusLabel="Watch"; notes.push(`Swap is ${pct(box.sample.swap!.percent)} used.`);
    }
    if ((box.sample.loadPerCpu ?? 0)>1) {
      status="degraded"; statusLabel="Watch"; notes.push("More queued tasks than CPU cores.");
    }
    if (box.containers.some(c=>/unhealthy|restarting/i.test(c.status ?? ""))) {
      status="degraded"; statusLabel="Watch"; notes.push("A container is unhealthy or restarting.");
    }
    if (meters.slice(0,3).every(m=>m.value===null)) {status="unknown";statusLabel="Not measured";}
  }
  const address = serverAddress(box);
  const local = address && /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.(local|lan|home|internal)$/.test(address);
  const expense = hz ? input.finance?.expenses.find(e=>!e.archived && e.source==="hetzner" && e.sourceRef===`server:${hz.id}`) : undefined;
  const cost = expense ? expense.monthly===null ? "Not priced" : `${money(expense.monthly,expense.currency)}/mo`
    : hz?.monthlyEur!==null && hz?.monthlyEur!==undefined ? `${money(hz.monthlyEur+(hz.ipv4MonthlyEur ?? 0),"EUR")}/mo` : "No recorded cloud bill";
  const facts: [string,string][] = [
    ["Load / core",box.sample?.loadPerCpu!==null && box.sample?.loadPerCpu!==undefined ? box.sample.loadPerCpu.toFixed(2) : "—"],
    ["CPU cores",String(box.sample?.cpus ?? "—")],
    ["Kernel",box.kernel ?? "—"],
    ["Swap",box.sample?.swap ? `${bytes(box.sample.swap.used)} used · ${pct(box.sample.swap.percent)}` : "not reported"],
    ...box.disks.map(d=>[`Filesystem ${d.mount}`,`${pct(percent(d.meter?.percent))} · ${bytes(d.avail)} free / ${bytes(d.size)}`] as [string,string]),
  ];
  if (hypervisor) for (const [label,stat] of [["Network in",hypervisor.netIn],["Network out",hypervisor.netOut],["Disk read",hypervisor.diskRead],["Disk write",hypervisor.diskWrite]] as const)
    facts.push([label,stat.now===null ? "—" : `${bytes(stat.now)}/s · hypervisor`]);
  return {
    id:String(box.accountId),name:box.label,address,hostname:box.hostname,
    provider:hz?"Hetzner":local?"Local network":"Other provider", location:hz?.location ?? null,specs:hz?.specs ?? hz?.plan ?? null,
    status,statusLabel,note:notes.join(" ") || null,seenAt:box.seenAt,uptime:durationS(box.sample?.uptimeSeconds ?? null),cost,
    meters,load,loadSource:useGuest?"Guest CPU samples":"Hetzner hypervisor CPU",loadSpan:serverHistorySpan(load),cadenceMinutes:useGuest?cadenceMinutes:0,
    docker:box.docker,containers:box.containers,
    counters:box.counters.map(c=>({label:c.label,value:c.latest?.value ?? null,note:c.note})),facts,
  };
}

export function serverFleet(input: LiveInputs, now = Date.now()): ServerFleetData | null {
  if (!input.boxes) return null;
  const cards = input.boxes.boxes.map(b=>serverCard(b,input,now));
  // Fleet averages use one instrument. Hypervisor fallback stays on each card.
  const guest = cards.filter(c=>c.loadSource==="Guest CPU samples");
  const cadenceMinutes = input.boxes.cadenceMinutes ?? 30;
  const points = meanServerLoad(guest,cadenceMinutes);
  const values = points.map(p=>p.value);
  const span = serverHistorySpan(points);
  const reporting = guest.filter(c=>c.load.length>0).length;
  return {cards,points,cadenceMinutes,span,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,peak:values.length?Math.max(...values):null,
    thresholds:serverThresholds(input.boxes),
    caption:`Guest CPU, averaged across reporting boxes in ${cadenceMinutes}-minute intervals · ${reporting}/${cards.length} boxes have CPU history · ${span}. Gaps mark periods without samples.`,
  };
}

function fleetCost(input: LiveInputs): Partial<Widget> | null {
  if (!input.finance) return null;
  const costs = input.finance.expenses.filter(e=>e.category==="server" && !e.archived);
  const totals = new Map<string,number>();
  for (const e of costs) if (e.monthly!==null) totals.set(e.currency,(totals.get(e.currency) ?? 0)+e.monthly);
  const unpriced = costs.filter(e=>e.monthly===null).length;
  return {value:[...totals].map(([c,n])=>money(n,c)).join(" · ") || "—",
    sub:`per month · servers and volumes${unpriced?` · ${unpriced} unpriced`:""}`,
    caption:"Operating-cost ledger, in each original currency. The selected history window does not change a monthly rate.",
    rows:costs.map(e=>[e.label,e.monthly===null?"Unpriced":`${money(e.monthly,e.currency)}/mo`]),
  };
}

export const SERVER_BUILDERS: Record<string,(input:LiveInputs)=>Partial<Widget>|null> = {
  "servers.cpu": input => {
    const fleet=serverFleet(input); if(!fleet)return null;
    return {value:pct(fleet.mean),sub:fleet.mean===null?"No CPU history yet":`mean over ${fleet.span} · peak ${pct(fleet.peak)}`,caption:fleet.caption};
  },
  "servers.worst": input => {
    const fleet=serverFleet(input); if(!fleet)return null;
    const readings=fleet.cards.filter(c=>c.status!=="down" && c.status!=="unknown").flatMap(c=>c.meters.filter(m=>m.value!==null).map(m=>({card:c,meter:m})));
    readings.sort((a,b)=>b.meter.value!/b.meter.critical-a.meter.value!/a.meter.critical);
    const worst=readings[0];
    return {value:worst?pct(worst.meter.value):"—",sub:worst?`${worst.card.name} · ${worst.meter.label.toLowerCase()}, act at ${worst.meter.critical}%`:"No current readings",caption:"The CPU, memory or filesystem reading nearest its own critical limit. Non-reporting servers are excluded."};
  },
  "servers.containers": input => {
    if(!input.boxes)return null;
    const boxes=input.boxes.boxes.filter(b=>b.sample && !b.error && b.seenAt && Date.now()-Date.parse(b.seenAt)<(input.boxes!.cadenceMinutes ?? 30)*180_000);
    const docker=boxes.filter(b=>b.docker?.installed);
    return {value:docker.length?String(docker.reduce((n,b)=>n+b.docker!.running,0)):"—",sub:`running · Docker on ${docker.length}/${input.boxes.boxes.length} boxes`,caption:"The probe lists running Docker containers only. Stopped containers, host processes and timers are not part of this count."};
  },
  "servers.cost": fleetCost,
  "servers.load": input => {
    const fleet=serverFleet(input); if(!fleet)return null;
    return {serverFleet:fleet,caption:fleet.caption};
  },
  "servers.cards": input => {
    const fleet=serverFleet(input); if(!fleet)return null;
    return {serverFleet:fleet};
  },
};
