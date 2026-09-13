import { domains } from "../../routes/domains.ts";
import { fleetRoutes } from "../ops/fleet-routes.ts";
import { uptimeRoutes } from "../ops/uptime-routes.ts";
import { currentDashboardAlerts, uniqueDashboardAlerts, type DashboardAlert, type DashboardAlertsDoc, type FleetAlertInput, type DomainAlertInput, type UptimeAlertInput } from "../../../../shared/dashboardAlerts.ts";
import { openRuleEvents, rules } from "./store.ts";

/** Read existing local reports; never trigger collectors or external requests. */
export async function dashboardAlerts():Promise<DashboardAlertsDoc> {
  const input:{fleet?:FleetAlertInput;domains?:DomainAlertInput;uptime?:UptimeAlertInput}={};
  const failures:DashboardAlert[]=[];
  const read=async(key:keyof typeof input,request:()=>Response|Promise<Response>)=>{
    try {
      const response=await request();
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      Object.assign(input,{[key]:await response.json()});
    } catch {
      failures.push({id:`source:${key}`,severity:"warning",title:`${key}: alert status unavailable`,detail:"The latest health report could not be read. Try refreshing.",sources:[key],href:"/ops"});
    }
  };
  await Promise.all([read("fleet",()=>fleetRoutes.request("/?hours=1")),read("domains",()=>domains.request("/")),read("uptime",()=>uptimeRoutes.request("/?hours=1"))]);
  const alerts=currentDashboardAlerts(input);
  const byRule=new Map(rules().map(r=>[r.id,r]));
  for(const event of openRuleEvents()) {
    const rule=byRule.get(event.rule_id);
    if(!rule)continue;
    // These portfolio seed rules summarize the individual current health
    // issues above. Custom thresholds and unreadable rules remain separate.
    const covered=rule.seeded===1 && event.kind==="trip" && !rule.venture_id && rule.view==="default" && rule.op===">" && (
      (rule.skill==="fleet" && rule.path==="totals.fullestDisk.percent" && rule.threshold===85 && input.fleet) ||
      (rule.skill==="domains" && rule.path==="summary.expiring30" && rule.threshold===0 && input.domains) ||
      (rule.skill==="uptime" && rule.path==="summary.down" && rule.threshold===0 && input.uptime));
    if(covered)continue;
    alerts.push({id:`rule:${rule.id}`,severity:"warning",title:event.kind==="unreadable"?`${rule.name} — check unavailable`:rule.name,detail:event.message,sources:[rule.skill],ventureId:rule.venture_id,href:"/alerts"});
  }
  return {alerts:uniqueDashboardAlerts([...alerts,...failures]),asOf:new Date().toISOString()};
}
