/** Current issues used by dashboard navigation, independent of chart windows. */
export type DashboardAlert = {
  id: string;
  severity: "warning" | "critical";
  title: string;
  detail: string;
  sources: string[];
  entity?: { kind: "server" | "domain" | "host"; id: string };
  ventureId?: string | null;
  href?: string;
  /** False for an incomplete/unavailable report rather than measured work. */
  actionable?: boolean;
};
export type DashboardAlertsDoc = { alerts: DashboardAlert[]; asOf: string };

type Limits = { warn:number; critical:number };
export type FleetAlertInput = {
  cadenceMinutes?: number;
  thresholds: { warn:number; critical:number; cpu?:Limits; memory?:Limits; disk?:Limits };
  boxes: {
    accountId:number; label:string; seenAt:string|null; error:string|null;
    sample:{cpuPercent:number|null;memory:{percent:number}|null;swap:{percent:number}|null;loadPerCpu:number|null}|null;
    disks:{mount:string;meter:{percent:number}|null}[];
    containers:{name:string;status?:string|null}[];
  }[];
};
export type DomainAlertInput = {
  domains:{name:string;expiresInDays:number|null;autoRenew:boolean|null;registrar:string}[];
  summary:{thresholds:{crit:number;warn:number}};
};
export type UptimeAlertInput = {
  hosts:{host:string;current:{ok:boolean;error:string|null;status:number|null}|null;tls:{daysLeft:number|null}}[];
};

/** Money that is in jeopardy on the billing side, straight off the Stripe
 *  document. Amounts stay per currency — a 100-unit number in two currencies
 *  is not 200 of anything. */
export type RevenueAlertInput = {
  atRisk: { subscriptions: number; mrr: { currency: string; amount: number }[] };
  endingSoon: { count: number; mrr: { currency: string; amount: number }[] };
};

export function currentDashboardAlerts(input:{fleet?:FleetAlertInput;domains?:DomainAlertInput;uptime?:UptimeAlertInput;revenue?:RevenueAlertInput},now=Date.now()):DashboardAlert[] {
  const alerts:DashboardAlert[]=[];
  const f=input.fleet;
  if(f) for(const box of f.boxes) {
    const entity={kind:"server" as const,id:String(box.accountId)};
    const add=(key:string,severity:DashboardAlert["severity"],title:string,detail="")=>alerts.push({id:`fleet:${box.accountId}:${key}`,severity,title:`${box.label}: ${title}`,detail,sources:["fleet"],entity});
    if(box.error || (box.seenAt && now-Date.parse(box.seenAt)>(f.cadenceMinutes ?? 30)*180_000)) {
      add("reporting","critical","not reporting",box.error ?? "More than three collection intervals since the last probe.");
      continue; // Old resource readings are not additional current incidents.
    }
    if(!box.sample) {add("reporting","warning","no readings yet","The server has not returned its first probe.");alerts[alerts.length-1]!.actionable=false;continue;}
    const check=(key:string,label:string,value:number|null|undefined,limits:Limits)=>{
      if(value===null || value===undefined || !Number.isFinite(value) || value<limits.warn)return;
      add(key,value>=limits.critical?"critical":"warning",`${label} at ${Math.round(value)}%`,`Watch at ${limits.warn}%; act at ${limits.critical}%.`);
    };
    check("cpu","CPU",box.sample.cpuPercent,f.thresholds.cpu ?? {warn:75,critical:90});
    check("memory","memory",box.sample.memory?.percent,f.thresholds.memory ?? {warn:80,critical:92});
    for(const disk of box.disks)check(`disk:${disk.mount}`,`${disk.mount} disk`,disk.meter?.percent,f.thresholds.disk ?? f.thresholds);
    if((box.sample.swap?.percent ?? 0)>=80)add("swap","warning",`swap at ${Math.round(box.sample.swap!.percent)}%`);
    if((box.sample.loadPerCpu ?? 0)>1)add("load","warning","more queued tasks than CPU cores",`Load per core: ${box.sample.loadPerCpu!.toFixed(2)}.`);
    for(const container of box.containers)if(/unhealthy|restarting/i.test(container.status ?? ""))add(`container:${container.name}`,"warning",`${container.name} needs attention`,container.status ?? "");
  }
  const d=input.domains;
  if(d)for(const domain of d.domains) {
    const days=domain.expiresInDays;
    if(days===null || !Number.isFinite(days) || days<0 || days>d.summary.thresholds.warn)continue;
    alerts.push({id:`domain:${domain.name.toLowerCase()}:expiry`,severity:days<=d.summary.thresholds.crit?"critical":"warning",
      title:days===0?`${domain.name} expires today`:`${domain.name} expires in ${days} days`,
      detail:`${domain.registrar} · auto-renew ${domain.autoRenew===null?"not reported":domain.autoRenew?"on":"off"}.`,sources:["domains"],entity:{kind:"domain",id:domain.name.toLowerCase()}});
  }
  if(input.uptime)for(const host of input.uptime.hosts) {
    const entity={kind:"host" as const,id:host.host.toLowerCase()};
    if(host.current && !host.current.ok)alerts.push({id:`uptime:${entity.id}:down`,severity:"critical",title:`${host.host} is not answering`,detail:host.current.error ?? `HTTP ${host.current.status ?? "failure"}`,sources:["uptime"],entity});
    const days=host.tls.daysLeft;
    if(days!==null && days<=30)alerts.push({id:`uptime:${entity.id}:tls`,severity:days<=7?"critical":"warning",title:days<0?`${host.host}: TLS certificate expired`:`${host.host}: TLS certificate expires in ${days} days`,detail:"Renew the certificate before it interrupts secure connections.",sources:["uptime","domains"],entity});
  }
  const r=input.revenue;
  if(r) {
    const sum=(rows:{currency:string;amount:number}[])=>{const by=new Map<string,number>();for(const x of rows)by.set(x.currency,(by.get(x.currency)??0)+x.amount);return [...by.entries()].map(([currency,amount])=>`${currency} ${amount.toFixed(2)}`).join(', ');};
    if(r.atRisk.subscriptions>0)alerts.push({id:'revenue:at-risk',severity:'warning',title:`${r.atRisk.subscriptions} subscription${r.atRisk.subscriptions===1?'':'s'} failing to pay`,detail:`At-risk MRR: ${sum(r.atRisk.mrr)||'not reported'}. Still contracted, currently declining to collect — Stripe retries on its own schedule; recovery outreach belongs to this group only.`,sources:['stripe'],href:'/alerts'});
    if(r.endingSoon.count>0)alerts.push({id:'revenue:ending-soon',severity:'warning',title:`${r.endingSoon.count} subscription${r.endingSoon.count===1?'':'s'} end soon`,detail:`Switched off auto-renew and paid to the end of the period: ${sum(r.endingSoon.mrr)||'not reported'} of MRR stops without a save. Decided customers, not failed cards — an offer or a conversation is the only move.`,sources:['stripe'],href:'/alerts'});
  }
  return uniqueDashboardAlerts(alerts);
}

export function uniqueDashboardAlerts(alerts:DashboardAlert[]):DashboardAlert[] {
  return [...new Map(alerts.map(a=>[a.id,a])).values()].sort((a,b)=>Number(b.severity==="critical")-Number(a.severity==="critical") || a.title.localeCompare(b.title));
}
