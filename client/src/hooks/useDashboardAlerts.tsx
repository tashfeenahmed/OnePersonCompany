import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { alertsApi } from "@/lib/api/proactive";
import { useStore } from "@/lib/store";
import { dashboardAlertRollup } from "@/lib/dashboardAlerts";
import type { DashboardAlertsDoc } from "../../../shared/dashboardAlerts";
import { ALERTS_CHANGED } from "./useOpenAlerts";

const empty=dashboardAlertRollup([],[]);
const Context=createContext({...empty,error:null as string|null,refresh:()=>{}});
const REFRESH="opc:dashboard-alerts-refresh";
export function DashboardAlertsProvider({children}:{children:ReactNode}) {
  const {state}=useStore();
  const [doc,setDoc]=useState<DashboardAlertsDoc|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    let alive=true,busy=false,again=false;
    const read=async()=>{
      if(busy){again=true;return;}
      busy=true;
      try {const next=await alertsApi.navigation();if(alive){setDoc(next);setError(null);}}
      catch {if(alive)setError("Alerts could not be refreshed. Counts may be out of date.");}
      finally {busy=false;if(alive && again){again=false;void read();}}
    };
    const visible=()=>{if(!document.hidden)void read();};
    void read();
    const timer=window.setInterval(visible,60_000);
    window.addEventListener(ALERTS_CHANGED,read);
    window.addEventListener(REFRESH,read);
    window.addEventListener("opc:data-changed",read);
    window.addEventListener("focus",visible);
    document.addEventListener("visibilitychange",visible);
    return ()=>{alive=false;clearInterval(timer);window.removeEventListener(ALERTS_CHANGED,read);window.removeEventListener(REFRESH,read);window.removeEventListener("opc:data-changed",read);window.removeEventListener("focus",visible);document.removeEventListener("visibilitychange",visible);};
  },[]);
  const rollup=useMemo(()=>dashboardAlertRollup(state.dashboards,doc?.alerts ?? [],state.ventures),[state.dashboards,state.ventures,doc]);
  const value=useMemo(()=>({...rollup,error,refresh:()=>window.dispatchEvent(new Event(REFRESH))}),[rollup,error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useDashboardAlerts=()=>useContext(Context);
