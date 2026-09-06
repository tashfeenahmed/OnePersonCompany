import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import { when } from "@/lib/format";
type Report = { node: string; port: number; dataDirectory: string; writable: boolean; ownerPassword: boolean; model: string | null; agent: string | null; tools: { name: string; available: boolean }[]; productionBuild: boolean; lastBackup: string | null };
export function SetupChecklist() {
  const { data, error, reload, loading } = useApi(() => call<Report>("/setup"));
  return <section className="py-5 space-y-3"><h2 className="text-lg">Setup checks</h2>
    {error && <p role="alert">{error}</p>}<button className="rounded-lg px-3.5 py-1.5 bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] transition-colors disabled:opacity-50" disabled={loading} onClick={reload}>Check again</button>
    {data && <><ul className="space-y-2 text-sm">
      <li>{data.writable ? "✓" : "!"} Server data storage {data.writable ? "is writable" : "needs attention"}.</li>
      <li>{data.model || data.agent ? "✓" : "!"} {data.model || data.agent || "Choose a model or connect an agent"}. <Link className="underline" to="/settings?tab=models">Models</Link></li>
      <li>{data.ownerPassword ? "✓ Owner sign-in is enabled." : "! Set an owner password to approve and send email."} <Link className="underline" to="/settings?tab=security">Security</Link></li>
      <li>{data.lastBackup ? `✓ Last backup: ${when(data.lastBackup)}` : "! No successful backup yet."}</li>
      <li>{data.productionBuild ? "✓ Production website is built." : "! Run npm run build before production startup."}</li>
    </ul><details><summary className="cursor-pointer text-sm">System details and optional tools</summary><p className="py-2 text-xs break-all">Node {data.node} · API port {data.port} · {data.dataDirectory}</p><ul>{data.tools.map(t => <li key={t.name} className="text-sm">{t.available ? "✓" : "—"} {t.name}</li>)}</ul></details></>}
  </section>;
}
