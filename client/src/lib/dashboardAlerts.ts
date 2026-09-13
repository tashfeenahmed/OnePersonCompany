import { WIDGETS } from "../data/widgets.ts";
import type { Dashboard, PlacedWidget } from "./store.tsx";
import type { Venture } from "./api.ts";
import { uniqueDashboardAlerts, type DashboardAlert } from "../../../shared/dashboardAlerts.ts";

export type AlertSummary={alerts:DashboardAlert[];count:number;critical:number;title:string};
export function summarizeAlerts(alerts:DashboardAlert[]):AlertSummary {
  const unique=uniqueDashboardAlerts(alerts),count=unique.length;
  return {alerts:unique,count,critical:unique.filter(a=>a.severity==="critical").length,title:[`${count} active alert${count===1?"":"s"}`,...unique.slice(0,8).map(a=>a.title),...(count>8?[`…and ${count-8} more`]:[])].join("\n")};
}
const aliases:Record<string,string[]>={
  registrars:["domains"],dynadot:["domains"],spaceship:["domains"],
  cf:["cloudflare"],boxes:["fleet"],summary:["hetzner"],load:["hetzner"],volumes:["hetzner"],
  play:["mobile"],appstore:["mobile"],mobilehealth:["stability"],mobileHealth:["stability"],
  revenue:["stripe"],leakage:["stripe"],disputes:["stripe"],queue:["stripe"],
  bing:["bing-webmaster"],hn:["hackernews"],gmail:["mail"],resend:["mail"],
  seoops:["seo"],instagram:["meta"],social:["meta","bluesky"],ads:["meta"],
};
function sourcesFor(widget:PlacedWidget):Set<string> {
  const def=WIDGETS[widget.type];
  const keys=def?[def.src,...Object.keys(def.live ?? {}).filter(k=>def.live?.[k as keyof typeof def.live]===true)]:[];
  return new Set(keys.flatMap(k=>[k,...(aliases[k] ?? [])]));
}
function inVenture(alert:DashboardAlert,venture:Pick<Venture,"id"|"host">|undefined):boolean {
  if(!venture)return false;
  if(alert.ventureId)return alert.ventureId===venture.id;
  if(!venture.host || !alert.entity || alert.entity.kind==="server")return false;
  const clean=(s:string)=>{try{return new URL(s.includes("://")?s:`https://${s}`).hostname.toLowerCase().replace(/^www\./,"");}catch{return s.toLowerCase();}};
  const host=clean(venture.host),entity=clean(alert.entity.id);
  return entity===host || (alert.entity.kind==="domain" && host.endsWith(`.${entity}`));
}
export function alertsForDashboard(board:Dashboard,alerts:DashboardAlert[],ventures:Pick<Venture,"id"|"host">[]=[]):AlertSummary {
  return summarizeAlerts(alerts.filter(alert=>{
    if(board.ventureId && !inVenture(alert,ventures.find(v=>v.id===board.ventureId)))return false;
    if(board.id==="d-overview" && !board.ventureId)return true;
    // The Apps dashboard owns app-health alerts even when its owner has
    // selected store widgets only. Slugs survive a rename; no layout changes.
    if(board.slug==="apps" && alert.sources.includes("stability") && board.widgets.some(w=>WIDGETS[w.type]?.live?.mobile || WIDGETS[w.type]?.live?.mobileHealth))return true;
    return board.widgets.some(widget=>{
      const def=WIDGETS[widget.type];
      if(!def)return false;
      if(def.perProject && !inVenture(alert,ventures.find(v=>v.id===widget.param)))return false;
      if(def.perParam?.kind==="server" && (alert.entity?.kind!=="server" || widget.param!==alert.entity.id))return false;
      const sources=sourcesFor(widget);
      return sources.has("inbox") || alert.sources.some(s=>sources.has(s));
    });
  }));
}
export function dashboardAlertRollup(boards:Dashboard[],alerts:DashboardAlert[],ventures:Pick<Venture,"id"|"host">[]=[]) {
  const byBoard=Object.fromEntries(boards.map(board=>[board.id,alertsForDashboard(board,alerts,ventures)]));
  return {byBoard,total:summarizeAlerts(boards.filter(b=>!b.ventureId).flatMap(b=>byBoard[b.id]!.alerts))};
}
